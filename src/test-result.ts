import { validationFailure, validationSuccess, type SemanticContract, type ValidationResult } from "./core.js";
import {
  compareSourceRanges,
  isRecord,
  isSourcePosition,
  isSourceRange,
  type SourceRange,
} from "./semantic-location.js";

export const TEST_RESULT_SEMANTIC_TYPE = "test-result";
export const TEST_RESULT_SCHEMA_VERSION = "1.0.0";

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface TestFailure {
  /** Stable identity derived from the producer identity and test name. */
  readonly id: string;
  /** Human-readable test identity, including ancestor titles when available. */
  readonly name: string;
  readonly file?: string;
  readonly location?: SourceRange;
  readonly message: string;
  readonly assertion?: string;
  readonly diagnostic?: string;
  readonly durationMs?: number;
  readonly suite?: readonly string[];
  readonly stack?: string;
}

export interface TestResult {
  readonly version: typeof TEST_RESULT_SCHEMA_VERSION;
  readonly status: TestStatus;
  readonly counts: TestCounts;
  readonly failures: readonly TestFailure[];
  readonly durationMs?: number;
}

export const testResultContract: SemanticContract<TestResult> = Object.freeze({
  id: TEST_RESULT_SEMANTIC_TYPE,
  version: TEST_RESULT_SCHEMA_VERSION,
  semanticType: TEST_RESULT_SEMANTIC_TYPE,
  validate: validateTestResult,
  normalize: normalizeTestResult,
});

export const vitestTestResultContract = testResultContract;

export function validateTestResult(value: unknown): ValidationResult {
  const issues: Array<{ code: string; message: string; path?: string }> = [];
  if (!isRecord(value)) {
    return validationFailure({ code: "type", message: "test-result must be an object" });
  }
  if (value.version !== TEST_RESULT_SCHEMA_VERSION) {
    issues.push({ code: "version", message: `version must be ${TEST_RESULT_SCHEMA_VERSION}`, path: "version" });
  }
  if (value.status !== "passed" && value.status !== "failed" && value.status !== "skipped") {
    issues.push({ code: "status", message: "status must be passed, failed, or skipped", path: "status" });
  }
  if (!isValidCounts(value.counts)) {
    issues.push({ code: "counts", message: "counts must contain non-negative integer totals", path: "counts" });
  }
  if (!Array.isArray(value.failures)) {
    issues.push({ code: "failures", message: "failures must be an array", path: "failures" });
  } else {
    value.failures.forEach((failure, index) => {
      const failureIssues = validateFailure(failure);
      for (const issue of failureIssues) {
        issues.push({ ...issue, path: `failures[${index}]${issue.path === undefined ? "" : `.${issue.path}`}` });
      }
    });
  }
  if (value.durationMs !== undefined && !isDuration(value.durationMs)) {
    issues.push({ code: "duration", message: "durationMs must be a non-negative finite number", path: "durationMs" });
  }
  if (isValidCounts(value.counts) && Array.isArray(value.failures) && value.failures.length > value.counts.failed) {
    issues.push({ code: "failure-count", message: "failures cannot exceed the failed count", path: "failures" });
  }
  return issues.length === 0 ? validationSuccess() : validationFailure(issues);
}

export function normalizeTestResult(value: unknown): TestResult {
  const validation = validateTestResult(value);
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => `${issue.path ?? "value"}: ${issue.message}`).join("; "));
  }
  const input = value as TestResult;
  const failures = input.failures.map((failure) => ({
    ...failure,
    ...(failure.location === undefined ? {} : { location: normalizeLocation(failure.location) }),
    ...(failure.suite === undefined ? {} : { suite: [...failure.suite] }),
  }));
  failures.sort(compareFailures);
  return {
    version: TEST_RESULT_SCHEMA_VERSION,
    status: input.status,
    counts: { ...input.counts },
    failures,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}

function validateFailure(value: unknown): readonly { code: string; message: string; path?: string }[] {
  if (!isRecord(value)) {
    return [{ code: "type", message: "failure must be an object" }];
  }
  const issues: Array<{ code: string; message: string; path?: string }> = [];
  for (const field of ["id", "name", "message"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      issues.push({ code: field, message: `${field} must be a non-empty string`, path: field });
    }
  }
  if (value.file !== undefined && (typeof value.file !== "string" || value.file.length === 0)) {
    issues.push({ code: "file", message: "file must be a non-empty string", path: "file" });
  }
  if (value.location !== undefined && !isSourceRange(value.location)) {
    issues.push({ code: "location", message: "location must contain one-based start/end positions", path: "location" });
  }
  for (const field of ["assertion", "diagnostic", "stack"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      issues.push({ code: field, message: `${field} must be a string`, path: field });
    }
  }
  if (value.durationMs !== undefined && !isDuration(value.durationMs)) {
    issues.push({ code: "duration", message: "durationMs must be a non-negative finite number", path: "durationMs" });
  }
  if (
    value.suite !== undefined &&
    (!Array.isArray(value.suite) || value.suite.some((item) => typeof item !== "string" || item.length === 0))
  ) {
    issues.push({ code: "suite", message: "suite must be an array of non-empty strings", path: "suite" });
  }
  return issues;
}

function isValidCounts(value: unknown): value is TestCounts {
  return (
    isRecord(value) &&
    ["total", "passed", "failed", "skipped"].every(
      (field) => Number.isSafeInteger(value[field]) && (value[field] as number) >= 0,
    ) &&
    (value.total as number) === (value.passed as number) + (value.failed as number) + (value.skipped as number)
  );
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeLocation(location: SourceRange): SourceRange {
  return {
    start: { ...location.start },
    ...(location.end === undefined ? {} : { end: { ...location.end } }),
  };
}

function compareFailures(left: TestFailure, right: TestFailure): number {
  return (
    compareStrings(left.file ?? "", right.file ?? "") ||
    compareSourceRanges(left.location, right.location) ||
    compareStrings(left.name, right.name) ||
    compareStrings(left.id, right.id)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isTestResult(value: unknown): value is TestResult {
  return validateTestResult(value).valid;
}

export function testResultStatus(counts: TestCounts): TestStatus {
  if (counts.failed > 0) {
    return "failed";
  }
  if (counts.total > 0 && counts.passed === 0) {
    return "skipped";
  }
  return "passed";
}

export function isTestLocation(value: unknown): value is SourceRange {
  return isRecord(value) && isSourcePosition(value.start) && (value.end === undefined || isSourcePosition(value.end));
}
