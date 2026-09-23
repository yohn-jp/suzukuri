import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { InitCommandError, runInitCommand } from "./init-command.js";
import { isSteppedExecutionCommand, parseExecutionConfig } from "./execution.js";
import { runRunCommand } from "./run-command.js";

const packageVersion = (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function repository(prefix: string, packageJson: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(packageJson, null, 2));
  const localSuzukuri = path.join(directory, ".suzukuri-test-package");
  fs.mkdirSync(localSuzukuri);
  fs.writeFileSync(
    path.join(localSuzukuri, "package.json"),
    JSON.stringify({ name: "suzukuri", version: packageVersion }, null, 2),
  );
  fs.writeFileSync(
    path.join(directory, "pnpm-workspace.yaml"),
    "overrides:\n  suzukuri: file:./.suzukuri-test-package\n",
  );
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
      "test:package": "pnpm run build && node scripts/run-package-suite.mjs",
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
    // Imported scripts are removed from package.json: suzukuri run is the sole agent-facing surface.
    assert.equal(packageJson.scripts.build, undefined);
    assert.equal(packageJson.scripts.test, undefined);
    assert.equal(packageJson.scripts.lint, undefined);
    assert.equal(packageJson.scripts.verify, undefined);
    assert.ok(packageJson.devDependencies.suzukuri !== undefined);

    const configRaw = JSON.parse(
      fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8"),
    ) as unknown;
    const config = parseExecutionConfig(configRaw);

    const build = config.commands.build;
    assert.ok(build !== undefined && !isSteppedExecutionCommand(build));
    if (build !== undefined && !isSteppedExecutionCommand(build)) {
      assert.deepEqual(build.argv, ["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"]);
      assert.equal(build.projection, "generic");
    }

    const testCommand = config.commands.test;
    assert.ok(testCommand !== undefined && !isSteppedExecutionCommand(testCommand));
    if (testCommand !== undefined && !isSteppedExecutionCommand(testCommand)) {
      assert.equal(testCommand.projection, "test-result");
      assert.deepEqual(testCommand.argv, [
        "node",
        "--test",
        "--test-reporter=tap",
        "--import",
        "tsx",
        "src/**/*.test.ts",
        "scripts/**/*.test.mjs",
      ]);
    }

    const lint = config.commands.lint;
    assert.ok(lint !== undefined && !isSteppedExecutionCommand(lint) && lint.projection === "generic");
    if (lint !== undefined && !isSteppedExecutionCommand(lint)) {
      assert.deepEqual(lint.argv, ["pnpm", "exec", "eslint", "src/**/*.ts"]);
    }

    const verifyCommand = config.commands.verify;
    assert.ok(verifyCommand !== undefined && isSteppedExecutionCommand(verifyCommand));
    if (verifyCommand !== undefined && isSteppedExecutionCommand(verifyCommand)) {
      assert.equal(verifyCommand.projection, "verification-result");
      assert.deepEqual(
        verifyCommand.steps.map((step) => step.name),
        ["format:check", "lint", "typecheck", "test", "governance:actions", "test:package"],
      );
      assert.deepEqual(verifyCommand.steps[0].argv, ["pnpm", "exec", "prettier", "--check", "."]);
      assert.deepEqual(verifyCommand.steps[3].argv, [
        "node",
        "--test",
        "--test-reporter=tap",
        "--import",
        "tsx",
        "src/**/*.test.ts",
        "scripts/**/*.test.mjs",
      ]);
      assert.deepEqual(verifyCommand.steps[5].argv, ["pnpm", "run", "test:package"]);
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

test("init lowers migrated composite producers while preserving unresolved package scripts", async () => {
  const directory = repository("suzukuri-init-composite-lowering-", {
    name: "wabachi",
    scripts: {
      lint: "eslint .",
      legacy: "echo $LEGACY",
      verify: "pnpm run lint && pnpm run legacy",
    },
  });
  try {
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(packageJson.scripts.lint, undefined);
    assert.equal(packageJson.scripts.verify, undefined);
    assert.equal(packageJson.scripts.legacy, "echo $LEGACY");
    const config = parseExecutionConfig(
      JSON.parse(fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8")) as unknown,
    );
    const verify = config.commands.verify;
    assert.ok(verify !== undefined && isSteppedExecutionCommand(verify));
    if (verify !== undefined && isSteppedExecutionCommand(verify)) {
      assert.deepEqual(verify.steps[0].argv, ["pnpm", "exec", "eslint", "."]);
      assert.deepEqual(verify.steps[1].argv, ["pnpm", "run", "legacy"]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init leaves a Node test with an unsupported explicit reporter unmigrated", async () => {
  const directory = repository("suzukuri-init-reporter-", {
    name: "wabachi",
    scripts: { test: "node --test --test-reporter=spec" },
  });
  try {
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    const config = parseExecutionConfig(
      JSON.parse(fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8")) as unknown,
    );
    assert.equal(config.commands.test, undefined);
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(packageJson.scripts.test, "node --test --test-reporter=spec");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("generated pnpm test and verify commands execute through the registry", async () => {
  const directory = repository("suzukuri-init-integration-", {
    name: "wabachi",
    scripts: {
      check: "node -e 0",
      test: "node --test fixture.test.mjs",
      verify: "pnpm run check && pnpm test",
    },
  });
  fs.writeFileSync(
    path.join(directory, "fixture.test.mjs"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("fixture", () => assert.equal(2 + 2, 4));\n',
  );
  const originalCwd = process.cwd();
  const originalNodeTestContext = process.env.NODE_TEST_CONTEXT;
  try {
    const { result: initExitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: { yes: true } }, { cwd: directory }),
    );
    assert.equal(await initExitCode, 0);
    process.chdir(directory);
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(await runRunCommand({ positionals: ["test"], options: {} }), 0);
    assert.equal(await runRunCommand({ positionals: ["verify"], options: {} }), 0);
  } finally {
    if (originalNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalNodeTestContext;
    process.chdir(originalCwd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("re-running init on an already initialized repository is an explicit no-op", async () => {
  const directory = repository("suzukuri-init-idempotent-", {
    name: "wabachi",
    scripts: {},
    devDependencies: { suzukuri: "^1.0.0" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["pnpm", "exec", "tsc"] } } }),
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
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["pnpm", "exec", "tsc"] } } }),
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

test("init updates the lockfile so devDependencies.suzukuri is reflected without a frozen-lockfile install failing", async () => {
  const directory = repository("suzukuri-init-lockfile-", {
    name: "wabachi",
    scripts: { build: "tsc" },
  });
  try {
    const workspaceBefore = fs.readFileSync(path.join(directory, "pnpm-workspace.yaml"), "utf8");
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    const lockfile = fs.readFileSync(path.join(directory, "pnpm-lock.yaml"), "utf8");
    assert.ok(lockfile.includes("suzukuri"), "the lockfile must include the new devDependency");
    assert.equal(fs.readFileSync(path.join(directory, "pnpm-workspace.yaml"), "utf8"), workspaceBefore);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init restores package and lockfile state when the targeted dependency update fails", async () => {
  const directory = repository("suzukuri-init-lockfile-failure-", {
    name: "wabachi",
    scripts: { build: "tsc" },
  });
  const fakeBin = path.join(directory, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "pnpm"), "#!/usr/bin/env node\nprocess.exit(1);\n");
  fs.chmodSync(path.join(fakeBin, "pnpm"), 0o755);
  const originalPath = process.env.PATH;
  try {
    const packageBefore = fs.readFileSync(path.join(directory, "package.json"), "utf8");
    const lockfileBefore = fs.readFileSync(path.join(directory, "pnpm-lock.yaml"), "utf8");
    const workspaceBefore = fs.readFileSync(path.join(directory, "pnpm-workspace.yaml"), "utf8");
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    await assert.rejects(
      () => runInitCommand({ positionals: [], options: { yes: true } }, { cwd: directory }),
      (error: unknown) => error instanceof InitCommandError && error.code === "INIT_LOCKFILE_UPDATE_FAILED",
    );
    assert.equal(fs.readFileSync(path.join(directory, "package.json"), "utf8"), packageBefore);
    assert.equal(fs.readFileSync(path.join(directory, "pnpm-lock.yaml"), "utf8"), lockfileBefore);
    assert.equal(fs.readFileSync(path.join(directory, "pnpm-workspace.yaml"), "utf8"), workspaceBefore);
    assert.equal(fs.existsSync(path.join(directory, ".suzukuri", "commands.json")), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init fails closed on an existing .suzukuri/commands.json that is not valid JSON, instead of overwriting it", async () => {
  const directory = repository("suzukuri-init-broken-config-", {
    name: "wabachi",
    scripts: { build: "tsc" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(path.join(directory, ".suzukuri", "commands.json"), "{ not valid json");
  try {
    await assert.rejects(
      () => runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
      (error: unknown) => error instanceof InitCommandError && error.code === "INIT_EXISTING_CONFIG_INVALID",
    );
    assert.equal(
      fs.readFileSync(path.join(directory, ".suzukuri", "commands.json"), "utf8"),
      "{ not valid json",
      "the broken existing registry must not be overwritten",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init fails closed on an existing .suzukuri/commands.json that does not match the schema", async () => {
  const directory = repository("suzukuri-init-invalid-schema-", {
    name: "wabachi",
    scripts: { build: "tsc" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: [] } } }),
  );
  try {
    await assert.rejects(
      () => runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
      (error: unknown) => error instanceof InitCommandError && error.code === "INIT_EXISTING_CONFIG_INVALID",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a stepped registry entry (e.g. verify) is recognized as already imported and not re-proposed", async () => {
  const directory = repository("suzukuri-init-steps-idempotent-", {
    name: "wabachi",
    scripts: {
      lint: "eslint .",
      test: "node --test",
      verify: "pnpm run lint && pnpm test",
    },
    devDependencies: { suzukuri: "^1.0.0" },
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        lint: { argv: ["pnpm", "exec", "eslint", "."] },
        test: { argv: ["node", "--test", "--test-reporter=tap"], projection: "test-result" },
        verify: {
          steps: [
            { name: "lint", argv: ["pnpm", "exec", "eslint", "."] },
            { name: "test", argv: ["node", "--test", "--test-reporter=tap"] },
          ],
          projection: "verification-result",
        },
      },
    }),
  );
  try {
    const { result: exitCode, lines } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    assert.ok(
      !lines.some((line) => line.includes("verify: import")),
      "an unchanged stepped command must not be re-proposed on re-run",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("init still applies when the registry is complete but only the devDependency is missing", async () => {
  const directory = repository("suzukuri-init-dependency-only-", {
    name: "wabachi",
    scripts: {},
  });
  fs.mkdirSync(path.join(directory, ".suzukuri"));
  fs.writeFileSync(
    path.join(directory, ".suzukuri", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands: { build: { argv: ["tsc"] } } }),
  );
  try {
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    assert.ok(packageJson.devDependencies.suzukuri !== undefined, "the missing devDependency must be added");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a lifecycle hook that invokes a migrated script is rewritten to call suzukuri run instead", async () => {
  const directory = repository("suzukuri-init-lifecycle-", {
    name: "wabachi",
    scripts: {
      build: "tsc -p tsconfig.build.json",
      test: "node --test",
      prepack: "pnpm run build",
      prepublishOnly: "pnpm run build && pnpm test",
    },
  });
  try {
    const { result: exitCode } = withCapturedLog(() =>
      runInitCommand({ positionals: [], options: {} }, { cwd: directory, confirm: async () => true }),
    );
    assert.equal(await exitCode, 0);
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    // The lifecycle hooks themselves are never removed (npm invokes them directly)...
    assert.equal(packageJson.scripts.prepack, "suzukuri run build");
    assert.equal(packageJson.scripts.prepublishOnly, "suzukuri run build && suzukuri run test");
    // ...but the scripts they used to call are gone, now reachable only via suzukuri run.
    assert.equal(packageJson.scripts.build, undefined);
    assert.equal(packageJson.scripts.test, undefined);
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
