import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GENERIC_TEXT_SEMANTIC_TYPE,
  TYPESCRIPT_SOURCE_SEMANTIC_TYPE,
  createSourceProjectionCore,
  createTypeScriptSymbolDetailView,
  decodeTypeScriptSource,
  genericTextAdapter,
  genericTextContract,
  genericTextView,
  sourceSemanticAdapters,
  sourceSemanticContracts,
  sourceSemanticViews,
  typescriptSourceAdapter,
  typescriptSourceContract,
  typescriptSymbolIndexView,
  validateTypeScriptSource,
  type TypeScriptSourceSemanticModel,
} from "./source-code.js";
import { SuzukuriError, validationSuccess, type ProjectionSource } from "./core.js";

const fixture: ProjectionSource = {
  identity: "fixtures/example.ts",
  mediaType: "text/typescript",
  content: `
// This comment is representation noise.
export interface User {
  id: string;
}

const localCount: number = 1;

export function greet(user: User): string {
  return user.id;
}
`,
};

test("TypeScript source decoding produces a versioned deterministic symbol model", () => {
  assert.deepEqual(validateTypeScriptSource(fixture), validationSuccess());

  const model = decodeTypeScriptSource(fixture);
  assert.equal(model.model, TYPESCRIPT_SOURCE_SEMANTIC_TYPE);
  assert.equal(model.version, "1.0.0");
  assert.equal(model.fileName, "fixtures/example.ts");

  const user = model.symbols.find((symbol) => symbol.name === "User" && symbol.kind === "interface");
  const localCount = model.symbols.find((symbol) => symbol.name === "localCount");
  const greet = model.symbols.find((symbol) => symbol.name === "greet" && symbol.kind === "function");
  assert.ok(user);
  assert.ok(localCount);
  assert.ok(greet);
  assert.equal(user.exported, true);
  assert.equal(localCount.exported, false);
  assert.equal(greet.exported, true);
  assert.equal(localCount.type, "number");
  assert.equal(greet.type, "string");
  assert.match(greet.signature ?? "", /^greet\(user: User\): string$/);
  assert.ok(greet.range.end > greet.range.start);

  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes("This comment is representation noise"), false);
  assert.equal(serialized.includes("sourceText"), false);
});

test("comments and formatting do not become semantic fields", () => {
  const compact = decodeTypeScriptSource({
    identity: "fixture.ts",
    content: "export function greet(user: User): string { return user.id; }",
  });
  const formatted = decodeTypeScriptSource({
    identity: "fixture.ts",
    content: "\n/* unrelated */\nexport function greet( user : User ) : string {\n  return user.id;\n}\n",
  });

  const semanticFields = (model: TypeScriptSourceSemanticModel) =>
    model.symbols.map(({ id: _id, range: _range, parentId: _parentId, ...symbol }) => symbol);
  assert.deepEqual(semanticFields(compact), semanticFields(formatted));
});

test("syntax failures are explicit and do not select generic-text", () => {
  const invalid: ProjectionSource = { identity: "broken.ts", content: "export function broken( {" };
  const result = validateTypeScriptSource(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "TYPESCRIPT_PARSE_ERROR"));

  const core = createSourceProjectionCore();
  assert.throws(
    () =>
      core.project({
        source: invalid,
        adapter: typescriptSourceAdapter,
        view: genericTextView,
        budget: 10_000,
        renderer: "json",
      }),
    (error: unknown) => error instanceof SuzukuriError && error.code === "SEMANTIC_TYPE_MISMATCH",
  );
});

test("symbol index and selected symbol views use the shared budget/rendering core", () => {
  const core = createSourceProjectionCore();
  const indexResult = core.project({
    source: fixture,
    adapter: "typescript-source",
    view: "typescript-symbol-index",
    budget: 100_000,
    renderer: "json",
  });
  const index = JSON.parse(String(indexResult.output)) as TypeScriptSourceSemanticModel;
  assert.equal(index.model, TYPESCRIPT_SOURCE_SEMANTIC_TYPE);
  assert.ok(index.symbols.some((symbol) => symbol.name === "greet"));
  assert.equal(indexResult.completeness, "complete");
  assert.equal(indexResult.outputSize, indexResult.byteLength);

  const detailView = createTypeScriptSymbolDetailView({ name: "greet", kind: "function" });
  const detailResult = core.project({
    source: fixture,
    adapter: "typescript-source",
    view: detailView,
    budget: 100_000,
    renderer: "json",
  });
  const detail = JSON.parse(String(detailResult.output)) as { symbol: { name: string; signature?: string } };
  assert.equal(detail.symbol.name, "greet");
  assert.equal(detail.symbol.signature, "greet(user: User): string");
});

test("generic-text is explicit and advertises a weaker semantic contract", () => {
  assert.equal(genericTextAdapter.semanticType, GENERIC_TEXT_SEMANTIC_TYPE);
  assert.equal(genericTextAdapter.lossContract.strength, "weak");
  assert.equal(genericTextContract.lossContract.strength, "weak");

  const core = createSourceProjectionCore();
  const result = core.project({
    source: { content: "\uFEFFone\r\ntwo\rthree" },
    adapter: "generic-text",
    view: "generic-text-view",
    budget: 100_000,
    renderer: "json",
  });
  assert.deepEqual(JSON.parse(String(result.output)), {
    model: "generic-text",
    text: "one\ntwo\nthree",
    version: "1.0.0",
  });
});

test("source component registries expose stable builtin identities", () => {
  assert.deepEqual(
    sourceSemanticAdapters.map(({ id, version }) => `${id}@${version}`),
    ["generic-text@1.0.0", "typescript-source@1.0.0"],
  );
  assert.deepEqual(
    sourceSemanticContracts.map(({ id, version }) => `${id}@${version}`),
    ["generic-text-contract@1.0.0", "typescript-source-contract@1.0.0"],
  );
  assert.deepEqual(
    sourceSemanticViews.map(({ id, version }) => `${id}@${version}`),
    ["generic-text-view@1.0.0", "typescript-symbol-index@1.0.0"],
  );
  assert.equal(typescriptSourceContract.semanticType, TYPESCRIPT_SOURCE_SEMANTIC_TYPE);
  assert.equal(typescriptSymbolIndexView.semanticType, TYPESCRIPT_SOURCE_SEMANTIC_TYPE);
});
