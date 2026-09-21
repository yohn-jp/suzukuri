import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { acquireGitDiff, DEFAULT_DIFF_MAX_INPUT_BYTES, runDiffCommand } from "./diff-command.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createRepository(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-diff-test-"));
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "suzukuri@example.invalid");
  git(directory, "config", "user.name", "Suzukuri Test");
  fs.writeFileSync(path.join(directory, "tracked.ts"), "export const value = 1;\n");
  git(directory, "add", "tracked.ts");
  git(directory, "commit", "--quiet", "-m", "initial");
  return directory;
}

test("diff acquisition preserves Git paths and separates staged/worktree scopes", async () => {
  const directory = createRepository();
  try {
    fs.writeFileSync(path.join(directory, "tracked.ts"), "export const value = 2;\n");
    fs.writeFileSync(path.join(directory, "new file.ts"), "export const added = true;\n");
    const worktree = await acquireGitDiff({ cwd: directory });
    const worktreeText = new TextDecoder().decode(worktree.content);
    assert.match(worktreeText, /a\/tracked\.ts b\/tracked\.ts/);
    assert.doesNotMatch(worktreeText, /new file\.ts/);

    git(directory, "add", "new file.ts");
    git(directory, "add", "tracked.ts");
    const staged = await acquireGitDiff({ cwd: directory, scope: "staged" });
    const stagedText = new TextDecoder().decode(staged.content);
    assert.match(stagedText, /a\/new file\.ts b\/new file\.ts/);
    assert.match(stagedText, /a\/tracked\.ts b\/tracked\.ts/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("empty diff is acquired as bounded empty input", async () => {
  const directory = createRepository();
  try {
    const result = await acquireGitDiff({ cwd: directory });
    assert.equal(result.content.byteLength, 0);
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("diff command returns the existing bounded files projection for an external repository", async () => {
  const directory = createRepository();
  const originalDirectory = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  try {
    fs.writeFileSync(path.join(directory, "tracked.ts"), "export const value = 2;\n");
    process.chdir(directory);
    console.log = (line: string) => lines.push(line);
    const exitCode = await runDiffCommand({ positionals: [], options: { budget: "4096" } });
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines[0] ?? "{}") as { output?: string; completeness?: string };
    assert.equal(result.completeness, "complete");
    assert.match(result.output ?? "", /tracked\.ts/);
  } finally {
    console.log = originalLog;
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("diff acquisition rejects output beyond the finite bound", async () => {
  const directory = createRepository();
  try {
    fs.writeFileSync(path.join(directory, "tracked.ts"), `${"x".repeat(100_000)}\n`);
    await assert.rejects(
      acquireGitDiff({ cwd: directory, maxBytes: 128 }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "DIFF_INPUT_TOO_LARGE" &&
        "details" in error &&
        (error.details as { maxBytes?: number }).maxBytes === 128,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("shared bounded acquisition preserves producer status and signal diagnostics", async () => {
  await assert.rejects(
    acquireGitDiff({
      argv: [process.execPath, "-e", "process.stderr.write('producer failed'); process.exit(7)"],
    }),
    (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "DIFF_ACQUISITION_FAILED") return false;
      const details = (error as Error & { details?: { status?: number; signal?: string; diagnostic?: string } })
        .details;
      return details?.status === 7 && details.signal === null && details.diagnostic === "producer failed";
    },
  );
  await assert.rejects(
    acquireGitDiff({ argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"] }),
    (error: unknown) => {
      if (!(error instanceof Error) || !("details" in error)) return false;
      return (error.details as { signal?: string }).signal === "SIGTERM";
    },
  );
});

test("diff command uses an explicitly configured diff producer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-diff-config-test-"));
  const originalDirectory = process.cwd();
  const originalLog = console.log;
  const lines: string[] = [];
  try {
    const producer = path.join(directory, "producer.mjs");
    const config = path.join(directory, "commands.json");
    fs.writeFileSync(
      producer,
      "process.stdout.write('diff --git a/configured.ts b/configured.ts\\n--- a/configured.ts\\n+++ b/configured.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n');\n",
    );
    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, commands: { diff: [process.execPath, producer] } }));
    process.chdir(directory);
    console.log = (line: string) => lines.push(line);
    const exitCode = await runDiffCommand({ positionals: [], options: { config, budget: "4096" } });
    assert.equal(exitCode, 0);
    const result = JSON.parse(lines[0] ?? "{}") as { output?: string };
    assert.match(result.output ?? "", /configured\.ts/);
  } finally {
    console.log = originalLog;
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("diff command rejects unsupported acquisition options with bounded diagnostics", async () => {
  await assert.rejects(
    runDiffCommand({ positionals: [], options: { recursive: true } }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DIFF_OPTION_UNSUPPORTED" && "details" in error,
  );
});

test("diff command rejects invalid path and scope before spawning Git", async () => {
  await assert.rejects(
    runDiffCommand({ positionals: [], options: { path: "../outside" } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DIFF_PATH_INVALID",
  );
  await assert.rejects(
    runDiffCommand({ positionals: [], options: { scope: "remote" } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DIFF_SCOPE_UNSUPPORTED",
  );
  assert.equal(DEFAULT_DIFF_MAX_INPUT_BYTES > 0, true);
});
