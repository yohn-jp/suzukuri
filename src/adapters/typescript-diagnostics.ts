import {
  validationFailure,
  validationSuccess,
  type Adapter,
  type ProjectionSource,
  type ValidationResult,
} from "../core.js";
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  DIAGNOSTICS_SEMANTIC_TYPE,
  diagnosticCounts,
  type Diagnostic,
  type DiagnosticSeverity,
  type DiagnosticsResult,
  type RelatedDiagnostic,
} from "../diagnostics.js";
import { type SourceRange } from "../semantic-location.js";
import {
  ProducerInputError,
  compareStrings,
  isRecord,
  positiveInteger,
  sourceText,
  stableString,
  stripAnsi,
  validationIssue,
} from "./input.js";

export const TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID = "typescript-diagnostics";
export const TYPESCRIPT_DIAGNOSTICS_ADAPTER_VERSION = "1.0.0";

export const typescriptDiagnosticsAdapter: Adapter<DiagnosticsResult> = Object.freeze({
  id: TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID,
  version: TYPESCRIPT_DIAGNOSTICS_ADAPTER_VERSION,
  semanticType: DIAGNOSTICS_SEMANTIC_TYPE,
  contract: { id: DIAGNOSTICS_SEMANTIC_TYPE, version: DIAGNOSTICS_SCHEMA_VERSION },
  validate: validateTypeScriptDiagnosticsSource,
  decode: decodeTypeScriptDiagnostics,
});

export const typescriptDiagnosticAdapter = typescriptDiagnosticsAdapter;

export function validateTypeScriptDiagnosticsSource(source: ProjectionSource): ValidationResult {
  try {
    decodeTypeScriptDiagnostics(source);
    return validationSuccess();
  } catch (error) {
    return validationFailure(validationIssue(error, TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID));
  }
}

export function decodeTypeScriptDiagnostics(source: ProjectionSource): DiagnosticsResult {
  const text = sourceText(source, TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "TypeScript diagnostics JSON is malformed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return decodeDiagnosticsJson(value);
  }
  return decodeDiagnosticsText(text);
}

interface MutableDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly file?: string;
  readonly range?: SourceRange;
  readonly messageParts: string[];
  readonly related: RelatedDiagnostic[];
  suggestion?: string;
  relatedMode: boolean;
}

function decodeDiagnosticsJson(value: unknown): DiagnosticsResult {
  const root = Array.isArray(value) ? { diagnostics: value } : value;
  if (!isRecord(root)) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostics JSON must be an object or array");
  }
  const values = Array.isArray(root.diagnostics)
    ? root.diagnostics
    : Array.isArray(root.results)
      ? root.results
      : undefined;
  if (values === undefined) {
    throw new ProducerInputError(
      TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID,
      "JSON is not a recognized TypeScript diagnostics result",
    );
  }
  const diagnostics = values.map((value, index) => parseJsonDiagnostic(value, index));
  return makeDiagnosticsResult(diagnostics);
}

function parseJsonDiagnostic(value: unknown, index: number): Diagnostic {
  if (!isRecord(value)) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostic entries must be objects", { index });
  }
  const severity = parseSeverity(value.severity ?? value.category ?? value.kind);
  if (severity === undefined) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostic severity is missing", { index });
  }
  const code = canonicalCode(value.code);
  if (code === undefined) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostic code is missing", { index });
  }
  const file = firstString(value, ["file", "fileName", "path"]);
  const range = jsonRange(value.range ?? value, true);
  const message = flattenMessage(value.message ?? value.messageText ?? value.text);
  if (message === undefined) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostic message is missing", { index });
  }
  const relatedValue = Array.isArray(value.relatedInformation)
    ? value.relatedInformation
    : Array.isArray(value.related)
      ? value.related
      : [];
  const related = relatedValue.map((item, relatedIndex) => parseJsonRelated(item, relatedIndex));
  const suggestion = firstString(value, ["suggestion", "suggestionMessage"]);
  return {
    id: diagnosticId(code, file, range, message, index),
    severity,
    code,
    ...(file === undefined ? {} : { file }),
    ...(range === undefined ? {} : { range }),
    message,
    ...(related.length === 0 ? {} : { related }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function parseJsonRelated(value: unknown, index: number): RelatedDiagnostic {
  if (!isRecord(value)) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "related diagnostic must be an object", { index });
  }
  const message = flattenMessage(value.message ?? value.messageText ?? value.text);
  if (message === undefined) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "related diagnostic message is missing", { index });
  }
  const file = firstString(value, ["file", "fileName", "path"]);
  const range = jsonRange(value.range ?? value, true);
  return {
    ...(file === undefined ? {} : { file }),
    ...(range === undefined ? {} : { range }),
    message,
  };
}

function decodeDiagnosticsText(text: string): DiagnosticsResult {
  const lines = stripAnsi(text).split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  let current: MutableDiagnostic | undefined;
  let recognized = false;

  const flush = (): void => {
    if (current === undefined) return;
    const message = current.messageParts.join("\n").trim();
    if (message.length === 0) {
      throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostic message is empty");
    }
    const index = diagnostics.length;
    diagnostics.push({
      id: diagnosticId(current.code, current.file, current.range, message, index),
      severity: current.severity,
      code: current.code,
      ...(current.file === undefined ? {} : { file: current.file }),
      ...(current.range === undefined ? {} : { range: current.range }),
      message,
      ...(current.related.length === 0 ? {} : { related: current.related }),
      ...(current.suggestion === undefined ? {} : { suggestion: current.suggestion }),
    });
    current = undefined;
  };

  for (const line of lines) {
    const header = parseDiagnosticHeader(line);
    if (header !== undefined) {
      recognized = true;
      if (current !== undefined && current.relatedMode && (line.startsWith(" ") || line.startsWith("\t"))) {
        current.related.push({
          ...(header.file === undefined ? {} : { file: header.file }),
          ...(header.range === undefined ? {} : { range: header.range }),
          message: header.message,
        });
        continue;
      }
      flush();
      current = {
        severity: header.severity,
        code: header.code,
        ...(header.file === undefined ? {} : { file: header.file }),
        ...(header.range === undefined ? {} : { range: header.range }),
        messageParts: [header.message],
        related: [],
        relatedMode: false,
      };
      continue;
    }
    const trimmed = line.trim();
    if (/^Related information:?$/i.test(trimmed)) {
      if (current !== undefined) current.relatedMode = true;
      continue;
    }
    if (/^Suggestion:\s*/i.test(trimmed) && current !== undefined) {
      current.suggestion = trimmed.replace(/^Suggestion:\s*/i, "").trim();
      continue;
    }
    if (current !== undefined && isDiagnosticContinuation(line)) {
      current.messageParts.push(trimmed);
    }
  }
  flush();

  if (!recognized && /^Found\s+0\s+errors?\.?$/im.test(text.trim())) {
    return makeDiagnosticsResult([]);
  }
  if (!recognized) {
    throw new ProducerInputError(
      TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID,
      "text is not recognized TypeScript compiler diagnostic output",
    );
  }
  return makeDiagnosticsResult(diagnostics);
}

interface ParsedDiagnosticHeader {
  readonly file?: string;
  readonly range?: SourceRange;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
}

function parseDiagnosticHeader(line: string): ParsedDiagnosticHeader | undefined {
  const legacy = line.match(
    /^\s*(.+?)\((\d+),(\d+)(?:,(\d+),(\d+))?\):\s*(error|warning|suggestion|message|note)\s+(TS?\d+|\d+)\s*:\s*(.*)\s*$/i,
  );
  if (legacy !== null) {
    return headerFromMatch(legacy[1], legacy[2], legacy[3], legacy[4], legacy[5], legacy[6], legacy[7], legacy[8]);
  }
  const modern = line.match(
    /^\s*(.+?):(\d+):(\d+)(?:-(\d+):(\d+))?\s*-\s*(error|warning|suggestion|message|note)\s+(TS?\d+|\d+)\s*:\s*(.*)\s*$/i,
  );
  if (modern !== null) {
    return headerFromMatch(modern[1], modern[2], modern[3], modern[4], modern[5], modern[6], modern[7], modern[8]);
  }
  const global = line.match(/^\s*(error|warning|suggestion|message|note)\s+(TS?\d+|\d+)\s*:\s*(.*)\s*$/i);
  if (global !== null) {
    const severity = parseSeverity(global[1]);
    const code = canonicalCode(global[2]);
    if (severity !== undefined && code !== undefined && global[3].trim().length > 0) {
      return { severity, code, message: global[3].trim() };
    }
  }
  return undefined;
}

function headerFromMatch(
  file: string,
  line: string,
  column: string,
  endLine: string | undefined,
  endColumn: string | undefined,
  severityValue: string,
  codeValue: string,
  messageValue: string,
): ParsedDiagnosticHeader {
  const severity = parseSeverity(severityValue);
  const code = canonicalCode(codeValue);
  if (severity === undefined || code === undefined) {
    throw new ProducerInputError(TYPESCRIPT_DIAGNOSTICS_ADAPTER_ID, "diagnostic header has unsupported severity/code");
  }
  const startLine = Number(line);
  const startColumn = Number(column);
  const parsedEndLine = endLine === undefined ? undefined : Number(endLine);
  const parsedEndColumn = endColumn === undefined ? undefined : Number(endColumn);
  return {
    file: file.trim(),
    range: {
      start: { line: startLine, column: startColumn },
      ...(parsedEndLine === undefined || parsedEndColumn === undefined
        ? {}
        : { end: { line: parsedEndLine, column: parsedEndColumn } }),
    },
    severity,
    code,
    message: messageValue.trim(),
  };
}

function isDiagnosticContinuation(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || /^\d+\s*[|│]/.test(trimmed) || /^[|│~^]+$/.test(trimmed)) return false;
  return line.startsWith(" ") || line.startsWith("\t") || trimmed.startsWith("-") || trimmed.startsWith("+");
}

function makeDiagnosticsResult(diagnostics: readonly Diagnostic[]): DiagnosticsResult {
  const normalized = [...diagnostics].sort(compareDiagnostics);
  return {
    version: DIAGNOSTICS_SCHEMA_VERSION,
    diagnostics: normalized,
    counts: diagnosticCounts(normalized),
  };
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareStrings(left.file ?? "", right.file ?? "") ||
    (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0) ||
    (left.range?.start.column ?? 0) - (right.range?.start.column ?? 0) ||
    severityRank(left.severity) - severityRank(right.severity) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message) ||
    compareStrings(left.id, right.id)
  );
}

function severityRank(value: DiagnosticSeverity): number {
  return { error: 0, warning: 1, suggestion: 2, message: 3 }[value];
}

function parseSeverity(value: unknown): DiagnosticSeverity | undefined {
  if (typeof value === "number") {
    return { 0: "warning", 1: "error", 2: "suggestion", 3: "message" }[value] as DiagnosticSeverity | undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "error") return "error";
  if (normalized === "warning" || normalized === "warn") return "warning";
  if (normalized === "suggestion") return "suggestion";
  if (normalized === "message" || normalized === "note") return "message";
  return undefined;
}

function canonicalCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return `TS${value}`;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const normalized = value.trim().toUpperCase();
  return /^TS\d+$/.test(normalized) ? normalized : /^\d+$/.test(normalized) ? `TS${normalized}` : normalized;
}

function firstString(root: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = stableString(root[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function flattenMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isRecord(value)) return undefined;
  const head = typeof value.messageText === "string" ? value.messageText : undefined;
  const next = Array.isArray(value.next) ? value.next : [];
  const parts = [head, ...next.map(flattenMessage)].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join("\n");
}

function jsonRange(value: unknown, zeroBased: boolean): SourceRange | undefined {
  if (!isRecord(value)) return undefined;
  const range = isRecord(value.range) ? value.range : value;
  const start = isRecord(range.start) ? range.start : range;
  const lineValue = start.line ?? start.lineNumber;
  const columnValue = start.column ?? start.character;
  const line = positionValue(lineValue, zeroBased);
  const column = positionValue(columnValue, zeroBased);
  if (line === undefined || column === undefined) return undefined;
  const end = isRecord(range.end) ? range.end : undefined;
  const endLine = end === undefined ? undefined : positionValue(end.line ?? end.lineNumber, zeroBased);
  const endColumn = end === undefined ? undefined : positionValue(end.column ?? end.character, zeroBased);
  return {
    start: { line, column },
    ...(endLine === undefined || endColumn === undefined ? {} : { end: { line: endLine, column: endColumn } }),
  };
}

function positionValue(value: unknown, zeroBased: boolean): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined;
  const normalized = (value as number) + (zeroBased ? 1 : 0);
  return positiveInteger(normalized);
}

function diagnosticId(
  code: string,
  file: string | undefined,
  range: SourceRange | undefined,
  message: string,
  index: number,
): string {
  const location =
    range === undefined
      ? ""
      : `${range.start.line}:${range.start.column}:${range.end?.line ?? ""}:${range.end?.column ?? ""}`;
  return `${file ?? "<project>"}:${location}:${code}:${message}:${index}`;
}
