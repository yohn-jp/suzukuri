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

test("--help=full prints the complete command and option reference", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--help=full"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /inspect <adapters\|views\|contracts\|renderers>/);
    assert.match(output, /skill \[scenario\] \[--json\]/);
  } finally {
    console.log = originalLog;
  }
});

test("--help=json prints machine-readable discovery", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--help=json"]);
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines.pop() ?? "{}") as { usage: string; domains: Array<{ domain: string }> };
    assert.equal(result.usage, "suzukuri <command> [options]");
    assert.ok(result.domains.some((entry) => entry.domain === "skill"));
  } finally {
    console.log = originalLog;
  }
});

test("profile --help prints that domain's operations", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["profile", "--help"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /Usage: suzukuri profile <command> \[options\]/);
    assert.match(output, /profile show <name>/);
  } finally {
    console.log = originalLog;
  }
});

test("profile show --help prints that leaf command's usage and example", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["profile", "show", "--help"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /Usage: suzukuri profile show <name>/);
    assert.match(output, /Example:/);
  } finally {
    console.log = originalLog;
  }
});

test("skill --help lists scenarios instead of falling back to root help", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill", "--help"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /Usage: suzukuri skill \[scenario\] \[--json\]/);
    assert.match(output, /skill bounded-implementation/);
  } finally {
    console.log = originalLog;
  }
});

test("skill <scenario> --help prints that scenario's summary", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill", "git-isolation", "--help"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /Usage: suzukuri skill git-isolation \[--json\]/);
  } finally {
    console.log = originalLog;
  }
});

test("--version prints a namespaced version string", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--version"]);
    assert.equal(exitCode, 0);
    assert.match(lines.join("\n"), /^suzukuri \d+\.\d+\.\d+$/);
  } finally {
    console.log = originalLog;
  }
});

test("--diagnose reports standalone runtime readiness as JSON", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["--diagnose"]);
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines.pop() ?? "{}") as { ready: boolean; name: string };
    assert.equal(result.ready, true);
    assert.equal(result.name, "suzukuri");
  } finally {
    console.log = originalLog;
  }
});

test("skill with no scenario lists a bounded human-readable index by default", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /^Suzukuri skill scenarios \(v\d+\.\d+\.\d+\):/);
    assert.match(output, /bounded-implementation - Follow a bounded implementation/);
    assert.match(output, /repository-operation - Use a registered repository operation/);
  } finally {
    console.log = originalLog;
  }
});

test("skill --json lists the versioned structured index", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill", "--json"]);
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines.pop() ?? "{}") as {
      version: string;
      scenarios: Array<{ id: string; title: string; scope: string }>;
    };
    assert.match(result.version, /^\d+\.\d+\.\d+$/);
    assert.equal(result.scenarios.find((scenario) => scenario.id === "repository-operation")?.scope, "leaf-operation");
  } finally {
    console.log = originalLog;
  }
});

test("skill <scenario> prints that scenario's human playbook", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill", "git-isolation"]);
    assert.equal(exitCode, 0);
    const output = lines.join("\n");
    assert.match(output, /Keep implementation work isolated \(git-isolation\)/);
    assert.match(output, /When to use:/);
    assert.match(output, /Workflow:/);
    assert.match(output, /Canonical entrypoint: suzukuri skill/);
    assert.match(output, /Exact syntax: suzukuri skill --help/);
  } finally {
    console.log = originalLog;
  }
});

test("skill <scenario> --json prints the same structured playbook", async () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["skill", "repository-operation", "--json"]);
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines.pop() ?? "{}") as {
      id: string;
      canonicalCommandId: string;
      workflow: Array<{ commandId: string; command: string }>;
    };
    assert.equal(result.id, "repository-operation");
    assert.equal(result.canonicalCommandId, "run");
    assert.ok(result.workflow.every((step) => step.commandId === "run" && step.command === "suzukuri run build"));
  } finally {
    console.log = originalLog;
  }
});

test("skill <unknown scenario> exits 1 with a stable error code", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (msg: string) => errors.push(msg);
  try {
    const exitCode = await runCli(["skill", "bogus-scenario"]);
    assert.equal(exitCode, 1);
    assert.match(errors.join("\n"), /SKILL_SCENARIO_NOT_FOUND/);
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
