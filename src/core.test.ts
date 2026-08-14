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
  stableJsonStringify,
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
    "BUDGET_TOO_SMALL",
  );
});

test("registry introspection is available for every component class", () => {
  assert.equal(new SemanticContractRegistry().componentType, "semantic-contract");
  assert.equal(new ViewRegistry().componentType, "view");
  assert.equal(new RendererRegistry().componentType, "renderer");
});

test("standard renderers are deterministic and budget reduction follows semantic priority", () => {
  const budgetView: View<{ required: string; high: string; low: string; items: string[] }> = {
    id: "budget-view",
    version: "1.0.0",
    semanticType: "text",
    meaning: {
      required: ["required"],
      preserved: ["high", "items", "low"],
      priorities: [
        { path: "high", priority: 0 },
        { path: "items", priority: 1 },
        { path: "low", priority: 2 },
      ],
      discarded: [],
    },
    project: () => ({
      required: "必須",
      high: "重要",
      low: "任意",
      items: ["a", "b"],
    }),
  };
  const core = new ProjectionCore({
    adapters: [adapter],
    semanticContracts: [contract],
    views: [budgetView],
  });
  const retained = stableJsonStringify({ items: ["a", "b"], high: "重要", required: "必須" });
  const requestJson = {
    source: "fixture",
    adapter: "text",
    view: "budget-view",
    budget: new TextEncoder().encode(retained).byteLength,
    renderer: "json",
  } as const;
  const result = core.project(requestJson);
  const result2 = core.project(requestJson);

  assert.equal(result.output, retained);
  assert.equal(result.completeness, "partial");
  assert.equal(result.loss.state, "partial");
  assert.deepEqual(result.loss.reductions, [{ kind: "semantic-priority", path: "low", count: 1 }]);
  assert.equal(new TextEncoder().encode(String(result.output)).byteLength, result.byteLength);

  assert.equal(result2.output, result.output);
  assert.equal(result2.projectionDigest, result.projectionDigest);
  assert.deepEqual(result2.loss, result.loss);

  const tooSmallRequest = { ...requestJson, budget: 1 };
  assert.throws(
    () => core.project(tooSmallRequest),
    (err: unknown) => {
      const err1 = err as SuzukuriError;
      assert.throws(
        () => core.project(tooSmallRequest),
        (err2: unknown) => {
          const err2Typed = err2 as SuzukuriError;
          assert.equal(err1.code, "BUDGET_TOO_SMALL");
          assert.equal(err2Typed.code, err1.code);
          assert.deepEqual(err2Typed.details, err1.details);
          return true;
        },
      );
      return true;
    },
  );

  const textRequest = { ...requestJson, renderer: "text" };
  const textResult1 = core.project(textRequest);
  const textResult2 = core.project(textRequest);
  assert.equal(textResult1.output, textResult2.output);
  assert.equal(textResult1.projectionDigest, textResult2.projectionDigest);
  assert.deepEqual(textResult1.loss, textResult2.loss);
});

test("semantic priority processes higher priority paths first regardless of declaration order", () => {
  const priorityView: View<{ low: string; high: string; required: string }> = {
    id: "priority-view",
    version: "1.0.0",
    semanticType: "text",
    meaning: {
      required: ["required"],
      preserved: ["low", "high"],
      priorities: [
        { path: "low", priority: 10 },
        { path: "high", priority: 1 },
      ],
      discarded: [],
    },
    project: () => ({ required: "R", low: "L", high: "H" }),
  };
  const core = new ProjectionCore({ adapters: [adapter], semanticContracts: [contract], views: [priorityView] });
  const retained = stableJsonStringify({ high: "H", required: "R" });
  const result = core.project({
    source: "fixture",
    adapter: "text",
    view: "priority-view",
    budget: new TextEncoder().encode(retained).byteLength,
    renderer: "json",
  });

  assert.equal(result.output, retained);
  assert.deepEqual(result.loss.reductions, [{ kind: "semantic-priority", path: "low", count: 1 }]);
});

test("collection reduction retains stable item order and reports omission counts", () => {
  const collectionView: View<{ title: string; entries: string[] }> = {
    id: "collection-view",
    version: "1.0.0",
    semanticType: "text",
    meaning: {
      required: ["title"],
      preserved: ["entries"],
      priorities: [{ path: "entries", priority: 1 }],
      discarded: [],
    },
    project: () => ({ title: "T", entries: ["一", "二", "三"] }),
  };
  const core = new ProjectionCore({ adapters: [adapter], semanticContracts: [contract], views: [collectionView] });
  const retained = stableJsonStringify({ entries: ["一"], title: "T" });
  const result = core.project({
    source: "fixture",
    adapter: "text",
    view: "collection-view",
    budget: new TextEncoder().encode(retained).byteLength,
    renderer: "json",
  });

  assert.equal(result.output, retained);
  assert.deepEqual(result.loss.reductions, [{ kind: "collection-item-omission", path: "entries", count: 2 }]);
});

test("required-only overflow is deterministic and reports requested and minimum budgets", () => {
  const core = makeCore();
  assert.throws(
    () => core.project({ source: "日本語", adapter: "text", view: "text-view", budget: 1, renderer: "json" }),
    (error: unknown) => {
      assert.ok(error instanceof SuzukuriError);
      assert.equal(error.code, "BUDGET_TOO_SMALL");
      assert.equal(error.details.requestedBudget, 1);
      assert.equal(typeof error.details.requiredMinimum, "number");
      assert.ok((error.details.requiredMinimum as number) > 1);
      return true;
    },
  );
});

test("representation reduction is opt-in and can make required UTF-8 output fit", () => {
  const ansiView: View<{ message: string }> = {
    id: "ansi-view",
    version: "1.0.0",
    semanticType: "text",
    meaning: {
      required: ["message"],
      preserved: ["message"],
      reductions: [{ kind: "ansi-removal", path: "message" }],
      discarded: [],
    },
    project: () => ({ message: "\u001b[31m日本語\u001b[0m" }),
  };
  const core = new ProjectionCore({ adapters: [adapter], semanticContracts: [contract], views: [ansiView] });
  const retained = stableJsonStringify({ message: "日本語" });
  const result = core.project({
    source: "fixture",
    adapter: "text",
    view: "ansi-view",
    budget: new TextEncoder().encode(retained).byteLength,
    renderer: "json",
  });

  assert.equal(result.output, retained);
  assert.deepEqual(result.loss.reductions, [{ kind: "ansi-removal", path: "message" }]);

  const ansiViewNoReduction: View<{ message: string }> = {
    id: "ansi-view-no-reduction",
    version: "1.0.0",
    semanticType: "text",
    meaning: {
      required: ["message"],
      preserved: ["message"],
      discarded: [],
    },
    project: () => ({ message: "\u001b[31m日本語\u001b[0m" }),
  };
  const coreNoReduction = new ProjectionCore({
    adapters: [adapter],
    semanticContracts: [contract],
    views: [ansiViewNoReduction],
  });
  assertErrorCode(
    () =>
      coreNoReduction.project({
        source: "fixture",
        adapter: "text",
        view: "ansi-view-no-reduction",
        budget: new TextEncoder().encode(retained).byteLength,
        renderer: "json",
      }),
    "BUDGET_TOO_SMALL",
  );
});
