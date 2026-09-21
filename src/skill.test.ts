import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedSkillIndex,
  boundedSkillScenario,
  findSkillScenario,
  listSkillScenarios,
  MAX_SKILL_OUTPUT_BYTES,
  projectSkillIndexToJson,
  projectSkillScenarioToJson,
  SKILL_MODEL_VERSION,
  type SkillScenario,
  validateSkillCommandReferences,
} from "./skill.js";
import { commandExample, commandHelpPointer, commandInvocation, commandUsage, getCommand } from "./command-contract.js";

test("Skill scenarios use the versioned command-contract projection", () => {
  for (const scenario of listSkillScenarios()) {
    assert.equal(scenario.version, SKILL_MODEL_VERSION);
    const canonicalCommand = getCommand(scenario.canonicalCommandId);
    assert.ok(canonicalCommand);
    assert.equal(scenario.canonicalEntrypoint, commandInvocation(canonicalCommand.id));
    assert.equal(scenario.helpDomain, canonicalCommand.domain);
    assert.equal(scenario.helpPointer, commandHelpPointer(canonicalCommand.id));
    for (const step of scenario.workflow) {
      if (step.commandId === undefined) continue;
      const command = getCommand(step.commandId);
      assert.ok(command);
      assert.equal(step.command, commandExample(command.id));
      assert.equal(step.usage, commandUsage(command.id));
      assert.equal(step.helpPointer, commandHelpPointer(command.id));
    }
  }
  assert.deepEqual(validateSkillCommandReferences(), []);
});

test("repository-operation teaches the canonical run route without producer bypass", () => {
  const scenario = findSkillScenario("repository-operation");
  assert.ok(scenario);
  assert.equal(scenario.canonicalCommandId, "run");
  assert.ok(scenario.workflow.some((step) => step.commandId === "run"));
  assert.ok(scenario.invariants.some((invariant) => invariant.includes("Do not bypass")));
  const rendered = boundedSkillScenario(scenario, false);
  assert.match(rendered, /suzukuri run build/);
  assert.match(rendered, /suzukuri run --help/);
  assert.doesNotMatch(rendered, /\b(pnpm|npm)\b/);
});

test("text and JSON Skill projections share the structured model and stay bounded", () => {
  const indexJson = projectSkillIndexToJson();
  assert.equal(indexJson.version, SKILL_MODEL_VERSION);
  assert.ok(indexJson.scenarios.some((scenario) => scenario.id === "repository-operation"));
  const indexText = boundedSkillIndex(false);
  const indexJsonText = boundedSkillIndex(true);
  assert.match(indexText, new RegExp(`v${SKILL_MODEL_VERSION}`));
  assert.equal(JSON.parse(indexJsonText).version, SKILL_MODEL_VERSION);
  assert.ok(Buffer.byteLength(indexText, "utf8") <= MAX_SKILL_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(indexJsonText, "utf8") <= MAX_SKILL_OUTPUT_BYTES);

  for (const scenario of listSkillScenarios()) {
    const projected = projectSkillScenarioToJson(scenario);
    assert.deepEqual(projected, scenario);
    const jsonText = boundedSkillScenario(scenario, true);
    const text = boundedSkillScenario(scenario, false);
    assert.deepEqual(JSON.parse(jsonText), projected);
    assert.match(text, new RegExp(escapeRegExp(scenario.title)));
    assert.ok(Buffer.byteLength(jsonText, "utf8") <= MAX_SKILL_OUTPUT_BYTES);
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_SKILL_OUTPUT_BYTES);
  }
});

test("Skill validation reports unknown command references", () => {
  const source = listSkillScenarios()[0];
  const invalid = {
    ...source,
    canonicalCommandId: "missing-command",
  } as SkillScenario;
  const issues = validateSkillCommandReferences([invalid]);
  assert.ok(issues.some((issue) => issue.path === "bounded-implementation.canonicalCommandId"));

  const invalidWorkflow = {
    ...source,
    workflow: [
      ...source.workflow,
      { summary: "invalid", commandId: "missing-command", command: "", usage: "", helpPointer: "" },
    ],
  } as SkillScenario;
  assert.ok(
    validateSkillCommandReferences([invalidWorkflow]).some((issue) => issue.path.endsWith("workflow[6].commandId")),
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
