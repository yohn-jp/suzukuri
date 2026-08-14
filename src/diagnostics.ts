import { validationFailure, validationSuccess, type SemanticContract, type ValidationResult } from "./core.js";
import { compareSourceRanges, isRecord, isSourceRange, type SourceRange } from "./semantic-location.js";

export const DIAGNOSTICS_SEMANTIC_TYPE = "diagnostics";
export const DIAGNOSTICS_SCHEMA_VERSION = "1.0.0";

export type DiagnosticSeverity = "error" | "warning" | "suggestion" | "message";

export interface RelatedDiagnostic {
  readonly file?: string;
  readonly range?: SourceRange;
  readonly message: string;
}

export interface Diagnostic {
  /** Stable identity derived from all deterministic diagnostic facts. */
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  /** Canonical TypeScript code, for example TS2322. */
  readonly code: string;
  readonly file?: string;
  readonly range?: SourceRange;
  readonly message: string;
  readonly related?: readonly RelatedDiagnostic[];
  readonly suggestion?: string;
}

export interface DiagnosticCounts {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly suggestions: number;
  readonly messages: number;
}

export interface DiagnosticsResult {
  readonly version: typeof DIAGNOSTICS_SCHEMA_VERSION;
  readonly diagnostics: readonly Diagnostic[];
  readonly counts: DiagnosticCounts;
}

export const diagnosticsContract: SemanticContract<DiagnosticsResult> = Object.freeze({
  id: DIAGNOSTICS_SEMANTIC_TYPE,
  version: DIAGNOSTICS_SCHEMA_VERSION,
  semanticType: DIAGNOSTICS_SEMANTIC_TYPE,
  validate: validateDiagnostics,
  normalize: normalizeDiagnostics,
});

export const typescriptDiagnosticsContract = diagnosticsContract;

export function validateDiagnostics(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return validationFailure({ code: "type", message: "diagnostics must be an object" });
  }
  const issues: Array<{ code: string; message: string; path?: string }> = [];
  if (value.version !== DIAGNOSTICS_SCHEMA_VERSION) {
    issues.push({ code: "version", message: `version must be ${DIAGNOSTICS_SCHEMA_VERSION}`, path: "version" });
  }
  if (!Array.isArray(value.diagnostics)) {
    issues.push({ code: "diagnostics", message: "diagnostics must be an array", path: "diagnostics" });
  } else {
    value.diagnostics.forEach((diagnostic, index) => {
      for (const issue of validateDiagnostic(diagnostic)) {
        issues.push({
          ...issue,
          path: `diagnostics[${index}]${issue.path === undefined ? "" : `.${issue.path}`}`,
        });
      }
    });
  }
  if (!isValidCounts(value.counts)) {
    issues.push({ code: "counts", message: "counts do not match diagnostic severities", path: "counts" });
  } else if (Array.isArray(value.diagnostics) && value.counts.total !== value.diagnostics.length) {
    issues.push({ code: "count-total", message: "counts.total must equal diagnostics.length", path: "counts.total" });
  }
  return issues.length === 0 ? validationSuccess() : validationFailure(issues);
}

export function normalizeDiagnostics(value: unknown): DiagnosticsResult {
  const validation = validateDiagnostics(value);
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => `${issue.path ?? "value"}: ${issue.message}`).join("; "));
  }
  const input = value as DiagnosticsResult;
  const diagnostics = input.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    ...(diagnostic.range === undefined ? {} : { range: normalizeRange(diagnostic.range) }),
    ...(diagnostic.related === undefined
      ? {}
      : {
          related: diagnostic.related.map((related) => ({
            ...related,
            ...(related.range === undefined ? {} : { range: normalizeRange(related.range) }),
          })),
        }),
  }));
  diagnostics.sort(compareDiagnostics);
  return {
    version: DIAGNOSTICS_SCHEMA_VERSION,
    diagnostics,
    counts: { ...input.counts },
  };
}

function validateDiagnostic(value: unknown): readonly { code: string; message: string; path?: string }[] {
  if (!isRecord(value)) {
    return [{ code: "type", message: "diagnostic must be an object" }];
  }
  const issues: Array<{ code: string; message: string; path?: string }> = [];
  if (typeof value.id !== "string" || value.id.length === 0) {
    issues.push({ code: "id", message: "id must be a non-empty string", path: "id" });
  }
  if (!isSeverity(value.severity)) {
    issues.push({ code: "severity", message: "severity is invalid", path: "severity" });
  }
  if (typeof value.code !== "string" || value.code.length === 0) {
    issues.push({ code: "code", message: "code must be a non-empty string", path: "code" });
  }
  if (value.file !== undefined && (typeof value.file !== "string" || value.file.length === 0)) {
    issues.push({ code: "file", message: "file must be a non-empty string", path: "file" });
  }
  if (value.range !== undefined && !isSourceRange(value.range)) {
    issues.push({ code: "range", message: "range must contain one-based start/end positions", path: "range" });
  }
  if (typeof value.message !== "string" || value.message.length === 0) {
    issues.push({ code: "message", message: "message must be a non-empty string", path: "message" });
  }
  if (
    value.related !== undefined &&
    (!Array.isArray(value.related) || value.related.some((item) => !isValidRelated(item)))
  ) {
    issues.push({ code: "related", message: "related must contain valid related diagnostics", path: "related" });
  }
  if (value.suggestion !== undefined && typeof value.suggestion !== "string") {
    issues.push({ code: "suggestion", message: "suggestion must be a string", path: "suggestion" });
  }
  return issues;
}

function isValidRelated(value: unknown): value is RelatedDiagnostic {
  return (
    isRecord(value) &&
    (value.file === undefined || (typeof value.file === "string" && value.file.length > 0)) &&
    (value.range === undefined || isSourceRange(value.range)) &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isValidCounts(value: unknown): value is DiagnosticCounts {
  if (!isRecord(value)) return false;
  const fields = [value.total, value.errors, value.warnings, value.suggestions, value.messages];
  return (
    fields.every((field) => Number.isSafeInteger(field) && (field as number) >= 0) &&
    value.total ===
      (value.errors as number) + (value.warnings as number) + (value.suggestions as number) + (value.messages as number)
  );
}

function isSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "error" || value === "warning" || value === "suggestion" || value === "message";
}

function normalizeRange(range: SourceRange): SourceRange {
  return {
    start: { ...range.start },
    ...(range.end === undefined ? {} : { end: { ...range.end } }),
  };
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareStrings(left.file ?? "", right.file ?? "") ||
    compareSourceRanges(left.range, right.range) ||
    severityRank(left.severity) - severityRank(right.severity) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message) ||
    compareStrings(left.id, right.id)
  );
}

function severityRank(value: DiagnosticSeverity): number {
  return { error: 0, warning: 1, suggestion: 2, message: 3 }[value];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isDiagnosticsResult(value: unknown): value is DiagnosticsResult {
  return validateDiagnostics(value).valid;
}

export function diagnosticCounts(values: readonly Diagnostic[]): DiagnosticCounts {
  const counts = { total: values.length, errors: 0, warnings: 0, suggestions: 0, messages: 0 };
  for (const value of values) {
    counts[`${value.severity}s` as "errors" | "warnings" | "suggestions" | "messages"] += 1;
  }
  return counts;
}
