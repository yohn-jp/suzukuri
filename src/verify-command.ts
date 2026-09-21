import { stableJsonStringify } from "./core.js";
import { lookupExecutionCache, markResultReused } from "./execution-cache.js";
import {
  DEFAULT_PROCESS_OUTPUT_LIMIT,
  loadExecutionConfig,
  processResultExitCode,
  resolveExecutionCommand,
  runBoundedProcess,
} from "./execution.js";
import type { VerifyResult } from "./verify-result.js";
import { isVerifyResult, VERIFY_RESULT_SCHEMA_VERSION } from "./verify-result.js";

export const DEFAULT_VERIFY_DIAGNOSTIC_BYTES = 8 * 1024;

type OptionValue = string | true;
type OutputFormat = "json" | "text";

export interface VerifyCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

export class VerifyCommandError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "VerifyCommandError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Execute the explicitly configured repository verify producer. */
export async function runVerifyCommand(parsed: VerifyCommandArguments): Promise<number> {
  assertSupportedOptions(parsed);
  if (parsed.positionals.length > 0) {
    throw new VerifyCommandError(
      "VERIFY_ARGUMENTS_UNSUPPORTED",
      "suzukuri verify does not accept positional arguments.",
      {
        positionals: parsed.positionals,
      },
    );
  }

  const format = parseFormat(parsed);
  const configPath = option(parsed, "config", "commands", "execution");
  const config = loadExecutionConfig(configPath);
  const command = resolveExecutionCommand(config, "verify");

  const lookup = await lookupExecutionCache("verify", command);
  if (lookup?.cached !== undefined && isVerifyResult(lookup.cached.printed)) {
    const result = markResultReused(lookup.cached.printed) as VerifyResult;
    console.log(format === "text" ? renderVerifyText(result) : stableJsonStringify(result));
    return processResultExitCode(lookup.cached);
  }

  const maxOutputBytes = command.budget ?? DEFAULT_PROCESS_OUTPUT_LIMIT;
  const processResult = await runBoundedProcess(command.argv, { maxOutputBytes });
  const result = createVerifyResult(processResult, command.budget ?? DEFAULT_VERIFY_DIAGNOSTIC_BYTES);
  if (lookup !== undefined) {
    await lookup.commit({
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      printed: result,
    });
  }
  if (format === "text") {
    console.log(renderVerifyText(result));
  } else {
    console.log(stableJsonStringify(result));
  }
  return processResultExitCode(processResult);
}

interface VerifyProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

function createVerifyResult(processResult: VerifyProcessResult, diagnosticLimit: number): VerifyResult {
  if (processResult.exitCode === 0 && processResult.signal === null) {
    return {
      version: VERIFY_RESULT_SCHEMA_VERSION,
      status: "passed",
      completeness: "complete",
    };
  }

  const observation = [processResult.stdout, processResult.stderr].filter((value) => value.length > 0).join("\n");
  const stage = identifyStage(observation);
  const diagnostic = boundedDiagnostic(observation || failureOutcome(processResult), diagnosticLimit);
  return {
    version: VERIFY_RESULT_SCHEMA_VERSION,
    status: "failed",
    completeness: stage === "unknown" ? "incomplete" : "complete",
    stage,
    diagnostic,
    ...(processResult.truncated ? { truncated: true } : {}),
    exitCode: processResult.exitCode,
    signal: processResult.signal,
  };
}

function identifyStage(observation: string): string {
  let stage: string | undefined;
  for (const line of observation.split(/\r?\n/)) {
    // A direct command line is the strongest evidence and intentionally only
    // captures the first command in an && chain: later stages did not run if
    // that first command failed.
    const run = line.match(/\b(?:pnpm|npm|yarn)\s+(?:run|exec)\s+([A-Za-z][A-Za-z0-9_.:-]*)/);
    if (run !== null && run[1] !== "verify") stage = run[1];

    // pnpm's package-script banner is `> package@version stage /cwd`.
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

function failureOutcome(result: Pick<VerifyProcessResult, "exitCode" | "signal">): string {
  if (result.signal !== null) return `Verification producer terminated by ${result.signal}.`;
  return `Verification producer exited with code ${String(result.exitCode)}.`;
}

function assertSupportedOptions(parsed: VerifyCommandArguments): void {
  const supported = new Set(["help", "h", "human", "format", "output", "config", "commands", "execution"]);
  for (const name of Object.keys(parsed.options)) {
    if (!supported.has(name)) {
      throw new VerifyCommandError("VERIFY_OPTION_UNSUPPORTED", `Unsupported verify option: --${name}.`, {
        option: name,
      });
    }
  }
  for (const name of ["format", "output", "config", "commands", "execution"]) {
    if (parsed.options[name] === true) {
      throw new VerifyCommandError("VERIFY_OPTION_VALUE_REQUIRED", `Option --${name} requires a value.`, {
        option: name,
      });
    }
  }
}

function parseFormat(parsed: VerifyCommandArguments): OutputFormat {
  if (parsed.options.human === true) return "text";
  const value = option(parsed, "format", "output");
  if (value === undefined || value === "json") return "json";
  if (value === "text" || value === "human") return "text";
  throw new VerifyCommandError("VERIFY_FORMAT_INVALID", "Verify output format must be json or text.", {
    format: value,
  });
}

function option(parsed: VerifyCommandArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function renderVerifyText(result: VerifyResult): string {
  const lines = [`status: ${result.status}`, `completeness: ${result.completeness}`];
  if (result.stage !== undefined) lines.push(`stage: ${result.stage}`);
  if (result.diagnostic !== undefined) lines.push(`diagnostic: ${result.diagnostic}`);
  return lines.join("\n");
}
