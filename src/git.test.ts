import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GIT_DIFF_ADAPTER_ID,
  GIT_STATUS_ADAPTER_ID,
  builtinGitComponentIdentities,
  createGitProjectionCore,
  decodeGitDiff,
  decodeGitStatus,
  gitDiffFilesView,
  gitDiffHunksView,
  gitDiffSummaryView,
  gitStatusFilesView,
  gitStatusSummaryView,
} from "./git.js";
import { SuzukuriError } from "./core.js";

const patch = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const value = "追加";
+
diff --git a/src/old.ts b/src/new-name.ts
similarity index 80%
rename from src/old.ts
rename to src/new-name.ts
diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
--- a/src/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

test("git diff decodes additions, deletions, renames, hunks, and normalized paths", () => {
  const model = decodeGitDiff({ content: patch });

  assert.equal(model.version, "1.0.0");
  assert.deepEqual(model.summary, {
    files: 3,
    hunks: 2,
    additions: 2,
    deletions: 2,
    added: 1,
    copied: 0,
    deleted: 1,
    modified: 0,
    renamed: 1,
    typeChanged: 0,
    binary: 0,
  });
  assert.deepEqual(
    model.files.map((file) => ({ path: file.path, oldPath: file.oldPath, status: file.status })),
    [
      { path: "src/new-name.ts", oldPath: "src/old.ts", status: "renamed" },
      { path: "src/new.ts", oldPath: undefined, status: "added" },
      { path: "src/removed.ts", oldPath: undefined, status: "deleted" },
    ],
  );
  assert.deepEqual(model.files.find((file) => file.path === "src/new.ts")?.hunks[0]?.lines[0], {
    kind: "addition",
    text: 'export const value = "追加";',
    newLine: 1,
  });
});

test("git diff name-status input is deterministic and supports copies", () => {
  const model = decodeGitDiff({ content: "R100\tb\t./a\nC075\tbase\tcopied\nA\tnew\n" });
  assert.deepEqual(
    model.files.map((file) => [file.path, file.oldPath, file.status]),
    [
      ["a", "b", "renamed"],
      ["copied", "base", "copied"],
      ["new", undefined, "added"],
    ],
  );
});

test("git diff treats header-looking lines inside hunks as content", () => {
  const model = decodeGitDiff({
    content: "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n--- removed\n+++ added\n",
  });
  assert.deepEqual(model.files[0]?.hunks[0]?.lines, [
    { kind: "deletion", text: "-- removed", oldLine: 1 },
    { kind: "addition", text: "++ added", newLine: 1 },
  ]);
});

test("git status decodes porcelain v1 classes and renames", () => {
  const model = decodeGitStatus({
    content:
      "## main...origin/main [ahead 2, behind 1]\nM  staged.ts\nR  old.ts -> new.ts\n?? untracked.ts\n!! ignored.ts\nUU conflict.ts\n",
  });

  assert.deepEqual(model.branch, { head: "main", upstream: "origin/main", ahead: 2, behind: 1 });
  assert.deepEqual(model.summary, {
    files: 5,
    staged: 3,
    unstaged: 1,
    added: 0,
    copied: 0,
    deleted: 0,
    modified: 1,
    renamed: 1,
    typeChanged: 0,
    unmerged: 1,
    untracked: 1,
    ignored: 1,
    unknown: 0,
  });
  assert.deepEqual(
    model.entries.map((entry) => [entry.path, entry.classification]),
    [
      ["conflict.ts", "unmerged"],
      ["ignored.ts", "ignored"],
      ["new.ts", "renamed"],
      ["staged.ts", "modified"],
      ["untracked.ts", "untracked"],
    ],
  );
});

test("git status decodes porcelain v2 and NUL-delimited paths", () => {
  const v2 = "# branch.oid abc\n# branch.head main\n1 .M N... 100644 100644 100644 abc def file.ts\n? new file.ts\n";
  const model = decodeGitStatus({ content: v2 });
  assert.deepEqual(
    model.entries.map((entry) => entry.path),
    ["file.ts", "new file.ts"],
  );

  const nul = decodeGitStatus({ content: "R  new name.ts\0old name.ts\0?? other.ts\0" });
  assert.equal(nul.entries[0]?.originalPath, "old name.ts");
  assert.equal(nul.entries[0]?.path, "new name.ts");
});

test("invalid Git input fails explicitly", () => {
  assert.throws(() => decodeGitDiff({ content: "not a patch" }), /unsupported git diff record/);
  assert.throws(() => decodeGitStatus({ content: "not porcelain" }), /unsupported git status record/);
});

test("builtin components are registered explicitly and use shared bounded projection", () => {
  const identities = builtinGitComponentIdentities();
  assert.deepEqual(identities.adapters, [
    { id: GIT_DIFF_ADAPTER_ID, version: "1.0.0" },
    { id: GIT_STATUS_ADAPTER_ID, version: "1.0.0" },
  ]);
  assert.deepEqual(
    identities.views.map((view) => view.id),
    ["git-diff-summary", "git-diff-files", "git-diff-hunks", "git-status-summary", "git-status-files"],
  );

  const core = createGitProjectionCore();
  const summary = core.project({
    source: patch,
    adapter: gitDiffAdapterReference(),
    view: gitDiffSummaryView,
    budget: 500,
    renderer: "json",
  });
  assert.equal(summary.completeness, "complete");
  assert.ok(summary.outputSize <= 500);

  const files = core.project({
    source: patch,
    adapter: GIT_DIFF_ADAPTER_ID,
    view: gitDiffFilesView,
    budget: 500,
    renderer: "json",
  });
  assert.ok(files.outputSize <= 500);
  assert.equal(files.provenance.adapter.id, GIT_DIFF_ADAPTER_ID);
  assert.equal(files.provenance.view.id, gitDiffFilesView.id);

  const hunks = core.project({
    source: patch,
    adapter: GIT_DIFF_ADAPTER_ID,
    view: gitDiffHunksView,
    budget: 500,
    renderer: "text",
  });
  assert.ok(hunks.outputSize <= 500);

  const statusSummary = core.project({
    source: "?? file.ts\n",
    adapter: GIT_STATUS_ADAPTER_ID,
    view: gitStatusSummaryView,
    budget: 500,
    renderer: "json",
  });
  assert.match(String(statusSummary.output), /untracked/);
  const statusFiles = core.project({
    source: "?? file.ts\n",
    adapter: GIT_STATUS_ADAPTER_ID,
    view: gitStatusFilesView,
    budget: 500,
    renderer: "json",
  });
  assert.match(String(statusFiles.output), /file.ts/);
});

test("required Git view meaning reports deterministic budget failure", () => {
  assert.throws(
    () =>
      createGitProjectionCore().project({
        source: "?? extremely-long-file-name.ts\n",
        adapter: GIT_STATUS_ADAPTER_ID,
        view: gitStatusSummaryView,
        budget: 1,
        renderer: "json",
      }),
    (error: unknown) => error instanceof SuzukuriError && error.code === "BUDGET_TOO_SMALL",
  );
});

function gitDiffAdapterReference(): { id: string; version: string } {
  return { id: GIT_DIFF_ADAPTER_ID, version: "1.0.0" };
}
