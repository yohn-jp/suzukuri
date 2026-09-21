import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionError, parseExecutionConfig, runBoundedProcess } from "./execution.js";

test("execution config accepts exact argv arrays and rejects shell strings", () => {
  const config = parseExecutionConfig({ schemaVersion: 1, commands: { test: ["node", "--test"] } });
  assert.deepEqual(config.commands.test?.argv, ["node", "--test"]);
  assert.deepEqual(parseExecutionConfig({ schemaVersion: 1, test: ["node", "--test"] }).commands.test?.argv, [
    "node",
    "--test",
  ]);
  assert.throws(
    () => parseExecutionConfig({ schemaVersion: 1, commands: { test: "node --test" } }),
    (error: unknown) => error instanceof ExecutionError && error.code === "EXECUTION_CONFIG_INVALID",
  );
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
