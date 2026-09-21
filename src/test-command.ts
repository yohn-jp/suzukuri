import { createBudget, stableJsonStringify } from "./core.js";
import { createBuiltinProjectionCore } from "./builtin.js";
import { lookupExecutionCache, markResultReused } from "./execution-cache.js";
import {
  ExecutionError,
  isSteppedExecutionCommand,
  loadExecutionConfig,
  processResultExitCode,
  resolveExecutionCommand,
  runBoundedCommandSteps,
  runBoundedProcess,
  type BoundedProcessResult,
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

  const outcome = isSteppedExecutionCommand(command)
    ? await runSteppedTest(command.steps)
    : {
        ...(await runBoundedProcess(command.argv)),
        adapter: command.adapter,
        view: command.view,
        budget: command.budget,
      };
  const source = projectionSource(outcome.stdout, outcome.stderr);
  const view =
    outcome.view ??
    (outcome.exitCode === 0 && outcome.signal === null ? "test-result-summary" : "test-result-failures");
  try {
    const result = createBuiltinProjectionCore().project({
      source: { content: source, identity: "suzukuri test producer", mediaType: "text/plain" },
      adapter: outcome.adapter ?? "vitest",
      view,
      budget: createBudget(outcome.budget ?? 8 * 1024),
      renderer: "json",
    });
    const printed = renderedText(result.output);
    if (lookup !== undefined) {
      await lookup.commit({
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        printed: JSON.parse(printed) as unknown,
      });
    }
    printText(printed);
    return processResultExitCode(outcome);
  } catch (error) {
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      printError(
        new ExecutionError("EXECUTION_OUTPUT_UNSUPPORTED", {
          command: "test",
          truncated: outcome.truncated,
          reason: errorCode(error),
        }),
        outputFormat(parsed),
      );
      return processResultExitCode(outcome);
    }
    throw new ExecutionError("EXECUTION_OUTPUT_UNSUPPORTED", {
      command: "test",
      truncated: outcome.truncated,
      reason: errorCode(error),
    });
  }
}

interface TestStepOutcome extends BoundedProcessResult {
  readonly adapter: string | undefined;
  readonly view: string | undefined;
  readonly budget: number | undefined;
}

/**
 * Runs a stepped test command sequentially, stopping at the first
 * failed/signaled step. Only that step's output (and its own declared
 * adapter/view/budget) is projected: on failure, later steps never ran; on
 * success, only the final step is expected to be test-runner output that a
 * `test-result-*` view can parse — earlier steps are pass/fail gates, not
 * projectable test results.
 */
async function runSteppedTest(steps: Parameters<typeof runBoundedCommandSteps>[0]): Promise<TestStepOutcome> {
  const result = await runBoundedCommandSteps(steps);
  const outcome = result.failedStep ?? result.steps[result.steps.length - 1];
  const definition = steps.find((step) => step.name === outcome.name);
  return {
    argv: outcome.argv,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncated,
    adapter: definition?.adapter,
    view: definition?.view,
    budget: definition?.budget,
  };
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
