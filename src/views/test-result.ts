import type { View, ViewProjection, ViewProjectInput, ViewReduceInput } from "../core.js";
import {
  TEST_RESULT_SCHEMA_VERSION,
  TEST_RESULT_SEMANTIC_TYPE,
  isTestResult,
  type TestFailure,
  type TestResult,
} from "../test-result.js";
import type { SourceRange } from "../semantic-location.js";

export interface TestFailureSummary {
  readonly id: string;
  readonly name: string;
  readonly file?: string;
  readonly location?: SourceRange;
  readonly message: string;
}

export interface TestResultSummaryProjection {
  readonly version: typeof TEST_RESULT_SCHEMA_VERSION;
  readonly status: TestResult["status"];
  readonly counts: TestResult["counts"];
  readonly failures: readonly TestFailureSummary[];
  readonly durationMs?: number;
}

export interface TestResultFailuresProjection {
  readonly version: typeof TEST_RESULT_SCHEMA_VERSION;
  readonly status: TestResult["status"];
  readonly counts: TestResult["counts"];
  readonly failures: readonly TestFailure[];
  readonly durationMs?: number;
}

export const testResultSummaryView: View<TestResultSummaryProjection> = Object.freeze({
  id: "test-result-summary",
  version: TEST_RESULT_SCHEMA_VERSION,
  semanticType: TEST_RESULT_SEMANTIC_TYPE,
  meaning: {
    required: ["version", "status", "counts", "failures"],
    preserved: ["failures.id", "failures.name", "failures.file", "failures.location", "failures.message", "durationMs"],
    discarded: [],
    priorities: [
      { path: "failures", priority: 0, required: true },
      { path: "durationMs", priority: 4 },
    ],
    reductions: ["ansi-removal", "repeated-message-folding"],
  },
  project: ({ semantic }: ViewProjectInput): TestResultSummaryProjection => {
    const result = asTestResult(semantic);
    return {
      version: TEST_RESULT_SCHEMA_VERSION,
      status: result.status,
      counts: { ...result.counts },
      failures: result.failures.map(toSummaryFailure),
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    };
  },
});

export const vitestSummaryView = testResultSummaryView;

export const testResultFailuresView: View<TestResultFailuresProjection> = Object.freeze({
  id: "test-result-failures",
  version: TEST_RESULT_SCHEMA_VERSION,
  semanticType: TEST_RESULT_SEMANTIC_TYPE,
  meaning: {
    required: ["version", "status", "counts", "failures"],
    preserved: [
      "failures.id",
      "failures.name",
      "failures.file",
      "failures.location",
      "failures.message",
      "failures.assertion",
      "failures.diagnostic",
      "failures.durationMs",
      "failures.suite",
      "failures.stack",
      "durationMs",
    ],
    discarded: [],
    priorities: [
      { path: "failures", priority: 0, required: true },
      { path: "failures.location", priority: 1 },
      { path: "failures.message", priority: 1 },
      { path: "failures.id", priority: 1 },
      { path: "failures.name", priority: 1 },
      { path: "failures.diagnostic", priority: 2 },
      { path: "failures.assertion", priority: 2 },
      { path: "failures.suite", priority: 3 },
      { path: "failures.durationMs", priority: 4 },
      { path: "failures.stack", priority: 5 },
      { path: "durationMs", priority: 6 },
    ],
    reductions: [
      { kind: "ansi-removal", priority: 0 },
      { kind: "stack-frame-collapse", path: "failures.stack", priority: 1 },
      { kind: "repeated-message-folding", path: "failures.message", priority: 2 },
    ],
  },
  project: ({ semantic }: ViewProjectInput): TestResultFailuresProjection => {
    const result = asTestResult(semantic);
    return {
      version: TEST_RESULT_SCHEMA_VERSION,
      status: result.status,
      counts: { ...result.counts },
      failures: result.failures.map((failure) => ({
        ...failure,
        ...(failure.location === undefined ? {} : { location: copyRange(failure.location) }),
        ...(failure.suite === undefined ? {} : { suite: [...failure.suite] }),
      })),
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    };
  },
  reduce: ({ projection }: ViewReduceInput<unknown>) =>
    reduceFailureDetails(projection as ViewProjection<TestResultFailuresProjection>),
});

export const vitestFailuresView = testResultFailuresView;

function asTestResult(value: unknown): TestResult {
  if (!isTestResult(value)) {
    throw new Error("test-result view received an invalid semantic value");
  }
  return value;
}

function toSummaryFailure(failure: TestFailure): TestFailureSummary {
  return {
    id: failure.id,
    name: failure.name,
    ...(failure.file === undefined ? {} : { file: failure.file }),
    ...(failure.location === undefined ? {} : { location: copyRange(failure.location) }),
    message: failure.message,
  };
}

function copyRange(range: SourceRange): SourceRange {
  return {
    start: { ...range.start },
    ...(range.end === undefined ? {} : { end: { ...range.end } }),
  };
}

function reduceFailureDetails(
  projection: ViewProjection<TestResultFailuresProjection>,
): ViewProjection<TestResultFailuresProjection> {
  const failures = projection.value.failures;
  if (failures.some((failure) => failure.stack !== undefined)) {
    return {
      value: {
        ...projection.value,
        failures: failures.map(({ stack: _stack, ...failure }) => failure),
      },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "failures.stack",
            count: failures.filter((failure) => failure.stack !== undefined).length,
          },
        ],
      },
    };
  }
  if (failures.some((failure) => failure.suite !== undefined)) {
    return {
      value: {
        ...projection.value,
        failures: failures.map(({ suite: _suite, ...failure }) => failure),
      },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "failures.suite",
            count: failures.filter((failure) => failure.suite !== undefined).length,
          },
        ],
      },
    };
  }
  if (failures.some((failure) => failure.durationMs !== undefined)) {
    return {
      value: {
        ...projection.value,
        failures: failures.map(({ durationMs: _durationMs, ...failure }) => failure),
      },
      completeness: "partial",
      loss: {
        state: "partial",
        discarded: [],
        reductions: [
          {
            kind: "view-reduction",
            path: "failures.durationMs",
            count: failures.filter((failure) => failure.durationMs !== undefined).length,
          },
        ],
      },
    };
  }
  if (projection.value.durationMs !== undefined) {
    const { durationMs: _durationMs, ...value } = projection.value;
    return {
      value,
      completeness: "partial",
      loss: { state: "partial", discarded: [], reductions: [{ kind: "view-reduction", path: "durationMs", count: 1 }] },
    };
  }
  return projection;
}
