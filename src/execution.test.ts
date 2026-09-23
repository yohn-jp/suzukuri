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

test("explicit verification tiers survive normalized command and step metadata", () => {
  const config = parseExecutionConfig({
    schemaVersion: 1,
    commands: {
      test: { argv: ["pnpm", "test"], tier: "iteration" },
      verify: {
        tier: "authoritative",
        steps: [
          { name: "lint", argv: ["pnpm", "run", "lint"], tier: "focused" },
          { name: "types", argv: ["pnpm", "run", "types"], tier: "iteration" },
        ],
      },
    },
  });
  assert.equal(config.commands.test?.tier, "iteration");
  const command = config.commands.verify;
  assert.ok(command !== undefined && isSteppedExecutionCommand(command));
  if (command !== undefined && isSteppedExecutionCommand(command)) {
    assert.equal(command.tier, "authoritative");
    assert.deepEqual(
      command.steps.map((step) => step.tier),
      ["focused", "iteration"],
    );
    assert.deepEqual(
      parseExecutionConfig({ schemaVersion: 1, commands: { verify: command } }).commands.verify,
      command,
    );
  }
});

test("verification tiers reject unknown values and remain absent when undeclared", () => {
  assert.throws(
    () => parseExecutionConfig({ schemaVersion: 1, commands: { test: { argv: ["node"], tier: "quick" } } }),
    (error: unknown) =>
      error instanceof ExecutionError &&
      error.code === "EXECUTION_CONFIG_INVALID" &&
      error.details.path === "$.commands.test.tier" &&
      typeof error.details.reason === "string" &&
      error.details.reason.includes("iteration, focused, authoritative"),
  );
  assert.throws(
    () =>
      parseExecutionConfig({
        schemaVersion: 1,
        commands: { verify: { steps: [{ name: "lint", argv: ["pnpm", "run", "lint"], tier: "eventual" }] } },
      }),
    (error: unknown) =>
      error instanceof ExecutionError &&
      error.code === "EXECUTION_CONFIG_INVALID" &&
      error.details.path === "$.commands.verify.steps[0].tier",
  );

  const config = parseExecutionConfig({
    schemaVersion: 1,
    commands: { test: { argv: ["node"] }, verify: { steps: [{ name: "lint", argv: ["pnpm", "run", "lint"] }] } },
  });
  const single = config.commands.test;
  const stepped = config.commands.verify;
  assert.ok(single !== undefined && !isSteppedExecutionCommand(single));
  assert.ok(stepped !== undefined && isSteppedExecutionCommand(stepped));
  if (single !== undefined && !isSteppedExecutionCommand(single)) {
    assert.equal(Object.hasOwn(single, "tier"), false);
  }
  if (stepped !== undefined && isSteppedExecutionCommand(stepped)) {
    assert.equal(Object.hasOwn(stepped, "tier"), false);
    assert.equal(Object.hasOwn(stepped.steps[0], "tier"), false);
  }
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
