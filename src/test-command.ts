import { createBudget, stableJsonStringify } from "./core.js";
import { createBuiltinProjectionCore } from "./builtin.js";
import { lookupExecutionCache, markResultReused } from "./execution-cache.js";
import {
  ExecutionError,
  loadExecutionConfig,
  processResultExitCode,
  resolveExecutionCommand,
  runBoundedProcess,
} from "./execution.js";
import { profileErrorToJson } from "./profiles.js";

type OptionValue = string | true;
type OutputFormat = "json" | "text";

export interface TestCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

/** Execute the explicitly configured repository test producer. */
export async function runTestCommand(parsed: TestCommandArguments): Promise<number> {
  const configPath = option(parsed, "config", "commands", "execution");
  const config = loadExecutionConfig(configPath);
  const command = resolveExecutionCommand(config, "test");

  const lookup = await lookupExecutionCache("test", command);
  if (lookup?.cached !== undefined) {
    printText(stableJsonStringify(markResultReused(lookup.cached.printed)));
    return processResultExitCode(lookup.cached);
  }

  const processResult = await runBoundedProcess(command.argv);
  const source = projectionSource(processResult.stdout, processResult.stderr);
  const view =
    command.view ??
    (processResult.exitCode === 0 && processResult.signal === null ? "test-result-summary" : "test-result-failures");
  try {
    const result = createBuiltinProjectionCore().project({
      source: { content: source, identity: "suzukuri test producer", mediaType: "text/plain" },
      adapter: command.adapter ?? "vitest",
      view,
      budget: createBudget(command.budget ?? 8 * 1024),
      renderer: "json",
    });
    const printed = renderedText(result.output);
    if (lookup !== undefined) {
      await lookup.commit({
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        printed: JSON.parse(printed) as unknown,
      });
    }
    printText(printed);
    return processResultExitCode(processResult);
  } catch (error) {
    if (processResult.exitCode !== 0 || processResult.signal !== null) {
      printError(
        new ExecutionError("EXECUTION_OUTPUT_UNSUPPORTED", {
          command: "test",
          truncated: processResult.truncated,
          reason: errorCode(error),
        }),
        outputFormat(parsed),
      );
      return processResultExitCode(processResult);
    }
    throw new ExecutionError("EXECUTION_OUTPUT_UNSUPPORTED", {
      command: "test",
      truncated: processResult.truncated,
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

class TestCommandUsageError extends Error {
  readonly code = "INVALID_ARGUMENTS";

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: {} };
  }
}

function option(parsed: TestCommandArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function outputFormat(parsed: TestCommandArguments): OutputFormat {
  if (parsed.options.human === true) return "text";
  const value = option(parsed, "format", "output");
  if (value === undefined || value === "json") return "json";
  if (value === "text" || value === "human") return "text";
  throw new TestCommandUsageError("Output format must be json or text.");
}

function renderedText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function printText(value: string): void {
  console.log(value);
}

function printError(error: unknown, format: OutputFormat): void {
  const value = profileErrorToJson(error);
  if (format === "text") {
    console.error(`${String(value.code)}: ${String(value.message)}`);
  } else {
    console.error(stableJsonStringify(value));
  }
}
