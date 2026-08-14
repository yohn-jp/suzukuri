import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProducerInputError,
  createBuiltinProjectionCore,
  decodeTypeScriptDiagnostics,
  decodeVitest,
  stableJsonStringify,
  testResultFailuresView,
  testResultSummaryView,
  typescriptDiagnosticsAdapter,
  vitestAdapter,
  type SuzukuriError,
} from "./index.js";
import {
  representativeTypeScriptDiagnostics,
  representativeTypeScriptDiagnosticsJson,
  representativeVitestJson,
  representativeVitestOutput,
} from "./fixtures/builtin-adapters.js";

test("Vitest text output becomes a versioned test-result with identity, locations, messages and stack evidence", () => {
  const result = decodeVitest({ content: representativeVitestOutput });
  assert.equal(result.version, "1.0.0");
  assert.equal(result.status, "failed");
  assert.deepEqual(result.counts, { total: 3, passed: 1, failed: 2, skipped: 0 });
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0].file, "src/math.test.ts");
  assert.deepEqual(result.failures[0].location, { start: { line: 4, column: 5 } });
  assert.match(result.failures[0].message, /Expected: 3\nReceived: 4/);
  assert.match(result.failures[0].stack ?? "", /node_modules/);
  assert.equal(result.failures[1].name, "math > 日本語の比較");
  assert.match(result.failures[1].message, /複数行/);
  assert.equal(result.failures[1].location, undefined);
});

test("Vitest JSON reporter output is decoded without text fallback", () => {
  const result = decodeVitest({ content: representativeVitestJson });
  assert.deepEqual(result.counts, { total: 3, passed: 1, failed: 1, skipped: 1 });
  assert.equal(result.failures[0].name, "math > adds numbers");
  assert.deepEqual(result.failures[0].location, { start: { line: 4, column: 5 } });
});

test("TypeScript compiler output preserves severity, code, location, multiline text and related information", () => {
  const result = decodeTypeScriptDiagnostics({ content: representativeTypeScriptDiagnostics });
  assert.equal(result.version, "1.0.0");
  assert.deepEqual(result.counts, { total: 3, errors: 2, warnings: 1, suggestions: 0, messages: 0 });
  const error = result.diagnostics.find((diagnostic) => diagnostic.code === "TS2322");
  assert.ok(error);
  assert.equal(error.severity, "error");
  assert.equal(error.file, "src/math.ts");
  assert.deepEqual(error.range, { start: { line: 3, column: 7 } });
  assert.match(error.message, /expected type/);
  assert.equal(error.related?.[0].file, "src/types.ts");
  assert.equal(error.related?.[0].message, "The declaration is here.");
  assert.equal(result.diagnostics.find((diagnostic) => diagnostic.code === "TS2688")?.file, undefined);
});

test("TypeScript JSON diagnostics use deterministic one-based positions", () => {
  const result = decodeTypeScriptDiagnostics({ content: representativeTypeScriptDiagnosticsJson });
  assert.equal(result.diagnostics[0].code, "TS2322");
  assert.deepEqual(result.diagnostics[0].range, { start: { line: 3, column: 7 } });
  assert.deepEqual(result.diagnostics[0].related?.[0].range, { start: { line: 1, column: 1 } });
});

test("invalid producer input fails explicitly and never silently falls back", () => {
  assert.throws(
    () => decodeVitest({ content: "not a Vitest report" }),
    (error: unknown) => error instanceof ProducerInputError && error.code === "INVALID_PRODUCER_INPUT",
  );
  const validation = vitestAdapter.validate({ content: "not a Vitest report" });
  assert.equal(typeof validation === "boolean" ? validation : validation.valid, false);
  assert.throws(
    () => decodeTypeScriptDiagnostics({ content: "not compiler output" }),
    (error: unknown) => error instanceof ProducerInputError && error.code === "INVALID_PRODUCER_INPUT",
  );
  const core = createBuiltinProjectionCore();
  assert.throws(
    () =>
      core.project({
        source: "not a Vitest report",
        adapter: "vitest",
        view: "test-result-summary",
        budget: 10_000,
        renderer: "json",
      }),
    (error: unknown) => (error as SuzukuriError).code === "ADAPTER_VALIDATION_FAILED",
  );
});

test("builtin views use one core renderer authority and remain deterministic", () => {
  const core = createBuiltinProjectionCore();
  const summaryRequest = {
    source: { content: representativeVitestOutput, identity: "vitest-fixture" },
    adapter: vitestAdapter,
    view: testResultSummaryView,
    budget: 20_000,
    renderer: "json",
  } as const;
  const first = core.project(summaryRequest);
  const second = core.project(summaryRequest);
  assert.equal(first.output, second.output);
  assert.equal(first.projectionDigest, second.projectionDigest);
  assert.ok(first.byteLength <= 20_000);
  assert.equal(first.loss.state, "none");
  const parsed = JSON.parse(String(first.output)) as { counts: { failed: number }; failures: unknown[] };
  assert.equal(parsed.counts.failed, 2);
  assert.equal(parsed.failures.length, 2);
  assert.deepEqual(testResultSummaryView.meaning?.priorities?.length, 2);
  assert.ok(testResultFailuresView.meaning?.reductions?.length);
});

test("diagnostics errors and files views order entries and group project diagnostics deterministically", () => {
  const core = createBuiltinProjectionCore();
  const errors = core.project({
    source: representativeTypeScriptDiagnostics,
    adapter: typescriptDiagnosticsAdapter,
    view: "diagnostics-errors",
    budget: 20_000,
    renderer: "json",
  });
  const files = core.project({
    source: representativeTypeScriptDiagnostics,
    adapter: "typescript-diagnostics",
    view: "diagnostics-files",
    budget: 20_000,
    renderer: "json",
  });
  const errorsValue = JSON.parse(String(errors.output)) as { errors: Array<{ code: string; severity: string }> };
  assert.deepEqual(
    errorsValue.errors.map((item) => item.code),
    ["TS2688", "TS2322"],
  );
  assert.ok(errorsValue.errors.every((item) => item.severity === "error"));
  const filesValue = JSON.parse(String(files.output)) as { files: Array<{ file: string }> };
  assert.deepEqual(
    filesValue.files.map((file) => file.file),
    ["<project>", "src/math.ts"],
  );
});

test("view-owned optional detail reduction is declared and reports loss", () => {
  const core = createBuiltinProjectionCore();
  const complete = core.project({
    source: representativeVitestJson,
    adapter: "vitest",
    view: "test-result-failures",
    budget: 20_000,
    renderer: "json",
  });
  const completeBytes = complete.byteLength;
  const reduced = core.project({
    source: representativeVitestJson,
    adapter: "vitest",
    view: "test-result-failures",
    budget: completeBytes - 1,
    renderer: "json",
  });
  assert.ok(reduced.byteLength <= completeBytes - 1);
  assert.equal(reduced.completeness, "partial");
  assert.ok(reduced.loss.reductions?.some((reduction) => reduction.path === "failures.stack"));
  assert.ok(stableJsonStringify(reduced.loss).includes("failures.stack"));
});
