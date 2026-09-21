/**
 * Bounded operational playbooks for common suzukuri workflows, derived from
 * the AGENTS.md execution contract. Each scenario is a fixed, versioned
 * summary; it never reads live repository state.
 */

export interface SkillScenario {
  readonly id: string;
  readonly summary: string;
  readonly steps: readonly string[];
}

export const SKILL_SCENARIOS: readonly SkillScenario[] = [
  {
    id: "bounded-implementation",
    summary: "Follow the default bounded implementation path for a governed change.",
    steps: [
      "contract: start from files, symbols, tests, and commands explicitly named by the request.",
      "target evidence: gather the narrowest sufficient evidence (see read-discipline).",
      "edit: implement the accepted gap only; do not redesign settled decisions.",
      "focused validation: run the minimum focused test/check that proves the changed behavior.",
      "final validation: run full required verification once the write-set stabilizes.",
      "requested lifecycle: complete exactly the requested lifecycle (see lifecycle).",
    ],
  },
  {
    id: "read-discipline",
    summary: "Use the narrowest sufficient evidence before editing.",
    steps: [
      "Prefer facts already supplied by the user or Issue.",
      "Use an exact indexed or structural query for a named question.",
      "Read the exact target symbol/file.",
      "Follow a direct dependency or relevant test only when needed.",
      "Read broader source/history only when a concrete unresolved question requires it.",
      "Do not scan the repository merely for orientation; do not reread unchanged evidence.",
    ],
  },
  {
    id: "first-sufficient-implementation",
    summary: "Choose the first solution that satisfies acceptance criteria without weakening correctness.",
    steps: [
      "1. No change if behavior already satisfies the request.",
      "2. Delete or simplify.",
      "3. Reuse an existing repository primitive/pattern.",
      "4. Use a language/platform native capability.",
      "5. Use an already-installed dependency.",
      "6. Add the minimum new machinery.",
      "Complexity requires evidence; hypothetical future needs are not evidence.",
    ],
  },
  {
    id: "git-isolation",
    summary: "Keep implementation changes off main/master and inside the correct branch or worktree.",
    steps: [
      "Never create, modify, delete, stage, or commit implementation changes directly on main or master.",
      "Use the supplied task branch/worktree when one exists; otherwise create the governed task branch.",
      "If already inside the correct worktree, keep using it.",
      "Do not overwrite, reset, stash, or commit unrelated existing changes.",
      "Report branch/worktree collisions or guard failures exactly; do not bypass them.",
    ],
  },
  {
    id: "validation-review",
    summary: "Validate and review a change against its accepted contract.",
    steps: [
      "Treat the Issue's validation and acceptance criteria as authoritative when specified.",
      "Run the minimum focused test/check that proves the changed behavior during implementation.",
      "Run full required verification only after the write-set stabilizes.",
      "Rerun a check only after a result-affecting change; never call a pending or unexecuted check passed.",
      "Compare the actual diff and tests against the accepted contract, architecture, error paths, scope, and current CI.",
    ],
  },
  {
    id: "lifecycle",
    summary: "Complete exactly the requested lifecycle phase, no more and no less.",
    steps: [
      "local-only: complete requested local work; commit only when requested/required; stop.",
      "standalone Issue/PR: branch/worktree, implement, validate, commit, push, open PR, verify metadata once, stop.",
      "Do not stop at diagnosis, planning, tests, or commit when further execution was requested and available.",
      "Do not continue beyond the requested phase.",
      "Never merge, close, force-push, or bypass governance unless explicitly authorized.",
    ],
  },
];

export function listSkillScenarios(): readonly SkillScenario[] {
  return SKILL_SCENARIOS;
}

export function findSkillScenario(id: string): SkillScenario | undefined {
  return SKILL_SCENARIOS.find((scenario) => scenario.id === id);
}

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
