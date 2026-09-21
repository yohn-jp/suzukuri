import fs from "node:fs";
import { createRequire } from "node:module";
import { type ComponentReference, createBudget, stableJsonStringify } from "./core.js";
import { runDiffCommand } from "./diff-command.js";
import { createProfileCore } from "./profile-builtins.js";
import { runTestCommand } from "./test-command.js";
import { runVerifyCommand } from "./verify-command.js";
import {
  DEFAULT_PROFILE_PATH,
  type InspectionKind,
  loadProfileDocument,
  profileErrorToJson,
  resolveProfile,
  runProfile,
  validateProfileFile,
} from "./profiles.js";
import { findSkillScenario, listSkillScenarios, SkillScenarioNotFoundError } from "./skill.js";
import {
  type CommandDefinition,
  type CommandDomain,
  DOMAIN_SUMMARIES,
  getCommandForPositionals,
  getDomainCommands,
  getDomainDescription,
  SUZUKURI_COMMANDS,
} from "./command-contract.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

type OptionValue = string | true;
type OutputFormat = "json" | "text";

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, OptionValue>>;
}

class CliUsageError extends Error {
  readonly code = "INVALID_ARGUMENTS";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "CliUsageError";
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArguments(argv);
  const command = parsed.positionals[0];

  if (command === undefined) {
    if (hasOption(parsed, "version")) {
      printVersion();
      return 0;
    }
    if (hasOption(parsed, "diagnose", "doctor")) {
      printDiagnose();
      return 0;
    }
    printHelpFor(parsed.positionals, parsed.options.help);
    return hasOption(parsed, "help") ? 0 : 1;
  }

  if (command === "--help" || command === "-h") {
    printHelpFor([], true);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    printVersion();
    return 0;
  }

  if (command === "--diagnose" || command === "--doctor") {
    printDiagnose();
    return 0;
  }

  try {
    if (hasOption(parsed, "help", "h")) {
      printHelpFor(parsed.positionals, parsed.options.help);
      return 0;
    }
    if (command === "test") {
      return await runTestCommand({ positionals: parsed.positionals.slice(1), options: parsed.options });
    }
    if (command === "verify") {
      return await runVerifyCommand({ positionals: parsed.positionals.slice(1), options: parsed.options });
    }
    if (command === "profile" || command === "profiles") {
      return runProfileCommand(parsed);
    }
    if (command === "project") {
      return runProjectCommand(parsed);
    }
    if (command === "diff") {
      return runDiffCommand({ positionals: parsed.positionals.slice(1), options: parsed.options });
    }
    if (command === "inspect") {
      return runInspectionCommand(parsed, parsed.positionals[1]);
    }
    if (command === "adapters" || command === "adapter") {
      return runInspectionCommand(parsed, "adapters");
    }
    if (command === "views" || command === "view") {
      return runInspectionCommand(parsed, "views");
    }
    if (command === "contracts" || command === "contract") {
      return runInspectionCommand(parsed, "semantic-contracts");
    }
    if (command === "renderers" || command === "renderer") {
      return runInspectionCommand(parsed, "renderers");
    }
    if (command === "skill") {
      return runSkillCommand(parsed);
    }

    console.error(`unsupported command: ${command}`);
    printHelpFor([], true);
    return 1;
  } catch (error) {
    let format: OutputFormat = "json";
    try {
      format = outputFormat(parsed);
    } catch {
      // If outputFormat itself throws (e.g., invalid --format), fall back to json
    }
    printError(error, format);
    return 1;
  }
}

function runProfileCommand(parsed: ParsedArguments): number {
  const subcommand = parsed.positionals[1];
  switch (subcommand) {
    case "list":
      return profileList(parsed);
    case "show":
      return profileShow(parsed);
    case "validate":
      return profileValidate(parsed);
    case "run":
      return profileRun(parsed);
    default:
      throw new CliUsageError("profile command must be one of list, show, validate, or run.");
  }
}

function profilePath(parsed: ParsedArguments): string {
  return option(parsed, "profiles", "profile-file", "config") ?? DEFAULT_PROFILE_PATH;
}

function profileList(parsed: ParsedArguments): number {
  const document = loadProfileDocument(profilePath(parsed));
  const format = outputFormat(parsed);
  if (format === "text") {
    printText(document.profiles.map((profile) => `${profile.name}\t${profile.description}`).join("\n"));
  } else {
    printJson({ schemaVersion: document.schemaVersion, profiles: document.profiles });
  }
  return 0;
}

function profileShow(parsed: ParsedArguments): number {
  const name = parsed.positionals[2] ?? option(parsed, "name", "profile");
  if (name === undefined) {
    throw new CliUsageError("profile show requires a profile name.");
  }
  const profile = resolveProfile(loadProfileDocument(profilePath(parsed)), name);
  if (outputFormat(parsed) === "text") {
    printText(
      [
        `name: ${profile.name}`,
        `description: ${profile.description}`,
        `source: ${profile.source.description}`,
        `adapter: ${referenceText(profile.adapter)}`,
        `view: ${referenceText(profile.view)}`,
        `budget: ${profile.budget.maxBytes} ${profile.budget.unit}`,
        `renderer: ${referenceText(profile.renderer)}`,
      ].join("\n"),
    );
  } else {
    printJson(profile);
  }
  return 0;
}

function profileValidate(parsed: ParsedArguments): number {
  const result = validateProfileFile(profilePath(parsed));
  const format = outputFormat(parsed);
  if (format === "text") {
    if (result.valid && result.document !== undefined) {
      printText(`valid: ${result.document.profiles.length} profile(s)`);
    } else {
      printText(result.issues.map((item) => `${item.path}: ${item.message}`).join("\n"));
    }
  } else if (result.valid && result.document !== undefined) {
    printJson({
      valid: true,
      schemaVersion: result.document.schemaVersion,
      profileCount: result.document.profiles.length,
    });
  } else {
    printJson({ valid: false, issues: result.issues });
  }
  return result.valid ? 0 : 1;
}

function profileRun(parsed: ParsedArguments): number {
  const name = parsed.positionals[2] ?? option(parsed, "name", "profile");
  if (name === undefined) {
    throw new CliUsageError("profile run requires a profile name.");
  }
  const profile = resolveProfile(loadProfileDocument(profilePath(parsed)), name);
  const input = readInput(parsed);
  const result = runProfile(profile, input, { core: createProfileCore() });
  if (outputFormat(parsed) === "text") {
    printText(renderedText(result.output));
  } else {
    printJson({ profile: profile.name, ...result });
  }
  return 0;
}

function runProjectCommand(parsed: ParsedArguments): number {
  const adapter = requiredReference(parsed, "adapter");
  const view = requiredReference(parsed, "view");
  const renderer = requiredReference(parsed, "renderer");
  const contract = option(parsed, "contract");
  const maxBytes = requiredNumber(parsed, "budget", "max-bytes");
  const result = createProfileCore().project({
    source: readInput(parsed),
    adapter,
    view,
    renderer,
    budget: createBudget(maxBytes),
    ...(contract === undefined ? {} : { contract }),
  });
  if (outputFormat(parsed) === "text") {
    printText(renderedText(result.output));
  } else {
    printJson(result);
  }
  return 0;
}

function runInspectionCommand(parsed: ParsedArguments, requestedKind: string | undefined): number {
  const kind = normalizeInspectionKind(requestedKind);
  const inspection = inspectRuntime(kind);
  if (outputFormat(parsed) === "text") {
    printText(inspection.components.map((component) => componentText(component)).join("\n"));
  } else {
    printJson(inspection);
  }
  return 0;
}

function runSkillCommand(parsed: ParsedArguments): number {
  const scenarioId = parsed.positionals[1];
  const asJson = hasOption(parsed, "json") || outputFormat(parsed) === "json";
  if (scenarioId === undefined) {
    const scenarios = listSkillScenarios();
    if (asJson) {
      printJson({ scenarios: scenarios.map((scenario) => ({ id: scenario.id, summary: scenario.summary })) });
    } else {
      printText(scenarios.map((scenario) => `${scenario.id}\t${scenario.summary}`).join("\n"));
    }
    return 0;
  }
  const scenario = findSkillScenario(scenarioId);
  if (scenario === undefined) {
    throw new SkillScenarioNotFoundError(scenarioId);
  }
  if (asJson) {
    printJson(scenario);
  } else {
    printText([`${scenario.id}: ${scenario.summary}`, "", ...scenario.steps.map((step) => `- ${step}`)].join("\n"));
  }
  return 0;
}

function normalizeInspectionKind(value: string | undefined): InspectionKind {
  switch (value) {
    case "adapters":
      return "adapters";
    case "contracts":
    case "semantic-contracts":
      return "semantic-contracts";
    case "views":
      return "views";
    case "renderers":
      return "renderers";
    default:
      throw new CliUsageError("inspect requires adapters, contracts, views, or renderers.");
  }
}

function inspectRuntime(kind: InspectionKind) {
  const core = createProfileCore();
  return {
    kind,
    components:
      kind === "adapters"
        ? core.adapters.describe()
        : kind === "semantic-contracts"
          ? core.semanticContracts.describe()
          : kind === "views"
            ? core.views.describe()
            : core.renderers.describe(),
  };
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, OptionValue> = {};
  const knownBooleanOptions = new Set(["help", "version", "human", "json", "diagnose", "doctor"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-") {
      positionals.push(argument);
      continue;
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    const normalized = argument === "-h" ? "help" : argument === "-v" ? "version" : argument.slice(2);
    if (normalized === "") {
      throw new CliUsageError("Option name must not be empty.");
    }
    const equals = normalized.indexOf("=");
    if (equals !== -1) {
      options[normalized.slice(0, equals)] = normalized.slice(equals + 1);
      continue;
    }
    if (knownBooleanOptions.has(normalized)) {
      options[normalized] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
      options[normalized] = next;
      index += 1;
    } else {
      options[normalized] = true;
    }
  }
  return { positionals, options };
}

function hasOption(parsed: ParsedArguments, ...names: string[]): boolean {
  return names.some((name) => parsed.options[name] !== undefined);
}

function option(parsed: ParsedArguments, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.options[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function requiredReference(parsed: ParsedArguments, name: string): ComponentReference {
  const value = option(parsed, name);
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`project requires --${name}.`);
  }
  return value;
}

function requiredNumber(parsed: ParsedArguments, ...names: string[]): number {
  const value = option(parsed, ...names);
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`project requires --${names[0]}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliUsageError(`--${names[0]} must be a non-negative safe integer.`);
  }
  return number;
}

function readInput(parsed: ParsedArguments): Uint8Array {
  const inputPath = option(parsed, "input", "source");
  if (inputPath === undefined || inputPath.trim() === "") {
    throw new CliUsageError("The command requires --input <path|->.");
  }
  return fs.readFileSync(inputPath === "-" ? 0 : inputPath);
}

function outputFormat(parsed: ParsedArguments): OutputFormat {
  if (hasOption(parsed, "human")) {
    return "text";
  }
  const value = option(parsed, "format", "output");
  if (value === undefined || value === "json") {
    return "json";
  }
  if (value === "text" || value === "human") {
    return "text";
  }
  throw new CliUsageError("Output format must be json or text.");
}

function referenceText(reference: ComponentReference): string {
  return typeof reference === "string" ? reference : `${reference.id}@${reference.version}`;
}

function renderedText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function componentText(component: { id: string; version: string; semanticType?: string; format?: string }): string {
  const kind = component.semanticType ?? component.format ?? "component";
  return `${component.id}@${component.version}\t${kind}`;
}

function printJson(value: unknown): void {
  console.log(stableJsonStringify(value));
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

const FULL_OPTION_REFERENCE: readonly string[] = [
  "--help[=full|json]  Print progressive help; use --help=full for the complete reference or --help=json for discovery.",
  "--json  Emit structured JSON output (skill).",
  "--format json|text  JSON is the stable automation contract (default: json).",
  "--human  Use human-readable output.",
  "--version  Print version and runtime contract metadata.",
  "--diagnose  Check standalone runtime readiness.",
  "--doctor  Alias for --diagnose.",
];

/**
 * Dispatches to root, domain, or leaf help from the same command table used
 * by execution dispatch, so `suzukuri <domain> --help` and
 * `suzukuri <domain> <command> --help` are always accurate.
 */
function printHelpFor(positionals: readonly string[], helpValue: string | boolean | undefined): void {
  if (helpValue === "json") return printJson(projectCommandHelp(positionals));
  if (helpValue === "full") return printFullHelp();
  const domain = positionals[0] as CommandDomain | undefined;
  if (domain === undefined) return printRootHelp();
  if (domain === "skill") return printSkillHelp(positionals[1]);
  const definition = getCommandForPositionals(positionals);
  const domainCommands = getDomainCommands(domain);
  if (domainCommands.length === 0) return printRootHelp();
  if (definition !== undefined && (definition.positionalSyntax === undefined || positionals.length > 1)) {
    return printLeafHelp(definition);
  }
  return printDomainHelp(domain);
}

function printSkillHelp(scenarioId: string | undefined): void {
  if (scenarioId !== undefined) {
    const scenario = findSkillScenario(scenarioId);
    if (scenario !== undefined) {
      console.log(
        [`Usage: suzukuri skill ${scenario.id} [--json]`, "", scenario.summary, "", "Run `suzukuri skill` for the full scenario list."].join(
          "\n",
        ),
      );
      return;
    }
  }
  const lines = listSkillScenarios().map((scenario) => `  skill ${scenario.id} [--json]  - ${scenario.summary}`);
  console.log(
    [
      "Usage: suzukuri skill [scenario] [--json]",
      "",
      getDomainDescription("skill") ?? "",
      "",
      "Scenarios:",
      ...lines,
      "",
      "Run `suzukuri skill <scenario> --json` for that scenario's full steps.",
    ].join("\n"),
  );
}

function printRootHelp(): void {
  const lines = DOMAIN_SUMMARIES.map(({ domain, description }) => `  ${domain.padEnd(10)} ${description}`);
  console.log(
    [
      "Usage: suzukuri <command> [options]",
      "",
      "Domains:",
      ...lines,
      "",
      "Run `suzukuri <domain> --help` for that domain's operations.",
      "Run `suzukuri --help=full` for the complete command and option reference.",
      "Run `suzukuri --version` or `suzukuri --diagnose` for machine-readable runtime checks.",
    ].join("\n"),
  );
}

function printDomainHelp(domain: CommandDomain): void {
  const commands = getDomainCommands(domain);
  const lines = commands.map((entry) => `  ${entry.usage}`);
  console.log(
    [
      `Usage: suzukuri ${domain} <command> [options]`,
      "",
      getDomainDescription(domain) ?? "",
      "",
      "Operations:",
      ...lines,
      "",
      `Run \`suzukuri ${domain} <command> --help\` for that command's inputs and an example.`,
    ].join("\n"),
  );
}

function printLeafHelp(command: CommandDefinition): void {
  console.log(
    [
      `Usage: suzukuri ${command.usage}`,
      "",
      command.summary,
      "",
      "Example:",
      `  ${command.example}`,
      "",
      "Run `suzukuri --help=full` for the complete option reference.",
    ].join("\n"),
  );
}

function printFullHelp(): void {
  const commands = SUZUKURI_COMMANDS.filter((entry) => entry.id !== "skill.scenario").map(
    (entry) => `  ${entry.usage}`,
  );
  console.log(
    [
      "Usage: suzukuri <command> [options]",
      "",
      "Commands:",
      ...commands,
      "",
      "Options:",
      ...FULL_OPTION_REFERENCE.map((line) => `  ${line}`),
    ].join("\n"),
  );
}

function projectCommandHelp(positionals: readonly string[]): unknown {
  const domain = positionals[0] as CommandDomain | undefined;
  if (domain === undefined) {
    return {
      usage: "suzukuri <command> [options]",
      domains: DOMAIN_SUMMARIES,
      options: FULL_OPTION_REFERENCE,
    };
  }
  if (domain === "skill") {
    const scenarioId = positionals[1];
    if (scenarioId !== undefined) {
      const scenario = findSkillScenario(scenarioId);
      if (scenario !== undefined) return scenario;
    }
    return { domain, description: getDomainDescription("skill"), scenarios: listSkillScenarios() };
  }
  const definition = getCommandForPositionals(positionals);
  if (definition !== undefined && (definition.positionalSyntax === undefined || positionals.length > 1)) {
    return definition;
  }
  const commands = getDomainCommands(domain);
  if (commands.length === 0) {
    return {
      usage: "suzukuri <command> [options]",
      domains: DOMAIN_SUMMARIES,
      options: FULL_OPTION_REFERENCE,
    };
  }
  return { domain, description: getDomainDescription(domain), commands };
}

function printVersion(): void {
  console.log(`suzukuri ${getVersion()}`);
}

function printDiagnose(): void {
  console.log(stableJsonStringify({ ready: true, name: "suzukuri", version: getVersion() }));
}

function getVersion(): string {
  return packageJson.version;
}
