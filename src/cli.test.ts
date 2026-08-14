import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";

const profileFixture = path.resolve(".suzukuri/profiles.json");

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
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-profile-test-"));
  const inputPath = path.join(tempDirectory, "input.txt");
  fs.writeFileSync(inputPath, "hello");
  try {
    const exitCode = await runCli(["profile", "run", "text-value", "--profiles", profileFixture, "--input", inputPath]);
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines.pop() ?? "{}") as { profile: string; output: string };
    assert.equal(result.profile, "text-value");
    assert.equal(result.output, '{"text":"hello"}');
  } finally {
    console.log = originalLog;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
