import {
  validationFailure,
  validationSuccess,
  type Adapter,
  type ProjectionSource,
  type ValidationResult,
} from "../core.js";
import {
  TEST_RESULT_SCHEMA_VERSION,
  TEST_RESULT_SEMANTIC_TYPE,
  testResultStatus,
  type TestCounts,
  type TestFailure,
  type TestResult,
} from "../test-result.js";
import { type SourceRange } from "../semantic-location.js";
import {
  ProducerInputError,
  compareStrings,
  isRecord,
  nonNegativeNumber,
  positiveInteger,
  sourceText,
  stableString,
  stripAnsi,
  validationIssue,
} from "./input.js";

export const VITEST_ADAPTER_ID = "vitest";
export const VITEST_ADAPTER_VERSION = "1.0.0";

export const vitestAdapter: Adapter<TestResult> = Object.freeze({
  id: VITEST_ADAPTER_ID,
  version: VITEST_ADAPTER_VERSION,
  semanticType: TEST_RESULT_SEMANTIC_TYPE,
  contract: { id: TEST_RESULT_SEMANTIC_TYPE, version: TEST_RESULT_SCHEMA_VERSION },
  validate: validateVitestSource,
  decode: decodeVitest,
});

export const vitestTestResultAdapter = vitestAdapter;

export function validateVitestSource(source: ProjectionSource): ValidationResult {
  try {
    decodeVitest(source);
    return validationSuccess();
  } catch (error) {
    return validationFailure(validationIssue(error, VITEST_ADAPTER_ID));
  }
}

export function decodeVitest(source: ProjectionSource): TestResult {
  const text = sourceText(source, VITEST_ADAPTER_ID);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest JSON output is malformed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return decodeVitestJson(value);
  }
  return decodeVitestText(text);
}

interface ParsedTestCase {
  readonly status: "passed" | "failed" | "skipped";
  readonly file?: string;
  readonly name?: string;
  readonly location?: SourceRange;
  readonly message?: string;
  readonly assertion?: string;
  readonly diagnostic?: string;
  readonly durationMs?: number;
  readonly suite?: readonly string[];
  readonly stack?: string;
  readonly id?: string;
}

function decodeVitestJson(value: unknown): TestResult {
  const root = Array.isArray(value) ? { testResults: value } : value;
  if (!isRecord(root)) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest JSON output must be an object or array");
  }

  const suiteValues = firstArray(root, ["testResults", "testFiles", "files", "results"]);
  const cases: ParsedTestCase[] = [];
  if (suiteValues !== undefined) {
    for (const suite of suiteValues) {
      if (!isRecord(suite)) {
        throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest test result entries must be objects");
      }
      const file = firstString(suite, ["name", "path", "file", "filePath"]);
      const assertionValues = firstArray(suite, ["assertionResults", "testResults", "tests", "assertions"]);
      if (assertionValues !== undefined) {
        for (const assertion of assertionValues) {
          cases.push(parseJsonCase(assertion, file));
        }
      } else if (hasStatus(suite)) {
        cases.push(parseJsonCase(suite, file));
      }
    }
  }

  const hasSummary = hasAny(root, [
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "totalTests",
    "passedTests",
    "failedTests",
    "skippedTests",
  ]);
  if (suiteValues === undefined && !hasSummary) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "JSON is not a recognized Vitest reporter result");
  }

  const summary = readJsonCounts(root);
  return buildTestResult(summary, cases, readDuration(root));
}

function parseJsonCase(value: unknown, suiteFile?: string): ParsedTestCase {
  if (!isRecord(value)) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest assertion entries must be objects");
  }
  const status = parseStatus(value.status ?? value.state ?? value.result);
  if (status === undefined) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest assertion entry has no supported status");
  }
  const file = firstString(value, ["file", "filePath", "path", "testFile"]) ?? suiteFile;
  const ancestors = firstStringArray(value, ["ancestorTitles", "ancestors", "suite"]);
  const title = firstString(value, ["fullName", "name", "title", "testName"]);
  const name = title ?? (ancestors === undefined ? undefined : ancestors.join(" > "));
  const messages = firstStringArray(value, ["failureMessages", "failureMessage", "messages"]);
  const message = messages?.join("\n") ?? firstString(value, ["message", "error", "errorMessage"]);
  const assertion = firstString(value, ["assertion", "assertionMessage"]);
  const diagnostic = firstString(value, ["diagnostic", "diagnostics"]);
  const stack = firstString(value, ["stack", "failureStack"]);
  const durationMs = firstNumber(value, ["duration", "durationMs", "time"]);
  return {
    status,
    ...(file === undefined ? {} : { file }),
    ...(name === undefined ? {} : { name }),
    ...(locationFromJson(value.location ?? value.range, file) === undefined
      ? {}
      : { location: locationFromJson(value.location ?? value.range, file) }),
    ...(message === undefined ? {} : { message }),
    ...(assertion === undefined ? {} : { assertion }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(ancestors === undefined ? {} : { suite: ancestors }),
    ...(stack === undefined ? {} : { stack }),
    ...(firstString(value, ["id", "testId"]) === undefined ? {} : { id: firstString(value, ["id", "testId"]) }),
  };
}

function readJsonCounts(root: Record<string, unknown>): Partial<TestCounts> {
  const passed = firstNumber(root, ["numPassedTests", "passedTests", "passed"]);
  const failed = firstNumber(root, ["numFailedTests", "failedTests", "failed"]);
  const pending = firstNumber(root, ["numPendingTests", "pendingTests", "pending"]);
  const todo = firstNumber(root, ["numTodoTests", "todoTests", "todo"]);
  const skipped = (pending ?? 0) + (todo ?? 0);
  const total = firstNumber(root, ["numTotalTests", "totalTests", "total"]);
  return {
    ...(total === undefined ? {} : { total }),
    ...(passed === undefined ? {} : { passed }),
    ...(failed === undefined ? {} : { failed }),
    ...(pending === undefined && todo === undefined ? {} : { skipped }),
  };
}

function decodeVitestText(text: string): TestResult {
  const lines = stripAnsi(text).split(/\r?\n/);
  const cases: ParsedTestCase[] = [];
  let current: MutableTextFailure | undefined;
  let lastFile: string | undefined;
  let testsSummary: Partial<TestCounts> | undefined;
  let filesSummary: Partial<TestCounts> | undefined;
  let durationMs: number | undefined;
  let recognized = false;

  const flush = (): void => {
    if (current !== undefined) {
      cases.push(finalizeTextFailure(current));
      current = undefined;
    }
  };

  for (const line of lines) {
    const summary = parseSummaryLine(line);
    if (summary !== undefined) {
      recognized = true;
      if (summary.kind === "tests") {
        testsSummary = summary.counts;
      } else {
        filesSummary = summary.counts;
      }
      continue;
    }
    const parsedDuration = parseDurationLine(line);
    if (parsedDuration !== undefined) {
      durationMs = parsedDuration;
      recognized = true;
      continue;
    }
    const file = parseFileRow(line);
    if (file !== undefined) {
      lastFile = file;
      recognized = true;
    }

    const location = parseTextLocation(line);
    if (location !== undefined) {
      recognized = true;
      if (/^\s*at\s+/.test(line)) {
        if (current !== undefined) current.stackParts.push(line.trim());
        continue;
      }
      const target = current ?? { name: location.file, file: location.file, messageParts: [], stackParts: [] };
      current = target;
      target.file = location.file;
      target.location = { start: { line: location.line, column: location.column } };
      continue;
    }

    const heading = parseFailureHeading(line, lastFile);
    if (heading !== undefined) {
      flush();
      current = { ...heading, messageParts: [], stackParts: [] };
      recognized = true;
      continue;
    }
    if (current !== undefined) {
      const trimmed = line.trim();
      if (trimmed.startsWith("→")) {
        current.messageParts.push(trimmed.slice(1).trim());
      } else if (trimmed.startsWith("at ")) {
        current.stackParts.push(trimmed);
      } else if (isTextMessageLine(line)) {
        current.messageParts.push(trimmed);
      }
    }
  }
  flush();

  if (!recognized) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "text is not recognized Vitest reporter output");
  }
  const summary = testsSummary ?? filesSummary ?? {};
  return buildTestResult(summary, cases, durationMs);
}

interface MutableTextFailure {
  file?: string;
  name: string;
  location?: SourceRange;
  messageParts: string[];
  stackParts: string[];
}

function finalizeTextFailure(value: MutableTextFailure): ParsedTestCase {
  const message = value.messageParts.filter((part) => part.length > 0).join("\n");
  return {
    status: "failed",
    ...(value.file === undefined ? {} : { file: value.file }),
    name: value.name,
    ...(value.location === undefined ? {} : { location: value.location }),
    message: message || "Vitest reported a failed test.",
    ...(value.stackParts.length === 0 ? {} : { stack: value.stackParts.join("\n") }),
  };
}

interface MutableCounts {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
}

function parseSummaryLine(line: string): { kind: "tests" | "files"; counts: MutableCounts } | undefined {
  const match = line.match(/^\s*(Test Files|Tests)\b(.*)$/i);
  if (match === null) {
    return undefined;
  }
  const rest = match[2];
  const counts: MutableCounts = {};
  for (const item of rest.matchAll(/(\d+)\s+(passed|failed|skipped|pending|todo)\b/gi)) {
    const count = Number(item[1]);
    const label = item[2].toLowerCase();
    if (label === "passed") counts.passed = count;
    if (label === "failed") counts.failed = count;
    if (label === "skipped" || label === "pending" || label === "todo") counts.skipped = (counts.skipped ?? 0) + count;
  }
  const totalMatch = rest.match(/\((\d+)\)/);
  if (totalMatch !== null) {
    counts.total = Number(totalMatch[1]);
  }
  if (rest.toLowerCase().includes("no tests")) {
    counts.total = 0;
    counts.passed = 0;
    counts.failed = 0;
    counts.skipped = 0;
  }
  return { kind: match[1].toLowerCase() === "tests" ? "tests" : "files", counts };
}

function parseDurationLine(line: string): number | undefined {
  const match = line.match(/^\s*Duration\b\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i);
  return match === null ? undefined : Number(match[1]);
}

function parseFileRow(line: string): string | undefined {
  const match = line.match(/^\s*[✓✔❯!✗×]\s+(.+?)(?:\s+\([^)]*\))?(?:\s+[0-9]+(?:\.[0-9]+)?\s*ms)?\s*$/);
  if (match === null) {
    return undefined;
  }
  const value = match[1].trim();
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value) ? value : undefined;
}

function parseTextLocation(line: string): { file: string; line: number; column: number } | undefined {
  const value = line.trim().replace(/^(?:❯|at)\s+/, "");
  const match = value.match(/^(.+?):(\d+):(\d+)\s*$/);
  if (match === null) {
    return undefined;
  }
  const lineNumber = Number(match[2]);
  const column = Number(match[3]);
  return lineNumber >= 1 && column >= 1 ? { file: match[1], line: lineNumber, column } : undefined;
}

function parseFailureHeading(line: string, lastFile?: string): { name: string; file?: string } | undefined {
  const trimmed = line.trim();
  if (/^❯\s+.*\(\d+\s+tests?\b/i.test(trimmed)) {
    return undefined;
  }
  const match = trimmed.match(/^(?:FAIL\s+|[×✗✖!❯]\s+)(.+)$/i);
  if (match === null) {
    return undefined;
  }
  const value = match[1].trim();
  const parts = value
    .split(/\s+>\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const possibleFile = parts.find((part) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(part));
  const name =
    possibleFile === undefined ? value : parts.filter((part) => part !== possibleFile).join(" > ") || possibleFile;
  return { name, ...((possibleFile ?? lastFile) === undefined ? {} : { file: possibleFile ?? lastFile }) };
}

function isTextMessageLine(line: string): boolean {
  const trimmed = line.trim();
  if (
    trimmed.length === 0 ||
    /^\d+\s*[|│]/.test(trimmed) ||
    /^[|│~^]+$/.test(trimmed) ||
    /^(?:RUN|Test Files|Tests|Start at|Duration)\b/i.test(trimmed) ||
    /^[✓✔❯×✗✖!]\s+/.test(trimmed)
  ) {
    return false;
  }
  return (
    trimmed.startsWith("AssertionError") ||
    trimmed.startsWith("Error") ||
    trimmed.startsWith("Expected") ||
    trimmed.startsWith("Received") ||
    trimmed.startsWith("- ") ||
    trimmed.startsWith("+ ") ||
    trimmed.startsWith("❯") ||
    line.startsWith(" ") ||
    line.startsWith("\t")
  );
}

function buildTestResult(
  summary: Partial<TestCounts>,
  parsedCases: readonly ParsedTestCase[],
  durationMs: number | undefined,
): TestResult {
  const failures = parsedCases.filter((item) => item.status === "failed");
  const derived = {
    passed: parsedCases.filter((item) => item.status === "passed").length,
    failed: failures.length,
    skipped: parsedCases.filter((item) => item.status === "skipped").length,
  };
  const passed = summary.passed ?? derived.passed;
  const failed = summary.failed ?? derived.failed;
  const skipped = summary.skipped ?? derived.skipped;
  const total = summary.total ?? passed + failed + skipped;
  if (![passed, failed, skipped, total].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest counts must be non-negative integers");
  }
  if (total < passed + failed + skipped) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest counts are inconsistent");
  }
  const normalizedSkipped = skipped + (total - passed - failed - skipped);
  const counts: TestCounts = { total, passed, failed, skipped: normalizedSkipped };
  const normalizedFailures = parsedCases
    .filter((item) => item.status === "failed")
    .map((item, index) => normalizeFailure(item, index));
  while (normalizedFailures.length < failed) {
    const index = normalizedFailures.length + 1;
    normalizedFailures.push({
      id: `unknown-failure-${index}`,
      name: `Unknown failed test ${index}`,
      message: "Vitest reported a failed test without failure details.",
    });
  }
  if (normalizedFailures.length > failed) {
    throw new ProducerInputError(VITEST_ADAPTER_ID, "Vitest failure details exceed the reported failed count");
  }
  return {
    version: TEST_RESULT_SCHEMA_VERSION,
    status: testResultStatus(counts),
    counts,
    failures: normalizedFailures,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function normalizeFailure(value: ParsedTestCase, index: number): TestFailure {
  const name = value.name?.trim() || `Unknown failed test ${index + 1}`;
  const baseId = value.id ?? `${value.file ?? "<unknown>"}::${name}`;
  return {
    id: baseId,
    name,
    ...(value.file === undefined ? {} : { file: value.file }),
    ...(value.location === undefined ? {} : { location: value.location }),
    message: value.message?.trim() || "Vitest reported a failed test.",
    ...(value.assertion === undefined ? {} : { assertion: value.assertion }),
    ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.suite === undefined ? {} : { suite: value.suite }),
    ...(value.stack === undefined ? {} : { stack: value.stack }),
  };
}

function parseStatus(value: unknown): ParsedTestCase["status"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const status = value.toLowerCase();
  if (["passed", "pass", "success", "ok"].includes(status)) return "passed";
  if (["failed", "fail", "failure", "error"].includes(status)) return "failed";
  if (["skipped", "skip", "pending", "todo", "disabled"].includes(status)) return "skipped";
  return undefined;
}

function hasStatus(value: Record<string, unknown>): boolean {
  return parseStatus(value.status ?? value.state ?? value.result) !== undefined;
}

function firstArray(root: Record<string, unknown>, fields: readonly string[]): unknown[] | undefined {
  for (const field of fields) {
    if (Array.isArray(root[field])) return root[field];
  }
  return undefined;
}

function firstString(root: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = stableString(root[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstStringArray(root: Record<string, unknown>, fields: readonly string[]): readonly string[] | undefined {
  for (const field of fields) {
    const value = root[field];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
    if (typeof value === "string" && value.length > 0) return [value];
  }
  return undefined;
}

function firstNumber(root: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = nonNegativeNumber(root[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readDuration(root: Record<string, unknown>): number | undefined {
  return firstNumber(root, ["runTime", "runtime", "duration", "durationMs"]);
}

function hasAny(root: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => root[field] !== undefined);
}

function locationFromJson(value: unknown, file?: string): SourceRange | undefined {
  if (!isRecord(value)) return undefined;
  const startValue = isRecord(value.start) ? value.start : value;
  const line = positiveInteger(startValue.line ?? startValue.lineNumber);
  const column = positiveInteger(startValue.column ?? startValue.character);
  if (line === undefined || column === undefined) return undefined;
  const endValue = isRecord(value.end) ? value.end : undefined;
  const endLine = endValue === undefined ? undefined : positiveInteger(endValue.line ?? endValue.lineNumber);
  const endColumn = endValue === undefined ? undefined : positiveInteger(endValue.column ?? endValue.character);
  return {
    start: { line, column },
    ...(endLine === undefined || endColumn === undefined ? {} : { end: { line: endLine, column: endColumn } }),
  };
}
