import { stableJsonStringify } from "./core.js";
import {
  commandExample,
  commandHelpPointer,
  commandInvocation,
  commandUsage,
  getCommand,
  type CommandDomain,
} from "./command-contract.js";

export const SKILL_MODEL_VERSION = "1.0.0";
export const MAX_SKILL_OUTPUT_BYTES = 4096;

export type SkillScope = "default-route" | "leaf-operation" | "specialized-alternative";

export interface SkillContractReference {
  readonly contract: string;
  readonly output: string;
  readonly instruction: string;
}

export interface SkillWorkflowStep {
  readonly summary: string;
  readonly commandId?: string;
  readonly command?: string;
  readonly usage?: string;
  readonly helpPointer?: string;
}

export interface SkillScenario {
  readonly version: string;
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly scope: SkillScope;
  readonly delegatesTo?: string;
  readonly workflow: readonly SkillWorkflowStep[];
  readonly contractReferences: readonly SkillContractReference[];
  readonly invariants: readonly string[];
  readonly canonicalCommandId: string;
  readonly helpDomain: CommandDomain;
  readonly canonicalEntrypoint: string;
  readonly helpPointer: string;
}

interface SkillScenarioDefinition {
  readonly id: string;
  readonly title: string;
  readonly whenToUse: string;
  readonly scope: SkillScope;
  readonly delegatesTo?: string;
  readonly workflow: readonly SkillWorkflowStep[];
  readonly contractReferences?: readonly SkillContractReference[];
  readonly invariants: readonly string[];
  readonly canonicalCommandId: string;
}

export interface SkillContractValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface SkillIndex {
  readonly version: string;
  readonly scenarios: readonly {
    readonly id: string;
    readonly title: string;
    readonly whenToUse: string;
    readonly scope: SkillScope;
    readonly delegatesTo?: string;
  }[];
}

function projectWorkflowStep(step: SkillWorkflowStep): SkillWorkflowStep {
  if (step.commandId === undefined) {
    return { summary: step.summary };
  }
  const command = getCommand(step.commandId);
  if (command === undefined) {
    throw new Error(`Skill workflow references unknown command ${step.commandId}.`);
  }
  return {
    summary: step.summary,
    commandId: step.commandId,
    command: commandExample(command.id),
    usage: commandUsage(command.id),
    helpPointer: commandHelpPointer(command.id),
  };
}

function projectScenario(definition: SkillScenarioDefinition): SkillScenario {
  const command = getCommand(definition.canonicalCommandId);
  if (command === undefined) {
    throw new Error(`Skill scenario ${definition.id} references unknown command ${definition.canonicalCommandId}.`);
  }
  return {
    version: SKILL_MODEL_VERSION,
    id: definition.id,
    title: definition.title,
    whenToUse: definition.whenToUse,
    scope: definition.scope,
    ...(definition.delegatesTo === undefined ? {} : { delegatesTo: definition.delegatesTo }),
    workflow: definition.workflow.map(projectWorkflowStep),
    contractReferences: definition.contractReferences ?? [],
    invariants: definition.invariants,
    canonicalCommandId: command.id,
    helpDomain: command.domain,
    canonicalEntrypoint: commandInvocation(command.id),
    helpPointer: commandHelpPointer(command.id),
  };
}

const SKILL_SCENARIO_DEFINITIONS: readonly SkillScenarioDefinition[] = [
  {
    id: "bounded-implementation",
    title: "Follow a bounded implementation",
    whenToUse: "Use when implementing one accepted gap within a governed repository task.",
    scope: "default-route",
    workflow: [
      {
        summary: "Start from the files, symbols, tests, and commands explicitly named by the request.",
      },
      {
        summary: "Gather the narrowest sufficient target evidence before editing.",
      },
      {
        summary: "Implement only the accepted gap and preserve settled architecture and contracts.",
      },
      {
        summary: "Run the minimum focused check that proves the changed behavior.",
        commandId: "verify",
      },
      {
        summary: "Run full required verification after the write-set stabilizes.",
        commandId: "verify",
      },
      {
        summary: "Complete exactly the requested lifecycle phase.",
      },
    ],
    invariants: [
      "Implement the accepted gap only; report newly noticed out-of-scope problems instead of expanding the write-set.",
      "Use the supplied task branch or worktree and preserve unrelated existing changes.",
      "Treat the accepted Issue and repository contracts as authoritative when they specify architecture, scope, or validation.",
    ],
    canonicalCommandId: "skill.scenario",
  },
  {
    id: "read-discipline",
    title: "Use narrow evidence",
    whenToUse: "Use before editing when deciding what repository evidence is sufficient.",
    scope: "specialized-alternative",
    delegatesTo: "bounded-implementation",
    workflow: [
      { summary: "Prefer facts already supplied by the user or accepted Issue." },
      { summary: "Use an exact structural query for a named question." },
      { summary: "Read the exact target symbol or file, then only its direct dependency when needed." },
      { summary: "Read broader source or history only for a concrete unresolved question." },
    ],
    invariants: [
      "Do not scan the repository merely for orientation or reread unchanged evidence.",
      "Stop gathering evidence once the next implementation decision is supported.",
    ],
    canonicalCommandId: "skill.scenario",
  },
  {
    id: "first-sufficient-implementation",
    title: "Choose the first sufficient implementation",
    whenToUse: "Use when more than one implementation could satisfy the accepted contract.",
    scope: "specialized-alternative",
    delegatesTo: "bounded-implementation",
    workflow: [
      { summary: "Keep the existing behavior when it already satisfies the request." },
      { summary: "Delete or simplify before adding machinery." },
      { summary: "Reuse an existing repository primitive or a native capability." },
      { summary: "Add new machinery only when the accepted contract requires it." },
    ],
    invariants: [
      "Complexity requires evidence; hypothetical future needs are not evidence.",
      "Do not add a wrapper, extension point, fallback, or compatibility layer for an unrequested future use.",
    ],
    canonicalCommandId: "skill.scenario",
  },
  {
    id: "git-isolation",
    title: "Keep implementation work isolated",
    whenToUse: "Use when preparing or checking the branch and worktree for implementation.",
    scope: "specialized-alternative",
    delegatesTo: "bounded-implementation",
    workflow: [
      { summary: "Use the supplied task branch and dedicated worktree when one exists." },
      { summary: "If the correct worktree is already active, continue using it." },
      { summary: "Stop and report branch, worktree, base, or ownership collisions exactly." },
    ],
    invariants: [
      "Never create, modify, delete, stage, or commit implementation changes directly on main or master.",
      "Do not overwrite, reset, stash, or commit unrelated existing changes.",
      "Do not bypass an isolation guard or silently change the governed base.",
    ],
    canonicalCommandId: "skill.scenario",
  },
  {
    id: "validation-review",
    title: "Validate against the accepted contract",
    whenToUse: "Use while validating and reviewing a bounded implementation before its requested lifecycle step.",
    scope: "specialized-alternative",
    delegatesTo: "bounded-implementation",
    workflow: [
      { summary: "Run the focused check that proves the changed behavior.", commandId: "verify" },
      { summary: "Run full required verification only after the write-set stabilizes.", commandId: "verify" },
      { summary: "Compare the actual diff and tests with the accepted contract, scope, and error paths." },
    ],
    invariants: [
      "Never call an unexecuted, pending, stale, hung, unavailable, or environment-blocked check passed.",
      "Rerun a check only after a result-affecting change.",
      "Remote CI and local validation are separate evidence.",
    ],
    canonicalCommandId: "verify",
  },
  {
    id: "lifecycle",
    title: "Complete the requested lifecycle",
    whenToUse: "Use when implementation, validation, and the next requested repository operation are available.",
    scope: "specialized-alternative",
    delegatesTo: "bounded-implementation",
    workflow: [
      { summary: "Complete local-only work and stop at the requested local boundary." },
      {
        summary:
          "For a standalone Issue or PR, continue through branch, implementation, validation, commit, push, and review admission as requested.",
      },
      { summary: "Stop after the requested phase instead of merging or changing review state." },
    ],
    invariants: [
      "Do not stop at diagnosis, planning, tests, or commit when the requested lifecycle continues and the next governed step is available.",
      "Never merge, close, force-push, release, or bypass governance without explicit authorization.",
    ],
    canonicalCommandId: "skill.scenario",
  },
  {
    id: "repository-operation",
    title: "Use a registered repository operation",
    whenToUse: "Use when a repository operation is registered in the Suzukuri command registry.",
    scope: "leaf-operation",
    workflow: [
      {
        summary: "Invoke the registered repository operation through Suzukuri's command surface.",
        commandId: "run",
      },
      {
        summary:
          "Project the bounded result returned by the registered operation and preserve its configured execution contract.",
        commandId: "run",
      },
    ],
    contractReferences: [
      {
        contract: "repository-command-registry",
        output: "registeredOperations",
        instruction:
          "Use the repository registry as the authority for available operations; Skill only guides their canonical invocation.",
      },
    ],
    invariants: [
      "When an operation is registered, invoke it through the Suzukuri run surface.",
      "Do not bypass a registered operation with a raw package-manager or producer command.",
      "Repository command definitions remain owned by .suzukuri/commands.json; Skill does not define or replace them.",
    ],
    canonicalCommandId: "run",
  },
];

export class SkillScenarioNotFoundError extends Error {
  readonly code = "SKILL_SCENARIO_NOT_FOUND";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(id: string) {
    super(`Unknown skill scenario: ${id}`);
    this.name = "SkillScenarioNotFoundError";
    this.details = { id, available: SKILL_SCENARIOS.map((scenario) => scenario.id) };
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const SKILL_SCENARIOS: readonly SkillScenario[] = SKILL_SCENARIO_DEFINITIONS.map(projectScenario);

export function validateSkillCommandReferences(
  scenarios: readonly SkillScenario[] = SKILL_SCENARIOS,
): readonly SkillContractValidationIssue[] {
  const issues: SkillContractValidationIssue[] = [];
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  const seenScenarioIds = new Set<string>();
  for (const scenario of scenarios) {
    if (seenScenarioIds.has(scenario.id)) {
      issues.push({ path: `${scenario.id}.id`, message: "scenario id is duplicated" });
    }
    seenScenarioIds.add(scenario.id);
    const canonicalCommand = getCommand(scenario.canonicalCommandId);
    if (canonicalCommand === undefined) {
      issues.push({
        path: `${scenario.id}.canonicalCommandId`,
        message: `unknown command contract: ${scenario.canonicalCommandId}`,
      });
    } else {
      if (scenario.canonicalEntrypoint !== commandInvocation(canonicalCommand.id)) {
        issues.push({
          path: `${scenario.id}.canonicalEntrypoint`,
          message: "canonical entrypoint does not match the command contract",
        });
      }
      if (scenario.helpPointer !== commandHelpPointer(canonicalCommand.id)) {
        issues.push({
          path: `${scenario.id}.helpPointer`,
          message: "help pointer does not match the command contract",
        });
      }
      if (scenario.helpDomain !== canonicalCommand.domain) {
        issues.push({
          path: `${scenario.id}.helpDomain`,
          message: "help domain does not match the command contract",
        });
      }
    }
    if (scenario.delegatesTo !== undefined && !scenarioIds.has(scenario.delegatesTo)) {
      issues.push({ path: `${scenario.id}.delegatesTo`, message: `unknown scenario: ${scenario.delegatesTo}` });
    }
    scenario.workflow.forEach((step, index) => {
      if (step.commandId === undefined) return;
      const command = getCommand(step.commandId);
      if (command === undefined) {
        issues.push({
          path: `${scenario.id}.workflow[${index}].commandId`,
          message: `unknown command contract: ${step.commandId}`,
        });
        return;
      }
      if (step.command !== commandExample(command.id) || step.usage !== commandUsage(command.id)) {
        issues.push({
          path: `${scenario.id}.workflow[${index}]`,
          message: "command projection does not match the command contract",
        });
      }
      if (step.helpPointer !== commandHelpPointer(command.id)) {
        issues.push({
          path: `${scenario.id}.workflow[${index}].helpPointer`,
          message: "help pointer does not match the command contract",
        });
      }
    });
  }
  return issues;
}

const initialValidationIssues = validateSkillCommandReferences(SKILL_SCENARIOS);
if (initialValidationIssues.length > 0) {
  throw new Error(`Invalid Skill command contract: ${stableJsonStringify(initialValidationIssues)}`);
}

export function assertSkillCommandContract(scenarios: readonly SkillScenario[] = SKILL_SCENARIOS): void {
  const issues = validateSkillCommandReferences(scenarios);
  if (issues.length > 0) {
    throw new Error(`Invalid Skill command contract: ${stableJsonStringify(issues)}`);
  }
}

export function listSkillScenarios(): readonly SkillScenario[] {
  return SKILL_SCENARIOS;
}

export function findSkillScenario(id: string): SkillScenario | undefined {
  return SKILL_SCENARIOS.find((scenario) => scenario.id === id);
}

export function projectSkillIndexToJson(): SkillIndex {
  return {
    version: SKILL_MODEL_VERSION,
    scenarios: SKILL_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      whenToUse: scenario.whenToUse,
      scope: scenario.scope,
      ...(scenario.delegatesTo === undefined ? {} : { delegatesTo: scenario.delegatesTo }),
    })),
  };
}

export function projectSkillIndexToText(): string {
  const lines = [`Suzukuri skill scenarios (v${SKILL_MODEL_VERSION}):`, ""];
  for (const scenario of SKILL_SCENARIOS) {
    const route =
      scenario.scope === "default-route"
        ? "default route"
        : scenario.scope === "leaf-operation"
          ? "leaf operation"
          : scenario.delegatesTo === undefined
            ? "specialized alternative"
            : `specialized alternative; see \`${commandInvocation("skill.scenario", scenario.delegatesTo)}\``;
    lines.push(`  ${scenario.id} - ${scenario.title} [${route}]`);
    lines.push(`    ${scenario.whenToUse}`);
  }
  lines.push("");
  lines.push(`Run \`${commandUsage("skill.scenario")}\` for a full scenario projection.`);
  return lines.join("\n");
}

export function projectSkillIndexToJsonString(): string {
  return boundedSkillOutput(stableJsonStringify(projectSkillIndexToJson()), undefined);
}

export function projectSkillScenarioToJson(scenario: SkillScenario): SkillScenario {
  const command = getCommand(scenario.canonicalCommandId);
  if (command === undefined) {
    throw new Error(`Skill scenario ${scenario.id} references unknown command ${scenario.canonicalCommandId}.`);
  }
  return {
    ...scenario,
    version: SKILL_MODEL_VERSION,
    workflow: scenario.workflow.map(projectWorkflowStep),
    canonicalCommandId: command.id,
    helpDomain: command.domain,
    canonicalEntrypoint: commandInvocation(command.id),
    helpPointer: commandHelpPointer(command.id),
  };
}

export function projectSkillScenarioToJsonString(scenario: SkillScenario): string {
  return boundedSkillOutput(stableJsonStringify(projectSkillScenarioToJson(scenario)), scenario.id);
}

export function projectSkillScenarioToText(scenario: SkillScenario): string {
  const projected = projectSkillScenarioToJson(scenario);
  const lines = [
    `${projected.title} (${projected.id})`,
    `Model version: ${projected.version}`,
    "",
    `When to use: ${projected.whenToUse}`,
    "",
    `Scope: ${scopeText(projected)}`,
    "",
    "Workflow:",
  ];
  projected.workflow.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.summary}`);
    if (step.command !== undefined) lines.push(`     ${step.command}`);
    if (step.usage !== undefined) lines.push(`     Usage: ${step.usage}`);
    if (step.helpPointer !== undefined) lines.push(`     Help: ${step.helpPointer}`);
  });
  if (projected.contractReferences.length > 0) {
    lines.push("", "Canonical contract references:");
    for (const reference of projected.contractReferences) {
      lines.push(`  - ${reference.contract}.${reference.output}: ${reference.instruction}`);
    }
  }
  lines.push("", "Invariants:");
  for (const invariant of projected.invariants) lines.push(`  - ${invariant}`);
  lines.push("", `Canonical entrypoint: ${projected.canonicalEntrypoint}`);
  lines.push(`Exact syntax: ${projected.helpPointer}`);
  return boundedSkillOutput(lines.join("\n"), projected.id);
}

export function boundedSkillIndex(asJson: boolean): string {
  return asJson ? projectSkillIndexToJsonString() : boundedSkillOutput(projectSkillIndexToText(), undefined);
}

export function boundedSkillScenario(scenario: SkillScenario, asJson: boolean): string {
  return asJson ? projectSkillScenarioToJsonString(scenario) : projectSkillScenarioToText(scenario);
}

function scopeText(scenario: SkillScenario): string {
  if (scenario.scope === "default-route") return `default route (run \`${scenario.canonicalEntrypoint}\`)`;
  if (scenario.scope === "leaf-operation") return "leaf operation";
  return scenario.delegatesTo === undefined
    ? "specialized alternative"
    : `specialized alternative; see \`${commandInvocation("skill.scenario", scenario.delegatesTo)}\``;
}

function boundedSkillOutput(output: string, scenarioId: string | undefined): string {
  const observedBytes = Buffer.byteLength(output, "utf8");
  if (observedBytes > MAX_SKILL_OUTPUT_BYTES) {
    const suffix = scenarioId === undefined ? "index" : `scenario ${scenarioId}`;
    throw new Error(`Skill ${suffix} output exceeds ${MAX_SKILL_OUTPUT_BYTES} bytes (${observedBytes}).`);
  }
  return output;
}
