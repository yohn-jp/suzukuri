import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExecutionError,
  isSteppedExecutionCommand,
  parseExecutionConfig,
  runBoundedCommandSteps,
  runBoundedProcess,
  type ExecutionCommand,
} from "./execution.js";

function singleArgv(command: ExecutionCommand | undefined): readonly string[] | undefined {
  if (command === undefined || isSteppedExecutionCommand(command)) return undefined;
  return command.argv;
}

test("execution config accepts exact argv arrays and rejects shell strings", () => {
  const config = parseExecutionConfig({ schemaVersion: 1, commands: { test: ["node", "--test"] } });
  assert.deepEqual(singleArgv(config.commands.test), ["node", "--test"]);
  assert.deepEqual(singleArgv(parseExecutionConfig({ schemaVersion: 1, test: ["node", "--test"] }).commands.test), [
    "node",
    "--test",
  ]);
  assert.throws(
    () => parseExecutionConfig({ schemaVersion: 1, commands: { test: "node --test" } }),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
  );
});

test("execution config accepts ordered named steps and rejects duplicate or missing step names", () => {
  const config = parseExecutionConfig({
    schemaVersion: 1,
    commands: {
      verify: {
        steps: [
          { name: "lint", argv: ["pnpm", "run", "lint"] },
          { name: "test", argv: ["pnpm", "test"] },
        ],
      },
    },
  });
  const command = config.commands.verify;
  assert.ok(command !== undefined && isSteppedExecutionCommand(command));
  if (command !== undefined && isSteppedExecutionCommand(command)) {
    assert.deepEqual(
      command.steps.map((step) => step.name),
      ["lint", "test"],
    );
  }
  assert.throws(
    () =>
      parseExecutionConfig({
        schemaVersion: 1,
        commands: {
          verify: {
            steps: [
              { name: "lint", argv: ["a"] },
              { name: "lint", argv: ["b"] },
            ],
          },
        },
      }),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
  );
  assert.throws(
    () => parseExecutionConfig({ schemaVersion: 1, commands: { diff: { steps: [{ name: "a", argv: ["a"] }] } } }),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
  );
});

test("bounded command steps stop at the first failed step and skip the rest", async () => {
  const result = await runBoundedCommandSteps([
    { name: "ok", argv: [process.execPath, "-e", "process.exit(0)"] },
    { name: "broken", argv: [process.execPath, "-e", "process.exit(3)"] },
    { name: "never-runs", argv: [process.execPath, "-e", "process.exit(0)"] },
  ]);
  assert.equal(result.steps.length, 2);
  assert.equal(result.failedStep?.name, "broken");
  assert.equal(result.failedStep?.exitCode, 3);
});

test("bounded process execution retains a finite tail under verbose output", async () => {
  const result = await runBoundedProcess(
    [process.execPath, "-e", "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000));"],
    { maxOutputBytes: 128 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 128);
  assert.equal(result.stderr.length, 128);
  assert.equal(result.truncated, true);
});
