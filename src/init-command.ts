import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { stableJsonStringify } from "./core.js";
import { DEFAULT_EXECUTION_CONFIG_PATH, EXECUTION_SCHEMA_VERSION, parseExecutionConfig } from "./execution.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };

type OptionValue = string | true;

export interface InitCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

export interface InitCommandDependencies {
  readonly cwd?: string;
  /** Overrides the interactive stdin confirmation prompt; used by tests. */
  readonly confirm?: (question: string) => Promise<boolean>;
}

export class InitCommandError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "InitCommandError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

interface StepPlan {
  readonly name: string;
  readonly argv: readonly [string, ...string[]];
}

interface CommandPlan {
  readonly kind: "single" | "steps";
  readonly argv?: readonly [string, ...string[]];
  readonly steps?: readonly StepPlan[];
  readonly projection: "generic" | "test-result" | "verification-result";
}

interface ScriptMigration {
  readonly scriptName: string;
  readonly originalScript: string;
  readonly plan: CommandPlan | undefined;
  /** Set when the composite script could not be parsed safely and losslessly. */
  readonly unresolvedReason: string | undefined;
}

export interface InitPlan {
  readonly packageManager: "pnpm" | "npm";
  readonly migrations: readonly ScriptMigration[];
  readonly commandsConfig: unknown;
  readonly importedCommandCount: number;
  readonly addDevDependency: boolean;
  readonly alreadyInitialized: boolean;
  /** package.json scripts to remove once imported, so `suzukuri run <name>` becomes the sole agent-facing entry point. */
  readonly scriptsToRemove: readonly string[];
  /** npm/pnpm lifecycle scripts whose body must be rewritten to call `suzukuri run <name>` because they reference a script being removed. */
  readonly lifecycleRewrites: Readonly<Record<string, string>>;
}

/**
 * npm/pnpm lifecycle hook names that the package manager invokes directly
 * (on install/pack/publish/version) rather than a human or agent running
 * `pnpm run <name>`. These are ecosystem plumbing, not repository-operation
 * vocabulary, so they are never migrated into the registry and are never
 * removed from package.json — only rewritten in place if their body invokes
 * a script that is being migrated out.
 */
const NPM_LIFECYCLE_SCRIPT_NAMES: ReadonlySet<string> = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
  "prepublishOnly",
  "publish",
  "postpublish",
  "preversion",
  "version",
  "postversion",
  "pretest",
  "posttest",
  "prestart",
  "poststart",
  "prestop",
  "poststop",
  "prerestart",
  "postrestart",
]);

/**
 * Guided repository-adoption flow: inspect the existing package.json script
 * vocabulary, propose importing it into `.suzukuri/commands.json` as the
 * canonical Suzukuri command registry, show the full plan, confirm, apply.
 * Every imported script is removed from package.json so `suzukuri run
 * <name>` becomes the sole agent-facing entry point; only npm/pnpm lifecycle
 * hooks (prepare, prepack, prepublishOnly, etc.) are left in package.json,
 * rewritten in place to call `suzukuri run <name>` if they referenced a
 * script that was just removed.
 */
export async function runInitCommand(
  parsed: InitCommandArguments,
  dependencies: InitCommandDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const confirm = dependencies.confirm ?? promptConfirm;
  const assumeYes = hasOption(parsed, "yes", "y");
  const dryRun = hasOption(parsed, "dry-run");

  const plan = buildInitPlan(cwd);

  printPlan(plan);

  if (plan.alreadyInitialized) {
    return 0;
  }

  if (dryRun) {
    return 0;
  }

  const confirmed = assumeYes ? true : await confirm("Apply this migration? [y/N] ");
  if (!confirmed) {
    console.log("Aborted: no files were changed.");
    return 1;
  }

  applyInitPlan(cwd, plan);
  validateAppliedPlan(cwd);
  console.log("suzukuri init complete.");
  return 0;
}

function buildInitPlan(cwd: string): InitPlan {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new InitCommandError(
      "INIT_ECOSYSTEM_UNSUPPORTED",
      "No package.json found: suzukuri init supports Node/pnpm/npm repositories only.",
    );
  }
  const packageManager = detectPackageManager(cwd);
  const packageJsonContent = readPackageJson(packageJsonPath);
  const scripts = packageJsonContent.scripts ?? {};

  const existingConfig = readExistingConfig(cwd);
  const existingCommands = existingConfig?.commands ?? {};

  const migrations: ScriptMigration[] = [];
  for (const scriptName of Object.keys(scripts).sort()) {
    const script = scripts[scriptName];
    if (isAlreadyImported(existingCommands[scriptName], scriptName, script, scripts)) continue;
    const plan = planForScript(scriptName, script, scripts);
    migrations.push({
      scriptName,
      originalScript: script,
      plan: plan.ok ? plan.plan : undefined,
      unresolvedReason: plan.ok ? undefined : plan.reason,
    });
  }

  const commands: Record<string, unknown> = { ...existingCommands };
  let importedCommandCount = 0;
  for (const migration of migrations) {
    if (migration.plan === undefined) continue;
    commands[migration.scriptName] = commandPlanToConfig(migration.plan);
    importedCommandCount += 1;
  }

  const commandsConfig = {
    $schema: "suzukuri/execution/v1",
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    commands,
  };

  // Every non-lifecycle script that ends up represented in the registry
  // (whether imported just now or already present from a prior run) is
  // removed from package.json, so `pnpm run <name>` stops being a viable
  // agent-facing alternative to `suzukuri run <name>`. Lifecycle hooks and
  // unresolved (unresolvable) scripts are left in package.json untouched.
  const scriptsToRemove = Object.keys(scripts)
    .filter((scriptName) => !NPM_LIFECYCLE_SCRIPT_NAMES.has(scriptName))
    .filter((scriptName) => commands[scriptName] !== undefined)
    .sort();

  const lifecycleRewrites = computeLifecycleRewrites(scripts, scriptsToRemove);

  const addDevDependency = packageJsonContent.devDependencies?.suzukuri === undefined;
  const alreadyInitialized =
    importedCommandCount === 0 &&
    existingConfig !== undefined &&
    !addDevDependency &&
    scriptsToRemove.length === 0 &&
    Object.keys(lifecycleRewrites).length === 0;

  return {
    packageManager,
    migrations,
    commandsConfig,
    importedCommandCount,
    addDevDependency,
    scriptsToRemove,
    lifecycleRewrites,
    alreadyInitialized,
  };
}

/**
 * A script already represented in the registry under an unchanged shape is
 * not re-proposed, making re-runs idempotent. Compares against whichever
 * plan `planForScript` would currently produce for this script, so both
 * single-argv and ordered-steps commands are recognized as already
 * imported rather than only the single-argv shape. Both sides are run
 * through `parseExecutionConfig`'s own normalization (which fills in
 * default `projection`/`reuse`) before comparing, so an existing entry
 * written with implicit defaults compares equal to a freshly generated one
 * that also relies on those same defaults.
 */
function isAlreadyImported(
  existing: unknown,
  scriptName: string,
  script: string,
  scripts: Readonly<Record<string, string>>,
): boolean {
  if (!isRecord(existing)) return false;
  const result = planForScript(scriptName, script, scripts);
  if (!result.ok) return false;
  const candidate = commandPlanToConfig(result.plan);
  const normalizedExisting = normalizeCommandForComparison(scriptName, existing);
  const normalizedCandidate = normalizeCommandForComparison(scriptName, candidate);
  if (normalizedExisting === undefined || normalizedCandidate === undefined) return false;
  return JSON.stringify(normalizedExisting) === JSON.stringify(normalizedCandidate);
}

/** Normalizes a single command definition through the same schema the registry file is validated against, or undefined if it doesn't parse. */
function normalizeCommandForComparison(scriptName: string, command: unknown): unknown {
  try {
    return parseExecutionConfig({ schemaVersion: EXECUTION_SCHEMA_VERSION, commands: { [scriptName]: command } })
      .commands[scriptName];
  } catch {
    return undefined;
  }
}

function detectPackageManager(cwd: string): "pnpm" | "npm" {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  throw new InitCommandError(
    "INIT_ECOSYSTEM_UNSUPPORTED",
    "No pnpm-lock.yaml or package-lock.json found: suzukuri init supports pnpm and npm repositories only.",
  );
}

function readPackageJson(packageJsonPath: string): PackageJson {
  let contents: string;
  try {
    contents = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    throw new InitCommandError("INIT_PACKAGE_JSON_UNREADABLE", "package.json could not be read.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return JSON.parse(contents) as PackageJson;
  } catch (error) {
    throw new InitCommandError("INIT_PACKAGE_JSON_INVALID", "package.json is not valid JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A missing registry is a legitimate "not yet initialized" state, but an
 * existing, unparsable registry is not: silently treating it as absent would
 * let init generate a fresh registry and, on confirmation, overwrite the
 * broken file — destroying whatever was there. Fail closed instead.
 */
function readExistingConfig(cwd: string): { commands: Record<string, unknown> } | undefined {
  const configPath = path.join(cwd, DEFAULT_EXECUTION_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new InitCommandError(
      "INIT_EXISTING_CONFIG_INVALID",
      `${DEFAULT_EXECUTION_CONFIG_PATH} exists but is not valid JSON. Fix or remove it before running suzukuri init.`,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
  try {
    const parsed = parseExecutionConfig(raw);
    return { commands: parsed.commands as Record<string, unknown> };
  } catch (error) {
    throw new InitCommandError(
      "INIT_EXISTING_CONFIG_INVALID",
      `${DEFAULT_EXECUTION_CONFIG_PATH} exists but does not match the execution command schema. Fix or remove it before running suzukuri init.`,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

type ScriptPlanResult =
  { readonly ok: true; readonly plan: CommandPlan } | { readonly ok: false; readonly reason: string };

/** The known semantic projection for a repository-vocabulary command name, or "generic" for anything else. */
function projectionForName(scriptName: string): CommandPlan["projection"] {
  if (scriptName === "test") return "test-result";
  if (scriptName === "verify") return "verification-result";
  return "generic";
}

/**
 * Interprets an existing package script into a suzukuri command plan. A
 * simple script becomes a single producer; a `&&`-joined composite of
 * `pnpm run <script>` / `npm run <script>` segments becomes ordered steps
 * naming each referenced script. Anything else is reported unresolved rather
 * than guessed, per the issue's fail-closed requirement. Producer behavior
 * is preserved exactly — no new validation stage is invented.
 */
function planForScript(
  scriptName: string,
  script: string,
  scripts: Readonly<Record<string, string>>,
): ScriptPlanResult {
  const projection = projectionForName(scriptName);
  const segments = splitTopLevelAnd(script);
  if (segments === undefined) {
    return { ok: false, reason: "The script contains shell syntax that cannot be split safely and losslessly." };
  }
  if (segments.length === 1) {
    const argv = tokenize(segments[0]);
    if (argv === undefined) {
      return { ok: false, reason: "The script could not be tokenized safely into an argv array." };
    }
    return { ok: true, plan: { kind: "single", argv, projection } };
  }
  const steps: StepPlan[] = [];
  for (const segment of segments) {
    const referencedScript = matchRunScript(segment);
    if (referencedScript === undefined) {
      return {
        ok: false,
        reason: `The composite script step "${segment}" is not a plain "pnpm run <script>"/"npm run <script>" call.`,
      };
    }
    if (referencedScript === scriptName) {
      return { ok: false, reason: `A composite script step must not recursively invoke "${scriptName}".` };
    }
    if (scripts[referencedScript] === undefined) {
      return { ok: false, reason: `The composite script references undefined script "${referencedScript}".` };
    }
    const argv = tokenize(segment);
    if (argv === undefined) {
      return { ok: false, reason: `Step "${referencedScript}" could not be tokenized safely.` };
    }
    steps.push({ name: referencedScript, argv });
  }
  return { ok: true, plan: { kind: "steps", steps, projection } };
}

/**
 * Lifecycle hooks are never removed, but a hook that invokes a script being
 * migrated out (e.g. `prepack: "pnpm run build"`) must keep working once
 * that script disappears from package.json. Each `&&`-joined segment that is
 * a plain `pnpm run <script>`/`npm run <script>`/`pnpm test`/`npm test` call
 * naming a removed script is rewritten to `suzukuri run <script>`; anything
 * else in the hook body is left untouched. A hook with no reference to a
 * removed script is omitted from the result.
 */
function computeLifecycleRewrites(
  scripts: Readonly<Record<string, string>>,
  scriptsToRemove: readonly string[],
): Record<string, string> {
  const removed = new Set(scriptsToRemove);
  const rewrites: Record<string, string> = {};
  for (const [scriptName, script] of Object.entries(scripts)) {
    if (!NPM_LIFECYCLE_SCRIPT_NAMES.has(scriptName)) continue;
    const segments = splitTopLevelAnd(script);
    if (segments === undefined) continue;
    let changed = false;
    const rewritten = segments.map((segment) => {
      const referencedScript = matchRunScript(segment);
      if (referencedScript === undefined || !removed.has(referencedScript)) return segment;
      changed = true;
      return `suzukuri run ${referencedScript}`;
    });
    if (changed) rewrites[scriptName] = rewritten.join(" && ");
  }
  return rewrites;
}

function matchRunScript(segment: string): string | undefined {
  const trimmed = segment.trim();
  const run = trimmed.match(/^(?:pnpm|npm)\s+run\s+([A-Za-z0-9][A-Za-z0-9_.:-]*)$/);
  if (run !== null) return run[1];
  // `pnpm test`/`npm test` is the standard shorthand for `pnpm run test`.
  return /^(?:pnpm|npm)\s+test$/.test(trimmed) ? "test" : undefined;
}

/** Splits on bare top-level `&&` only; returns undefined for any other control operator. */
function splitTopLevelAnd(script: string): string[] | undefined {
  if (/\|\||[;|`]|\$\(|<|>|(?<!&)&(?!&)/.test(stripQuotedSections(script))) {
    return undefined;
  }
  const parts = script.split("&&").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) return undefined;
  return parts;
}

/** Replaces quoted spans with placeholders so control-operator detection ignores their contents. */
function stripQuotedSections(value: string): string {
  return value.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (match) => "x".repeat(match.length));
}

/** Minimal, fail-closed shell-word tokenizer: single/double quotes only, no expansion of any kind. */
function tokenize(command: string): [string, ...string[]] | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  if (/[$`<>|;&]/.test(stripQuotedSections(trimmed))) return undefined;
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== undefined) return undefined;
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) return undefined;
  return tokens as [string, ...string[]];
}

function commandPlanToConfig(plan: CommandPlan): unknown {
  const projection = plan.projection === "generic" ? {} : { projection: plan.projection };
  if (plan.kind === "single") {
    return { argv: plan.argv, ...projection };
  }
  return { steps: plan.steps?.map((step) => ({ name: step.name, argv: step.argv })), ...projection };
}

function printPlan(plan: InitPlan): void {
  console.log(`Detected package manager: ${plan.packageManager}`);
  if (plan.alreadyInitialized) {
    console.log("Repository command registry is already up to date. Re-running is a no-op.");
    return;
  }
  for (const migration of plan.migrations) {
    if (migration.plan === undefined) {
      console.log(`- ${migration.scriptName}: left unchanged (${migration.unresolvedReason})`);
      continue;
    }
    console.log(
      `- ${migration.scriptName}: import as ${migration.plan.kind === "steps" ? "ordered steps" : "a single producer"} (${migration.plan.projection})`,
    );
  }
  if (plan.importedCommandCount > 0) {
    console.log("\nProposed .suzukuri/commands.json:");
    console.log(stableJsonStringify(plan.commandsConfig));
  }
  if (plan.scriptsToRemove.length > 0) {
    console.log(
      `\npackage.json scripts to remove (now reachable only via suzukuri run): ${plan.scriptsToRemove.join(", ")}`,
    );
  }
  for (const [scriptName, rewritten] of Object.entries(plan.lifecycleRewrites)) {
    console.log(`package.json lifecycle script "${scriptName}" will be rewritten to: ${rewritten}`);
  }
  if (plan.addDevDependency) {
    console.log(`\nProposed devDependency: suzukuri@${packageJson.version}`);
  }
}

function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

/**
 * Applies the accepted plan. Every mutation is staged first — the registry
 * to a temp file, package.json to an in-memory candidate — and the package
 * manager lockfile is updated (which is the only step that can fail for
 * reasons outside our control, e.g. a missing binary or network-dependent
 * resolution) before any file is committed. Only once the lockfile mutation
 * has succeeded are package.json and the registry renamed into place, and
 * that rename order is chosen so a crash between them leaves package.json
 * (with its devDependency and pruned scripts) already consistent with the
 * lockfile, with only the registry file still to land — never the reverse,
 * which would leave a registry with no declared dependency.
 */
function applyInitPlan(cwd: string, plan: InitPlan): void {
  const configDirectory = path.join(cwd, path.dirname(DEFAULT_EXECUTION_CONFIG_PATH));
  const configPath = path.join(cwd, DEFAULT_EXECUTION_CONFIG_PATH);
  fs.mkdirSync(configDirectory, { recursive: true });
  const configTemp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(configTemp, `${JSON.stringify(plan.commandsConfig, null, 2)}\n`);

  const packageJsonPath = path.join(cwd, "package.json");
  const packageJsonContent = readPackageJson(packageJsonPath);
  const nextPackageJson = computeNextPackageJson(packageJsonContent, plan);

  if (nextPackageJson === undefined) {
    fs.renameSync(configTemp, configPath);
    return;
  }

  const originalPackageJsonRaw = fs.readFileSync(packageJsonPath, "utf8");
  const packageJsonSerialized = `${JSON.stringify(nextPackageJson, null, 2)}\n`;
  fs.writeFileSync(packageJsonPath, packageJsonSerialized);

  // Re-checked against the just-written package.json rather than trusting a
  // plan-time decision, which was made before the confirmation prompt and
  // could be stale if package.json changed in that window. Only the
  // devDependency being newly added needs the lockfile regenerated; a
  // scripts-only change doesn't affect resolved dependencies.
  if (
    packageJsonContent.devDependencies?.suzukuri === undefined &&
    nextPackageJson.devDependencies?.suzukuri !== undefined
  ) {
    try {
      updateLockfile(cwd, plan.packageManager);
    } catch (error) {
      fs.writeFileSync(packageJsonPath, originalPackageJsonRaw);
      fs.rmSync(configTemp, { force: true });
      throw error;
    }
  }

  fs.renameSync(configTemp, configPath);
}

/**
 * Builds the package.json this plan would produce, or undefined when
 * package.json needs no changes at all (nothing to import into scripts and
 * the devDependency is already present).
 */
function computeNextPackageJson(current: PackageJson, plan: InitPlan): PackageJson | undefined {
  let next = current;
  let scriptsChanged = false;
  if (plan.scriptsToRemove.length > 0 || Object.keys(plan.lifecycleRewrites).length > 0) {
    const nextScripts = { ...next.scripts };
    for (const scriptName of plan.scriptsToRemove) {
      if (nextScripts[scriptName] === undefined) continue;
      delete nextScripts[scriptName];
      scriptsChanged = true;
    }
    for (const [scriptName, rewritten] of Object.entries(plan.lifecycleRewrites)) {
      if (nextScripts[scriptName] === rewritten) continue;
      nextScripts[scriptName] = rewritten;
      scriptsChanged = true;
    }
    if (scriptsChanged) next = { ...next, scripts: nextScripts };
  }
  if (plan.addDevDependency && current.devDependencies?.suzukuri === undefined) {
    next = { ...next, devDependencies: { ...next.devDependencies, suzukuri: `^${packageJson.version}` } };
  }
  return next === current ? undefined : next;
}

/**
 * Regenerates the package manager's lockfile from the just-written
 * package.json without touching node_modules, so `devDependencies.suzukuri`
 * is reflected in the lockfile and a subsequent frozen-lockfile / CI install
 * does not fail or drift.
 */
function updateLockfile(cwd: string, packageManager: "pnpm" | "npm"): void {
  const argv: [string, ...string[]] =
    packageManager === "pnpm" ? ["pnpm", "install", "--lockfile-only"] : ["npm", "install", "--package-lock-only"];
  const result = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new InitCommandError(
      "INIT_LOCKFILE_UPDATE_FAILED",
      `Failed to update the lockfile via "${argv.join(" ")}".`,
      {
        status: result.status,
        stderr: result.stderr,
        reason: result.error?.message,
      },
    );
  }
}

function validateAppliedPlan(cwd: string): void {
  const configPath = path.join(cwd, DEFAULT_EXECUTION_CONFIG_PATH);
  parseExecutionConfig(JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown);
}

function hasOption(parsed: InitCommandArguments, ...names: string[]): boolean {
  return names.some((name) => parsed.options[name] !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
