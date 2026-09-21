import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { InitCommandError, runInitCommand } from "./init-command.js";
import { parseExecutionConfig } from "./execution.js";

function repository(prefix: string, packageJson: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return directory;
}

function withCapturedLog<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    return { result: run(), lines };
  } finally {
    console.log = original;
  }
}

test("init proposes a migration plan without mutating files when declined", async () => {
  const directory = repository("suzukuri-init-decline-", {
    name: "wabachi",
    scripts: {
      test: "node --test --import tsx src/**/*.test.ts",
      verify: "pnpm run format:check && pnpm run lint && pnpm test",
      "format:check": "prettier --check .",
      lint: "eslint .",
    },
  });
  try {
    const before = fs.readFileSync(path.join(directory, "package.json"), "utf8");
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    let exitCode: number;
    try {
      exitCode = await runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => false });
    } finally {
      console.log = original;
    }
    assert.equal(exitCode, 1);
    assert.equal(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      before,
      "declining must leave package.json byte-for-byte unchanged",
    );
    assert.equal(fs.existsSync(path.join(directory, ".suzukuri", "commands.json")), false);
    assert.ok(lines.some((line) => line.includes("Proposed .suzukuri/commands.json")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init applies an accepted migration atomically: rewires scripts, writes commands.json, adds the dependency", async () => {
  const directory = repository("suzukuri-init-accept-", {
    name: "wabachi",
    version: "1.0.0",
    scripts: {
      test: "node --test --import tsx src/**/*.test.ts scripts/**/*.test.mjs",
      verify:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test && pnpm run governance:actions && pnpm run test:package",
      "format:check": "prettier --check .",
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      "governance:actions": "node scripts/validate-actions.mjs",
      "test:package": "node scripts/run-package-suite.mjs",
    },
  });
  try {
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);

    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(packageJson.scripts.test, "suzukuri test");
    assert.equal(packageJson.scripts.verify, "suzukuri verify");
    assert.ok(packageJson.devDependencies.suzukuri !== undefined);

    const configRaw = JSON.parse(
      fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8"),
    ) as unknown;
    const config = parseExecutionConfig(configRaw);
    const testCommand = config.commands.test;
    assert.ok(testCommand !== undefined && "argv" in testCommand);
    if (testCommand !== undefined && "argv" in testCommand) {
      assert.deepEqual(testCommand.argv, [
        "node",
        "--test",
        "--import",
        "tsx",
        "src/**/*.test.ts",
        "scripts/**/*.test.mjs",
      ]);
    }
    const verifyCommand = config.commands.verify;
    assert.ok(verifyCommand !== undefined && "steps" in verifyCommand);
    if (verifyCommand !== undefined && "steps" in verifyCommand) {
      assert.deepEqual(
        verifyCommand.steps.map((step) => step.name),
        ["format:check", "lint", "typecheck", "test", "governance:actions", "test:package"],
      );
      assert.deepEqual(verifyCommand.steps[0].argv, ["pnpm", "run", "format:check"]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init leaves an unparsable composite verify script unchanged and reports it explicitly", async () => {
  const directory = repository("suzukuri-init-unresolved-", {
    name: "wabachi",
    scripts: {
      verify: "pnpm run lint || pnpm run fallback",
      lint: "eslint .",
      fallback: "echo fallback",
    },
  });
  try {
    const { result: exitCode, lines } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    assert.equal(fs.existsSync(path.join(directory, ".suzukuri", "commands.json")), false);
    const packageJsonAfter = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(packageJsonAfter.scripts.verify, "pnpm run lint || pnpm run fallback");
    assert.ok(lines.some((line) => line.includes("left unchanged")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("re-running init on an already initialized repository is an explicit no-op", async () => {
  const directory = repository("suzukuri-init-idempotent-", {
    name: "wabachi",
    scripts: { test: "suzukuri test", verify: "suzukuri verify" },
    devDependencies: { suzukuri: "^1.0.0" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands: { test: { argv: ["node", "--test"] } } }),
  );
  try {
    const { result: exitCode, lines } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    assert.ok(lines.some((line) => line.includes("already initialized")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init reports an unsupported ecosystem explicitly instead of guessing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-init-unsupported-"));
  try {
    await assert.rejects(
      () => runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
      (error: unknown) => error instanceof InitCommandError && error.code === "INIT_ECOSYSTEM_UNSUPPORTED",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--yes bypasses the confirmation prompt entirely", async () => {
  const directory = repository("suzukuri-init-yes-", {
    name: "wabachi",
    scripts: { test: "node --test" },
  });
  try {
    let confirmCalled = false;
    const exitCode = await runInitCommand(
      { positionals: [], options: { yes: true } },
      { cwd: directory, confirm: async () => ((confirmCalled = true), true) },
    );
    assert.equal(exitCode, 0);
    assert.equal(confirmCalled, false);
    assert.equal(fs.existsSync(path.join(directory, ".suzukuri", "commands.json")), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("--dry-run prints the plan and never mutates or prompts", async () => {
  const directory = repository("suzukuri-init-dry-run-", {
    name: "wabachi",
    scripts: { test: "node --test" },
  });
  try {
    let confirmCalled = false;
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand(
        { positionals: [], options: { "dry-run": true } },
        { cwd: directory, confirm: async () => ((confirmCalled = true), true) },
      ),
    );
    assert.equal(await exitCode, 0);
    assert.equal(confirmCalled, false);
    assert.equal(fs.existsSync(path.join(directory, ".suzukuri", "commands.json")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
