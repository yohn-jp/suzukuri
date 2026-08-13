import { createHash } from "node:crypto";

export const CORE_ID = "suzukuri-projection-core";
export const CORE_VERSION = "1.0.0";

export interface ComponentIdentity {
  readonly id: string;
  readonly version: string;
}

export type ComponentReference = string | ComponentIdentity;

export interface ProjectionSource {
  readonly content: string | Uint8Array;
  readonly identity?: string;
  readonly hash?: string;
  readonly mediaType?: string;
}

export type SourceInput = ProjectionSource | string | Uint8Array;

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export type ValidationResultInput = ValidationResult | boolean;

export function validationSuccess(): ValidationResult {
  return { valid: true, issues: [] };
}

export function validationFailure(issues: readonly ValidationIssue[] | ValidationIssue): ValidationResult {
  const normalizedIssues = Array.isArray(issues) ? issues : [issues];
  return { valid: false, issues: normalizedIssues };
}

export interface Adapter<TDecoded = unknown> extends ComponentIdentity {
  readonly semanticType: string;
  readonly contract?: ComponentReference;
  validate(source: ProjectionSource): ValidationResultInput;
  decode(source: ProjectionSource): TDecoded;
}

export interface SemanticContract<TSemantic = unknown> extends ComponentIdentity {
  readonly semanticType: string;
  validate(value: unknown): ValidationResultInput;
  normalize?(value: unknown): TSemantic;
}

export interface ViewMeaning {
  readonly required: readonly string[];
  readonly preserved: readonly string[];
  readonly discarded: readonly string[];
}

export interface ViewProjectInput {
  readonly semantic: unknown;
  readonly source: ProjectionSource;
  readonly budget: Budget;
  readonly renderer: Renderer;
  readonly meaning: ViewMeaning;
}

export interface ViewProjection<TProjection = unknown> {
  readonly value: TProjection;
  readonly completeness?: Completeness;
  readonly loss?: LossMetadata | LossState;
}

export interface View<TProjection = unknown> extends ComponentIdentity {
  readonly semanticType: string;
  readonly meaning?: ViewMeaning;
  readonly required?: readonly string[];
  readonly preserved?: readonly string[];
  readonly discarded?: readonly string[];
  readonly requiredMeaning?: readonly string[];
  readonly preservedMeaning?: readonly string[];
  readonly discardedMeaning?: readonly string[];
  project(input: ViewProjectInput): TProjection | ViewProjection<TProjection>;
}

export type BudgetUnit = "utf8-bytes";

export interface Budget {
  readonly unit: BudgetUnit;
  readonly maxBytes: number;
}

export type BudgetInput = Budget | number | { readonly maxBytes: number; readonly unit?: BudgetUnit };

export interface RenderContext {
  readonly source: ProjectionSource;
  readonly budget: Budget;
  readonly adapter: ComponentIdentity;
  readonly semanticContract: ComponentIdentity;
  readonly view: ComponentIdentity;
  readonly meaning: ViewMeaning;
  readonly projection: ViewProjection;
}

export interface RenderedOutput {
  readonly output: string | Uint8Array;
  readonly completeness?: Completeness;
  readonly loss?: LossMetadata | LossState;
}

export interface Renderer extends ComponentIdentity {
  readonly format: string;
  render(projection: unknown, context: RenderContext): string | Uint8Array | RenderedOutput;
}

export type Completeness = "complete" | "partial";
export type LossState = "none" | "partial" | "total";

export interface LossMetadata {
  readonly state: LossState;
  readonly discarded: readonly string[];
}

export interface ProjectionRequest {
  readonly source: SourceInput;
  readonly adapter: ComponentReference | Adapter;
  readonly view: ComponentReference | View;
  readonly budget: BudgetInput;
  readonly renderer: ComponentReference | Renderer;
  readonly contract?: ComponentReference | SemanticContract;
}

export interface SourceProvenance {
  readonly identity?: string;
  readonly hash?: string;
  readonly mediaType?: string;
}

export interface ProjectionProvenance {
  readonly core: ComponentIdentity;
  readonly adapter: ComponentIdentity;
  readonly semanticContract: ComponentIdentity;
  readonly view: ComponentIdentity;
  readonly renderer: ComponentIdentity;
  readonly source?: SourceProvenance;
}

export interface ProjectionComponents {
  readonly adapter: ComponentIdentity;
  readonly semanticContract: ComponentIdentity;
  readonly view: ComponentIdentity;
  readonly renderer: ComponentIdentity;
}

export interface ProjectionResult {
  readonly output: string | Uint8Array;
  readonly outputSize: number;
  readonly byteLength: number;
  readonly coreVersion: string;
  readonly adapter: ComponentIdentity;
  readonly contract: ComponentIdentity;
  readonly semanticContract: ComponentIdentity;
  readonly view: ComponentIdentity;
  readonly renderer: ComponentIdentity;
  readonly source?: SourceProvenance;
  readonly components: ProjectionComponents;
  readonly provenance: ProjectionProvenance;
  readonly projectionDigest: string;
  readonly completeness: Completeness;
  readonly loss: LossMetadata;
}

export type SuzukuriErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_COMPONENT"
  | "DUPLICATE_IDENTITY"
  | "COMPONENT_NOT_FOUND"
  | "AMBIGUOUS_COMPONENT"
  | "SOURCE_INVALID"
  | "BUDGET_INVALID"
  | "ADAPTER_VALIDATION_FAILED"
  | "DECODE_FAILED"
  | "CONTRACT_VALIDATION_FAILED"
  | "CONTRACT_NORMALIZATION_FAILED"
  | "SEMANTIC_TYPE_MISMATCH"
  | "VIEW_PROJECTION_FAILED"
  | "RENDER_FAILED"
  | "BUDGET_EXCEEDED";

export interface StableError {
  readonly code: SuzukuriErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

const ERROR_MESSAGES: Record<SuzukuriErrorCode, string> = {
  INVALID_REQUEST: "The projection request is invalid.",
  INVALID_COMPONENT: "The component contract is invalid.",
  DUPLICATE_IDENTITY: "The component identity is already registered.",
  COMPONENT_NOT_FOUND: "The requested component was not found.",
  AMBIGUOUS_COMPONENT: "The component selector matches multiple versions.",
  SOURCE_INVALID: "The projection source is invalid.",
  BUDGET_INVALID: "The UTF-8 byte budget is invalid.",
  ADAPTER_VALIDATION_FAILED: "The adapter rejected the source.",
  DECODE_FAILED: "The adapter could not decode the source.",
  CONTRACT_VALIDATION_FAILED: "The decoded value violates the semantic contract.",
  CONTRACT_NORMALIZATION_FAILED: "The semantic contract could not normalize the decoded value.",
  SEMANTIC_TYPE_MISMATCH: "The selected components use incompatible semantic types.",
  VIEW_PROJECTION_FAILED: "The view could not project the semantic value.",
  RENDER_FAILED: "The renderer could not render the projection.",
  BUDGET_EXCEEDED: "The rendered projection exceeds its UTF-8 byte budget.",
};

export class SuzukuriError extends Error {
  readonly code: SuzukuriErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SuzukuriErrorCode,
    message = ERROR_MESSAGES[code],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SuzukuriError";
    this.code = code;
    this.details = details;
  }

  toJSON(): StableError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export { SuzukuriError as ProjectionError };

export class ComponentRegistry<T extends ComponentIdentity> {
  private readonly components = new Map<string, T>();

  constructor(readonly componentType: string) {
    if (componentType.trim() === "") {
      throw new SuzukuriError("INVALID_COMPONENT", ERROR_MESSAGES.INVALID_COMPONENT, {
        field: "componentType",
      });
    }
  }

  register(component: T): this {
    validateComponentIdentity(component, this.componentType);
    if (isView(component)) {
      normalizeViewMeaning(component);
    }

    const key = identityKey(component);
    if (this.components.has(key)) {
      throw new SuzukuriError("DUPLICATE_IDENTITY", undefined, {
        componentType: this.componentType,
        component: identityOf(component),
      });
    }

    this.components.set(key, component);
    return this;
  }

  registerMany(components: Iterable<T>): this {
    for (const component of components) {
      this.register(component);
    }
    return this;
  }

  get(reference: ComponentReference): T {
    const identity = typeof reference === "string" ? undefined : reference;
    if (identity !== undefined) {
      validateComponentIdentity(identity, this.componentType);
      const exact = this.components.get(identityKey(identity));
      if (exact !== undefined) {
        return exact;
      }
      throw componentNotFound(this.componentType, identity);
    }

    const selector = reference as string;
    const byId = this.list().filter((component) => component.id === selector);
    if (byId.length === 1) {
      return byId[0];
    }
    if (byId.length > 1) {
      throw new SuzukuriError("AMBIGUOUS_COMPONENT", undefined, {
        componentType: this.componentType,
        selector,
        versions: byId.map((component) => component.version),
      });
    }

    const separator = selector.lastIndexOf("@");
    if (separator > 0) {
      const parsedIdentity = {
        id: selector.slice(0, separator),
        version: selector.slice(separator + 1),
      };
      const exact = this.components.get(identityKey(parsedIdentity));
      if (exact !== undefined) {
        return exact;
      }
    }

    throw componentNotFound(this.componentType, selector);
  }

  has(reference: ComponentReference): boolean {
    try {
      this.get(reference);
      return true;
    } catch (error) {
      if (error instanceof SuzukuriError && ["COMPONENT_NOT_FOUND", "AMBIGUOUS_COMPONENT"].includes(error.code)) {
        return false;
      }
      throw error;
    }
  }

  list(): readonly T[] {
    return [...this.components.values()].sort(compareComponents);
  }

  identities(): readonly ComponentIdentity[] {
    return this.list().map(identityOf);
  }

  describe(): readonly ComponentDescriptor[] {
    return this.list().map((component) => {
      const descriptor: ComponentDescriptor = identityOf(component);
      if ("semanticType" in component && typeof component.semanticType === "string") {
        descriptor.semanticType = component.semanticType;
      }
      if ("format" in component && typeof component.format === "string") {
        descriptor.format = component.format;
      }
      if (isView(component)) {
        descriptor.meaning = normalizeViewMeaning(component);
      }
      return descriptor;
    });
  }
}

export interface ComponentDescriptor extends ComponentIdentity {
  semanticType?: string;
  format?: string;
  meaning?: ViewMeaning;
}

export class AdapterRegistry extends ComponentRegistry<Adapter> {
  constructor() {
    super("adapter");
  }
}

export class SemanticContractRegistry extends ComponentRegistry<SemanticContract> {
  constructor() {
    super("semantic-contract");
  }
}

export class ViewRegistry extends ComponentRegistry<View> {
  constructor() {
    super("view");
  }
}

export class RendererRegistry extends ComponentRegistry<Renderer> {
  constructor() {
    super("renderer");
  }
}

export interface ProjectionRegistries {
  readonly adapters: AdapterRegistry;
  readonly semanticContracts: SemanticContractRegistry;
  readonly views: ViewRegistry;
  readonly renderers: RendererRegistry;
}

export interface ProjectionCoreOptions {
  readonly adapters?: Iterable<Adapter>;
  readonly semanticContracts?: Iterable<SemanticContract>;
  readonly contracts?: Iterable<SemanticContract>;
  readonly views?: Iterable<View>;
  readonly renderers?: Iterable<Renderer>;
  readonly adapterRegistry?: AdapterRegistry;
  readonly semanticContractRegistry?: SemanticContractRegistry;
  readonly contractRegistry?: SemanticContractRegistry;
  readonly viewRegistry?: ViewRegistry;
  readonly rendererRegistry?: RendererRegistry;
}

export class ProjectionCore {
  readonly adapters: AdapterRegistry;
  readonly semanticContracts: SemanticContractRegistry;
  readonly contracts: SemanticContractRegistry;
  readonly views: ViewRegistry;
  readonly renderers: RendererRegistry;
  readonly registries: ProjectionRegistries;

  constructor(options: ProjectionCoreOptions = {}) {
    this.adapters = options.adapterRegistry ?? new AdapterRegistry();
    this.semanticContracts =
      options.semanticContractRegistry ?? options.contractRegistry ?? new SemanticContractRegistry();
    this.contracts = this.semanticContracts;
    this.views = options.viewRegistry ?? new ViewRegistry();
    this.renderers = options.rendererRegistry ?? new RendererRegistry();
    this.registries = {
      adapters: this.adapters,
      semanticContracts: this.semanticContracts,
      views: this.views,
      renderers: this.renderers,
    };

    this.adapters.registerMany(options.adapters ?? []);
    this.semanticContracts.registerMany(options.semanticContracts ?? options.contracts ?? []);
    this.views.registerMany(options.views ?? []);
    this.renderers.registerMany(options.renderers ?? []);
  }

  registerAdapter(adapter: Adapter): this {
    this.adapters.register(adapter);
    return this;
  }

  registerSemanticContract(contract: SemanticContract): this {
    this.semanticContracts.register(contract);
    return this;
  }

  registerContract(contract: SemanticContract): this {
    return this.registerSemanticContract(contract);
  }

  registerView(view: View): this {
    this.views.register(view);
    return this;
  }

  registerRenderer(renderer: Renderer): this {
    this.renderers.register(renderer);
    return this;
  }

  project(request: ProjectionRequest): ProjectionResult {
    validateRequest(request);

    const source = normalizeSource(request.source);
    const adapter = resolveAdapter(request.adapter, this.adapters);
    const view = resolveView(request.view, this.views);
    const renderer = resolveRenderer(request.renderer, this.renderers);
    const budget = normalizeBudget(request.budget);
    const contract = resolveContract(request.contract, adapter, this.semanticContracts);
    const meaning = normalizeViewMeaning(view);

    assertSemanticTypes(adapter.semanticType, contract.semanticType, "adapter", "semantic-contract");
    assertSemanticTypes(contract.semanticType, view.semanticType, "semantic-contract", "view");

    const adapterValidation = invokeValidation(() => adapter.validate(source), "ADAPTER_VALIDATION_FAILED", {
      adapter: identityOf(adapter),
    });
    if (!adapterValidation.valid) {
      throw new SuzukuriError("ADAPTER_VALIDATION_FAILED", undefined, {
        adapter: identityOf(adapter),
        issues: adapterValidation.issues,
      });
    }

    let decoded: unknown;
    try {
      decoded = adapter.decode(source);
    } catch (error) {
      throw failure("DECODE_FAILED", { adapter: identityOf(adapter) }, error);
    }

    const contractValidation = invokeValidation(() => contract.validate(decoded), "CONTRACT_VALIDATION_FAILED", {
      contract: identityOf(contract),
    });
    if (!contractValidation.valid) {
      throw new SuzukuriError("CONTRACT_VALIDATION_FAILED", undefined, {
        contract: identityOf(contract),
        issues: contractValidation.issues,
      });
    }

    let semantic: unknown = decoded;
    if (contract.normalize !== undefined) {
      try {
        semantic = contract.normalize(decoded);
      } catch (error) {
        throw failure("CONTRACT_NORMALIZATION_FAILED", { contract: identityOf(contract) }, error);
      }
    }

    let projected: ViewProjection;
    try {
      projected = normalizeViewProjection(view.project({ semantic, source, budget, renderer, meaning }));
    } catch (error) {
      throw failure("VIEW_PROJECTION_FAILED", { view: identityOf(view) }, error);
    }

    let rendered: NormalizedRenderedOutput;
    try {
      rendered = normalizeRenderedOutput(
        renderer.render(projected.value, {
          source,
          budget,
          adapter: identityOf(adapter),
          semanticContract: identityOf(contract),
          view: identityOf(view),
          meaning,
          projection: projected,
        }),
      );
    } catch (error) {
      throw failure("RENDER_FAILED", { renderer: identityOf(renderer) }, error);
    }

    const outputSize = rendered.bytes.byteLength;
    if (outputSize > budget.maxBytes) {
      throw new SuzukuriError("BUDGET_EXCEEDED", undefined, {
        budget: budget.maxBytes,
        outputSize,
        renderer: identityOf(renderer),
      });
    }

    const completeness: Completeness =
      projected.completeness === "partial" || rendered.completeness === "partial" ? "partial" : "complete";
    const loss = mergeLoss(meaning, projected.loss, rendered.loss);
    const adapterIdentity = identityOf(adapter);
    const contractIdentity = identityOf(contract);
    const viewIdentity = identityOf(view);
    const rendererIdentity = identityOf(renderer);
    const sourceProvenance = sourceMetadata(source);
    const provenance: ProjectionProvenance = {
      core: { id: CORE_ID, version: CORE_VERSION },
      adapter: adapterIdentity,
      semanticContract: contractIdentity,
      view: viewIdentity,
      renderer: rendererIdentity,
      ...(sourceProvenance === undefined ? {} : { source: sourceProvenance }),
    };
    const components: ProjectionComponents = {
      adapter: adapterIdentity,
      semanticContract: contractIdentity,
      view: viewIdentity,
      renderer: rendererIdentity,
    };
    const projectionDigest = digest({
      provenance,
      components,
      completeness,
      loss,
      output: Buffer.from(rendered.bytes).toString("base64"),
    });
    const output = rendered.output;

    return {
      output,
      outputSize,
      byteLength: outputSize,
      coreVersion: CORE_VERSION,
      adapter: adapterIdentity,
      contract: contractIdentity,
      semanticContract: contractIdentity,
      view: viewIdentity,
      renderer: rendererIdentity,
      ...(sourceProvenance === undefined ? {} : { source: sourceProvenance }),
      components,
      provenance,
      projectionDigest,
      completeness,
      loss,
    };
  }
}

export class ProjectionRegistry extends ProjectionCore {}
export { ProjectionCore as ProjectionEngine };

export function project(request: ProjectionRequest, core = new ProjectionCore()): ProjectionResult {
  return core.project(request);
}

export function createBudget(maxBytes: number): Budget {
  return normalizeBudget(maxBytes);
}

export const utf8ByteBudget = createBudget;

export function normalizeViewMeaning(view: View): ViewMeaning {
  const declared =
    view.meaning !== undefined ||
    view.required !== undefined ||
    view.preserved !== undefined ||
    view.discarded !== undefined ||
    view.requiredMeaning !== undefined ||
    view.preservedMeaning !== undefined ||
    view.discardedMeaning !== undefined;
  if (!declared) {
    throw new SuzukuriError("INVALID_COMPONENT", undefined, {
      componentType: "view",
      field: "meaning",
      component: identityOf(view),
    });
  }

  const meaning = view.meaning;
  return freezeMeaning({
    required: meaning?.required ?? view.required ?? view.requiredMeaning ?? [],
    preserved: meaning?.preserved ?? view.preserved ?? view.preservedMeaning ?? [],
    discarded: meaning?.discarded ?? view.discarded ?? view.discardedMeaning ?? [],
  });
}

interface NormalizedRenderedOutput {
  readonly output: string | Uint8Array;
  readonly bytes: Uint8Array;
  readonly completeness?: Completeness;
  readonly loss?: LossMetadata;
}

function validateRequest(request: ProjectionRequest): void {
  if (request === null || typeof request !== "object") {
    throw new SuzukuriError("INVALID_REQUEST", undefined, { field: "request" });
  }
  for (const field of ["source", "adapter", "view", "budget", "renderer"] as const) {
    if (!(field in request) || request[field] === undefined || request[field] === null) {
      throw new SuzukuriError("INVALID_REQUEST", undefined, { field });
    }
  }
}

function normalizeSource(source: SourceInput): ProjectionSource {
  if (typeof source === "string") {
    return Object.freeze({ content: source });
  }
  if (source instanceof Uint8Array) {
    return Object.freeze({ content: new Uint8Array(source) });
  }
  if (source === null || typeof source !== "object") {
    throw new SuzukuriError("SOURCE_INVALID", undefined, { field: "source" });
  }
  const content = source.content;
  if (typeof content !== "string" && !(content instanceof Uint8Array)) {
    throw new SuzukuriError("SOURCE_INVALID", undefined, { field: "source.content" });
  }
  return Object.freeze({
    ...source,
    content: typeof content === "string" ? content : new Uint8Array(content),
  });
}

function normalizeBudget(input: BudgetInput): Budget {
  const maxBytes = typeof input === "number" ? input : input?.maxBytes;
  const unit = typeof input === "number" ? "utf8-bytes" : (input?.unit ?? "utf8-bytes");
  if (unit !== "utf8-bytes" || typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new SuzukuriError("BUDGET_INVALID", undefined, {
      unit,
      maxBytes,
    });
  }
  return Object.freeze({ unit: "utf8-bytes", maxBytes });
}

function resolveAdapter(reference: ComponentReference | Adapter, registry: AdapterRegistry): Adapter {
  if (isAdapter(reference)) {
    validateComponentIdentity(reference, "adapter");
    return reference;
  }
  return registry.get(reference);
}

function resolveView(reference: ComponentReference | View, registry: ViewRegistry): View {
  if (isView(reference)) {
    validateComponentIdentity(reference, "view");
    return reference;
  }
  return registry.get(reference);
}

function resolveRenderer(reference: ComponentReference | Renderer, registry: RendererRegistry): Renderer {
  if (isRenderer(reference)) {
    validateComponentIdentity(reference, "renderer");
    return reference;
  }
  return registry.get(reference);
}

function resolveContract(
  reference: ComponentReference | SemanticContract | undefined,
  adapter: Adapter,
  registry: SemanticContractRegistry,
): SemanticContract {
  if (reference !== undefined) {
    if (isSemanticContract(reference)) {
      validateComponentIdentity(reference, "semantic-contract");
      return reference;
    }
    return registry.get(reference);
  }
  if (adapter.contract !== undefined) {
    return registry.get(adapter.contract);
  }

  const matches = registry.list().filter((contract) => contract.semanticType === adapter.semanticType);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new SuzukuriError("AMBIGUOUS_COMPONENT", undefined, {
      componentType: "semantic-contract",
      semanticType: adapter.semanticType,
      versions: matches.map((contract) => contract.version),
    });
  }
  throw componentNotFound("semantic-contract", adapter.semanticType);
}

function assertSemanticTypes(left: string, right: string, leftType: string, rightType: string): void {
  if (left !== right) {
    throw new SuzukuriError("SEMANTIC_TYPE_MISMATCH", undefined, {
      [leftType]: left,
      [rightType]: right,
    });
  }
}

function invokeValidation(
  validate: () => ValidationResultInput,
  code: "ADAPTER_VALIDATION_FAILED" | "CONTRACT_VALIDATION_FAILED",
  details: Readonly<Record<string, unknown>>,
): ValidationResult {
  try {
    return normalizeValidationResult(validate());
  } catch (error) {
    throw failure(code, details, error);
  }
}

function normalizeValidationResult(result: ValidationResultInput): ValidationResult {
  if (typeof result === "boolean") {
    return result ? validationSuccess() : validationFailure({ code: "invalid", message: "Validation failed." });
  }
  if (result === null || typeof result !== "object" || typeof result.valid !== "boolean") {
    throw new Error("validation must return a boolean or { valid, issues }");
  }
  const issues = result.issues ?? [];
  if (!Array.isArray(issues)) {
    throw new Error("validation issues must be an array");
  }
  return {
    valid: result.valid,
    issues: issues.map(normalizeValidationIssue),
  };
}

function normalizeValidationIssue(issue: ValidationIssue): ValidationIssue {
  if (issue === null || typeof issue !== "object") {
    throw new Error("validation issue must be an object");
  }
  if (typeof issue.code !== "string" || typeof issue.message !== "string") {
    throw new Error("validation issue requires code and message");
  }
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.path === undefined ? {} : { path: issue.path }),
    ...(issue.details === undefined ? {} : { details: issue.details }),
  };
}

function normalizeViewProjection(value: unknown): ViewProjection {
  if (isRecord(value) && "value" in value) {
    return {
      value: value.value,
      ...(value.completeness === undefined ? {} : { completeness: normalizeCompleteness(value.completeness) }),
      ...(value.loss === undefined ? {} : { loss: normalizeLoss(value.loss) }),
    };
  }
  return { value };
}

function normalizeRenderedOutput(value: string | Uint8Array | RenderedOutput): NormalizedRenderedOutput {
  let output: string | Uint8Array;
  let completeness: Completeness | undefined;
  let loss: LossMetadata | undefined;
  if (typeof value === "string" || value instanceof Uint8Array) {
    output = value;
  } else if (isRecord(value) && (typeof value.output === "string" || value.output instanceof Uint8Array)) {
    output = value.output;
    completeness = value.completeness === undefined ? undefined : normalizeCompleteness(value.completeness);
    loss = value.loss === undefined ? undefined : normalizeLoss(value.loss);
  } else {
    throw new Error("renderer must return a string, Uint8Array, or { output }");
  }
  const bytes = typeof output === "string" ? new TextEncoder().encode(output) : new Uint8Array(output);
  return {
    output: typeof output === "string" ? output : bytes,
    bytes,
    ...(completeness === undefined ? {} : { completeness }),
    ...(loss === undefined ? {} : { loss }),
  };
}

function normalizeCompleteness(value: unknown): Completeness {
  if (value === "complete" || value === "partial") {
    return value;
  }
  throw new Error("completeness must be complete or partial");
}

function normalizeLoss(value: unknown): LossMetadata {
  if (value === "none" || value === "partial" || value === "total") {
    return { state: value, discarded: [] };
  }
  if (!isRecord(value) || (value.state !== "none" && value.state !== "partial" && value.state !== "total")) {
    throw new Error("loss must be none, partial, total, or { state, discarded }");
  }
  const discarded = value.discarded ?? [];
  if (!Array.isArray(discarded) || discarded.some((item) => typeof item !== "string")) {
    throw new Error("loss.discarded must be an array of strings");
  }
  return { state: value.state, discarded };
}

function mergeLoss(
  meaning: ViewMeaning,
  projected: LossMetadata | LossState | undefined,
  rendered: LossMetadata | undefined,
): LossMetadata {
  const declared: LossMetadata = {
    state: meaning.discarded.length === 0 ? "none" : "partial",
    discarded: meaning.discarded,
  };
  const projectionLoss = projected === undefined ? undefined : normalizeLoss(projected);
  const candidates = [declared, projectionLoss, rendered].filter(
    (candidate): candidate is LossMetadata => candidate !== undefined,
  );
  const state = candidates.reduce<LossState>(
    (current, candidate) => (lossRank(candidate.state) > lossRank(current) ? candidate.state : current),
    "none",
  );
  const discarded = uniqueStrings(candidates.flatMap((candidate) => candidate.discarded));
  return { state, discarded };
}

function lossRank(state: LossState): number {
  return state === "none" ? 0 : state === "partial" ? 1 : 2;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function sourceMetadata(source: ProjectionSource): SourceProvenance | undefined {
  if (source.identity === undefined && source.hash === undefined && source.mediaType === undefined) {
    return undefined;
  }
  return {
    ...(source.identity === undefined ? {} : { identity: source.identity }),
    ...(source.hash === undefined ? {} : { hash: source.hash }),
    ...(source.mediaType === undefined ? {} : { mediaType: source.mediaType }),
  };
}

function validateComponentIdentity(component: ComponentIdentity, componentType: string): void {
  if (
    component === null ||
    typeof component !== "object" ||
    typeof component.id !== "string" ||
    component.id.trim() === "" ||
    typeof component.version !== "string" ||
    component.version.trim() === ""
  ) {
    throw new SuzukuriError("INVALID_COMPONENT", undefined, {
      componentType,
      fields: ["id", "version"],
    });
  }
}

function identityOf(component: ComponentIdentity): ComponentIdentity {
  return Object.freeze({ id: component.id, version: component.version });
}

function identityKey(identity: ComponentIdentity): string {
  return `${identity.id}\u0000${identity.version}`;
}

function compareComponents(left: ComponentIdentity, right: ComponentIdentity): number {
  const leftKey = identityKey(left);
  const rightKey = identityKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function componentNotFound(componentType: string, selector: ComponentReference): SuzukuriError {
  return new SuzukuriError("COMPONENT_NOT_FOUND", undefined, {
    componentType,
    selector: typeof selector === "string" ? selector : identityOf(selector),
  });
}

function failure(
  code:
    | "ADAPTER_VALIDATION_FAILED"
    | "DECODE_FAILED"
    | "CONTRACT_VALIDATION_FAILED"
    | "CONTRACT_NORMALIZATION_FAILED"
    | "VIEW_PROJECTION_FAILED"
    | "RENDER_FAILED",
  details: Readonly<Record<string, unknown>>,
  error: unknown,
): SuzukuriError {
  return new SuzukuriError(code, undefined, {
    ...details,
    cause: stableCause(error),
  });
}

function stableCause(error: unknown): Readonly<Record<string, string>> {
  if (error instanceof SuzukuriError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (typeof value === "bigint") {
    return JSON.stringify(`${value}n`);
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: Buffer.from(value).toString("base64") });
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareStrings);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeMeaning(meaning: ViewMeaning): ViewMeaning {
  const fields: Array<keyof ViewMeaning> = ["required", "preserved", "discarded"];
  for (const field of fields) {
    if (!Array.isArray(meaning[field]) || meaning[field].some((item) => typeof item !== "string")) {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field,
      });
    }
  }
  return Object.freeze({
    required: Object.freeze([...meaning.required]),
    preserved: Object.freeze([...meaning.preserved]),
    discarded: Object.freeze([...meaning.discarded]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isAdapter(value: unknown): value is Adapter {
  return isRecord(value) && typeof value.validate === "function" && typeof value.decode === "function";
}

function isSemanticContract(value: unknown): value is SemanticContract {
  return isRecord(value) && typeof value.validate === "function";
}

function isView(value: unknown): value is View {
  return isRecord(value) && typeof value.project === "function";
}

function isRenderer(value: unknown): value is Renderer {
  return isRecord(value) && typeof value.render === "function";
}
