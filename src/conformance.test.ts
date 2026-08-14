import assert from "node:assert/strict";
import test from "node:test";
import { runConformance } from "./conformance.js";
import { createProfileCore, profileTextAdapter, profileTextView } from "./profile-builtins.js";

test("v0 conformance covers every builtin family and all five profiles", () => {
  const report = runConformance();

  assert.equal(report.schemaVersion, 1);
  assert.ok(report.caseCount >= 17);
  assert.equal(report.profileCount, 5);
  assert.equal(report.fallbackRate, 0);
  assert.ok(report.cases.every((metric) => metric.fullBytes >= metric.reducedBytes));
  assert.ok(report.cases.every((metric) => metric.requiredMeaning.length > 0));
  assert.ok(report.simpleTruncation.comparedCases > 0);
});

test("hard budgets and insufficient budgets are explicit package contracts", () => {
  const core = createProfileCore();
  const request = {
    source: { identity: "conformance:budget", content: "a deliberately bounded observation" },
    adapter: profileTextAdapter,
    view: profileTextView,
    budget: { unit: "utf8-bytes" as const, maxBytes: 1_000 },
    renderer: "json",
  };
  const fitted = core.project(request);
  assert.ok(fitted.byteLength <= 1_000);

  assert.throws(
    () => core.project({ ...request, budget: { unit: "utf8-bytes", maxBytes: 1 } }),
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "BUDGET_TOO_SMALL",
  );
});

test("an external caller receives stable Suzukuri provenance without caller state", () => {
  const core = createProfileCore();
  const callerOwnedSource = {
    identity: "external-caller:observation-1",
    content: "caller-owned source",
    mediaType: "text/plain",
  };
  const result = core.project({
    source: callerOwnedSource,
    adapter: "profile-text",
    view: "profile-text",
    budget: 1_024,
    renderer: "json",
  });

  assert.equal(result.provenance.source?.identity, callerOwnedSource.identity);
  assert.deepEqual(result.components, {
    adapter: { id: "profile-text", version: "1.0.0" },
    semanticContract: { id: "profile-text", version: "1.0.0" },
    view: { id: "profile-text", version: "1.0.0" },
    renderer: { id: "json", version: "1.0.0" },
  });
  assert.equal("task" in result, false);
  assert.equal("policy" in result, false);
});
