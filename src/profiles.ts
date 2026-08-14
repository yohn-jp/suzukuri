import fs from "node:fs";
import path from "node:path";
import { createProfileCore } from "./profile-builtins.js";
import {
  type Budget,
  type ComponentDescriptor,
  type ComponentReference,
  type ProjectionCore,
  type ProjectionResult,
  type ProjectionSource,
  type SourceInput,
  type SuzukuriError,
  type View,
  createBudget,
  type ComponentIdentity,
  type Adapter,
  type SemanticContract,
  type Renderer,
} from "./core.js";

export const PROFILE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PROFILE_PATH = ".suzukuri/profiles.json";

export interface ProfileSourceDescription {
  readonly description: string;
  readonly identity?: string;
  readonly mediaType?: string;
}

export interface ProfileDefinition {
  readonly name: string;
  readonly description: string;
  readonly source: ProfileSourceDescription;
  readonly adapter: ComponentReference;
  readonly view: ComponentReference;
  readonly budget: Budget;
  readonly renderer: ComponentReference;
}

export interface ProfileDocument {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly profiles: readonly ProfileDefinition[];
}

export interface ProfileIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ProfileValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProfileIssue[];
  readonly document?: ProfileDocument;
}

export type ProfileErrorCode =
  "PROFILE_INVALID" | "PROFILE_FILE_NOT_FOUND" | "PROFILE_FILE_INVALID" | "PROFILE_NOT_FOUND" | "PROFILE_AMBIGUOUS";

const PROFILE_ERROR_MESSAGES: Record<ProfileErrorCode, string> = {
  PROFILE_INVALID: "The profile document is invalid.",
  PROFILE_FILE_NOT_FOUND: "The profile file was not found.",
  PROFILE_FILE_INVALID: "The profile file is not valid JSON.",
  PROFILE_NOT_FOUND: "The requested profile was not found.",
  PROFILE_AMBIGUOUS: "The profile selector matches multiple profiles.",
};

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ProfileErrorCode,
    message = PROFILE_ERROR_MESSAGES[code],
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ProfileErrorCode; message: string; details: Readonly<Record<string, unknown>> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  issues: ProfileIssue[],
  code: string,
  message: string,
  issuePath: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  issues.push({ code, message, path: issuePath, ...(details === undefined ? {} : { details }) });
}

function unknownKeys(value: RecordValue, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort(compareStrings);
}

function normalizeReference(value: unknown, issuePath: string, issues: ProfileIssue[]): ComponentReference | undefined {
  if (typeof value === "string") {
    if (value.trim() !== "") {
      return value;
    }
    issue(issues, "PROFILE_COMPONENT_INVALID", "Component reference must not be empty.", issuePath);
    return undefined;
  }

  if (!isRecord(value)) {
    issue(issues, "PROFILE_COMPONENT_INVALID", "Component reference must be an id or identity object.", issuePath);
    return undefined;
  }

  for (const key of unknownKeys(value, ["id", "version"])) {
    issue(issues, "PROFILE_FIELD_UNKNOWN", `Unknown component reference property "${key}".`, `${issuePath}.${key}`);
  }

  const id = value.id;
  const version = value.version;
  if (typeof id !== "string" || id.trim() === "") {
    issue(issues, "PROFILE_COMPONENT_INVALID", "Component identity id must be a non-empty string.", `${issuePath}.id`);
  }
  if (typeof version !== "string" || version.trim() === "") {
    issue(
      issues,
      "PROFILE_COMPONENT_INVALID",
      "Component identity version must be a non-empty string.",
      `${issuePath}.version`,
    );
  }
  if (typeof id !== "string" || typeof version !== "string" || id.trim() === "" || version.trim() === "") {
    return undefined;
  }
  return { id, version };
}

function normalizeSourceDescription(
  value: unknown,
  issuePath: string,
  issues: ProfileIssue[],
): ProfileSourceDescription | undefined {
  if (!isRecord(value)) {
    issue(issues, "PROFILE_SOURCE_INVALID", "Profile source must be a description object.", issuePath);
    return undefined;
  }

  for (const key of unknownKeys(value, ["description", "identity", "mediaType"])) {
    issue(issues, "PROFILE_FIELD_UNKNOWN", `Unknown profile source property "${key}".`, `${issuePath}.${key}`);
  }

  const description = value.description;
  if (typeof description !== "string" || description.trim() === "") {
    issue(
      issues,
      "PROFILE_SOURCE_INVALID",
      "Profile source description must be a non-empty string.",
      `${issuePath}.description`,
    );
  }

  for (const key of ["identity", "mediaType"] as const) {
    const field = value[key];
    if (field !== undefined && (typeof field !== "string" || field.trim() === "")) {
      issue(
        issues,
        "PROFILE_SOURCE_INVALID",
        `Profile source ${key} must be a non-empty string when supplied.`,
        `${issuePath}.${key}`,
      );
    }
  }

  if (typeof description !== "string" || description.trim() === "") {
    return undefined;
  }
  return {
    description,
    ...(typeof value.identity === "string" ? { identity: value.identity } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
  };
}

function normalizeBudget(value: unknown, issuePath: string, issues: ProfileIssue[]): Budget | undefined {
  const raw = typeof value === "number" ? { maxBytes: value } : value;
  if (!isRecord(raw)) {
    issue(issues, "PROFILE_BUDGET_INVALID", "Profile budget must be an object with maxBytes.", issuePath);
    return undefined;
  }

  for (const key of unknownKeys(raw, ["maxBytes", "unit"])) {
    issue(issues, "PROFILE_FIELD_UNKNOWN", `Unknown profile budget property "${key}".`, `${issuePath}.${key}`);
  }

  if (raw.unit !== undefined && raw.unit !== "utf8-bytes") {
    issue(issues, "PROFILE_BUDGET_INVALID", "Profile budget unit must be utf8-bytes.", `${issuePath}.unit`);
  }
  if (typeof raw.maxBytes !== "number" || !Number.isSafeInteger(raw.maxBytes) || raw.maxBytes < 0) {
    issue(
      issues,
      "PROFILE_BUDGET_INVALID",
      "Profile maxBytes must be a non-negative safe integer.",
      `${issuePath}.maxBytes`,
    );
    return undefined;
  }
  if (raw.unit !== undefined && raw.unit !== "utf8-bytes") {
    return undefined;
  }
  return createBudget(raw.maxBytes);
}

function normalizeProfile(value: unknown, index: number, issues: ProfileIssue[]): ProfileDefinition | undefined {
  const issuePrefix = `profiles[${index}]`;
  if (!isRecord(value)) {
    issue(issues, "PROFILE_ENTRY_INVALID", "Profile entry must be an object.", issuePrefix);
    return undefined;
  }

  for (const key of unknownKeys(value, [
    "name",
    "id",
    "description",
    "source",
    "adapter",
    "view",
    "budget",
    "renderer",
  ])) {
    issue(issues, "PROFILE_FIELD_UNKNOWN", `Unknown profile property "${key}".`, `${issuePrefix}.${key}`);
  }

  const rawName = value.name ?? value.id;
  if (value.name !== undefined && value.id !== undefined && value.name !== value.id) {
    issue(
      issues,
      "PROFILE_NAME_AMBIGUOUS",
      "Profile name and id must match when both are supplied.",
      `${issuePrefix}.name`,
    );
  }
  if (typeof rawName !== "string" || rawName.trim() === "") {
    issue(issues, "PROFILE_NAME_INVALID", "Profile name must be a non-empty string.", `${issuePrefix}.name`);
  }
  if (typeof value.description !== "string" || value.description.trim() === "") {
    issue(
      issues,
      "PROFILE_DESCRIPTION_INVALID",
      "Profile description must be a non-empty string.",
      `${issuePrefix}.description`,
    );
  }

  const source = normalizeSourceDescription(value.source, `${issuePrefix}.source`, issues);
  const adapter = normalizeReference(value.adapter, `${issuePrefix}.adapter`, issues);
  const view = normalizeReference(value.view, `${issuePrefix}.view`, issues);
  const renderer = normalizeReference(value.renderer, `${issuePrefix}.renderer`, issues);
  const budget = normalizeBudget(value.budget, `${issuePrefix}.budget`, issues);

  if (
    typeof rawName !== "string" ||
    rawName.trim() === "" ||
    typeof value.description !== "string" ||
    value.description.trim() === "" ||
    source === undefined ||
    adapter === undefined ||
    view === undefined ||
    renderer === undefined ||
    budget === undefined
  ) {
    return undefined;
  }

  return {
    name: rawName,
    description: value.description,
    source,
    adapter,
    view,
    budget,
    renderer,
  };
}

export function validateProfileDocument(input: unknown): ProfileValidationResult {
  const issues: ProfileIssue[] = [];
  if (!isRecord(input)) {
    issue(issues, "PROFILE_DOCUMENT_INVALID", "Profile document must be an object.", "$");
    return { valid: false, issues };
  }

  for (const key of unknownKeys(input, ["$schema", "schemaVersion", "version", "profiles"])) {
    issue(issues, "PROFILE_FIELD_UNKNOWN", `Unknown profile document property "${key}".`, `$.${key}`);
  }

  const rawVersion = input.schemaVersion ?? input.version;
  if (input.schemaVersion !== undefined && input.version !== undefined && input.schemaVersion !== input.version) {
    issue(
      issues,
      "PROFILE_SCHEMA_AMBIGUOUS",
      "schemaVersion and version must match when both are supplied.",
      "$.schemaVersion",
    );
  }
  if (rawVersion !== PROFILE_SCHEMA_VERSION && rawVersion !== String(PROFILE_SCHEMA_VERSION)) {
    issue(
      issues,
      "PROFILE_SCHEMA_UNSUPPORTED",
      `Profile schema version must be ${PROFILE_SCHEMA_VERSION}.`,
      "$.schemaVersion",
      {
        received: rawVersion,
      },
    );
  }

  if (!Array.isArray(input.profiles)) {
    issue(issues, "PROFILE_LIST_INVALID", "Profile document profiles must be an array.", "$.profiles");
    return { valid: false, issues };
  }

  const profiles: ProfileDefinition[] = [];
  for (const [index, value] of input.profiles.entries()) {
    const profile = normalizeProfile(value, index, issues);
    if (profile !== undefined) {
      profiles.push(profile);
    }
  }

  const names = new Map<string, number>();
  for (const profile of profiles) {
    const count = (names.get(profile.name) ?? 0) + 1;
    names.set(profile.name, count);
  }
  for (const [name, count] of [...names.entries()].sort(([left], [right]) => compareStrings(left, right))) {
    if (count > 1) {
      issue(issues, "PROFILE_NAME_DUPLICATE", `Profile name "${name}" is declared more than once.`, "$.profiles", {
        name,
        count,
      });
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  profiles.sort((left, right) => compareStrings(left.name, right.name));
  return {
    valid: true,
    issues: [],
    document: { schemaVersion: PROFILE_SCHEMA_VERSION, profiles },
  };
}

export function parseProfileDocument(input: unknown): ProfileDocument {
  const result = validateProfileDocument(input);
  if (!result.valid || result.document === undefined) {
    throw new ProfileError("PROFILE_INVALID", undefined, { issues: result.issues });
  }
  return result.document;
}

export function resolveProfile(document: ProfileDocument, name: string): ProfileDefinition {
  const matches = document.profiles.filter((profile) => profile.name === name);
  if (matches.length === 0) {
    throw new ProfileError("PROFILE_NOT_FOUND", undefined, { name });
  }
  if (matches.length > 1) {
    throw new ProfileError("PROFILE_AMBIGUOUS", undefined, { name, matches: matches.map((profile) => profile.name) });
  }
  return matches[0];
}

export function resolveProfilePath(profilePath = DEFAULT_PROFILE_PATH, cwd = process.cwd()): string {
  return path.isAbsolute(profilePath) ? profilePath : path.resolve(cwd, profilePath);
}

export function readProfileFile(profilePath = DEFAULT_PROFILE_PATH, cwd = process.cwd()): unknown {
  const resolvedPath = resolveProfilePath(profilePath, cwd);
  let contents: string;
  try {
    contents = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const code = isNodeError(error) && error.code === "ENOENT" ? "PROFILE_FILE_NOT_FOUND" : "PROFILE_FILE_INVALID";
    throw new ProfileError(code, undefined, { path: resolvedPath });
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new ProfileError("PROFILE_FILE_INVALID", undefined, {
      path: resolvedPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function loadProfileDocument(profilePath = DEFAULT_PROFILE_PATH, cwd = process.cwd()): ProfileDocument {
  return parseProfileDocument(readProfileFile(profilePath, cwd));
}

export function validateProfileFile(profilePath = DEFAULT_PROFILE_PATH, cwd = process.cwd()): ProfileValidationResult {
  try {
    return validateProfileDocument(readProfileFile(profilePath, cwd));
  } catch (error) {
    if (error instanceof ProfileError) {
      return {
        valid: false,
        issues: [{ code: error.code, message: error.message, path: "$", details: error.details }],
      };
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function sourceWithProfileDescription(source: SourceInput, description: ProfileSourceDescription): ProjectionSource {
  const normalized: ProjectionSource =
    typeof source === "string"
      ? { content: source }
      : source instanceof Uint8Array
        ? { content: new Uint8Array(source) }
        : {
            ...source,
            content: typeof source.content === "string" ? source.content : new Uint8Array(source.content),
          };

  return {
    ...normalized,
    ...(normalized.identity === undefined && description.identity === undefined
      ? {}
      : { identity: normalized.identity ?? description.identity }),
    ...(normalized.mediaType === undefined && description.mediaType === undefined
      ? {}
      : { mediaType: normalized.mediaType ?? description.mediaType }),
  };
}

export interface ProfileRunOptions {
  readonly core?: ProjectionCore;
}

export function runProfile(profile: ProfileDefinition, source: SourceInput, core: ProjectionCore): ProjectionResult;
export function runProfile(
  profile: ProfileDefinition,
  source: SourceInput,
  options?: ProfileRunOptions,
): ProjectionResult;
export function runProfile(
  profile: ProfileDefinition,
  source: SourceInput,
  options: ProfileRunOptions | ProjectionCore = {},
): ProjectionResult {
  const core = isProjectionCore(options) ? options : (options.core ?? createProfileCore());
  return core.project({
    source: sourceWithProfileDescription(source, profile.source),
    adapter: profile.adapter,
    view: profile.view,
    budget: profile.budget,
    renderer: profile.renderer,
  });
}

function isProjectionCore(value: ProfileRunOptions | ProjectionCore): value is ProjectionCore {
  return typeof value === "object" && value !== null && "project" in value && typeof value.project === "function";
}

export type InspectionKind = "adapters" | "semantic-contracts" | "views" | "renderers";

export interface ComponentInspection {
  readonly kind: InspectionKind;
  readonly components: readonly ComponentDescriptor[];
}

export function inspectComponents(core: ProjectionCore, kind: InspectionKind): ComponentInspection {
  const components =
    kind === "adapters"
      ? core.adapters.describe()
      : kind === "semantic-contracts"
        ? core.semanticContracts.describe()
        : kind === "views"
          ? core.views.describe()
          : core.renderers.describe();
  return { kind, components };
}

export interface ProfileComponentRegistries {
  readonly adapters: Readonly<Record<string, Adapter>>;
  readonly semanticContracts: Readonly<Record<string, SemanticContract>>;
  readonly views: Readonly<Record<string, View>>;
  readonly renderers: Readonly<Record<string, Renderer>>;
}

export function profileReferenceIdentity(reference: ComponentReference): ComponentIdentity {
  if (typeof reference === "string") {
    const separator = reference.lastIndexOf("@");
    return separator > 0
      ? { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
      : { id: reference, version: "*" };
  }
  return { id: reference.id, version: reference.version };
}

export function stableProfileJson(document: ProfileDocument): string {
  const sortedProfiles = [...document.profiles].sort((left, right) => compareStrings(left.name, right.name));
  return JSON.stringify(
    {
      schemaVersion: document.schemaVersion,
      profiles: sortedProfiles.map((profile) => ({
        name: profile.name,
        description: profile.description,
        source: profile.source,
        adapter: profile.adapter,
        view: profile.view,
        budget: profile.budget,
        renderer: profile.renderer,
      })),
    },
    null,
    2,
  );
}

export function profileErrorToJson(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof ProfileError) {
    return error.toJSON();
  }
  if (isSuzukuriError(error)) {
    return { ...error.toJSON() };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function isSuzukuriError(error: unknown): error is SuzukuriError {
  return typeof error === "object" && error !== null && "toJSON" in error && typeof error.toJSON === "function";
}
