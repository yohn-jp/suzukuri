import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

export const EXECUTION_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EXECUTION_CONFIG_PATH = ".suzukuri/commands.json";
export const DEFAULT_PROCESS_OUTPUT_LIMIT = 64 * 1024;

/**
 * A repository-local command name in `.suzukuri/commands.json`, e.g.
 * "build", "test", "lint", "verify". Any non-empty name is a valid registry
 * key; there is no fixed vocabulary, so a repository can register whatever
 * operations its own tooling exposes.
 */
export type ExecutionCommandName = string;

/**
 * Selects the semantic projection used to interpret a command's producer
 * output. "generic" (the default) preserves only bounded outcome fields
 * (exit/signal, duration, bounded stdout/stderr, truncation) without
 * assuming any domain-specific structure. "test-result" and
 * "verification-result" opt into the existing specialized adapters.
 */
export type ExecutionProjectionKind = "generic" | "test-result" | "verification-result";

/**
 * Declares whether a command's cached result may be reused while the
 * repository content fingerprint is unchanged. Reuse is conservative by
 * default: a "generic" command's producer identity gives no evidence it is
 * side-effect-free, so it defaults to "never" and must opt in explicitly.
 * "test-result"/"verification-result" commands are conventionally read-only
 * verification producers, so they default to "fingerprint".
 */
export type ExecutionReuseMode = "fingerprint" | "never";

export interface ExecutionCommandStep {
  readonly name: string;
  readonly inputs?: readonly string[];
  readonly argv: readonly [string, ...string[]];
  readonly adapter?: string;
  readonly view?: string;
  readonly budget?: number;
}

export interface SingleExecutionCommand {
  readonly inputs?: readonly string[];
  readonly argv: readonly [string, ...string[]];
  readonly adapter?: string;
  readonly view?: string;
  readonly budget?: number;
  readonly projection: ExecutionProjectionKind;
  readonly reuse: ExecutionReuseMode;
}

export interface SteppedExecutionCommand {
  readonly steps: readonly [ExecutionCommandStep, ...ExecutionCommandStep[]];
  readonly inputs?: readonly string[];
  readonly projection: ExecutionProjectionKind;
  readonly reuse: ExecutionReuseMode;
}

export type ExecutionCommand = SingleExecutionCommand | SteppedExecutionCommand;

export function isSteppedExecutionCommand(command: ExecutionCommand): command is SteppedExecutionCommand {
  return "steps" in command;
}

export interface ExecutionConfig {
  readonly schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  readonly commands: Readonly<Record<ExecutionCommandName, ExecutionCommand>>;
}

export type ExecutionErrorCode =
  | "EXECUTION_CONFIG_NOT_FOUND"
  | "EXECUTION_CONFIG_INVALID"
  | "EXECUTION_COMMAND_NOT_FOUND"
  | "EXECUTION_COMMAND_FAILED"
  | "EXECUTION_OUTPUT_UNSUPPORTED";

const ERROR_MESSAGES: Record<ExecutionErrorCode, string> = {
  EXECUTION_CONFIG_NOT_FOUND: "The execution command configuration was not found.",
  EXECUTION_CONFIG_INVALID: "The execution command configuration is invalid.",
  EXECUTION_COMMAND_NOT_FOUND: "The requested execution command is not configured.",
  EXECUTION_COMMAND_FAILED: "The configured producer could not be started.",
  EXECUTION_OUTPUT_UNSUPPORTED: "The producer output is not a supported semantic result.",
};

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ExecutionErrorCode,
    details: Readonly<Record<string, unknown>> = {},
    message = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: RecordValue, allowed: readonly string[]): string[] {
  const accepted = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !accepted.has(key))
    .sort();
}

function configIssue(pathName: string, message: string): ExecutionError {
  return new ExecutionError("EXECUTION_CONFIG_INVALID", { path: pathName, reason: message });
}

const PROJECTION_KINDS: readonly ExecutionProjectionKind[] = ["generic", "test-result", "verification-result"];

/** A command's default reuse mode when not explicitly declared: conservative unless its projection is a known read-only verification shape. */
function defaultReuseMode(projection: ExecutionProjectionKind): ExecutionReuseMode {
  return projection === "generic" ? "never" : "fingerprint";
}

/** A command name's default projection when not explicitly declared, preserving prior `test`/`verify` behavior. */
function defaultProjection(commandName: string): ExecutionProjectionKind {
  if (commandName === "test") return "test-result";
  if (commandName === "verify") return "verification-result";
  return "generic";
}

function normalizeCommand(value: unknown, commandName: string): ExecutionCommand {
  const issuePath = `$.commands.${commandName}`;
  const projection = readProjection(value, issuePath, commandName);
  const reuse = readReuse(value, issuePath, projection);
  if (isRecord(value) && value.steps !== undefined) {
    for (const key of unknownKeys(value, ["steps", "projection", "reuse", "inputs"])) {
      throw configIssue(`${issuePath}.${key}`, `Unknown command property "${key}".`);
    }
    if (!Array.isArray(value.steps) || value.steps.length === 0) {
      throw configIssue(`${issuePath}.steps`, "Command steps must be a non-empty array.");
    }
    const seenNames = new Set<string>();
    const steps = value.steps.map((step, index) => {
      const stepPath = `${issuePath}.steps[${index}]`;
      if (!isRecord(step)) throw configIssue(stepPath, "Each step must be an object.");
      if (typeof step.name !== "string" || step.name.trim() === "") {
        throw configIssue(`${stepPath}.name`, "Step name must be a non-empty string.");
      }
      if (seenNames.has(step.name)) {
        throw configIssue(`${stepPath}.name`, `Step name "${step.name}" must be unique within the command.`);
      }
      seenNames.add(step.name);
      const normalized = normalizeSingleCommand(step, stepPath, [
        "name",
        "argv",
        "command",
        "adapter",
        "view",
        "budget",
        "inputs",
      ]);
      const stepDefinition: ExecutionCommandStep = { name: step.name, ...normalized };
      return stepDefinition;
    });
    const inputs = readInputs(value.inputs, `${issuePath}.inputs`);
    return {
      steps: steps as [ExecutionCommandStep, ...ExecutionCommandStep[]],
      projection,
      reuse,
      ...(inputs === undefined ? {} : { inputs }),
    };
  }
  const single = normalizeSingleCommand(value, issuePath, [
    "argv",
    "command",
    "adapter",
    "view",
    "budget",
    "projection",
    "reuse",
    "inputs",
  ]);
  return { ...single, projection, reuse };
}

function readProjection(value: unknown, issuePath: string, commandName: string): ExecutionProjectionKind {
  if (!isRecord(value) || value.projection === undefined) return defaultProjection(commandName);
  const raw = value.projection;
  if (typeof raw !== "string" || !PROJECTION_KINDS.includes(raw as ExecutionProjectionKind)) {
    throw configIssue(`${issuePath}.projection`, `Command projection must be one of ${PROJECTION_KINDS.join(", ")}.`);
  }
  return raw as ExecutionProjectionKind;
}

function readReuse(value: unknown, issuePath: string, projection: ExecutionProjectionKind): ExecutionReuseMode {
  if (!isRecord(value) || value.reuse === undefined) return defaultReuseMode(projection);
  const raw = value.reuse;
  if (raw !== "fingerprint" && raw !== "never") {
    throw configIssue(`${issuePath}.reuse`, 'Command reuse must be "fingerprint" or "never".');
  }
  return raw;
}

interface ArgvBearingCommand {
  readonly inputs?: readonly string[];
  readonly argv: readonly [string, ...string[]];
  readonly adapter?: string;
  readonly view?: string;
  readonly budget?: number;
}

function normalizeSingleCommand(value: unknown, issuePath: string, allowedKeys: readonly string[]): ArgvBearingCommand {
  let argvValue: unknown = value;
  let adapter: string | undefined;
  let view: string | undefined;
  let budget: number | undefined;
  let inputs: readonly string[] | undefined;
  if (isRecord(value)) {
    for (const key of unknownKeys(value, allowedKeys)) {
      throw configIssue(`${issuePath}.${key}`, `Unknown command property "${key}".`);
    }
    argvValue = value.argv ?? value.command;
    if (value.adapter !== undefined) adapter = value.adapter as string;
    if (value.view !== undefined) view = value.view as string;
    if (value.budget !== undefined) budget = value.budget as number;
    if (value.inputs !== undefined) inputs = readInputs(value.inputs, `${issuePath}.inputs`);
  }
  if (!Array.isArray(argvValue) || argvValue.length === 0 || !argvValue.every((item) => typeof item === "string")) {
    throw configIssue(`${issuePath}.argv`, "Command argv must be a non-empty array of strings.");
  }
  const argv = argvValue as string[];
  if (argv.some((item) => item.trim() === "")) {
    throw configIssue(`${issuePath}.argv`, "Command argv entries must not be empty.");
  }
  if (adapter !== undefined && (typeof adapter !== "string" || adapter.trim() === "")) {
    throw configIssue(`${issuePath}.adapter`, "Command adapter must be a non-empty string.");
  }
  if (view !== undefined && (typeof view !== "string" || view.trim() === "")) {
    throw configIssue(`${issuePath}.view`, "Command view must be a non-empty string.");
  }
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1)) {
    throw configIssue(`${issuePath}.budget`, "Command budget must be a positive safe integer.");
  }
  return {
    argv: argv as [string, ...string[]],
    ...(adapter === undefined ? {} : { adapter }),
    ...(view === undefined ? {} : { view }),
    ...(budget === undefined ? {} : { budget }),
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function readInputs(value: unknown, issuePath: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw configIssue(issuePath, "Inputs must be a non-empty array of repository-relative paths.");
  }
  const inputs = value as string[];
  if (
    inputs.some(
      (item) =>
        item === "" ||
        item.startsWith("/") ||
        item.includes("\\") ||
        item.includes("\0") ||
        item.split("/").some((part) => part === "" || part === "." || part === "..") ||
        item === ".git" ||
        item.startsWith(".git/") ||
        item === ".suzukuri/cache" ||
        item.startsWith(".suzukuri/cache/"),
    ) ||
    new Set(inputs).size !== inputs.length
  ) {
    throw configIssue(
      issuePath,
      "Inputs must be unique canonical repository-relative paths outside Git and Suzukuri cache state.",
    );
  }
  return [...inputs].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function parseExecutionConfig(input: unknown): ExecutionConfig {
  if (!isRecord(input)) throw configIssue("$", "Execution configuration must be an object.");
  const rawVersion = input.schemaVersion ?? input.version;
  if (rawVersion !== EXECUTION_SCHEMA_VERSION && rawVersion !== String(EXECUTION_SCHEMA_VERSION)) {
    throw configIssue("$.schemaVersion", `Execution schema version must be ${EXECUTION_SCHEMA_VERSION}.`);
  }
  const rawCommands =
    input.commands ??
    Object.fromEntries(
      ["test", "verify", "diff"].filter((name) => input[name] !== undefined).map((name) => [name, input[name]]),
    );
  if (!isRecord(rawCommands)) throw configIssue("$.commands", "Execution commands must be an object.");
  const commands: Record<ExecutionCommandName, ExecutionCommand> = {};
  for (const [name, value] of Object.entries(rawCommands)) {
    if (name.trim() === "") throw configIssue("$.commands", "Command names must not be empty.");
    const command = normalizeCommand(value, name);
    if (name === "diff" && isSteppedExecutionCommand(command)) {
      throw configIssue(`$.commands.${name}`, `Command "diff" does not support ordered steps.`);
    }
    commands[name] = command;
  }
  return { schemaVersion: EXECUTION_SCHEMA_VERSION, commands };
}

export function resolveExecutionConfigPath(configPath = DEFAULT_EXECUTION_CONFIG_PATH, cwd = process.cwd()): string {
  return path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);
}

export function readExecutionConfig(configPath = DEFAULT_EXECUTION_CONFIG_PATH, cwd = process.cwd()): unknown {
  const resolvedPath = resolveExecutionConfigPath(configPath, cwd);
  let contents: string;
  try {
    contents = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ExecutionError("EXECUTION_CONFIG_NOT_FOUND", { path: resolvedPath });
    }
    throw new ExecutionError("EXECUTION_CONFIG_INVALID", { path: resolvedPath });
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new ExecutionError("EXECUTION_CONFIG_INVALID", {
      path: resolvedPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function loadExecutionConfig(configPath = DEFAULT_EXECUTION_CONFIG_PATH, cwd = process.cwd()): ExecutionConfig {
  return parseExecutionConfig(readExecutionConfig(configPath, cwd));
}

export function resolveExecutionCommand(config: ExecutionConfig, name: ExecutionCommandName): ExecutionCommand {
  const command = config.commands[name];
  if (command === undefined) {
    throw new ExecutionError("EXECUTION_COMMAND_NOT_FOUND", { command: name });
  }
  return command;
}

class BoundedBuffer {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  private truncatedValue = false;

  constructor(private readonly limit: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.limit) {
      this.chunks.length = 0;
      this.chunks.push(chunk.subarray(chunk.byteLength - this.limit));
      this.size = this.limit;
      this.truncatedValue = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    while (this.size > this.limit) {
      const first = this.chunks[0];
      const excess = this.size - this.limit;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.size -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
      this.truncatedValue = true;
    }
  }

  get truncated(): boolean {
    return this.truncatedValue;
  }

  toString(): string {
    const result = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  }
}

export interface BoundedProcessResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface BoundedProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
}

export function runBoundedProcess(
  argv: readonly [string, ...string[]],
  options: BoundedProcessOptions = {},
): Promise<BoundedProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    return Promise.reject(new ExecutionError("EXECUTION_COMMAND_FAILED", { reason: "invalid output limit" }));
  }
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ExecutionError("EXECUTION_COMMAND_FAILED", { argv, reason: errorMessage(error) }));
      return;
    }
    const stdout = new BoundedBuffer(maxOutputBytes);
    const stderr = new BoundedBuffer(maxOutputBytes);
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.once("error", (error) => {
      reject(new ExecutionError("EXECUTION_COMMAND_FAILED", { argv, reason: errorMessage(error) }));
    });
    child.once("close", (exitCode, signal) => {
      resolve({
        argv,
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}

export interface StepProcessResult extends BoundedProcessResult {
  readonly name: string;
}

export interface SteppedProcessResult {
  readonly steps: readonly StepProcessResult[];
  /** The step that stopped execution, or undefined when every step passed. */
  readonly failedStep: StepProcessResult | undefined;
}

/**
 * Runs each step's argv in declared order, stopping at the first
 * failed/signaled step so later steps never run once an earlier one has
 * already failed, matching `&&` aggregate semantics.
 */
export async function runBoundedCommandSteps(
  steps: readonly [ExecutionCommandStep, ...ExecutionCommandStep[]],
  options: BoundedProcessOptions = {},
): Promise<SteppedProcessResult> {
  const results: StepProcessResult[] = [];
  for (const step of steps) {
    const result = await runBoundedProcess(step.argv, {
      ...options,
      maxOutputBytes: step.budget ?? options.maxOutputBytes,
    });
    const stepResult: StepProcessResult = { ...result, name: step.name };
    results.push(stepResult);
    if (result.exitCode !== 0 || result.signal !== null) {
      return { steps: results, failedStep: stepResult };
    }
  }
  return { steps: results, failedStep: undefined };
}

export function processResultExitCode(result: Pick<BoundedProcessResult, "exitCode" | "signal">): number {
  if (result.exitCode !== null) return result.exitCode;
  if (result.signal === null) return 1;
  const signalNumber = processSignalNumber(result.signal);
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function processSignalNumber(signal: NodeJS.Signals): number | undefined {
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGABRT: 6,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGSEGV: 11,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGUSR1: 10,
    SIGUSR2: 12,
  } as const;
  return signals[signal as keyof typeof signals];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
