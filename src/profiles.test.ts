import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createProfileCore } from "./profile-builtins.js";
import {
  ProfileError,
  inspectComponents,
  loadProfileDocument,
  parseProfileDocument,
  resolveProfile,
  runProfile,
  validateProfileDocument,
  validateProfileFile,
} from "./profiles.js";

const fixturePath = fileURLToPath(new URL("../.suzukuri/profiles.json", import.meta.url));

test("the repository profile fixture is valid and has five deterministic names", () => {
  const result = validateProfileFile(fixturePath);
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(
    result.document?.profiles.map((profile) => profile.name),
    ["json-keys", "json-value", "text-lines", "text-summary", "text-value"],
  );
});

test("profile normalization sorts entries and rejects duplicate names", () => {
  const document = parseProfileDocument({
    schemaVersion: 1,
    profiles: [
      {
        name: "zeta",
        description: "Z",
        source: { description: "text" },
        adapter: "profile-text",
        view: "profile-text",
        budget: { maxBytes: 10, unit: "utf8-bytes" },
        renderer: "json",
      },
      {
        name: "alpha",
        description: "A",
        source: { description: "text" },
        adapter: "profile-text",
        view: "profile-text",
        budget: { maxBytes: 10, unit: "utf8-bytes" },
        renderer: "json",
      },
    ],
  });
  assert.deepEqual(
    document.profiles.map((profile) => profile.name),
    ["alpha", "zeta"],
  );

  const invalid = validateProfileDocument({
    schemaVersion: 1,
    profiles: [
      {
        name: "same",
        description: "one",
        source: { description: "text" },
        adapter: "profile-text",
        view: "profile-text",
        budget: { maxBytes: 10 },
        renderer: "json",
      },
      {
        name: "same",
        description: "two",
        source: { description: "text" },
        adapter: "profile-text",
        view: "profile-text",
        budget: { maxBytes: 10 },
        renderer: "json",
      },
    ],
  });
  assert.equal(invalid.valid, false);
  assert.equal(
    invalid.issues.some((item) => item.code === "PROFILE_NAME_DUPLICATE"),
    true,
  );
});

test("profile resolution is exact and profile execution uses the shared core", () => {
  const document = loadProfileDocument(fixturePath);
  const profile = resolveProfile(document, "json-keys");
  const core = createProfileCore();
  const result = runProfile(profile, '{"z": 1, "a": 2}', { core });
  const resultAgain = runProfile(profile, '{"z": 1, "a": 2}', { core });

  assert.equal(result.output, '{"count":2,"keys":["a","z"]}');
  assert.equal(result.output, resultAgain.output);
  assert.equal(result.projectionDigest, resultAgain.projectionDigest);
  assert.deepEqual(result.components.adapter, { id: "profile-json", version: "1.0.0" });
  assert.throws(
    () => resolveProfile(document, "missing"),
    (error: unknown) => error instanceof ProfileError && error.code === "PROFILE_NOT_FOUND",
  );
});

test("inspection is stable and exposes the profile runtime registries", () => {
  const core = createProfileCore();
  const adapters = inspectComponents(core, "adapters");
  const views = inspectComponents(core, "views");

  assert.deepEqual(
    adapters.components.map((component) => component.id),
    ["profile-json", "profile-text"],
  );
  assert.deepEqual(
    views.components.map((component) => component.id),
    ["profile-json-keys", "profile-json-value", "profile-lines", "profile-text", "profile-text-summary"],
  );
});

test("invalid profile configuration reports deterministic issues", () => {
  const result = validateProfileDocument({ schemaVersion: 2, profiles: [] });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map((item) => item.code),
    ["PROFILE_SCHEMA_UNSUPPORTED"],
  );
});
