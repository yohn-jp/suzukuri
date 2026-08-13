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

/** A semantic field or collection that may be reduced when the budget is tight. */
export interface SemanticPriority {
  /** Dot-separated path in the typed projection. */
  readonly path?: string;
  /** Aliases accepted for adapter/view ergonomics. */
  readonly key?: string;
  readonly field?: string;
  readonly name?: string;
  /** Lower numbers are retained before higher numbers. Array order breaks ties. */
  readonly priority?: number;
  readonly rank?: number;
  readonly order?: number;
  readonly required?: boolean;
}

export type SemanticPriorityDeclaration = SemanticPriority | string;

export type SemanticReductionKind =
  "ansi-removal" | "path-deduplication" | "repeated-message-folding" | "stack-frame-collapse";

export interface SemanticReduction {
  readonly kind: SemanticReductionKind | string;
  readonly path?: string;
  readonly priority?: number;
}

export type SemanticReductionDeclaration = SemanticReduction | SemanticReductionKind | string;

export interface ViewMeaning {
  readonly required: readonly string[];
  readonly preserved: readonly string[];
  readonly discarded: readonly string[];
  /** Ordered high-to-low semantic priorities for optional fields/collections. */
  readonly priorities?: readonly SemanticPriorityDeclaration[] | Readonly<Record<string, number>>;
  /** Singular alias for integrations that use a priority map/list. */
  readonly priority?: readonly SemanticPriorityDeclaration[] | Readonly<Record<string, number>>;
  /** Explicitly optional paths, useful when no priority object is needed. */
  readonly optional?: readonly string[];
  /** Representation reductions are opt-in and contract-controlled. */
  readonly reductions?: readonly SemanticReductionDeclaration[];
  readonly allowedReductions?: readonly SemanticReductionDeclaration[];
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

export interface ViewReduceInput<TProjection = unknown> {
  readonly projection: ViewProjection<TProjection>;
  readonly source: ProjectionSource;
  readonly budget: Budget;
  readonly renderer: Renderer;
  readonly meaning: ViewMeaning;
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
  readonly priorities?: readonly SemanticPriorityDeclaration[] | Readonly<Record<string, number>>;
  readonly priority?: readonly SemanticPriorityDeclaration[] | Readonly<Record<string, number>>;
  readonly optional?: readonly string[];
  readonly reductions?: readonly SemanticReductionDeclaration[];
  readonly allowedReductions?: readonly SemanticReductionDeclaration[];
  project(input: ViewProjectInput): TProjection | ViewProjection<TProjection>;
  /** Optional view-owned reduction hook for typed projections with custom semantics. */
  readonly reduce?: (input: ViewReduceInput<TProjection>) => TProjection | ViewProjection<TProjection>;
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
  readonly loss: LossMetadata;
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

export interface LossReduction {
  readonly kind: string;
  readonly path?: string;
  readonly count?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface LossMetadata {
  readonly state: LossState;
  readonly discarded: readonly string[];
  readonly reductions?: readonly LossReduction[];
  readonly discardedCounts?: Readonly<Record<string, number>>;
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
  | "BUDGET_EXCEEDED"
  | "BUDGET_TOO_SMALL";

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
  BUDGET_TOO_SMALL: "The UTF-8 byte budget is too small for required semantic meaning.",
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
    const renderers = options.renderers !== undefined ? [...options.renderers] : undefined;
    const shouldLoadStandardRenderers = renderers === undefined || renderers.length === 0;
    if (renderers !== undefined) {
      this.renderers.registerMany(renderers);
    }
    if (shouldLoadStandardRenderers) {
      for (const renderer of standardRenderers()) {
        if (!this.renderers.has(renderer.id)) {
          this.renderers.register(renderer);
        }
      }
    }
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

    const initialLoss = mergeLoss(meaning, projected.loss, undefined);
    let finalProjected = projected;
    let rendered = renderProjection(renderer, source, budget, adapter, contract, view, meaning, projected, initialLoss);
    if (rendered.bytes.byteLength > budget.maxBytes) {
      const fitted = fitProjectionToBudget({
        source,
        budget,
        adapter,
        contract,
        view,
        renderer,
        meaning,
        projection: projected,
        initial: rendered,
      });
      finalProjected = fitted.projection;
      rendered = fitted.rendered;
    }

    const outputSize = rendered.bytes.byteLength;
    if (outputSize > budget.maxBytes) {
      const requiredMinimum = fittedRequiredMinimum(
        source,
        budget,
        adapter,
        contract,
        view,
        renderer,
        meaning,
        projected,
      );
      throw new SuzukuriError("BUDGET_TOO_SMALL", undefined, {
        requestedBudget: budget.maxBytes,
        requested: budget.maxBytes,
        budget: budget.maxBytes,
        requiredMinimum,
        requiredMinimumBytes: requiredMinimum,
        requiredMinimumSize: requiredMinimum,
        outputSize,
        renderer: identityOf(renderer),
      });
    }

    const completeness: Completeness =
      finalProjected.completeness === "partial" || rendered.completeness === "partial" ? "partial" : "complete";
    const loss = mergeLoss(meaning, finalProjected.loss, rendered.loss);
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
    view.discardedMeaning !== undefined ||
    view.priorities !== undefined ||
    view.priority !== undefined ||
    view.optional !== undefined ||
    view.reductions !== undefined ||
    view.allowedReductions !== undefined;
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
    priorities: meaning?.priorities ?? meaning?.priority ?? view.priorities ?? view.priority ?? [],
    optional: meaning?.optional ?? view.optional ?? [],
    reductions: meaning?.reductions ?? meaning?.allowedReductions ?? view.reductions ?? view.allowedReductions ?? [],
  });
}

interface NormalizedRenderedOutput {
  readonly output: string | Uint8Array;
  readonly bytes: Uint8Array;
  readonly completeness?: Completeness;
  readonly loss?: LossMetadata;
}

interface BudgetFitInput {
  readonly source: ProjectionSource;
  readonly budget: Budget;
  readonly adapter: Adapter;
  readonly contract: SemanticContract;
  readonly view: View;
  readonly renderer: Renderer;
  readonly meaning: ViewMeaning;
  readonly projection: ViewProjection;
  readonly initial: NormalizedRenderedOutput;
}

interface BudgetFitResult {
  readonly projection: ViewProjection;
  readonly rendered: NormalizedRenderedOutput;
}

interface ReductionOperation {
  readonly kind: string;
  readonly path?: string;
  readonly count?: number;
  readonly operationKey?: string;
  apply(value: unknown): unknown;
}

function renderProjection(
  renderer: Renderer,
  source: ProjectionSource,
  budget: Budget,
  adapter: Adapter,
  contract: SemanticContract,
  view: View,
  meaning: ViewMeaning,
  projection: ViewProjection,
  loss: LossMetadata,
): NormalizedRenderedOutput {
  try {
    return normalizeRenderedOutput(
      renderer.render(projection.value, {
        source,
        budget,
        adapter: identityOf(adapter),
        semanticContract: identityOf(contract),
        view: identityOf(view),
        meaning,
        projection,
        loss,
      }),
    );
  } catch (error) {
    throw failure("RENDER_FAILED", { renderer: identityOf(renderer) }, error);
  }
}

function fitProjectionToBudget(input: BudgetFitInput): BudgetFitResult {
  let projection = input.projection;
  let rendered = input.initial;
  let currentBytes = rendered.bytes.byteLength;
  const normalizedMeaning = freezeMeaning(input.meaning);

  if (input.view.reduce !== undefined) {
    let reduced: ViewProjection;
    try {
      reduced = normalizeViewProjection(
        input.view.reduce({
          projection,
          source: input.source,
          budget: input.budget,
          renderer: input.renderer,
          meaning: input.meaning,
        }),
      );
    } catch (error) {
      throw failure("VIEW_PROJECTION_FAILED", { view: identityOf(input.view) }, error);
    }
    if (!sameSemanticValue(reduced.value, projection.value) && preservesRequiredMeaning(reduced.value, normalizedMeaning)) {
      reduced = markReducedProjection(reduced, {
        kind: "view-reduction",
      });
      const reducedLoss = mergeLoss(input.meaning, reduced.loss, undefined);
      const reducedRendered = renderProjection(
        input.renderer,
        input.source,
        input.budget,
        input.adapter,
        input.contract,
        input.view,
        input.meaning,
        reduced,
        reducedLoss,
      );
      if (reducedRendered.bytes.byteLength < currentBytes) {
        projection = reduced;
        rendered = reducedRendered;
        currentBytes = rendered.bytes.byteLength;
      }
      if (currentBytes <= input.budget.maxBytes) {
        return { projection, rendered };
      }
    }
  }

  const operations = reductionOperations(projection.value, normalizedMeaning);
  for (const operation of operations) {
    const value = operation.apply(projection.value);
    if (sameSemanticValue(value, projection.value) || !preservesRequiredMeaning(value, normalizedMeaning)) {
      continue;
    }
    const candidate = markReducedProjection({ ...projection, value }, operation);
    const candidateLoss = mergeLoss(input.meaning, candidate.loss, undefined);
    const candidateRendered = renderProjection(
      input.renderer,
      input.source,
      input.budget,
      input.adapter,
      input.contract,
      input.view,
      input.meaning,
      candidate,
      candidateLoss,
    );
    if (candidateRendered.bytes.byteLength < currentBytes) {
      projection = candidate;
      rendered = candidateRendered;
      currentBytes = rendered.bytes.byteLength;
    }
    if (currentBytes <= input.budget.maxBytes) {
      return { projection, rendered };
    }
  }

  return { projection, rendered };
}

function fittedRequiredMinimum(
  source: ProjectionSource,
  budget: Budget,
  adapter: Adapter,
  contract: SemanticContract,
  view: View,
  renderer: Renderer,
  meaning: ViewMeaning,
  projection: ViewProjection,
): number {
  let value = projection.value;
  const normalizedMeaning = freezeMeaning(meaning);
  for (const operation of reductionOperations(value, normalizedMeaning)) {
    value = operation.apply(value);
  }
  const minimumProjection = markReducedProjection({ ...projection, value }, { kind: "required-minimum" });
  try {
    const rendered = renderProjection(
      renderer,
      source,
      budget,
      adapter,
      contract,
      view,
      meaning,
      minimumProjection,
      mergeLoss(meaning, minimumProjection.loss, undefined),
    );
    return rendered.bytes.byteLength;
  } catch {
    return budget.maxBytes + 1;
  }
}

function markReducedProjection(
  projection: ViewProjection,
  operation: Pick<ReductionOperation, "kind" | "path" | "count">,
): ViewProjection {
  const previous: LossMetadata =
    projection.loss === undefined ? { state: "none", discarded: [] } : normalizeLoss(projection.loss);
  const reduction: LossReduction = {
    kind: operation.kind,
    ...(operation.path === undefined ? {} : { path: operation.path }),
    ...(operation.count === undefined ? {} : { count: operation.count }),
  };
  return {
    ...projection,
    completeness: "partial",
    loss: {
      state: previous.state === "total" ? "total" : "partial",
      discarded: previous.discarded,
      reductions: [...(previous.reductions ?? []), reduction],
      ...(previous.discardedCounts === undefined ? {} : { discardedCounts: previous.discardedCounts }),
    },
  };
}

function reductionOperations(value: unknown, meaning: NormalizedViewMeaning): readonly ReductionOperation[] {
  const operations: ReductionOperation[] = [];
  const seen = new Set<string>();
  const add = (operation: ReductionOperation): void => {
    const key = `${operation.kind}:${operation.path ?? ""}:${operation.count ?? ""}:${operation.operationKey ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      operations.push(operation);
    }
  };

  const representationReductions = [...(meaning.reductions ?? meaning.allowedReductions ?? [])]
    .map((reduction, index) => ({ reduction, index }))
    .sort((left, right) => {
      const leftPriority =
        typeof left.reduction === "object" && left.reduction.priority !== undefined ? left.reduction.priority : 0;
      const rightPriority =
        typeof right.reduction === "object" && right.reduction.priority !== undefined ? right.reduction.priority : 0;
      return leftPriority - rightPriority || left.index - right.index;
    });
  for (const { reduction } of representationReductions) {
    const normalized = typeof reduction === "string" ? { kind: reduction } : reduction;
    const kind = canonicalReductionKind(normalized.kind);
    if (kind === undefined) {
      continue;
    }
    add({
      kind,
      ...(normalized.path === undefined ? {} : { path: normalized.path }),
      apply: (current) => applyRepresentationReduction(current, kind, normalized.path),
    });
  }

  const priorities = meaning.priorities;
  const requiredPaths = new Set(meaning.required);
  for (const priority of priorities) {
    if (priority.required) {
      requiredPaths.add(priority.path);
    }
  }
  const prioritized = priorities
    .map((priority, index) => ({ priority, index }))
    .filter(({ priority }) => !priority.required && !isProtectedPath(priority.path, requiredPaths))
    .sort((left, right) => right.priority.priority - left.priority.priority || right.index - left.index);
  for (const { priority } of prioritized) {
    addPathOperations(value, priority.path, "semantic-priority", add);
  }

  const explicitOptional = [...(meaning.optional ?? [])];
  for (let index = explicitOptional.length - 1; index >= 0; index -= 1) {
    const path = explicitOptional[index];
    if (!isProtectedPath(path, requiredPaths)) {
      addPathOperations(value, path, "optional-field", add);
    }
  }

  const preserved = [...meaning.preserved];
  for (let index = preserved.length - 1; index >= 0; index -= 1) {
    const path = preserved[index];
    if (!isProtectedPath(path, requiredPaths)) {
      addPathOperations(value, path, "preserved-field", add);
    }
  }
  return operations;
}

function addPathOperations(
  value: unknown,
  path: string,
  kind: string,
  add: (operation: ReductionOperation) => void,
): void {
  const current = getPath(value, path);
  if (Array.isArray(current)) {
    const length = current.length;
    if (length > 10) {
      const steps = [length >> 1, length >> 2, length >> 3];
      for (const step of steps) {
        if (step > 0) {
          for (let count = step; count < length; count += step) {
            const startIndex = length - count;
            add({
              kind: "collection-item-omission",
              path,
              count,
              operationKey: `${path}[${startIndex}:${length}]`,
              apply: (candidate) => removePathRange(candidate, path, startIndex, length),
            });
          }
        }
      }
    }
    for (let index = current.length - 1; index >= 0; index -= 1) {
      add({
        kind: "collection-item-omission",
        path,
        count: 1,
        operationKey: `${path}[${index}]`,
        apply: (candidate) => removePathIndex(candidate, path, index),
      });
    }
    return;
  }
  if (current !== undefined) {
    add({
      kind,
      path,
      count: 1,
      apply: (candidate) => removePath(candidate, path),
    });
  }
}

function isProtectedPath(path: string, required: ReadonlySet<string>): boolean {
  for (const requiredPath of required) {
    if (requiredPath === path || requiredPath.startsWith(`${path}.`) || requiredPath.startsWith(`${path}[`)) {
      return true;
    }
  }
  return false;
}

function canonicalReductionKind(kind: string): SemanticReductionKind | undefined {
  const aliases: Record<string, SemanticReductionKind> = {
    ansi: "ansi-removal",
    "strip-ansi": "ansi-removal",
    "ansi-removal": "ansi-removal",
    "path-dedup": "path-deduplication",
    "path-deduplication": "path-deduplication",
    "repeated-message-fold": "repeated-message-folding",
    "repeated-message-folding": "repeated-message-folding",
    "stack-collapse": "stack-frame-collapse",
    "stack-frame-collapse": "stack-frame-collapse",
  };
  return aliases[kind];
}

function applyRepresentationReduction(value: unknown, kind: SemanticReductionKind, path: string | undefined): unknown {
  const transform = (current: unknown): unknown => {
    if (kind === "ansi-removal") {
      return transformDeep(current, (item) => (typeof item === "string" ? stripAnsi(item) : item));
    }
    if (!Array.isArray(current)) {
      return current;
    }
    if (kind === "path-deduplication") {
      return deduplicatePaths(current);
    }
    if (kind === "repeated-message-folding") {
      return foldRepeatedMessages(current);
    }
    return collapseStackFrames(current);
  };
  return path === undefined ? transform(value) : updatePath(value, path, transform);
}

function transformDeep(value: unknown, transform: (value: unknown) => unknown): unknown {
  const transformed = transform(value);
  if (transformed !== value) {
    return transformed;
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformDeep(item, transform));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transformDeep(item, transform)]));
  }
  return value;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function deduplicatePaths(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const path =
      isRecord(value) && typeof value.path === "string" ? value.path : typeof value === "string" ? value : undefined;
    if (path === undefined) {
      return true;
    }
    if (seen.has(path)) {
      return false;
    }
    seen.add(path);
    return true;
  });
}

function foldRepeatedMessages(values: readonly unknown[]): readonly unknown[] {
  const result: unknown[] = [];
  for (const value of values) {
    const previous = result[result.length - 1];
    if (isRecord(previous) && isRecord(value) && previous.message === value.message) {
      const count = typeof previous.count === "number" ? previous.count : 1;
      result[result.length - 1] = { ...previous, count: count + 1 };
    } else {
      result.push(value);
    }
  }
  return result;
}

function collapseStackFrames(values: readonly unknown[]): readonly unknown[] {
  const result: unknown[] = [];
  for (const value of values) {
    if (result.length > 0 && sameSemanticValue(result[result.length - 1], value)) {
      continue;
    }
    result.push(value);
  }
  return result;
}

function sameSemanticValue(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function pathSegments(path: string): readonly (string | number)[] {
  return path
    .replace(/\[([0-9]+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^[0-9]+$/.test(segment) ? Number(segment) : segment));
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of pathSegments(path)) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (isRecord(current) && typeof segment === "string") {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function preservesRequiredMeaning(value: unknown, meaning: NormalizedViewMeaning): boolean {
  const required = new Set(meaning.required);
  for (const priority of meaning.priorities) {
    if (priority.required) {
      required.add(priority.path);
    }
  }
  return [...required].every((path) => hasPath(value, path));
}

function hasPath(value: unknown, path: string): boolean {
  let current = value;
  for (const segment of pathSegments(path)) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (segment < 0 || segment >= current.length) {
        return false;
      }
      current = current[segment];
    } else if (
      isRecord(current) &&
      typeof segment === "string" &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return true;
}

function removePath(value: unknown, path: string): unknown {
  return updatePath(value, path, () => undefined, true);
}

function removePathIndex(value: unknown, path: string, index: number): unknown {
  const current = getPath(value, path);
  if (!Array.isArray(current) || index < 0 || index >= current.length) {
    return value;
  }
  return updatePath(value, path, (item) =>
    Array.isArray(item) ? item.filter((_, itemIndex) => itemIndex !== index) : item,
  );
}

function removePathRange(value: unknown, path: string, startIndex: number, endIndex: number): unknown {
  const current = getPath(value, path);
  if (!Array.isArray(current) || startIndex < 0 || startIndex >= current.length) {
    return value;
  }
  return updatePath(value, path, (item) =>
    Array.isArray(item) ? item.filter((_, itemIndex) => itemIndex < startIndex || itemIndex >= endIndex) : item,
  );
}

function updatePath(value: unknown, path: string, transform: (value: unknown) => unknown, remove = false): unknown {
  return updatePathSegments(value, pathSegments(path), transform, remove);
}

function updatePathSegments(
  value: unknown,
  segments: readonly (string | number)[],
  transform: (value: unknown) => unknown,
  remove = false,
): unknown {
  if (segments.length === 0) {
    return transform(value);
  }
  const clone = cloneContainer(value);
  if (clone === undefined) {
    return value;
  }
  const [head, ...tail] = segments;
  const child = getSegment(clone, head);
  if (tail.length === 0) {
    const next = remove ? undefined : transform(child);
    if (remove && Array.isArray(clone) && typeof head === "number") {
      clone.splice(head, 1);
    } else if (next === undefined) {
      delete clone[head as keyof typeof clone];
    } else {
      clone[head as keyof typeof clone] = next as never;
    }
    return clone;
  }
  const next = updatePathSegments(child, tail, transform, remove);
  if (next === child) {
    return value;
  }
  clone[head as keyof typeof clone] = next as never;
  return clone;
}

function cloneContainer(value: unknown): Record<string, unknown> | unknown[] | undefined {
  return Array.isArray(value) ? [...value] : isRecord(value) ? { ...value } : undefined;
}

function getSegment(value: Record<string, unknown> | unknown[], segment: string | number): unknown {
  if (Array.isArray(value)) {
    return typeof segment === "number" ? value[segment] : undefined;
  }
  return value[String(segment)];
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
  const reductions = value.reductions ?? [];
  if (!Array.isArray(reductions)) {
    throw new Error("loss.reductions must be an array");
  }
  const normalizedReductions = reductions.map(normalizeLossReduction);
  const discardedCounts = value.discardedCounts;
  if (
    discardedCounts !== undefined &&
    (!isRecord(discardedCounts) ||
      Object.values(discardedCounts).some((count) => typeof count !== "number" || count < 0))
  ) {
    throw new Error("loss.discardedCounts must be a map of non-negative numbers");
  }
  return {
    state: normalizedReductions.length > 0 && value.state === "none" ? "partial" : value.state,
    discarded,
    ...(normalizedReductions.length === 0 ? {} : { reductions: normalizedReductions }),
    ...(discardedCounts === undefined ? {} : { discardedCounts: discardedCounts as Readonly<Record<string, number>> }),
  };
}

function normalizeLossReduction(value: unknown): LossReduction {
  if (!isRecord(value) || typeof value.kind !== "string" || value.kind === "") {
    throw new Error("loss.reductions entries require kind");
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    throw new Error("loss.reductions.path must be a string");
  }
  if (value.count !== undefined && (typeof value.count !== "number" || value.count < 0)) {
    throw new Error("loss.reductions.count must be a non-negative number");
  }
  if (value.details !== undefined && !isRecord(value.details)) {
    throw new Error("loss.reductions.details must be an object");
  }
  return {
    kind: value.kind,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.count === undefined ? {} : { count: value.count }),
    ...(value.details === undefined ? {} : { details: value.details as Readonly<Record<string, unknown>> }),
  };
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
  const reductions = uniqueReductions(candidates.flatMap((candidate) => candidate.reductions ?? []));
  const pathRemovalKinds = new Set([
    "semantic-priority",
    "optional-field",
    "preserved-field",
    "view-reduction",
    "required-minimum",
  ]);
  const discarded = uniqueStrings([
    ...candidates.flatMap((candidate) => candidate.discarded),
    ...reductions.flatMap((reduction) =>
      reduction.path === undefined || !pathRemovalKinds.has(reduction.kind) ? [] : [reduction.path],
    ),
  ]);
  const discardedCounts: Record<string, number> = {};
  for (const candidate of candidates) {
    for (const [path, count] of Object.entries(candidate.discardedCounts ?? {})) {
      discardedCounts[path] = (discardedCounts[path] ?? 0) + count;
    }
  }
  for (const reduction of reductions) {
    if (reduction.path !== undefined && reduction.count !== undefined) {
      discardedCounts[reduction.path] = (discardedCounts[reduction.path] ?? 0) + reduction.count;
    }
  }
  const finalState: LossState = reductions.length > 0 && state === "none" ? "partial" : state;
  return {
    state: finalState,
    discarded,
    ...(reductions.length === 0 ? {} : { reductions }),
    ...(Object.keys(discardedCounts).length === 0 ? {} : { discardedCounts }),
  };
}

function lossRank(state: LossState): number {
  return state === "none" ? 0 : state === "partial" ? 1 : 2;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueReductions(values: readonly LossReduction[]): readonly LossReduction[] {
  const indexes = new Map<string, number>();
  const result: LossReduction[] = [];
  for (const value of values) {
    const key = canonicalize({ kind: value.kind, path: value.path, details: value.details });
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, result.length);
      result.push(value);
    } else {
      const existing = result[existingIndex];
      const count = (existing.count ?? 0) + (value.count ?? 0);
      result[existingIndex] = {
        ...existing,
        ...(count === 0 ? {} : { count }),
      };
    }
  }
  return result;
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
  if (value === undefined) {
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

/** Canonical machine-readable JSON used by the standard renderer. */
export function stableJsonStringify(value: unknown): string {
  return canonicalize(value);
}

/** Deterministic compact text representation for agent-facing output. */
export function compactTextStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (Array.isArray(value)) {
    return value.map(compactTextStringify).join("\n");
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${key}=${compactTextStringify(value[key])}`)
      .join(" ");
  }
  return String(value);
}

export const jsonRenderer: Renderer = Object.freeze({
  id: "json",
  version: "1.0.0",
  format: "application/json",
  render: (projection: unknown) => stableJsonStringify(projection),
});

export const machineJsonRenderer = jsonRenderer;
export const stableMachineJsonRenderer = jsonRenderer;

export const textRenderer: Renderer = Object.freeze({
  id: "text",
  version: "1.0.0",
  format: "text/plain",
  render: (projection: unknown) => compactTextStringify(projection),
});

export const compactTextRenderer = textRenderer;
export const compactAgentTextRenderer = textRenderer;
export const agentTextRenderer = textRenderer;

function standardRenderers(): readonly Renderer[] {
  return [jsonRenderer, textRenderer];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeMeaning(meaning: ViewMeaning): NormalizedViewMeaning {
  const fields: Array<keyof ViewMeaning> = ["required", "preserved", "discarded"];
  for (const field of fields) {
    if (!Array.isArray(meaning[field]) || meaning[field].some((item) => typeof item !== "string")) {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field,
      });
    }
  }
  if (
    meaning.optional !== undefined &&
    (!Array.isArray(meaning.optional) || meaning.optional.some((item) => typeof item !== "string"))
  ) {
    throw new SuzukuriError("INVALID_COMPONENT", undefined, {
      componentType: "view",
      field: "optional",
    });
  }
  const required = [...meaning.required];
  const preserved = [...meaning.preserved];
  const discarded = [...meaning.discarded];
  const optional = [...(meaning.optional ?? [])];
  const priorities = normalizePriorities(meaning.priorities ?? meaning.priority ?? [], required);
  const reductions = normalizeReductions(meaning.reductions ?? meaning.allowedReductions ?? []);
  const frozenPriorities = Object.freeze(priorities.map((priority) => Object.freeze(priority)));
  const frozenReductions = Object.freeze(reductions.map((reduction) => Object.freeze(reduction)));
  return Object.freeze({
    required: Object.freeze(required),
    preserved: Object.freeze(preserved),
    discarded: Object.freeze(discarded),
    priorities: frozenPriorities,
    priority: frozenPriorities,
    optional: Object.freeze(optional),
    reductions: frozenReductions,
    allowedReductions: frozenReductions,
  });
}

interface NormalizedPriority {
  readonly path: string;
  readonly priority: number;
  readonly required: boolean;
}

interface NormalizedReduction {
  readonly kind: string;
  readonly path?: string;
  readonly priority?: number;
}

interface NormalizedViewMeaning {
  readonly required: readonly string[];
  readonly preserved: readonly string[];
  readonly discarded: readonly string[];
  readonly priorities: readonly NormalizedPriority[];
  readonly priority: readonly NormalizedPriority[];
  readonly optional: readonly string[];
  readonly reductions: readonly NormalizedReduction[];
  readonly allowedReductions: readonly NormalizedReduction[];
}

function normalizePriorities(
  value: ViewMeaning["priorities"],
  required: readonly string[],
): readonly NormalizedPriority[] {
  const declarations: readonly SemanticPriorityDeclaration[] = Array.isArray(value)
    ? value
    : value !== undefined && value !== null && typeof value === "object"
      ? Object.keys(value).map((path) => ({ path, priority: (value as Record<string, number>)[path] }))
      : [];
  const requiredPaths = new Set(required);
  const seen = new Set<string>();
  const normalized: NormalizedPriority[] = [];
  declarations.forEach((declaration, index) => {
    const candidate = typeof declaration === "string" ? { path: declaration } : declaration;
    if (candidate === null || typeof candidate !== "object") {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field: "priorities",
      });
    }
    const path = [candidate.path, candidate.key, candidate.field, candidate.name].find(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    if (path === undefined) {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field: "priorities",
      });
    }
    if (seen.has(path)) {
      return;
    }
    const declaredPriority = candidate.priority ?? candidate.rank ?? candidate.order ?? index;
    if (typeof declaredPriority !== "number" || !Number.isFinite(declaredPriority)) {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field: "priorities",
        path,
      });
    }
    seen.add(path);
    normalized.push({
      path,
      priority: declaredPriority,
      required: candidate.required ?? requiredPaths.has(path),
    });
  });
  return normalized;
}

function normalizeReductions(
  value: readonly SemanticReductionDeclaration[] | undefined,
): readonly NormalizedReduction[] {
  if (value === undefined) {
    return [];
  }
  return value.map((declaration) => {
    const candidate = typeof declaration === "string" ? { kind: declaration } : declaration;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      typeof candidate.kind !== "string" ||
      candidate.kind === ""
    ) {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field: "reductions",
      });
    }
    if (candidate.path !== undefined && typeof candidate.path !== "string") {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field: "reductions.path",
      });
    }
    if (
      candidate.priority !== undefined &&
      (typeof candidate.priority !== "number" || !Number.isFinite(candidate.priority))
    ) {
      throw new SuzukuriError("INVALID_COMPONENT", undefined, {
        componentType: "view",
        field: "reductions.priority",
      });
    }
    return {
      kind: candidate.kind,
      ...(candidate.path === undefined ? {} : { path: candidate.path }),
      ...(candidate.priority === undefined ? {} : { priority: candidate.priority }),
    };
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
