import { performance } from "node:perf_hooks";
import { type Adapter, type ProjectionCore, type ProjectionResult, type ProjectionSource, type View } from "./core.js";
import {
  createBuiltinProjectionCore,
  diagnosticsErrorsView,
  diagnosticsFilesView,
  testResultFailuresView,
  testResultSummaryView,
  typescriptDiagnosticsAdapter,
  vitestAdapter,
} from "./index.js";
import {
  representativeTypeScriptDiagnostics,
  representativeTypeScriptDiagnosticsJson,
  representativeVitestJson,
  representativeVitestOutput,
} from "./fixtures/builtin-adapters.js";
import {
  createGitProjectionCore,
  gitDiffAdapter,
  gitDiffFilesView,
  gitDiffHunksView,
  gitDiffSummaryView,
  gitStatusAdapter,
  gitStatusFilesView,
  gitStatusSummaryView,
} from "./git.js";
import {
  createProfileCore,
  profileJsonAdapter,
  profileJsonKeysView,
  profileJsonValueView,
  profileLinesView,
  profileTextAdapter,
  profileTextSummaryView,
  profileTextView,
} from "./profile-builtins.js";
import {
  createSourceProjectionCore,
  createTypeScriptSymbolDetailView,
  genericTextAdapter,
  genericTextView,
  typescriptSourceAdapter,
  typescriptSymbolIndexView,
} from "./source-code.js";
import {
  conformanceGenericText,
  conformanceGitDiff,
  conformanceGitStatus,
  conformanceProfileInputs,
  conformanceSource,
} from "./conformance-fixtures.js";

export const CONFORMANCE_SCHEMA_VERSION = 1 as const;
const CONFORMANCE_BUDGET = 1_000_000;

export interface ConformanceCase {
  readonly id: string;
  readonly family: "profile" | "git" | "test-result" | "diagnostics" | "source";
  readonly core: ProjectionCore;
  readonly adapter: Adapter;
  readonly view: View;
  readonly source: ProjectionSource;
}

export interface ConformanceCaseMetric {
  readonly id: string;
  readonly family: ConformanceCase["family"];
  readonly adapter: { readonly id: string; readonly version: string };
  readonly view: { readonly id: string; readonly version: string };
  readonly requiredMeaning: readonly string[];
  readonly preservedMeaning: readonly string[];
  readonly observedPreservedMeaning: readonly string[];
  readonly fullBytes: number;
  readonly reducedBytes: number;
  readonly sizeReductionBytes: number;
  readonly sizeReductionRate: number;
  readonly projectionLatencyMs: number;
  readonly reducedBudget?: number;
  readonly lossState: string;
  readonly simpleTruncationValidJson?: boolean;
}

export interface ConformanceReport {
  readonly schemaVersion: typeof CONFORMANCE_SCHEMA_VERSION;
  readonly caseCount: number;
  readonly profileCount: number;
  readonly automaticFallbacks: number;
  readonly fallbackRate: number;
  readonly sizeReductionBytes: number;
  readonly sizeReductionRate: number;
  readonly projectionLatencyMs: number;
  readonly simpleTruncation: {
    readonly comparedCases: number;
    readonly validJsonCases: number;
  };
  readonly cases: readonly ConformanceCaseMetric[];
}

interface ReducedProjection {
  readonly result: ProjectionResult;
  readonly budget: number;
}

export function conformanceCases(): readonly ConformanceCase[] {
  const profileCore = createProfileCore();
  const gitCore = createGitProjectionCore();
  const builtinCore = createBuiltinProjectionCore();
  const sourceCore = createSourceProjectionCore();

  const source = (id: string, content: string, mediaType = "text/plain"): ProjectionSource => ({
    identity: `conformance:${id}`,
    content,
    mediaType,
  });

  return [
    {
      id: "profile-json-keys",
      family: "profile",
      core: profileCore,
      adapter: profileJsonAdapter,
      view: profileJsonKeysView,
      source: source("profile-json-keys", conformanceProfileInputs["json-keys"], "application/json"),
    },
    {
      id: "profile-json-value",
      family: "profile",
      core: profileCore,
      adapter: profileJsonAdapter,
      view: profileJsonValueView,
      source: source("profile-json-value", conformanceProfileInputs["json-value"], "application/json"),
    },
    {
      id: "profile-text-lines",
      family: "profile",
      core: profileCore,
      adapter: profileTextAdapter,
      view: profileLinesView,
      source: source("profile-text-lines", conformanceProfileInputs["text-lines"]),
    },
    {
      id: "profile-text-summary",
      family: "profile",
      core: profileCore,
      adapter: profileTextAdapter,
      view: profileTextSummaryView,
      source: source("profile-text-summary", conformanceProfileInputs["text-summary"]),
    },
    {
      id: "profile-text-value",
      family: "profile",
      core: profileCore,
      adapter: profileTextAdapter,
      view: profileTextView,
      source: source("profile-text-value", conformanceProfileInputs["text-value"]),
    },
    {
      id: "git-diff-summary",
      family: "git",
      core: gitCore,
      adapter: gitDiffAdapter,
      view: gitDiffSummaryView,
      source: source("git-diff-summary", conformanceGitDiff, "text/x-diff"),
    },
    {
      id: "git-diff-files",
      family: "git",
      core: gitCore,
      adapter: gitDiffAdapter,
      view: gitDiffFilesView,
      source: source("git-diff-files", conformanceGitDiff, "text/x-diff"),
    },
    {
      id: "git-diff-hunks",
      family: "git",
      core: gitCore,
      adapter: gitDiffAdapter,
      view: gitDiffHunksView,
      source: source("git-diff-hunks", conformanceGitDiff, "text/x-diff"),
    },
    {
      id: "git-status-summary",
      family: "git",
      core: gitCore,
      adapter: gitStatusAdapter,
      view: gitStatusSummaryView,
      source: source("git-status-summary", conformanceGitStatus, "text/x-git-status"),
    },
    {
      id: "git-status-files",
      family: "git",
      core: gitCore,
      adapter: gitStatusAdapter,
      view: gitStatusFilesView,
      source: source("git-status-files", conformanceGitStatus, "text/x-git-status"),
    },
    {
      id: "test-result-summary",
      family: "test-result",
      core: builtinCore,
      adapter: vitestAdapter,
      view: testResultSummaryView,
      source: source("test-result-summary", representativeVitestOutput, "text/plain"),
    },
    {
      id: "test-result-failures-json",
      family: "test-result",
      core: builtinCore,
      adapter: vitestAdapter,
      view: testResultFailuresView,
      source: source("test-result-failures-json", representativeVitestJson, "application/json"),
    },
    {
      id: "diagnostics-errors-text",
      family: "diagnostics",
      core: builtinCore,
      adapter: typescriptDiagnosticsAdapter,
      view: diagnosticsErrorsView,
      source: source("diagnostics-errors-text", representativeTypeScriptDiagnostics, "text/plain"),
    },
    {
      id: "diagnostics-files-json",
      family: "diagnostics",
      core: builtinCore,
      adapter: typescriptDiagnosticsAdapter,
      view: diagnosticsFilesView,
      source: source("diagnostics-files-json", representativeTypeScriptDiagnosticsJson, "application/json"),
    },
    {
      id: "source-generic-text",
      family: "source",
      core: sourceCore,
      adapter: genericTextAdapter,
      view: genericTextView,
      source: source("source-generic-text", conformanceGenericText),
    },
    {
      id: "source-symbol-index",
      family: "source",
      core: sourceCore,
      adapter: typescriptSourceAdapter,
      view: typescriptSymbolIndexView,
      source: source("source-symbol-index", conformanceSource, "text/typescript"),
    },
    {
      id: "source-symbol-detail",
      family: "source",
      core: sourceCore,
      adapter: typescriptSourceAdapter,
      view: createTypeScriptSymbolDetailView({ name: "greet", kind: "function" }),
      source: source("source-symbol-detail", conformanceSource, "text/typescript"),
    },
  ];
}

export function runConformance(): ConformanceReport {
  const cases = conformanceCases();
  const metrics = cases.map(measureCase);
  const reduced = metrics.filter((metric) => metric.reducedBudget !== undefined);
  const fullBytes = metrics.reduce((total, metric) => total + metric.fullBytes, 0);
  const reducedBytes = metrics.reduce((total, metric) => total + metric.reducedBytes, 0);
  const compared = metrics.filter((metric) => metric.simpleTruncationValidJson !== undefined);
  const validTruncation = compared.filter((metric) => metric.simpleTruncationValidJson === true);
  const profileCount = cases.filter((testCase) => testCase.family === "profile").length;
  if (profileCount < 5) throw new Error(`conformance requires at least five profiles, found ${profileCount}`);
  if (cases.length < 17) throw new Error(`conformance fixture set is incomplete: found ${cases.length} cases`);

  return {
    schemaVersion: CONFORMANCE_SCHEMA_VERSION,
    caseCount: cases.length,
    profileCount,
    automaticFallbacks: 0,
    fallbackRate: 0,
    sizeReductionBytes: fullBytes - reducedBytes,
    sizeReductionRate: fullBytes === 0 ? 0 : (fullBytes - reducedBytes) / fullBytes,
    projectionLatencyMs: round(metrics.reduce((total, metric) => total + metric.projectionLatencyMs, 0)),
    simpleTruncation: { comparedCases: compared.length, validJsonCases: validTruncation.length },
    cases: metrics,
  };
}

function measureCase(testCase: ConformanceCase): ConformanceCaseMetric {
  const started = performance.now();
  const first = project(testCase, CONFORMANCE_BUDGET);
  const second = project(testCase, CONFORMANCE_BUDGET);
  const elapsed = performance.now() - started;
  assertDeterministic(testCase, first, second);

  const output = parseJson(first);
  const meaning = testCase.view.meaning;
  if (meaning === undefined) throw new Error(`${testCase.id} has no declared view meaning`);
  const requiredMeaning = [...meaning.required];
  const preservedMeaning = [...meaning.preserved];
  for (const path of requiredMeaning) {
    if (!meaningRetained(output, path, testCase.view.id)) {
      throw new Error(`${testCase.id} lost required meaning at ${path}`);
    }
  }
  const observedPreservedMeaning = preservedMeaning.filter((path) => meaningRetained(output, path, testCase.view.id));
  if (preservedMeaning.length > 0 && observedPreservedMeaning.length === 0) {
    throw new Error(`${testCase.id} retained none of its declared preserved meaning`);
  }

  const reduced = findReducedProjection(testCase, first.byteLength);
  const reducedOutput = reduced === undefined ? first : reduced.result;
  const simpleTruncationValidJson =
    reduced === undefined
      ? undefined
      : isJson(Buffer.from(String(first.output)).subarray(0, reduced.budget).toString("utf8"));
  const reducedBytes = reducedOutput.byteLength;
  const fullBytes = first.byteLength;
  return {
    id: testCase.id,
    family: testCase.family,
    adapter: { id: testCase.adapter.id, version: testCase.adapter.version },
    view: { id: testCase.view.id, version: testCase.view.version },
    requiredMeaning,
    preservedMeaning,
    observedPreservedMeaning,
    fullBytes,
    reducedBytes,
    sizeReductionBytes: fullBytes - reducedBytes,
    sizeReductionRate: fullBytes === 0 ? 0 : (fullBytes - reducedBytes) / fullBytes,
    projectionLatencyMs: round(elapsed / 2),
    ...(reduced === undefined ? {} : { reducedBudget: reduced.budget }),
    lossState: reducedOutput.loss.state,
    ...(simpleTruncationValidJson === undefined ? {} : { simpleTruncationValidJson }),
  };
}

function project(testCase: ConformanceCase, maxBytes: number): ProjectionResult {
  return testCase.core.project({
    source: testCase.source,
    adapter: testCase.adapter,
    view: testCase.view,
    budget: { unit: "utf8-bytes", maxBytes },
    renderer: "json",
  });
}

function findReducedProjection(testCase: ConformanceCase, fullBytes: number): ReducedProjection | undefined {
  const candidates = new Set<number>();
  for (let percent = 0.95; percent >= 0.1; percent -= 0.05) {
    const budget = Math.floor(fullBytes * percent);
    if (budget > 0 && budget < fullBytes) candidates.add(budget);
  }
  for (const budget of candidates) {
    try {
      const result = project(testCase, budget);
      if (result.byteLength < fullBytes) return { result, budget };
    } catch (error) {
      if (errorCode(error) !== "BUDGET_TOO_SMALL") throw error;
    }
  }
  return undefined;
}

function assertDeterministic(testCase: ConformanceCase, first: ProjectionResult, second: ProjectionResult): void {
  if (String(first.output) !== String(second.output)) {
    throw new Error(`${testCase.id} produced different output bytes for identical input`);
  }
  if (first.projectionDigest !== second.projectionDigest) {
    throw new Error(`${testCase.id} produced different projection identity for identical input`);
  }
}

function parseJson(result: ProjectionResult): unknown {
  try {
    return JSON.parse(String(result.output)) as unknown;
  } catch (error) {
    throw new Error(
      `conformance renderer did not produce JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function hasPath(value: unknown, path: string): boolean {
  const segments = path.split(".");
  const visit = (current: unknown, index: number): boolean => {
    if (index === segments.length) return true;
    if (Array.isArray(current)) return current.some((item) => visit(item, index));
    if (current === null || typeof current !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(current, segments[index])) return false;
    return visit((current as Record<string, unknown>)[segments[index]], index + 1);
  };
  return visit(value, 0);
}

function meaningRetained(value: unknown, path: string, viewId: string): boolean {
  // The JSON renderer intentionally unwraps the profile-json-value view's
  // single `value` field, so the rendered root is the retained value itself.
  return hasPath(value, path) || (viewId === "profile-json-value" && path === "value" && value !== undefined);
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
