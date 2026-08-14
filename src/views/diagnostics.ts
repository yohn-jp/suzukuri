import type { View, ViewProjection, ViewProjectInput, ViewReduceInput } from "../core.js";
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  DIAGNOSTICS_SEMANTIC_TYPE,
  isDiagnosticsResult,
  type Diagnostic,
  type DiagnosticsResult,
} from "../diagnostics.js";
import type { SourceRange } from "../semantic-location.js";

export interface DiagnosticsErrorsProjection {
  readonly version: typeof DIAGNOSTICS_SCHEMA_VERSION;
  readonly counts: DiagnosticsResult["counts"];
  readonly errors: readonly Diagnostic[];
}

export interface DiagnosticsFile {
  readonly file: string;
  readonly counts: DiagnosticsResult["counts"];
  readonly diagnostics: readonly Diagnostic[];
}

export interface DiagnosticsFilesProjection {
  readonly version: typeof DIAGNOSTICS_SCHEMA_VERSION;
  readonly files: readonly DiagnosticsFile[];
}

export const diagnosticsErrorsView: View<DiagnosticsErrorsProjection> = Object.freeze({
  id: "diagnostics-errors",
  version: DIAGNOSTICS_SCHEMA_VERSION,
  semanticType: DIAGNOSTICS_SEMANTIC_TYPE,
  meaning: {
    required: ["version", "counts", "errors"],
    preserved: [
      "errors.id",
      "errors.severity",
      "errors.code",
      "errors.file",
      "errors.range",
      "errors.message",
      "errors.related",
      "errors.suggestion",
    ],
    discarded: [],
    priorities: [
      { path: "errors", priority: 0, required: true },
      { path: "errors.id", priority: 1 },
      { path: "errors.severity", priority: 1 },
      { path: "errors.code", priority: 1 },
      { path: "errors.file", priority: 1 },
      { path: "errors.range", priority: 1 },
      { path: "errors.message", priority: 1 },
      { path: "errors.related", priority: 3 },
      { path: "errors.suggestion", priority: 4 },
    ],
    reductions: [{ kind: "path-deduplication", path: "errors", priority: 0 }],
  },
  project: ({ semantic }: ViewProjectInput): DiagnosticsErrorsProjection => {
    const result = asDiagnostics(semantic);
    return {
      version: DIAGNOSTICS_SCHEMA_VERSION,
      counts: { ...result.counts },
      errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map(copyDiagnostic),
    };
  },
  reduce: ({ projection }: ViewReduceInput<unknown>) =>
    reduceErrors(projection as ViewProjection<DiagnosticsErrorsProjection>),
});

export const typescriptErrorsView = diagnosticsErrorsView;

export const diagnosticsFilesView: View<DiagnosticsFilesProjection> = Object.freeze({
  id: "diagnostics-files",
  version: DIAGNOSTICS_SCHEMA_VERSION,
  semanticType: DIAGNOSTICS_SEMANTIC_TYPE,
  meaning: {
    required: ["version", "files"],
    preserved: [
      "files.file",
      "files.counts",
      "files.diagnostics.id",
      "files.diagnostics.severity",
      "files.diagnostics.code",
      "files.diagnostics.range",
      "files.diagnostics.message",
      "files.diagnostics.related",
      "files.diagnostics.suggestion",
    ],
    discarded: [],
    priorities: [
      { path: "files", priority: 0, required: true },
      { path: "files.file", priority: 1 },
      { path: "files.diagnostics", priority: 1 },
      { path: "files.diagnostics.related", priority: 3 },
      { path: "files.diagnostics.suggestion", priority: 4 },
    ],
    reductions: [{ kind: "path-deduplication", path: "files", priority: 0 }],
  },
  project: ({ semantic }: ViewProjectInput): DiagnosticsFilesProjection => {
    const result = asDiagnostics(semantic);
    const groups = new Map<string, Diagnostic[]>();
    for (const diagnostic of result.diagnostics) {
      const file = diagnostic.file ?? "<project>";
      const group = groups.get(file) ?? [];
      group.push(copyDiagnostic(diagnostic));
      groups.set(file, group);
    }
    const files: DiagnosticsFile[] = [...groups.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([file, diagnostics]) => ({
        file,
        counts: diagnosticCountsFor(diagnostics),
        diagnostics,
      }));
    return { version: DIAGNOSTICS_SCHEMA_VERSION, files };
  },
  reduce: ({ projection }: ViewReduceInput<unknown>) =>
    reduceFiles(projection as ViewProjection<DiagnosticsFilesProjection>),
});

export const typescriptFilesView = diagnosticsFilesView;

function asDiagnostics(value: unknown): DiagnosticsResult {
  if (!isDiagnosticsResult(value)) {
    throw new Error("diagnostics view received an invalid semantic value");
  }
  return value;
}

function copyDiagnostic(value: Diagnostic): Diagnostic {
  return {
    ...value,
    ...(value.range === undefined ? {} : { range: copyRange(value.range) }),
    ...(value.related === undefined
      ? {}
      : {
          related: value.related.map((related) => ({
            ...related,
            ...(related.range === undefined ? {} : { range: copyRange(related.range) }),
          })),
        }),
  };
}

function copyRange(range: SourceRange): SourceRange {
  return {
    start: { ...range.start },
    ...(range.end === undefined ? {} : { end: { ...range.end } }),
  };
}

function diagnosticCountsFor(values: readonly Diagnostic[]): DiagnosticsResult["counts"] {
  const counts = { total: values.length, errors: 0, warnings: 0, suggestions: 0, messages: 0 };
  for (const diagnostic of values) {
    if (diagnostic.severity === "error") counts.errors += 1;
    if (diagnostic.severity === "warning") counts.warnings += 1;
    if (diagnostic.severity === "suggestion") counts.suggestions += 1;
    if (diagnostic.severity === "message") counts.messages += 1;
  }
  return counts;
}

function reduceErrors(
  projection: ViewProjection<DiagnosticsErrorsProjection>,
): ViewProjection<DiagnosticsErrorsProjection> {
  const value = projection.value;
  const diagnostics = value.errors;
  if (diagnostics.some((diagnostic) => diagnostic.related !== undefined)) {
    return {
      value: { ...value, errors: diagnostics.map(({ related: _related, ...diagnostic }) => diagnostic) },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "errors.related",
            count: diagnostics.filter((diagnostic) => diagnostic.related !== undefined).length,
          },
        ],
      },
    };
  }
  if (diagnostics.some((diagnostic) => diagnostic.suggestion !== undefined)) {
    return {
      value: { ...value, errors: diagnostics.map(({ suggestion: _suggestion, ...diagnostic }) => diagnostic) },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "errors.suggestion",
            count: diagnostics.filter((diagnostic) => diagnostic.suggestion !== undefined).length,
          },
        ],
      },
    };
  }
  return projection;
}

function reduceFiles(
  projection: ViewProjection<DiagnosticsFilesProjection>,
): ViewProjection<DiagnosticsFilesProjection> {
  const value = projection.value;
  const diagnostics = value.files.flatMap((file) => file.diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.related !== undefined)) {
    return {
      value: {
        ...value,
        files: value.files.map((file) => ({
          ...file,
          diagnostics: file.diagnostics.map(({ related: _related, ...diagnostic }) => diagnostic),
        })),
      },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "files.diagnostics.related",
            count: diagnostics.filter((diagnostic) => diagnostic.related !== undefined).length,
          },
        ],
      },
    };
  }
  if (diagnostics.some((diagnostic) => diagnostic.suggestion !== undefined)) {
    return {
      value: {
        ...value,
        files: value.files.map((file) => ({
          ...file,
          diagnostics: file.diagnostics.map(({ suggestion: _suggestion, ...diagnostic }) => diagnostic),
        })),
      },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "files.diagnostics.suggestion",
            count: diagnostics.filter((diagnostic) => diagnostic.suggestion !== undefined).length,
          },
        ],
      },
    };
  }
  return projection;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
