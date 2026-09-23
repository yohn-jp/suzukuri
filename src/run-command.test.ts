import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { RunCommandError, runRunCommand } from "./run-command.js";
import { GENERIC_RESULT_SCHEMA_VERSION, isGenericCommandResult } from "./generic-result.js";

function fixture(prefix: string): { directory: string; config: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { directory, config: path.join(directory, "commands.json") };
}

interface GitFixture {
  readonly directory: string;
  readonly repository: string;
  readonly config: string;
  readonly counter: string;
}

function gitFixture(prefix: string): GitFixture {
  const base = fixture(prefix);
  const repository = path.join(base.directory, "repo");
  fs.mkdirSync(repository);
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.txt"), "content");
  execFileSync("git", ["add", "source.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: repository });
  return { ...base, repository, counter: path.join(base.directory, "runs.count") };
}

test("suzukuri run resolves an arbitrary registered command name and executes it", async () => {
  const { directory, config } = fixture("suzukuri-run-generic-");
  const script = path.join(directory, "build.mjs");
  fs.writeFileSync(script, "console.log('built'); process.exitCode = 0;\n");
  fs.writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: [process.execPath, script] } } }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["run", "build", "--config", config]);
    assert.equal(exitCode, 0);
    const result: unknown = JSON.parse(lines[0] ?? "{}");
    assert.ok(isGenericCommandResult(result));
    if (isGenericCommandResult(result)) {
      assert.equal(result.command, "build");
      assert.equal(result.status, "passed");
      assert.equal(result.version, GENERIC_RESULT_SCHEMA_VERSION);
      assert.match(result.stdout, /built/);
      assert.ok(result.durationMs >= 0);
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("suzukuri run fails explicitly for an unregistered command name instead of any shell passthrough", async () => {
  const { directory, config } = fixture("suzukuri-run-unknown-");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["echo", "ok"] } } }));
  try {
    await assert.rejects(
      () => runRunCommand({ positionals: ["deploy"], options: { config } }),
      (error: unknown) => error instanceof RunCommandError && error.code === "RUN_COMMAND_NOT_FOUND",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("suzukuri run requires a command name", async () => {
  const { directory, config } = fixture("suzukuri-run-missing-name-");
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["echo", "ok"] } } }));
  try {
    await assert.rejects(
      () => runRunCommand({ positionals: [], options: { config } }),
      (error: unknown) => error instanceof RunCommandError && error.code === "RUN_COMMAND_REQUIRED",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a generic command's failed producer projects a bounded failed result with exit code and stderr", async () => {
  const { directory, config } = fixture("suzukuri-run-generic-fail-");
  const script = path.join(directory, "lint.mjs");
  fs.writeFileSync(script, "console.error('lint error'); process.exitCode = 1;\n");
  fs.writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, commands: { lint: { argv: [process.execPath, script] } } }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["run", "lint", "--config", config]);
    assert.equal(exitCode, 1);
    const result: unknown = JSON.parse(lines[0] ?? "{}");
    assert.ok(isGenericCommandResult(result));
    if (isGenericCommandResult(result)) {
      assert.equal(result.status, "failed");
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /lint error/);
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a generic command's ordered steps stop at the first failed step and report its name as stage", async () => {
  const { directory, config } = fixture("suzukuri-run-generic-steps-");
  const okScript = path.join(directory, "ok.mjs");
  const brokenScript = path.join(directory, "broken.mjs");
  const neverRunsScript = path.join(directory, "never-runs.mjs");
  const marker = path.join(directory, "never-runs.marker");
  fs.writeFileSync(okScript, "process.exitCode = 0;\n");
  fs.writeFileSync(brokenScript, "console.error('typecheck failed'); process.exitCode = 1;\n");
  fs.writeFileSync(neverRunsScript, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: {
          steps: [
            { name: "lint", argv: [process.execPath, okScript] },
            { name: "typecheck", argv: [process.execPath, brokenScript] },
            { name: "test", argv: [process.execPath, neverRunsScript] },
          ],
          projection: "generic",
        },
      },
    }),
  );
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    const exitCode = await runCli(["run", "verify", "--config", config]);
    assert.equal(exitCode, 1);
    const result: unknown = JSON.parse(lines[0] ?? "{}");
    assert.ok(isGenericCommandResult(result));
    if (isGenericCommandResult(result)) {
      assert.equal(result.stage, "typecheck");
      assert.match(result.stderr, /typecheck failed/);
    }
    assert.equal(fs.existsSync(marker), false, "a step after the failing one must never run");
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a generic command defaults to reuse "never" and never caches, even when unchanged', async () => {
  const { repository, directory, config, counter } = gitFixture("suzukuri-run-reuse-never-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  console.log = () => {};
  const script = path.join(directory, "deploy.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");\n`);
  fs.writeFileSync(
    config,
    JSON.stringify({ schemaVersion: 1, commands: { deploy: { argv: [process.execPath, script] } } }),
  );
  try {
    process.chdir(repository);
    await runCli(["run", "deploy", "--config", config]);
    await runCli(["run", "deploy", "--config", config]);
    assert.equal(fs.readFileSync(counter, "utf8"), "xx", "a mutation-capable generic command must run every time");
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a generic command with explicit reuse "fingerprint" is cached like test/verify', async () => {
  const { repository, directory, config, counter } = gitFixture("suzukuri-run-reuse-explicit-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => lines.push(line);
  const script = path.join(directory, "lint.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");\n`);
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: { lint: { argv: [process.execPath, script], reuse: "fingerprint" } },
    }),
  );
  try {
    process.chdir(repository);
    const first = await runCli(["run", "lint", "--config", config]);
    assert.equal(first, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "x");

    const second = await runCli(["run", "lint", "--config", config]);
    assert.equal(second, 0);
    assert.equal(fs.readFileSync(counter, "utf8"), "x", "producer must not run a second time on a cache hit");
    const cachedResult = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    assert.equal(cachedResult.reused, true);
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stepped verification reuses independent scoped results and invalidates only a changed step", async () => {
  const { repository, directory, config } = gitFixture("suzukuri-run-step-reuse-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  const firstCounter = path.join(directory, "first.count");
  const changedCounter = path.join(directory, "changed.count");
  const secondCounter = path.join(directory, "second.count");
  const firstProducer = path.join(directory, "first.mjs");
  const changedProducer = path.join(directory, "changed.mjs");
  const secondProducer = path.join(directory, "second.mjs");
  fs.writeFileSync(path.join(repository, "one.txt"), "one");
  fs.writeFileSync(path.join(repository, "two.txt"), "two");
  execFileSync("git", ["add", "one.txt", "two.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "step inputs", "--quiet"], { cwd: repository });
  fs.writeFileSync(
    firstProducer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(firstCounter)}, "x");\n`,
  );
  fs.writeFileSync(
    changedProducer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(changedCounter)}, "x");\n`,
  );
  fs.writeFileSync(
    secondProducer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(secondCounter)}, "x");\n`,
  );
  console.log = (line: string) => lines.push(line);
  try {
    process.chdir(repository);
    const writeConfig = (producer: string) =>
      fs.writeFileSync(
        config,
        JSON.stringify({
          schemaVersion: 1,
          commands: {
            verify: {
              projection: "verification-result",
              reuse: "fingerprint",
              steps: [
                { name: "first", argv: [process.execPath, producer], inputs: ["one.txt"] },
                { name: "second", argv: [process.execPath, secondProducer], inputs: ["two.txt"] },
              ],
            },
          },
        }),
      );
    writeConfig(firstProducer);

    await runRunCommand({ positionals: ["verify"], options: { config } });
    await runRunCommand({ positionals: ["verify"], options: { config } });
    fs.writeFileSync(path.join(repository, "one.txt"), "changed");
    await runRunCommand({ positionals: ["verify"], options: { config } });
    writeConfig(changedProducer);
    await runRunCommand({ positionals: ["verify"], options: { config } });

    assert.deepEqual(JSON.parse(lines[0] ?? "{}").steps, [
      { name: "first", execution: "executed" },
      { name: "second", execution: "executed" },
    ]);
    assert.deepEqual(JSON.parse(lines[1] ?? "{}").steps, [
      { name: "first", execution: "reused" },
      { name: "second", execution: "reused" },
    ]);
    assert.deepEqual(JSON.parse(lines[2] ?? "{}").steps, [
      { name: "first", execution: "executed" },
      { name: "second", execution: "reused" },
    ]);
    assert.deepEqual(JSON.parse(lines[3] ?? "{}").steps, [
      { name: "first", execution: "executed" },
      { name: "second", execution: "reused" },
    ]);
    assert.equal(fs.readFileSync(firstCounter, "utf8"), "xx");
    assert.equal(fs.readFileSync(changedCounter, "utf8"), "x");
    assert.equal(fs.readFileSync(secondCounter, "utf8"), "x");
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a cached failing step is reused and still short-circuits later steps", async () => {
  const { repository, directory, config } = gitFixture("suzukuri-run-step-failure-reuse-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  const firstCounter = path.join(directory, "first.count");
  const failedCounter = path.join(directory, "failed.count");
  const laterMarker = path.join(directory, "later.marker");
  const firstProducer = path.join(directory, "first.mjs");
  const failedProducer = path.join(directory, "failed.mjs");
  const laterProducer = path.join(directory, "later.mjs");
  for (const input of ["one.txt", "two.txt"]) fs.writeFileSync(path.join(repository, input), input);
  execFileSync("git", ["add", "one.txt", "two.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "step inputs", "--quiet"], { cwd: repository });
  fs.writeFileSync(
    firstProducer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(firstCounter)}, "x");\n`,
  );
  fs.writeFileSync(
    failedProducer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(failedCounter)}, "x"); process.exitCode = 1;\n`,
  );
  fs.writeFileSync(
    laterProducer,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(laterMarker)}, "ran");\n`,
  );
  fs.writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: {
          projection: "verification-result",
          reuse: "fingerprint",
          steps: [
            { name: "first", argv: [process.execPath, firstProducer], inputs: ["one.txt"] },
            { name: "failed", argv: [process.execPath, failedProducer], inputs: ["two.txt"] },
            { name: "later", argv: [process.execPath, laterProducer] },
          ],
        },
      },
    }),
  );
  console.log = (line: string) => lines.push(line);
  try {
    process.chdir(repository);
    assert.equal(await runRunCommand({ positionals: ["verify"], options: { config } }), 1);
    fs.writeFileSync(path.join(repository, "two.txt"), "changed");
    assert.equal(await runRunCommand({ positionals: ["verify"], options: { config } }), 1);
    assert.equal(await runRunCommand({ positionals: ["verify"], options: { config } }), 1);

    assert.deepEqual(JSON.parse(lines[1] ?? "{}").steps, [
      { name: "first", execution: "reused" },
      { name: "failed", execution: "executed" },
    ]);
    assert.deepEqual(JSON.parse(lines[2] ?? "{}").steps, [
      { name: "first", execution: "reused" },
      { name: "failed", execution: "reused" },
    ]);
    assert.equal(fs.readFileSync(firstCounter, "utf8"), "x");
    assert.equal(fs.readFileSync(failedCounter, "utf8"), "xx");
    assert.equal(fs.existsSync(laterMarker), false);
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("changing a registered command's projection invalidates any prior cached reuse", async () => {
  const { repository, directory, config, counter } = gitFixture("suzukuri-run-reuse-projection-change-");
  const originalCwd = process.cwd();
  const originalLog = console.log;
  console.log = () => {};
  const script = path.join(directory, "check.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");\n`);
  const baseCommand = { argv: [process.execPath, script], reuse: "fingerprint" as const };
  try {
    process.chdir(repository);
    fs.writeFileSync(
      config,
      JSON.stringify({ schemaVersion: 1, commands: { check: { ...baseCommand, projection: "generic" } } }),
    );
    await runCli(["run", "check", "--config", config]);
    assert.equal(fs.readFileSync(counter, "utf8"), "x");

    fs.writeFileSync(
      config,
      JSON.stringify({ schemaVersion: 1, commands: { check: { ...baseCommand, projection: "test-result" } } }),
    );
    await runCli(["run", "check", "--config", config]);
    assert.equal(
      fs.readFileSync(counter, "utf8"),
      "xx",
      "a changed projection must be a different cache key and re-run the producer",
    );
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
