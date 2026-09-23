import { createBudget, stableJsonStringify } from "./core.js";
import { createBuiltinProjectionCore } from "./builtin.js";
import { lookupExecutionCache, lookupExecutionStepCache, markResultReused } from "./execution-cache.js";
import {
  ExecutionError,
  isSteppedExecutionCommand,
  loadExecutionConfig,
  processResultExitCode,
  resolveExecutionCommand,
  runBoundedCommandSteps,
  runBoundedProcess,
  type ExecutionCommand,
  type ExecutionCommandStep,
  type SteppedExecutionCommand,
} from "./execution.js";
import { GENERIC_RESULT_SCHEMA_VERSION, type GenericCommandResult } from "./generic-result.js";
import { isTestResult } from "./test-result.js";
import { isVerifyResult, VERIFY_RESULT_SCHEMA_VERSION, type VerifyResult } from "./verify-result.js";

type OptionValue = string | true;
type OutputFormat = "json" | "text";

export interface RunCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

export class RunCommandError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "RunCommandError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * The uniform, execution-structure-derived outcome of running a command's
 * producer, whether it was a single argv or ordered steps. On a stepped
 * failure this is the failing step; on a stepped success, the final step
 * (the only one expected to look like specialized producer output — earlier
 * steps are pass/fail gates, not projectable results).
 */
interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  /** The structurally identified step name, when execution ran named steps. */
  readonly stage?: string;
  readonly adapter?: string;
  readonly view?: string;
  readonly budget?: number;
}

/** Resolves `suzukuri run <command>` to its registry definition and fails explicitly for an unregistered name. */
export async function runRunCommand(parsed: RunCommandArguments): Promise<number> {
  const commandName = parsed.positionals[0];
  if (commandName === undefined || commandName.trim() === "") {
    throw new RunCommandError("RUN_COMMAND_REQUIRED", "suzukuri run requires a registered command name.");
  }
  const configPath = option(parsed, "config", "commands", "execution");
  const config = loadExecutionConfig(configPath);
  if (config.commands[commandName] === undefined) {
    throw new RunCommandError("RUN_COMMAND_NOT_FOUND", `No command named "${commandName}" is registered.`, {
      command: commandName,
      registered: Object.keys(config.commands).sort(),
    });
  }
  return executeRegisteredCommand(commandName, resolveExecutionCommand(config, commandName), parsed);
}

/**
 * Executes an already-resolved command definition: cache lookup, producer
 * execution, projection by the command's declared `projection` kind, cache
 * commit (when the command's `reuse` mode allows it), and output. Shared by
 * `suzukuri run <command>` and the compatibility `suzukuri test`/`suzukuri
 * verify` entry points so they can never diverge from the generic registry
 * path.
 */
export async function executeRegisteredCommand(
  commandName: string,
  command: ExecutionCommand,
  parsed: RunCommandArguments,
): Promise<number> {
  const format = outputFormat(parsed);
  if (isSteppedExecutionCommand(command) && command.projection !== "generic") {
    const outcome = await runSteps(commandName, command);
    const printed = withStepExecutions(outcome.printed, outcome.steps);
    console.log(format === "text" ? renderText(command.projection, printed) : stableJsonStringify(printed));
    return processResultExitCode(outcome);
  }
  const lookup = await lookupExecutionCache(commandName, command);
  if (lookup?.cached !== undefined) {
    const reused = markResultReused(lookup.cached.printed);
    console.log(format === "text" ? renderText(command.projection, reused) : stableJsonStringify(reused));
    return processResultExitCode(lookup.cached);
  }

  const outcome = isSteppedExecutionCommand(command)
    ? await runCommandSteps(command.steps)
    : {
        ...(await runBoundedProcess(command.argv)),
        adapter: command.adapter,
        view: command.view,
        budget: command.budget,
      };

  const printed = projectOutcome(commandName, command.projection, outcome);
  if (lookup !== undefined) {
    await lookup.commit({ exitCode: outcome.exitCode, signal: outcome.signal, printed });
  }
  console.log(format === "text" ? renderText(command.projection, printed) : stableJsonStringify(printed));
  return processResultExitCode(outcome);
}

async function runCommandSteps(
  steps: readonly [ExecutionCommandStep, ...ExecutionCommandStep[]],
): Promise<CommandOutcome> {
  const result = await runBoundedCommandSteps(steps);
  const resolved = result.failedStep ?? result.steps[result.steps.length - 1];
  const definition = steps.find((step) => step.name === resolved.name);
  return {
    exitCode: resolved.exitCode,
    signal: resolved.signal,
    stdout: resolved.stdout,
    stderr: resolved.stderr,
    truncated: resolved.truncated,
    durationMs: resolved.durationMs,
    stage: resolved.name,
    adapter: definition?.adapter,
    view: definition?.view,
    budget: definition?.budget,
  };
}

/** Runs ordered verification steps, reusing each exact producer identity independently and stopping on failure. */
interface StepExecutionSummary {
  readonly name: string;
  readonly execution: "executed" | "reused";
}

interface SteppedCommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly printed: unknown;
  readonly steps: readonly StepExecutionSummary[];
}

async function runSteps(commandName: string, command: SteppedExecutionCommand): Promise<SteppedCommandOutcome> {
  const steps: StepExecutionSummary[] = [];
  let finalOutcome: Pick<SteppedCommandOutcome, "exitCode" | "signal" | "printed"> | undefined;
  for (const [index, step] of command.steps.entries()) {
    const lookup = await lookupExecutionStepCache(commandName, command, step);
    const cached = lookup?.cached;
    const finalStep = index === command.steps.length - 1;
    const cachedResultIsProjectable =
      command.projection !== "test-result" || !finalStep || (cached !== undefined && isTestResult(cached.printed));
    let outcome: Pick<SteppedCommandOutcome, "exitCode" | "signal" | "printed">;
    if (cached !== undefined && cachedResultIsProjectable) {
      outcome = cached;
      steps.push({ name: step.name, execution: "reused" });
    } else {
      const process = await runBoundedProcess(step.argv, { maxOutputBytes: step.budget });
      const commandOutcome: CommandOutcome = {
        ...process,
        stage: step.name,
        adapter: step.adapter,
        view: step.view,
        budget: step.budget,
      };
      const needsTestResult =
        command.projection !== "test-result" || process.exitCode !== 0 || process.signal !== null || finalStep;
      const printed = needsTestResult
        ? projectOutcome(commandName, command.projection, commandOutcome)
        : { status: "passed" };
      outcome = { exitCode: process.exitCode, signal: process.signal, printed };
      if (lookup !== undefined) await lookup.commit({ ...outcome });
      steps.push({ name: step.name, execution: "executed" });
    }
    finalOutcome = outcome;
    if (outcome.exitCode !== 0 || outcome.signal !== null) break;
  }
  if (finalOutcome === undefined) {
    throw new RunCommandError("RUN_STEPS_EMPTY", "A stepped command must contain at least one step.");
  }
  return { ...finalOutcome, steps };
}

function withStepExecutions(printed: unknown, steps: readonly StepExecutionSummary[]): unknown {
  if (!isRecord(printed)) return printed;
  return { ...printed, steps };
}

function projectOutcome(
  commandName: string,
  projection: ExecutionCommand["projection"],
  outcome: CommandOutcome,
): unknown {
  if (projection === "generic") return projectGeneric(commandName, outcome);
  if (projection === "verification-result") return projectVerification(outcome);
  return projectTestResult(outcome);
}

function projectGeneric(commandName: string, outcome: CommandOutcome): GenericCommandResult {
  const passed = outcome.exitCode === 0 && outcome.signal === null;
  return {
    version: GENERIC_RESULT_SCHEMA_VERSION,
    command: commandName,
    status: passed ? "passed" : "failed",
    completeness: outcome.truncated ? "incomplete" : "complete",
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncated,
    ...(outcome.stage === undefined ? {} : { stage: outcome.stage }),
  };
}

const DEFAULT_VERIFY_DIAGNOSTIC_BYTES = 8 * 1024;

function projectVerification(outcome: CommandOutcome): VerifyResult {
  if (outcome.exitCode === 0 && outcome.signal === null) {
    return { version: VERIFY_RESULT_SCHEMA_VERSION, status: "passed", completeness: "complete" };
  }
  const observation = [outcome.stdout, outcome.stderr].filter((value) => value.length > 0).join("\n");
  const stage = outcome.stage ?? identifyStage(observation);
  const diagnosticLimit = outcome.budget ?? DEFAULT_VERIFY_DIAGNOSTIC_BYTES;
  const diagnostic = boundedDiagnostic(observation || failureOutcome(outcome), diagnosticLimit);
  return {
    version: VERIFY_RESULT_SCHEMA_VERSION,
    status: "failed",
    completeness: stage === "unknown" ? "incomplete" : "complete",
    stage,
    diagnostic,
    ...(outcome.truncated ? { truncated: true } : {}),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  };
}

function identifyStage(observation: string): string {
  let stage: string | undefined;
  for (const line of observation.split(/\r?\n/)) {
    const run = line.match(/\b(?:pnpm|npm|yarn)\s+(?:run|exec)\s+([A-Za-z][A-Za-z0-9_.:-]*)/);
    if (run !== null && run[1] !== "verify") stage = run[1];
    const banner = line.match(/^\s*>\s+[^\s@]+@[^\s]+\s+([A-Za-z][A-Za-z0-9_.:-]*)\s+/);
    if (banner !== null && banner[1] !== "verify") stage = banner[1];
    const labelled = line.match(/\b(?:stage|step)\s*[:=]\s*([A-Za-z][A-Za-z0-9_.:-]*)/i);
    if (labelled !== null && labelled[1] !== "verify") stage = labelled[1];
  }
  return stage ?? "unknown";
}

function boundedDiagnostic(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value.trim(), "utf8");
  if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}

function failureOutcome(outcome: Pick<CommandOutcome, "exitCode" | "signal">): string {
  if (outcome.signal !== null) return `Command producer terminated by ${outcome.signal}.`;
  return `Command producer exited with code ${String(outcome.exitCode)}.`;
}

function projectTestResult(outcome: CommandOutcome): unknown {
  const source = projectionSource(outcome.stdout, outcome.stderr);
  const view =
    outcome.view ??
    (outcome.exitCode === 0 && outcome.signal === null ? "test-result-summary" : "test-result-failures");
  try {
    const result = createBuiltinProjectionCore().project({
      source: { content: source, identity: "suzukuri command producer", mediaType: "text/plain" },
      adapter: outcome.adapter ?? "vitest",
      view,
      budget: createBudget(outcome.budget ?? 8 * 1024),
      renderer: "json",
    });
    return JSON.parse(renderedText(result.output)) as unknown;
  } catch (error) {
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      throw new ExecutionError("EXECUTION_OUTPUT_UNSUPPORTED", {
        truncated: outcome.truncated,
        reason: errorCode(error),
      });
    }
    throw new ExecutionError("EXECUTION_OUTPUT_UNSUPPORTED", {
      truncated: outcome.truncated,
      reason: errorCode(error),
    });
  }
}

function projectionSource(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) return stdout;
  return [stdout, stderr].filter((value) => value.length > 0).join("\n");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "PROJECTION_FAILED";
}

function renderedText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function renderText(projection: ExecutionCommand["projection"], printed: unknown): string {
  if (projection === "verification-result" && isVerifyResult(printed)) {
    const lines = [`status: ${printed.status}`, `completeness: ${printed.completeness}`];
    if (printed.stage !== undefined) lines.push(`stage: ${printed.stage}`);
    if (printed.diagnostic !== undefined) lines.push(`diagnostic: ${printed.diagnostic}`);
    lines.push(...stepExecutionLines(printed));
    return lines.join("\n");
  }
  if (projection === "generic" && isRecord(printed) && typeof printed.status === "string") {
    const lines = [
      `command: ${String(printed.command)}`,
      `status: ${String(printed.status)}`,
      `completeness: ${String(printed.completeness)}`,
    ];
    return lines.join("\n");
  }
  return stableJsonStringify(printed);
}

function stepExecutionLines(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.steps)) return [];
  return value.steps.flatMap((step) =>
    isRecord(step) && typeof step.name === "string" && (step.execution === "executed" || step.execution === "reused")
      ? [`step: ${step.name} (${step.execution})`]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function option(parsed: RunCommandArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function outputFormat(parsed: RunCommandArguments): OutputFormat {
  if (parsed.options.human === true) return "text";
  const value = option(parsed, "format", "output");
  if (value === undefined || value === "json") return "json";
  if (value === "text" || value === "human") return "text";
  throw new RunCommandError("RUN_FORMAT_INVALID", "Output format must be json or text.", { format: value });
}
