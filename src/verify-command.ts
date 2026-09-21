import { loadExecutionConfig, resolveExecutionCommand } from "./execution.js";
import { executeRegisteredCommand, type RunCommandArguments } from "./run-command.js";

export interface VerifyCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | true>>;
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

/**
 * Compatibility entry point for `suzukuri verify`. Resolves the registered
 * "verify" command from `.suzukuri/commands.json` and executes it through
 * the same generic command registry path as `suzukuri run verify`, so the
 * two can never diverge in cache keying, step handling, or projection.
 */
export async function runVerifyCommand(parsed: VerifyCommandArguments): Promise<number> {
  assertSupportedOptions(parsed);
  if (parsed.positionals.length > 0) {
    throw new VerifyCommandError(
      "VERIFY_ARGUMENTS_UNSUPPORTED",
      "suzukuri verify does not accept positional arguments.",
      { positionals: parsed.positionals },
    );
  }

  const configPath = option(parsed, "config", "commands", "execution");
  const config = loadExecutionConfig(configPath);
  const command = resolveExecutionCommand(config, "verify");
  const runArguments: RunCommandArguments = { positionals: ["verify"], options: parsed.options };
  return executeRegisteredCommand("verify", command, runArguments);
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

function option(parsed: VerifyCommandArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}
