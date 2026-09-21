/**
 * Single source of truth for the suzukuri command surface. Both execution
 * dispatch (getCommandForPositionals) and every help surface (root, domain,
 * leaf, --help=full, --help=json) read this table, so a command can never
 * exist in dispatch without being documented or vice versa.
 */

export type CommandDomain =
  | "root"
  | "test"
  | "profile"
  | "project"
  | "diff"
  | "verify"
  | "init"
  | "adapters"
  | "views"
  | "contracts"
  | "renderers"
  | "inspect"
  | "skill";

export interface CommandDefinition {
  readonly id: string;
  readonly domain: CommandDomain;
  readonly path: readonly string[];
  readonly positionalSyntax?: string;
  readonly usage: string;
  readonly summary: string;
  readonly example: string;
}

export const DOMAIN_SUMMARIES: ReadonlyArray<{ readonly domain: CommandDomain; readonly description: string }> = [
  { domain: "test", description: "Execute the configured repository test producer and project bounded results" },
  { domain: "profile", description: "Repository-local profile discovery, validation, and execution" },
  { domain: "project", description: "Explicit low-level adapter/view/renderer projection" },
  { domain: "diff", description: "Bounded git diff/status projection" },
  { domain: "verify", description: "Repository-mapped semantic verify execution" },
  { domain: "init", description: "Guided repository adoption of suzukuri as the public test/verify interface" },
  { domain: "adapters", description: "Inspect the registered adapter surface" },
  { domain: "views", description: "Inspect the registered view surface" },
  { domain: "contracts", description: "Inspect the registered semantic-contract surface" },
  { domain: "renderers", description: "Inspect the registered renderer surface" },
  { domain: "inspect", description: "Inspect any registered component surface by kind" },
  { domain: "skill", description: "Bounded operational playbooks for common suzukuri workflows" },
];

export const SUZUKURI_COMMANDS: readonly CommandDefinition[] = [
  {
    id: "test",
    domain: "test",
    path: ["test"],
    usage: "test [--config path]",
    summary: "Execute the configured repository test producer and project bounded pass/fail results.",
    example: "suzukuri test --config .suzukuri/commands.json",
  },
  {
    id: "profile.list",
    domain: "profile",
    path: ["profile", "list"],
    usage: "profile list [--profiles path]",
    summary: "List the named profiles in a profile document.",
    example: "suzukuri profile list",
  },
  {
    id: "profile.show",
    domain: "profile",
    path: ["profile", "show"],
    positionalSyntax: "<name>",
    usage: "profile show <name> [--profiles path]",
    summary: "Show the resolved adapter/view/budget/renderer identity of one profile.",
    example: "suzukuri profile show text-value",
  },
  {
    id: "profile.validate",
    domain: "profile",
    path: ["profile", "validate"],
    usage: "profile validate [--profiles path]",
    summary: "Validate a profile document and report deterministic issues.",
    example: "suzukuri profile validate",
  },
  {
    id: "profile.run",
    domain: "profile",
    path: ["profile", "run"],
    positionalSyntax: "<name>",
    usage: "profile run <name> --input <path|-> [--profiles path]",
    summary: "Run a named profile against caller-supplied source.",
    example: "suzukuri profile run text-value --input observation.txt",
  },
  {
    id: "project",
    domain: "project",
    path: ["project"],
    usage: "project --adapter <id> --view <id> --budget <bytes> --renderer <id> --input <path|-> [--contract <id>]",
    summary: "Project caller-supplied source through an explicit adapter/view/renderer.",
    example: "suzukuri project --adapter profile-text --view profile-text --budget 4096 --renderer json --input -",
  },
  {
    id: "diff",
    domain: "diff",
    path: ["diff"],
    usage: "diff [--scope worktree|staged|all] [--view summary|files|hunks] [--budget bytes] [--path path]",
    summary: "Acquire and project a bounded git diff or status.",
    example: "suzukuri diff --scope staged --view files",
  },
  {
    id: "verify",
    domain: "verify",
    path: ["verify"],
    usage: "verify [--config path] [--format json|text]",
    summary: "Run the configured repository verify producer and project bounded results.",
    example: "suzukuri verify --config .suzukuri/commands.json",
  },
  {
    id: "init",
    domain: "init",
    path: ["init"],
    usage: "init [--yes] [--dry-run]",
    summary: "Inspect existing test/verify scripts and propose a confirmed migration to suzukuri test/verify.",
    example: "suzukuri init",
  },
  {
    id: "adapters",
    domain: "adapters",
    path: ["adapters"],
    usage: "adapters",
    summary: "List the registered adapter components.",
    example: "suzukuri adapters",
  },
  {
    id: "views",
    domain: "views",
    path: ["views"],
    usage: "views",
    summary: "List the registered view components.",
    example: "suzukuri views",
  },
  {
    id: "contracts",
    domain: "contracts",
    path: ["contracts"],
    usage: "contracts",
    summary: "List the registered semantic-contract components.",
    example: "suzukuri contracts",
  },
  {
    id: "renderers",
    domain: "renderers",
    path: ["renderers"],
    usage: "renderers",
    summary: "List the registered renderer components.",
    example: "suzukuri renderers",
  },
  {
    id: "inspect",
    domain: "inspect",
    path: ["inspect"],
    positionalSyntax: "<adapters|views|contracts|renderers>",
    usage: "inspect <adapters|views|contracts|renderers>",
    summary: "Inspect one registered component surface by kind.",
    example: "suzukuri inspect adapters",
  },
  {
    id: "skill.index",
    domain: "skill",
    path: ["skill"],
    usage: "skill [scenario] [--json]",
    summary: "List bounded operational playbooks for common suzukuri workflows.",
    example: "suzukuri skill",
  },
  {
    id: "skill.scenario",
    domain: "skill",
    path: ["skill"],
    positionalSyntax: "<scenario>",
    usage: "skill <scenario> [--json]",
    summary: "Print one scenario's playbook.",
    example: "suzukuri skill bounded-implementation",
  },
];

const commandsById = new Map(SUZUKURI_COMMANDS.map((entry) => [entry.id, entry]));

export function getCommand(id: string): CommandDefinition | undefined {
  return commandsById.get(id);
}

/**
 * Resolves positionals to the command definition that both execution
 * dispatch and help share, so the two can never disagree about what a
 * given invocation depth means.
 */
export function getCommandForPositionals(positionals: readonly string[]): CommandDefinition | undefined {
  if (positionals.length === 0) return undefined;
  if (positionals[0] === "skill") {
    return positionals.length > 1 ? getCommand("skill.scenario") : getCommand("skill.index");
  }
  return SUZUKURI_COMMANDS.find(
    (entry) =>
      entry.path.length > 0 &&
      entry.path.every((part, index) => positionals[index] === part) &&
      (entry.positionalSyntax === undefined
        ? positionals.length === entry.path.length
        : positionals.length <= entry.path.length + 1),
  );
}

export function getDomainCommands(domain: CommandDomain): readonly CommandDefinition[] {
  return SUZUKURI_COMMANDS.filter((entry) => entry.domain === domain);
}

export function getDomainDescription(domain: CommandDomain): string | undefined {
  return DOMAIN_SUMMARIES.find((entry) => entry.domain === domain)?.description;
}
