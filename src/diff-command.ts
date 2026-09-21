import fs from "node:fs";
import { createGitProjectionCore, gitDiffFilesView, gitDiffHunksView, gitDiffSummaryView } from "./git.js";
import type { ProjectionResult } from "./core.js";
import { stableJsonStringify } from "./core.js";
import {
  DEFAULT_EXECUTION_CONFIG_PATH,
  ExecutionError,
  isSteppedExecutionCommand,
  loadExecutionConfig,
  processResultExitCode,
  resolveExecutionCommand,
  resolveExecutionConfigPath,
  runBoundedProcess,
} from "./execution.js";

export const DEFAULT_DIFF_BUDGET = 16 * 1024;
export const DEFAULT_DIFF_MAX_INPUT_BYTES = 4 * 1024 * 1024;

type OptionValue = string | true;
type DiffView = "summary" | "files" | "hunks";
type DiffScope = "worktree" | "staged" | "all";

export interface DiffCommandArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

export interface GitDiffAcquisitionOptions {
  readonly cwd?: string;
  readonly scope?: DiffScope;
  readonly path?: string;
  readonly maxBytes?: number;
  readonly argv?: readonly [string, ...string[]];
}

export interface GitDiffAcquisitionResult {
  readonly content: Uint8Array;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class DiffCommandError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "DiffCommandError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Run the explicit Git diff producer through the shared finite process boundary. */
export function acquireGitDiff(options: GitDiffAcquisitionOptions = {}): Promise<GitDiffAcquisitionResult> {
  const scope = options.scope ?? "worktree";
  const maxBytes = options.maxBytes ?? DEFAULT_DIFF_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new DiffCommandError("DIFF_BUDGET_INVALID", "Git diff input byte bound must be a positive safe integer.");
  }

  const argv = options.argv ?? defaultGitDiffArgv(scope, options.path);
  return runBoundedProcess(argv, { cwd: options.cwd, maxOutputBytes: maxBytes }).then((result) => {
    if (result.truncated) {
      throw new DiffCommandError("DIFF_INPUT_TOO_LARGE", "Git diff output exceeded the finite acquisition bound.", {
        maxBytes,
        status: result.exitCode,
        signal: result.signal,
      });
    }
    if (result.signal !== null || result.exitCode !== 0) {
      const diagnostic = result.stderr.trim();
      throw new DiffCommandError("DIFF_ACQUISITION_FAILED", "Git diff exited unsuccessfully.", {
        status: result.exitCode,
        signal: result.signal,
        exitCode: processResultExitCode(result),
        ...(diagnostic === "" ? {} : { diagnostic }),
      });
    }
    return {
      content: new TextEncoder().encode(result.stdout),
      status: result.exitCode,
      signal: result.signal,
    };
  });
}

export async function runDiffCommand(parsed: DiffCommandArguments): Promise<number> {
  assertSupportedOptions(parsed);
  if (parsed.positionals.length > 0) {
    throw new DiffCommandError("DIFF_ARGUMENTS_UNSUPPORTED", "suzukuri diff does not accept positional arguments.", {
      positionals: parsed.positionals,
    });
  }

  const scope = parseScope(option(parsed, "scope"));
  const path = option(parsed, "path");
  const maxBytes = parseNumber(
    option(parsed, "max-input-bytes", "max-raw-bytes"),
    "max-input-bytes",
    DEFAULT_DIFF_MAX_INPUT_BYTES,
  );
  const configured = resolveConfiguredDiff(parsed);
  const budget = parseNumber(option(parsed, "budget"), "budget", configured?.budget ?? DEFAULT_DIFF_BUDGET);
  const view = parseView(option(parsed, "view") ?? configured?.view);
  const format = parseFormat(parsed);
  const renderer = option(parsed, "renderer") ?? format;
  if (renderer !== "json" && renderer !== "text") {
    throw new DiffCommandError("DIFF_RENDERER_UNSUPPORTED", "Diff renderer must be json or text.", { renderer });
  }

  if (configured !== undefined && (parsed.options.scope !== undefined || path !== undefined)) {
    throw new DiffCommandError(
      "DIFF_OPTION_UNSUPPORTED",
      "Scope and path options cannot modify a configured diff producer.",
      { options: ["scope", ...(path === undefined ? [] : ["path"])] },
    );
  }
  const acquired = await acquireGitDiff({
    scope,
    path,
    maxBytes,
    ...(configured === undefined ? {} : { argv: configured.argv }),
  });
  const result = createGitProjectionCore().project({
    source: {
      content: acquired.content,
      identity: `git:diff:${scope}`,
      mediaType: "text/x-git-diff",
    },
    adapter: "git-diff",
    view: view === "summary" ? gitDiffSummaryView : view === "hunks" ? gitDiffHunksView : gitDiffFilesView,
    budget,
    renderer,
  });
  if (format === "text") {
    console.log(renderedText(result));
  } else {
    console.log(stableJsonStringify(result));
  }
  return acquired.status ?? 1;
}

function defaultGitDiffArgv(scope: DiffScope, pathValue: string | undefined): [string, ...string[]] {
  const args = ["git", "diff", "--no-ext-diff", "--no-color", "--binary", "--full-index", "--find-renames"];
  if (scope === "staged") {
    args.push("--cached");
  } else if (scope === "all") {
    args.push("HEAD");
  } else if (scope !== "worktree") {
    throw new DiffCommandError("DIFF_SCOPE_UNSUPPORTED", `Unsupported diff scope: ${scope}.`);
  }
  args.push("--");
  if (pathValue !== undefined) {
    validatePathOption(pathValue);
    args.push(pathValue);
  }
  return args as [string, ...string[]];
}

interface ConfiguredDiffCommand {
  readonly argv: readonly [string, ...string[]];
  readonly adapter?: string;
  readonly view?: string;
  readonly budget?: number;
}

function resolveConfiguredDiff(parsed: DiffCommandArguments): ConfiguredDiffCommand | undefined {
  const configPath = option(parsed, "config", "commands", "execution");
  const resolvedPath = resolveExecutionConfigPath(configPath ?? DEFAULT_EXECUTION_CONFIG_PATH);
  if (!fs.existsSync(resolvedPath)) {
    if (configPath !== undefined) {
      return asSingleDiffCommand(resolveExecutionCommand(loadExecutionConfig(configPath), "diff"));
    }
    return undefined;
  }
  const config = loadExecutionConfig(configPath);
  return config.commands.diff === undefined ? undefined : asSingleDiffCommand(resolveExecutionCommand(config, "diff"));
}

/** `diff` never accepts ordered steps; parseExecutionConfig already rejects them. */
function asSingleDiffCommand(command: ReturnType<typeof resolveExecutionCommand>): ConfiguredDiffCommand {
  if (isSteppedExecutionCommand(command)) {
    throw new ExecutionError("EXECUTION_CONFIG_INVALID", {
      path: "$.commands.diff",
      reason: 'Command "diff" does not support ordered steps.',
    });
  }
  return command;
}

function assertSupportedOptions(parsed: DiffCommandArguments): void {
  const supported = new Set([
    "help",
    "human",
    "format",
    "output",
    "scope",
    "path",
    "view",
    "budget",
    "renderer",
    "max-input-bytes",
    "max-raw-bytes",
    "config",
    "commands",
    "execution",
  ]);
  for (const name of Object.keys(parsed.options)) {
    if (!supported.has(name)) {
      throw new DiffCommandError("DIFF_OPTION_UNSUPPORTED", `Unsupported diff option: --${name}.`, { option: name });
    }
  }
  for (const name of [
    "format",
    "output",
    "scope",
    "path",
    "view",
    "budget",
    "renderer",
    "max-input-bytes",
    "max-raw-bytes",
    "config",
    "commands",
    "execution",
  ]) {
    if (parsed.options[name] === true) {
      throw new DiffCommandError("DIFF_OPTION_VALUE_REQUIRED", `Option --${name} requires a value.`, { option: name });
    }
  }
}

function parseScope(value: string | undefined): DiffScope {
  if (value === undefined || value === "worktree" || value === "working") return "worktree";
  if (value === "staged") return "staged";
  if (value === "all") return "all";
  throw new DiffCommandError("DIFF_SCOPE_UNSUPPORTED", `Unsupported diff scope: ${value}.`, { scope: value });
}

function parseView(value: string | undefined): DiffView {
  if (value === undefined || value === "files" || value === "git-diff-files") return "files";
  if (value === "summary" || value === "git-diff-summary") return "summary";
  if (value === "hunks" || value === "git-diff-hunks") return "hunks";
  throw new DiffCommandError("DIFF_VIEW_UNSUPPORTED", `Unsupported diff view: ${value}.`, { view: value });
}

function parseFormat(parsed: DiffCommandArguments): "json" | "text" {
  if (parsed.options.human === true) return "text";
  const value = option(parsed, "format", "output");
  if (value === undefined || value === "json") return "json";
  if (value === "text" || value === "human") return "text";
  throw new DiffCommandError("DIFF_FORMAT_INVALID", "Diff output format must be json or text.", { format: value });
}

function parseNumber(value: string | undefined, name: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new DiffCommandError("DIFF_NUMBER_INVALID", `--${name} must be a positive safe integer.`, { option: name });
  }
  return number;
}

function option(parsed: DiffCommandArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function validatePathOption(value: string): void {
  if (value.trim() === "" || value.startsWith("/") || value.includes("\0")) {
    throw new DiffCommandError("DIFF_PATH_INVALID", "Diff path must be a non-empty relative path.", { path: value });
  }
  const parts = value.replaceAll("\\", "/").split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) {
        throw new DiffCommandError("DIFF_PATH_INVALID", "Diff path must stay within the repository.", { path: value });
      }
    } else {
      depth += 1;
    }
  }
}

function renderedText(result: ProjectionResult): string {
  return typeof result.output === "string" ? result.output : new TextDecoder().decode(result.output);
}
