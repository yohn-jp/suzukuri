import { loadExecutionConfig, resolveExecutionCommand } from "./execution.js";
import { executeRegisteredCommand, type RunCommandArguments } from "./run-command.js";

export interface TestCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | true>>;
}

/**
 * Compatibility entry point for `suzukuri test`. Resolves the registered
 * "test" command from `.suzukuri/commands.json` and executes it through the
 * same generic command registry path as `suzukuri run test`, so the two can
 * never diverge in cache keying, step handling, or projection.
 */
export async function runTestCommand(parsed: TestCommandArguments): Promise<number> {
  const configPath = option(parsed, "config", "commands", "execution");
  const config = loadExecutionConfig(configPath);
  const command = resolveExecutionCommand(config, "test");
  const runArguments: RunCommandArguments = { positionals: ["test"], options: parsed.options };
  return executeRegisteredCommand("test", command, runArguments);
}

function option(parsed: TestCommandArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}
