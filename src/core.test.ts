import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdapterRegistry,
  ProjectionCore,
  RendererRegistry,
  SemanticContractRegistry,
  SuzukuriError,
  ViewRegistry,
  createBudget,
  validationFailure,
  validationSuccess,
  type Adapter,
  type ProjectionRequest,
  type Renderer,
  type SemanticContract,
  type View,
} from "./core.js";

const adapter: Adapter<string> = {
  id: "text",
  version: "1.0.0",
  semanticType: "text",
  validate: () => validationSuccess(),
  decode: (source) => (typeof source.content === "string" ? source.content : new TextDecoder().decode(source.content)),
};

const contract: SemanticContract<string> = {
  id: "text-contract",
  version: "1.0.0",
  semanticType: "text",
  validate: (value) =>
    typeof value === "string"
      ? validationSuccess()
      : validationFailure({
          code: "type",
          message: "expected text",
        }),
  normalize: (value) => String(value).trim(),
};

const view: View<{ text: string }> = {
  id: "text-view",
  version: "1.0.0",
  semanticType: "text",
  meaning: {
    required: ["text"],
    preserved: ["text"],
    discarded: [],
  },
  project: ({ semantic }) => ({ value: { text: String(semantic) } }),
};

const renderer: Renderer = {
  id: "json",
  version: "1.0.0",
  format: "application/json",
  render: (projection) => JSON.stringify(projection),
};

function makeCore(): ProjectionCore {
  return new ProjectionCore({
    adapters: [adapter],
    semanticContracts: [contract],
    views: [view],
    renderers: [renderer],
  });
}

function assertErrorCode(action: () => unknown, code: SuzukuriError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof SuzukuriError && error.code === code);
}

test("registries reject duplicate identities and list deterministically", () => {
  const registry = new AdapterRegistry();
  registry.register({ ...adapter, id: "zeta", version: "2.0.0" });
  registry.register({ ...adapter, id: "alpha", version: "2.0.0" });
  registry.register({ ...adapter, id: "alpha", version: "1.0.0" });

  assert.deepEqual(registry.identities(), [
    { id: "alpha", version: "1.0.0" },
    { id: "alpha", version: "2.0.0" },
    { id: "zeta", version: "2.0.0" },
  ]);
  assertErrorCode(() => registry.register({ ...adapter, id: "alpha", version: "1.0.0" }), "DUPLICATE_IDENTITY");
});

test("projection requires explicit adapter and view selection", () => {
  const core = makeCore();
  const request = {
    source: "hello",
    view: "text-view",
    budget: createBudget(100),
    renderer: "json",
  } as ProjectionRequest;

  assertErrorCode(() => core.project(request), "INVALID_REQUEST");
  assertErrorCode(() => core.project({ ...request, adapter: "missing" }), "COMPONENT_NOT_FOUND");
});

test("pipeline order is adapter validation, decode, contract validation, then view", () => {
  const calls: string[] = [];
  const orderedAdapter: Adapter<string> = {
    ...adapter,
    validate: () => {
      calls.push("adapter.validate");
      return validationSuccess();
    },
    decode: (source) => {
      calls.push("adapter.decode");
      return String(source.content);
    },
  };
  const orderedContract: SemanticContract<string> = {
    ...contract,
    validate: () => {
      calls.push("contract.validate");
      return validationSuccess();
    },
    normalize: (value) => {
      calls.push("contract.normalize");
      return String(value);
    },
  };
  const orderedView: View<string> = {
    ...view,
    project: ({ semantic }) => {
      calls.push("view.project");
      return String(semantic);
    },
  };
  const orderedRenderer: Renderer = {
    ...renderer,
    render: (projection) => {
      calls.push("renderer.render");
      return String(projection);
    },
  };
  const core = new ProjectionCore({
    adapters: [orderedAdapter],
    semanticContracts: [orderedContract],
    views: [orderedView],
    renderers: [orderedRenderer],
  });

  core.project({
    source: "hello",
    adapter: "text",
    view: "text-view",
    budget: 100,
    renderer: "json",
  });

  assert.deepEqual(calls, [
    "adapter.validate",
    "adapter.decode",
    "contract.validate",
    "contract.normalize",
    "view.project",
    "renderer.render",
  ]);
});

test("validation and decode failures use stable error codes", () => {
  let decoded = false;
  const rejectingAdapter: Adapter<string> = {
    ...adapter,
    validate: () => validationFailure({ code: "format", message: "unsupported" }),
    decode: () => {
      decoded = true;
      return "never";
    },
  };
  const validationCore = new ProjectionCore({
    adapters: [rejectingAdapter],
    semanticContracts: [contract],
    views: [view],
    renderers: [renderer],
  });
  assertErrorCode(
    () => validationCore.project({ source: "bad", adapter: "text", view: "text-view", budget: 100, renderer: "json" }),
    "ADAPTER_VALIDATION_FAILED",
  );
  assert.equal(decoded, false);

  const decodeCore = new ProjectionCore({
    adapters: [
      {
        ...adapter,
        decode: () => {
          throw new Error("bad bytes");
        },
      },
    ],
    semanticContracts: [contract],
    views: [view],
    renderers: [renderer],
  });
  assertErrorCode(
    () => decodeCore.project({ source: "bad", adapter: "text", view: "text-view", budget: 100, renderer: "json" }),
    "DECODE_FAILED",
  );
});

test("result carries provenance, source metadata, bounded output, and stable digest", () => {
  const core = makeCore();
  const request = {
    source: { content: " hello ", identity: "fixture-1", hash: "sha256:abc", mediaType: "text/plain" },
    adapter: "text",
    view: "text-view",
    budget: createBudget(100),
    renderer: "json",
  } satisfies ProjectionRequest;

  const first = core.project(request);
  const second = core.project(request);

  assert.equal(first.output, '{"text":"hello"}');
  assert.equal(first.outputSize, new TextEncoder().encode(String(first.output)).byteLength);
  assert.deepEqual(first.source, {
    identity: "fixture-1",
    hash: "sha256:abc",
    mediaType: "text/plain",
  });
  assert.equal(first.provenance.adapter.id, "text");
  assert.equal(first.provenance.semanticContract.version, "1.0.0");
  assert.equal(first.projectionDigest, second.projectionDigest);
  assert.equal(first.loss.state, "none");
});

test("a rendered projection over the hard budget fails explicitly", () => {
  assertErrorCode(
    () => makeCore().project({ source: "hello", adapter: "text", view: "text-view", budget: 1, renderer: "json" }),
    "BUDGET_EXCEEDED",
  );
});

test("registry introspection is available for every component class", () => {
  assert.equal(new SemanticContractRegistry().componentType, "semantic-contract");
  assert.equal(new ViewRegistry().componentType, "view");
  assert.equal(new RendererRegistry().componentType, "renderer");
});
