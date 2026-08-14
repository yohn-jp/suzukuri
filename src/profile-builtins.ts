import {
  type Adapter,
  type ProjectionSource,
  type SemanticContract,
  type View,
  type ViewProjectInput,
  ProjectionCore,
  jsonRenderer,
  textRenderer,
  validationSuccess,
} from "./core.js";

/** Small deterministic components used by the repository-local v0 profiles. */
export const profileTextAdapter: Adapter<string> = Object.freeze({
  id: "profile-text",
  version: "1.0.0",
  semanticType: "text",
  contract: "profile-text",
  validate: () => validationSuccess(),
  decode: (source: ProjectionSource) =>
    typeof source.content === "string" ? source.content : new TextDecoder().decode(source.content),
});

export const profileTextContract: SemanticContract<string> = Object.freeze({
  id: "profile-text",
  version: "1.0.0",
  semanticType: "text",
  validate: (value: unknown) => typeof value === "string",
  normalize: (value: unknown) => String(value),
});

export const profileJsonAdapter: Adapter<unknown> = Object.freeze({
  id: "profile-json",
  version: "1.0.0",
  semanticType: "json",
  contract: "profile-json",
  validate: () => validationSuccess(),
  decode: (source: ProjectionSource) =>
    JSON.parse(
      typeof source.content === "string" ? source.content : new TextDecoder().decode(source.content),
    ) as unknown,
});

export const profileJsonContract: SemanticContract<unknown> = Object.freeze({
  id: "profile-json",
  version: "1.0.0",
  semanticType: "json",
  validate: () => validationSuccess(),
});

export const profileTextView: View<{ text: string }> = Object.freeze({
  id: "profile-text",
  version: "1.0.0",
  semanticType: "text",
  meaning: {
    required: ["text"],
    preserved: ["text"],
    discarded: [],
  },
  project: ({ semantic }: ViewProjectInput) => ({ text: String(semantic) }),
});

export const profileLinesView: View<{ lines: string[] }> = Object.freeze({
  id: "profile-lines",
  version: "1.0.0",
  semanticType: "text",
  meaning: {
    required: ["lines"],
    preserved: ["lines"],
    discarded: [],
  },
  project: ({ semantic }: ViewProjectInput) => ({ lines: String(semantic).split(/\r?\n/) }),
});

export const profileTextSummaryView: View<{ text: string; characters: number }> = Object.freeze({
  id: "profile-text-summary",
  version: "1.0.0",
  semanticType: "text",
  meaning: {
    required: ["text"],
    preserved: ["text", "characters"],
    discarded: [],
    priorities: [{ path: "characters", priority: 2 }],
  },
  project: ({ semantic }: { semantic: unknown }) => {
    const text = String(semantic);
    return { text, characters: [...text].length };
  },
});

export const profileJsonValueView: View<{ value: unknown }> = Object.freeze({
  id: "profile-json-value",
  version: "1.0.0",
  semanticType: "json",
  meaning: {
    required: ["value"],
    preserved: ["value"],
    discarded: [],
  },
  project: ({ semantic }: { semantic: unknown }) => ({ value: semantic }),
});

export const profileJsonKeysView: View<{ keys: string[]; count: number }> = Object.freeze({
  id: "profile-json-keys",
  version: "1.0.0",
  semanticType: "json",
  meaning: {
    required: ["keys"],
    preserved: ["keys", "count"],
    discarded: [],
    priorities: [{ path: "count", priority: 2 }],
  },
  project: ({ semantic }: ViewProjectInput) => {
    const keys = semantic !== null && typeof semantic === "object" ? Object.keys(semantic).sort() : [];
    return { keys, count: keys.length };
  },
});

export const defaultProfileAdapters = Object.freeze([profileJsonAdapter, profileTextAdapter]);
export const defaultProfileContracts = Object.freeze([profileJsonContract, profileTextContract]);
export const defaultProfileViews = Object.freeze([
  profileJsonKeysView,
  profileJsonValueView,
  profileLinesView,
  profileTextSummaryView,
  profileTextView,
]);
export const defaultProfileRenderers = Object.freeze([jsonRenderer, textRenderer]);

export function createProfileCore(): ProjectionCore {
  return new ProjectionCore({
    adapters: defaultProfileAdapters,
    semanticContracts: defaultProfileContracts,
    views: defaultProfileViews,
    renderers: defaultProfileRenderers,
  });
}

export const createDefaultProfileCore = createProfileCore;
