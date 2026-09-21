import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { InitCommandError, runInitCommand } from "./init-command.js";
import { isSteppedExecutionCommand, parseExecutionConfig } from "./execution.js";

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
      build: "tsc -p tsconfig.build.json",
      test: "node --test --import tsx src/**/*.test.ts",
      lint: "eslint .",
      "format:check": "prettier --check .",
      verify: "pnpm run format:check && pnpm run lint && pnpm test",
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

test("init imports the full script vocabulary (build/lint/format/test/verify) with known semantics assigned the right projection", async () => {
  const directory = repository("suzukuri-init-accept-", {
    name: "wabachi",
    version: "1.0.0",
    scripts: {
      build: "tsc -p tsconfig.build.json",
      test: "node --test --import tsx src/**/*.test.ts scripts/**/*.test.mjs",
      lint: "eslint src/**/*.ts",
      "format:check": "prettier --check .",
      typecheck: "tsc --noEmit",
      "governance:actions": "node scripts/validate-actions.mjs",
      "test:package": "node scripts/run-package-suite.mjs",
      verify:
        "pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test && pnpm run governance:actions && pnpm run test:package",
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
    // package.json scripts are left exactly as they were.
    assert.equal(packageJson.scripts.build, "tsc -p tsconfig.build.json");
    assert.equal(packageJson.scripts.test, "node --test --import tsx src/**/*.test.ts scripts/**/*.test.mjs");
    assert.ok(packageJson.devDependencies.suzukuri !== undefined);

    const configRaw = JSON.parse(
      fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8"),
    ) as unknown;
    const config = parseExecutionConfig(configRaw);

    const build = config.commands.build;
    assert.ok(build !== undefined && !isSteppedExecutionCommand(build));
    if (build !== undefined && !isSteppedExecutionCommand(build)) {
      assert.deepEqual(build.argv, ["tsc", "-p", "tsconfig.build.json"]);
      assert.equal(build.projection, "generic");
    }

    const testCommand = config.commands.test;
    assert.ok(testCommand !== undefined && !isSteppedExecutionCommand(testCommand));
    if (testCommand !== undefined && !isSteppedExecutionCommand(testCommand)) {
      assert.equal(testCommand.projection, "test-result");
      assert.deepEqual(testCommand.argv, [
        "node",
        "--test",
        "--import",
        "tsx",
        "src/**/*.test.ts",
        "scripts/**/*.test.mjs",
      ]);
    }

    const lint = config.commands.lint;
    assert.ok(lint !== undefined && !isSteppedExecutionCommand(lint) && lint.projection === "generic");

    const verifyCommand = config.commands.verify;
    assert.ok(verifyCommand !== undefined && isSteppedExecutionCommand(verifyCommand));
    if (verifyCommand !== undefined && isSteppedExecutionCommand(verifyCommand)) {
      assert.equal(verifyCommand.projection, "verification-result");
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
    const configRaw = JSON.parse(
      fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8"),
    ) as unknown;
    const config = parseExecutionConfig(configRaw);
    assert.equal(config.commands.verify, undefined, "the unresolvable verify script must not be imported");
    assert.ok(config.commands.lint !== undefined, "the independently resolvable lint script is still imported");
    assert.ok(lines.some((line) => line.includes("left unchanged")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("re-running init on an already initialized repository is an explicit no-op", async () => {
  const directory = repository("suzukuri-init-idempotent-", {
    name: "wabachi",
    scripts: { build: "tsc" },
    devDependencies: { suzukuri: "^1.0.0" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["tsc"] } } }),
  );
  try {
    const { result: exitCode, lines } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    assert.ok(lines.some((line) => line.includes("already up to date")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("re-running init after adding a new script proposes only the new command, not a full re-import", async () => {
  const directory = repository("suzukuri-init-incremental-", {
    name: "wabachi",
    scripts: { build: "tsc", lint: "eslint ." },
    devDependencies: { suzukuri: "^1.0.0" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["tsc"] } } }),
  );
  try {
    const { result: exitCode, lines } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    assert.ok(lines.some((line) => line.includes("lint: import")));
    assert.ok(!lines.some((line) => line.includes("build: import")), "an unchanged script must not be re-proposed");

    const config = parseExecutionConfig(
      JSON.parse(fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8")) as unknown,
    );
    assert.ok(config.commands.build !== undefined);
    assert.ok(config.commands.lint !== undefined);
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
    scripts: { build: "tsc" },
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
    scripts: { build: "tsc" },
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
