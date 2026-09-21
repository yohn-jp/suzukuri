import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { runVerifyCommand } from "./verify-command.js";
import { VERIFY_RESULT_SCHEMA_VERSION, isVerifyResult, validateVerifyResult } from "./verify-result.js";

function fixture(prefix: string): { directory: string; producer: string; config: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    producer: path.join(directory, "producer.mjs"),
    config: path.join(directory, "commands.json"),
  };
}

test("verify returns a minimal semantic success result for an explicit aggregate argv", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-success-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(
    producer,
    "if (process.argv.slice(2).join(' ') !== 'format:check lint typecheck test governance:actions test:package') process.exit(2);\n" +
      "console.log('verbose format/lint/typecheck/test/governance/package output'.repeat(10000));\n",
  );
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: [
          process.execPath,
          producer,
          "format:check",
          "lint",
          "typecheck",
          "test",
          "governance:actions",
          "test:package",
        ],
      },
    }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["verify", "--config", config]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
      completeness: "complete",
      status: "passed",
      version: VERIFY_RESULT_SCHEMA_VERSION,
    });
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify identifies an observable failing stage and bounds its diagnostic", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-failure-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(
    producer,
    "console.log('x'.repeat(100000) + '\\n> package@1.0.0 lint /repo\\n> eslint .\\nError: stage: lint'); process.exitCode = 1;\n",
  );
  fs.writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer, "lint"] } }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(exitCode, 1);
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "lint");
    assert.equal(result.completeness, "complete");
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(String(result.diagnostic), "utf8") <= 8 * 1024);
    assert.equal(isVerifyResult(result), true);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify emits an explicit incomplete unknown-stage result when evidence is insufficient", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-unknown-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(producer, "process.stderr.write('opaque failure\\n'); process.exitCode = 1;\n");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    assert.equal(exitCode, 1);
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(result.stage, "unknown");
    assert.equal(result.completeness, "incomplete");
    assert.equal(validateVerifyResult(result).valid, true);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("verify preserves a producer signal outcome", async () => {
  const { directory, producer, config } = fixture("suzukuri-verify-signal-");
  const lines: string[] = [];
  const originalLog = console.log;
  fs.writeFileSync(producer, "process.kill(process.pid, 'SIGTERM');\n");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { verify: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runVerifyCommand({ positionals: [], options: { config } });
    const result = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(exitCode, 128 + 15);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.exitCode, null);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
