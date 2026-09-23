import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stableJsonStringify } from "./core.js";
import {
  isSteppedExecutionCommand,
  type ExecutionCommand,
  type ExecutionCommandName,
  type ExecutionCommandStep,
  type SteppedExecutionCommand,
} from "./execution.js";
import { computeRepositoryFingerprint, RepositoryFingerprintError } from "./repository-fingerprint.js";
import {
  isVerificationEvidence,
  VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  type VerificationEvidence,
} from "./verify-result.js";

export const EXECUTION_CACHE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_EXECUTION_CACHE_DIRECTORY = ".suzukuri/cache/execution-results";
/** Bounds the cache to a fixed maximum number of stored entries. */
export const DEFAULT_EXECUTION_CACHE_MAX_ENTRIES = 200;

export interface CachedExecutionOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly printed: unknown;
  readonly evidence?: VerificationEvidence;
}

export interface ExecutionCacheEntry {
  readonly schemaVersion: typeof EXECUTION_CACHE_SCHEMA_VERSION;
  readonly command: ExecutionCommandName;
  readonly fingerprint: string;
  readonly outcome: CachedExecutionOutcome;
  /**
   * Monotonically increasing write sequence number, used only to make
   * eviction order deterministic (oldest write evicted first) independent
   * of filesystem mtime resolution or clock behavior.
   */
  readonly sequence: number;
}

export interface ExecutionCacheOptions {
  readonly cacheDirectory?: string;
  readonly cwd?: string;
  readonly maxEntries?: number;
}

/**
 * A bounded on-disk store of semantic execution results keyed by repository
 * content fingerprint plus the exact producer definition, so different
 * commands or configurations can never share a cached result. Only the
 * bounded semantic result and minimum identity metadata are retained; raw
 * producer stdout/stderr is never stored here.
 */
export class ExecutionResultCache {
  private readonly directory: string;
  private readonly maxEntries: number;

  constructor(options: ExecutionCacheOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const cacheDirectory = options.cacheDirectory ?? DEFAULT_EXECUTION_CACHE_DIRECTORY;
    this.directory = path.isAbsolute(cacheDirectory) ? cacheDirectory : path.resolve(cwd, cacheDirectory);
    this.maxEntries = options.maxEntries ?? DEFAULT_EXECUTION_CACHE_MAX_ENTRIES;
  }

  key(commandName: ExecutionCommandName, command: ExecutionCommand, fingerprint: string): string {
    return createHash("sha256").update(stableJsonStringify({ commandName, command, fingerprint })).digest("hex");
  }

  read(key: string): CachedExecutionOutcome | undefined {
    const entry = this.readEntry(key);
    return entry?.outcome;
  }

  /**
   * Stores an entry, then deterministically evicts the oldest entries (by
   * write sequence, ties broken by key) until the store holds at most
   * `maxEntries` — bounding total cache state regardless of how many
   * distinct worktrees or producer definitions have been seen.
   */
  write(key: string, commandName: ExecutionCommandName, fingerprint: string, outcome: CachedExecutionOutcome): void {
    fs.mkdirSync(this.directory, { recursive: true });
    const entry: ExecutionCacheEntry = {
      schemaVersion: EXECUTION_CACHE_SCHEMA_VERSION,
      command: commandName,
      fingerprint,
      outcome,
      sequence: this.nextSequence(),
    };
    const target = this.entryPath(key);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entry));
    fs.renameSync(temporary, target);
    this.evictOverflow();
  }

  private readEntry(key: string): ExecutionCacheEntry | undefined {
    let contents: string;
    try {
      contents = fs.readFileSync(this.entryPath(key), "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return undefined;
    }
    if (!isCacheEntry(parsed) || parsed.schemaVersion !== EXECUTION_CACHE_SCHEMA_VERSION) return undefined;
    return parsed;
  }

  private listEntryKeys(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
  }

  private nextSequence(): number {
    let highest = 0;
    for (const key of this.listEntryKeys()) {
      const entry = this.readEntry(key);
      if (entry !== undefined && entry.sequence > highest) highest = entry.sequence;
    }
    return highest + 1;
  }

  private evictOverflow(): void {
    // An entry that fails to parse (corrupt write, incompatible schema) is
    // treated as older than everything else so it is evicted first — it
    // still counts toward the bound but can never survive it in place of a
    // readable entry.
    const entries = this.listEntryKeys()
      .map((key) => ({ key, sequence: this.readEntry(key)?.sequence ?? -1 }))
      .sort((left, right) => left.sequence - right.sequence || compareStrings(left.key, right.key));
    const overflow = entries.length - this.maxEntries;
    for (let index = 0; index < overflow; index += 1) {
      try {
        fs.rmSync(this.entryPath(entries[index].key));
      } catch {
        // Already gone (e.g. a concurrent evict): nothing left to bound.
      }
    }
  }

  private entryPath(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ExecutionCacheLookup {
  readonly cacheKey: string;
  readonly fingerprint: string;
  readonly cached: CachedExecutionOutcome | undefined;
  /**
   * Stores `outcome` for this lookup's key, but only if the repository
   * content fingerprint is unchanged from the one this lookup was resolved
   * against. A producer can take arbitrary time to run and is free to
   * modify the working tree; without this recheck, a result produced for
   * content observed at lookup time could be filed under a fingerprint that
   * no longer describes what the producer actually saw, and a later restore
   * of that content would incorrectly reuse it. When the recheck itself
   * fails or the content changed, the outcome is silently not cached —
   * this only affects caching, never the result already returned to the
   * caller for the current invocation. For verification projections, the
   * method returns evidence only when the post-run fingerprint still matches
   * the lookup fingerprint and the bounded result is committed.
   */
  commit(outcome: CachedExecutionOutcome): Promise<VerificationEvidence | undefined>;
}

/**
 * Resolves a cache lookup for a producer invocation. Returns `undefined`
 * when the repository content fingerprint cannot be proven complete and
 * stable, so callers fail closed to a live producer run without caching its
 * result rather than risk keying on or reusing an unsafe fingerprint.
 *
 * Also returns `undefined` when the command's own `reuse` mode is `"never"`:
 * an unchanged repository fingerprint proves the tracked/non-ignored file
 * content is identical, but it proves nothing about a command's side
 * effects (network calls, writes outside the fingerprinted tree, external
 * state). Reuse is therefore conservative and commands must opt in.
 */
export async function lookupExecutionCache(
  commandName: ExecutionCommandName,
  command: ExecutionCommand,
  options: ExecutionCacheOptions = {},
): Promise<ExecutionCacheLookup | undefined> {
  if (command.reuse === "never") return undefined;
  const inputs = isSteppedExecutionCommand(command)
    ? command.inputs === undefined && command.steps.some((step) => step.inputs === undefined)
      ? undefined
      : [...new Set([...(command.inputs ?? []), ...command.steps.flatMap((step) => step.inputs ?? [])])]
    : command.inputs;
  return lookupCacheForIdentity(commandName, command, inputs, options);
}

/** Resolves a separate cache identity and input fingerprint for one ordered step. */
export async function lookupExecutionStepCache(
  commandName: ExecutionCommandName,
  command: SteppedExecutionCommand,
  step: ExecutionCommandStep,
  options: ExecutionCacheOptions = {},
): Promise<ExecutionCacheLookup | undefined> {
  if (command.reuse === "never") return undefined;
  const scopedInputs = [...new Set([...(command.inputs ?? []), ...(step.inputs ?? [])])];
  const inputs = scopedInputs.length === 0 ? undefined : scopedInputs;
  const identity: SteppedExecutionCommand = {
    steps: [
      {
        ...step,
        ...(inputs === undefined ? {} : { inputs }),
        ...(step.tier === undefined && command.tier !== undefined ? { tier: command.tier } : {}),
      },
    ],
    projection: command.projection,
    reuse: command.reuse,
  };
  return lookupCacheForIdentity(commandName, identity, inputs, options);
}

async function lookupCacheForIdentity(
  commandName: ExecutionCommandName,
  command: ExecutionCommand,
  inputs: readonly string[] | undefined,
  options: ExecutionCacheOptions,
): Promise<ExecutionCacheLookup | undefined> {
  let fingerprint: string;
  try {
    fingerprint = await computeRepositoryFingerprint(options.cwd, inputs);
  } catch (error) {
    if (error instanceof RepositoryFingerprintError) return undefined;
    throw error;
  }
  const cache = new ExecutionResultCache(options);
  const cacheKey = cache.key(commandName, command, fingerprint);
  const stored = cache.read(cacheKey);
  const cached =
    stored === undefined || command.projection === "generic"
      ? stored
      : isCurrentVerificationEvidence(stored, commandName, command, fingerprint)
        ? stored
        : undefined;
  return {
    cacheKey,
    fingerprint,
    cached,
    commit: async (outcome) => {
      let postFingerprint: string;
      try {
        postFingerprint = await computeRepositoryFingerprint(options.cwd, inputs);
      } catch {
        return undefined;
      }
      if (postFingerprint !== fingerprint) return undefined;
      const evidence =
        command.projection === "generic"
          ? undefined
          : createVerificationEvidence(commandName, command, fingerprint, outcome);
      cache.write(cacheKey, commandName, fingerprint, {
        ...outcome,
        ...(evidence === undefined ? {} : { evidence }),
      });
      return evidence;
    },
  };
}

function createVerificationEvidence(
  commandName: ExecutionCommandName,
  command: ExecutionCommand,
  inputFingerprint: string,
  outcome: CachedExecutionOutcome,
): VerificationEvidence {
  const step = isSteppedExecutionCommand(command) && command.steps.length === 1 ? command.steps[0] : undefined;
  const tier = step?.tier ?? command.tier;
  const producerDefinitionIdentity = hashIdentity({ commandName, command });
  const resultIdentity = hashIdentity({
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    result: outcome.printed,
  });
  return {
    version: VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    identity: hashIdentity({
      version: VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      producerIdentity: producerDefinitionIdentity,
      inputFingerprint,
      resultIdentity,
    }),
    producerIdentity: producerDefinitionIdentity,
    inputFingerprint,
    resultIdentity,
    execution: "executed",
    ...(tier === undefined ? {} : { tier }),
  };
}

function isCurrentVerificationEvidence(
  outcome: CachedExecutionOutcome,
  commandName: ExecutionCommandName,
  command: ExecutionCommand,
  fingerprint: string,
): boolean {
  if (!isVerificationEvidence(outcome.evidence) || outcome.evidence.execution !== "executed") return false;
  const expected = createVerificationEvidence(commandName, command, fingerprint, outcome);
  return stableJsonStringify(outcome.evidence) === stableJsonStringify(expected);
}

function hashIdentity(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

/**
 * Marks a cached result as reused rather than freshly produced, so it is
 * machine-readable as cached evidence and never mistaken for a live
 * producer run. Only defined for JSON object results; any other shape is
 * left untouched since it has no field to carry the marker.
 */
export function markResultReused(printed: unknown): unknown {
  if (typeof printed !== "object" || printed === null || Array.isArray(printed)) return printed;
  return { ...(printed as Record<string, unknown>), reused: true };
}

function isCacheEntry(value: unknown): value is ExecutionCacheEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "outcome" in value &&
    "fingerprint" in value &&
    "command" in value &&
    "sequence" in value &&
    typeof (value as { sequence: unknown }).sequence === "number"
  );
}
