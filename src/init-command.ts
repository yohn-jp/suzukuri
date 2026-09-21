import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
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
}

interface ScriptMigration {
  readonly scriptName: "test" | "verify";
  readonly originalScript: string;
  readonly plan: CommandPlan | undefined;
  /** Set when the composite script could not be parsed safely and losslessly. */
  readonly unresolvedReason: string | undefined;
}

export interface InitPlan {
  readonly packageManager: "pnpm" | "npm";
  readonly migrations: readonly ScriptMigration[];
  readonly commandsConfig: unknown;
  readonly packageJsonScriptChanges: Readonly<Record<string, string>>;
  readonly addDevDependency: boolean;
  readonly alreadyInitialized: boolean;
}

/** Guided repository-adoption flow: inspect, propose, confirm, apply atomically. */
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

  if (plan.migrations.every((migration) => migration.plan === undefined)) {
    console.log("Nothing to migrate: no supported test/verify scripts were found or changes are already applied.");
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
  const alreadyInitialized =
    scripts.test === "suzukuri test" &&
    scripts.verify === "suzukuri verify" &&
    existingConfig !== undefined &&
    packageJsonContent.devDependencies?.suzukuri !== undefined;

  const migrations: ScriptMigration[] = [];
  for (const scriptName of ["test", "verify"] as const) {
    const script = scripts[scriptName];
    if (script === undefined) continue;
    if (script === `suzukuri ${scriptName}`) continue;
    const plan = planForScript(script, scripts);
    migrations.push({
      scriptName,
      originalScript: script,
      plan: plan.ok ? plan.plan : undefined,
      unresolvedReason: plan.ok ? undefined : plan.reason,
    });
  }

  const commands: Record<string, unknown> = { ...(existingConfig?.commands ?? {}) };
  const packageJsonScriptChanges: Record<string, string> = {};
  for (const migration of migrations) {
    if (migration.plan === undefined) continue;
    commands[migration.scriptName] = commandPlanToConfig(migration.plan);
    packageJsonScriptChanges[migration.scriptName] = `suzukuri ${migration.scriptName}`;
  }

  const commandsConfig = {
    $schema: "suzukuri/execution/v1",
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    commands,
  };

  return {
    packageManager,
    migrations,
    commandsConfig,
    packageJsonScriptChanges,
    addDevDependency: packageJsonContent.devDependencies?.suzukuri === undefined,
    alreadyInitialized,
  };
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

function readExistingConfig(cwd: string): { commands: Record<string, unknown> } | undefined {
  const configPath = path.join(cwd, DEFAULT_EXECUTION_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = parseExecutionConfig(JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown);
    return { commands: parsed.commands as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

type ScriptPlanResult =
  { readonly ok: true; readonly plan: CommandPlan } | { readonly ok: false; readonly reason: string };

/**
 * Interprets an existing package script into a suzukuri command plan. A
 * simple script becomes a single producer; a `&&`-joined composite of
 * `pnpm run <script>` / `npm run <script>` segments becomes ordered steps
 * naming each referenced script. Anything else is reported unresolved rather
 * than guessed, per the issue's fail-closed requirement.
 */
function planForScript(script: string, scripts: Readonly<Record<string, string>>): ScriptPlanResult {
  const segments = splitTopLevelAnd(script);
  if (segments === undefined) {
    return { ok: false, reason: "The script contains shell syntax that cannot be split safely and losslessly." };
  }
  if (segments.length === 1) {
    const argv = tokenize(segments[0]);
    if (argv === undefined) {
      return { ok: false, reason: "The script could not be tokenized safely into an argv array." };
    }
    return { ok: true, plan: { kind: "single", argv } };
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
    if (referencedScript === "verify") {
      return { ok: false, reason: 'A composite script step must not recursively invoke "verify".' };
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
  return { ok: true, plan: { kind: "steps", steps } };
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
  if (plan.kind === "single") {
    return { argv: plan.argv };
  }
  return { steps: plan.steps?.map((step) => ({ name: step.name, argv: step.argv })) };
}

function printPlan(plan: InitPlan): void {
  console.log(`Detected package manager: ${plan.packageManager}`);
  if (plan.alreadyInitialized) {
    console.log("Repository is already initialized for suzukuri test/verify. Re-running is a no-op.");
    return;
  }
  for (const migration of plan.migrations) {
    if (migration.plan === undefined) {
      console.log(`- ${migration.scriptName}: left unchanged (${migration.unresolvedReason})`);
      continue;
    }
    console.log(`- ${migration.scriptName}: package.json script -> "suzukuri ${migration.scriptName}"`);
  }
  if (Object.keys(plan.packageJsonScriptChanges).length > 0) {
    console.log("\nProposed .suzukuri/commands.json:");
    console.log(stableJsonStringify(plan.commandsConfig));
    console.log("\nProposed package.json script changes:");
    for (const [name, value] of Object.entries(plan.packageJsonScriptChanges)) {
      console.log(`  ${name}: "${value}"`);
    }
    if (plan.addDevDependency) {
      console.log(`\nProposed devDependency: suzukuri@${packageJson.version}`);
    }
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
 * Applies the accepted plan by writing every changed file to a temporary
 * path first and renaming only once all writes have succeeded, so a
 * mid-apply failure cannot leave package.json scripts pointing at a
 * .suzukuri/commands.json that was never written.
 */
function applyInitPlan(cwd: string, plan: InitPlan): void {
  if (Object.keys(plan.packageJsonScriptChanges).length === 0) return;

  const configDirectory = path.join(cwd, path.dirname(DEFAULT_EXECUTION_CONFIG_PATH));
  const configPath = path.join(cwd, DEFAULT_EXECUTION_CONFIG_PATH);
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJsonContent = readPackageJson(packageJsonPath);

  const nextPackageJson: PackageJson = {
    ...packageJsonContent,
    scripts: { ...packageJsonContent.scripts, ...plan.packageJsonScriptChanges },
    ...(plan.addDevDependency
      ? {
          devDependencies: {
            ...packageJsonContent.devDependencies,
            suzukuri: `^${packageJson.version}`,
          },
        }
      : {}),
  };

  fs.mkdirSync(configDirectory, { recursive: true });
  const configTemp = `${configPath}.${process.pid}.tmp`;
  const packageJsonTemp = `${packageJsonPath}.${process.pid}.tmp`;
  fs.writeFileSync(configTemp, `${JSON.stringify(plan.commandsConfig, null, 2)}\n`);
  fs.writeFileSync(packageJsonTemp, `${JSON.stringify(nextPackageJson, null, 2)}\n`);
  fs.renameSync(configTemp, configPath);
  fs.renameSync(packageJsonTemp, packageJsonPath);
}

function validateAppliedPlan(cwd: string): void {
  const configPath = path.join(cwd, DEFAULT_EXECUTION_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return;
  parseExecutionConfig(JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown);
}

function hasOption(parsed: InitCommandArguments, ...names: string[]): boolean {
  return names.some((name) => parsed.options[name] !== undefined);
}
