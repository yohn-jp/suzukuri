import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCli } from "./cli.js";

const profileFixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.suzukuri/profiles.json");

test("--help exits 0 and prints usage", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--help"]);
    assert.equal(exitCode, 0);
    assert.match(lines.join("\n"), /Usage:/);
  } finally {
    console.log = originalLog;
  }
});

test("no arguments exits 1", async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const exitCode = await runCli([]);
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
  }
});

test("unknown command exits 1", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const exitCode = await runCli(["bogus"]);
    assert.equal(exitCode, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("missing --input exits 1", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (msg: string) => errors.push(msg);
  try {
    const exitCode = await runCli([
      "project",
      "--adapter",
      "profile-text",
      "--view",
      "profile-text",
      "--budget",
      "1024",
      "--renderer",
      "json",
    ]);
    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /--input/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("unresolvable profile name exits 1", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (msg: string) => errors.push(msg);
  try {
    const exitCode = await runCli([
      "profile",
      "run",
      "nonexistent-profile",
      "--profiles",
      profileFixture,
      "--input",
      "-",
    ]);
    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /PROFILE_NOT_FOUND/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("invalid --format value exits 1", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (msg: string) => errors.push(msg);
  try {
    const exitCode = await runCli(["profile", "validate", "--profiles", profileFixture, "--format", "invalid-format"]);
    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /Output format must be json or text/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("profile validate and project expose stable JSON command results", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const validateExitCode = await runCli(["profile", "validate", "--profiles", profileFixture]);
    assert.equal(validateExitCode, 0);
    assert.deepEqual(JSON.parse(lines.pop() ?? "{}"), { profileCount: 5, schemaVersion: 1, valid: true });

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-cli-test-"));
    const inputPath = path.join(tempDirectory, "input.txt");
    fs.writeFileSync(inputPath, "hello");
    try {
      const projectExitCode = await runCli([
        "project",
        "--adapter",
        "profile-text",
        "--view",
        "profile-text",
        "--budget",
        "1024",
        "--renderer",
        "json",
        "--input",
        inputPath,
      ]);
      assert.equal(projectExitCode, 0);
      const result = JSON.parse(lines.pop() ?? "{}") as { output: string };
      assert.equal(result.output, '{"text":"hello"}');
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  } finally {
    console.log = originalLog;
  }
});

test("profile run accepts caller-supplied source and resolves the named profile", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-profile-test-"));
    const inputPath = path.join(tempDirectory, "input.txt");
    fs.writeFileSync(inputPath, "hello");
    try {
      const exitCode = await runCli([
        "profile",
        "run",
        "text-value",
        "--profiles",
        profileFixture,
        "--input",
        inputPath,
      ]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(lines.pop() ?? "{}") as { profile: string; output: string };
      assert.equal(result.profile, "text-value");
      assert.equal(result.output, '{"text":"hello"}');
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  } finally {
    console.log = originalLog;
  }
});

test("test executes an explicit Node test producer and emits bounded success semantics", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  const errors: string[] = [];
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-semantic-test-"));
  const producer = path.join(tempDirectory, "producer.mjs");
  const config = path.join(tempDirectory, "commands.json");
  fs.writeFileSync(
    producer,
    "console.log('TAP version 13\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# duration_ms 2');\n",
  );
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { test: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  console.error = (line: string) => errors.push(line);
  try {
    const exitCode = await runCli(["test", "--config", config]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(lines.pop() ?? "{}"), {
      counts: { failed: 0, passed: 1, skipped: 0, total: 1 },
      durationMs: 2,
      failures: [],
      status: "passed",
      version: "1.0.0",
    });
    assert.deepEqual(errors, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("test projects supported failures without dumping producer output", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  const errors: string[] = [];
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-semantic-test-failure-"));
  const producer = path.join(tempDirectory, "producer.mjs");
  const config = path.join(tempDirectory, "commands.json");
  fs.writeFileSync(
    producer,
    "console.log('TAP version 13\\nnot ok 1 - adds numbers\\n# Expected 3\\n# Received 4\\n1..1\\n# tests 1\\n# pass 0\\n# fail 1'); process.exitCode = 1;\n",
  );
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { test: [process.execPath, producer] } }));
  console.log = (line: string) => lines.push(line);
  console.error = (line: string) => errors.push(line);
  try {
    const exitCode = await runCli(["test", "--config", config]);
    assert.equal(exitCode, 1);
    const result = JSON.parse(lines.pop() ?? "{}") as {
      status: string;
      failures: Array<{ name: string; message: string }>;
    };
    assert.equal(result.status, "failed");
    assert.equal(result.failures[0]?.name, "adds numbers");
    assert.match(result.failures[0]?.message ?? "", /Expected 3/);
    assert.deepEqual(errors, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("test reports missing mapping with a stable bounded diagnostic", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const errors: string[] = [];
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-semantic-test-invalid-"));
  const config = path.join(tempDirectory, "commands.json");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: {} }));
  console.log = () => {};
  console.error = (line: string) => errors.push(line);
  try {
    const exitCode = await runCli(["test", "--config", config]);
    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /EXECUTION_COMMAND_NOT_FOUND/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
