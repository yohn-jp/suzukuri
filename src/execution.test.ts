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

test("test/verify default to their known specialized projection and fingerprint reuse; other commands default to generic/never", () => {
  const config = parseExecutionConfig({
    schemaVersion: 1,
    commands: {
      test: { argv: ["node", "--test"] },
      verify: { argv: ["pnpm", "run", "verify"] },
      build: { argv: ["tsc"] },
    },
  });
  assert.equal(config.commands.test?.projection, "test-result");
  assert.equal(config.commands.test?.reuse, "fingerprint");
  assert.equal(config.commands.verify?.projection, "verification-result");
  assert.equal(config.commands.verify?.reuse, "fingerprint");
  assert.equal(config.commands.build?.projection, "generic");
  assert.equal(config.commands.build?.reuse, "never");
});

test("an explicit projection/reuse declaration overrides the name-based default", () => {
  const config = parseExecutionConfig({
    schemaVersion: 1,
    commands: {
      build: { argv: ["tsc"], projection: "generic", reuse: "fingerprint" },
      test: { argv: ["node", "--test"], projection: "generic" },
    },
  });
  assert.equal(config.commands.build?.reuse, "fingerprint");
  assert.equal(config.commands.test?.projection, "generic");
  assert.equal(config.commands.test?.reuse, "never", "generic overrides the test-name default projection's reuse too");
  assert.throws(
    () => parseExecutionConfig({ schemaVersion: 1, commands: { build: { argv: ["tsc"], projection: "bogus" } } }),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
  );
  assert.throws(
    () => parseExecutionConfig({ schemaVersion: 1, commands: { build: { argv: ["tsc"], reuse: "bogus" } } }),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
  );
});

test("an arbitrary repository-local command name is accepted; only diff rejects ordered steps", () => {
  const config = parseExecutionConfig({
    schemaVersion: 1,
    commands: {
      "test:package": { argv: ["node", "scripts/run-package-suite.mjs"] },
    },
  });
  assert.ok(config.commands["test:package"] !== undefined);
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
