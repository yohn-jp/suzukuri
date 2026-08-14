import {
  ProjectionCore,
  type Adapter,
  type ComponentIdentity,
  type ProjectionCoreOptions,
  type ProjectionSource,
  type SemanticContract,
  type ValidationIssue,
  type ValidationResult,
  type View,
  type ViewProjectInput,
  validationFailure,
  validationSuccess,
} from "./core.js";

export const GIT_DIFF_ADAPTER_ID = "git-diff";
export const GIT_STATUS_ADAPTER_ID = "git-status";
export const GIT_DIFF_VERSION = "1.0.0";
export const GIT_STATUS_VERSION = "1.0.0";
export const GIT_DIFF_SEMANTIC_TYPE = "git-diff";
export const GIT_STATUS_SEMANTIC_TYPE = "git-status";

export type GitDiffFileStatus =
  "added" | "copied" | "deleted" | "modified" | "renamed" | "type-changed" | "unmerged" | "unknown";

export interface GitDiffSummary {
  readonly files: number;
  readonly hunks: number;
  readonly additions: number;
  readonly deletions: number;
  readonly added: number;
  readonly copied: number;
  readonly deleted: number;
  readonly modified: number;
  readonly renamed: number;
  readonly typeChanged: number;
  readonly binary: number;
}

export type GitDiffLineKind = "context" | "addition" | "deletion";

export interface GitDiffLine {
  readonly kind: GitDiffLineKind;
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface GitDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly heading?: string;
  readonly lines: readonly GitDiffLine[];
  readonly noNewlineAtEnd?: boolean;
}

export interface GitDiffFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: GitDiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly GitDiffHunk[];
  readonly binary?: boolean;
  readonly similarity?: number;
}

export interface GitDiffSemanticModel {
  readonly schema: "git-diff";
  readonly version: typeof GIT_DIFF_VERSION;
  readonly summary: GitDiffSummary;
  readonly files: readonly GitDiffFile[];
}

export type GitDiffModel = GitDiffSemanticModel;
export type GitDiffSemantic = GitDiffSemanticModel;

export type GitStatusClass =
  | "added"
  | "copied"
  | "deleted"
  | "ignored"
  | "modified"
  | "renamed"
  | "type-changed"
  | "unmerged"
  | "untracked"
  | "unknown";

export interface GitStatusBranch {
  readonly head: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly index: string;
  readonly worktree: string;
  readonly classification: GitStatusClass;
}

export interface GitStatusSummary {
  readonly files: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly added: number;
  readonly copied: number;
  readonly deleted: number;
  readonly modified: number;
  readonly renamed: number;
  readonly typeChanged: number;
  readonly unmerged: number;
  readonly untracked: number;
  readonly ignored: number;
  readonly unknown: number;
}

export interface GitStatusSemanticModel {
  readonly schema: "git-status";
  readonly version: typeof GIT_STATUS_VERSION;
  readonly summary: GitStatusSummary;
  readonly entries: readonly GitStatusEntry[];
  readonly branch?: GitStatusBranch;
}

export type GitStatusModel = GitStatusSemanticModel;
export type GitStatusSemantic = GitStatusSemanticModel;

export interface GitDiffSummaryProjection {
  readonly schema: "git-diff";
  readonly version: typeof GIT_DIFF_VERSION;
  readonly summary: GitDiffSummary;
}

export interface GitDiffFileProjection {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: GitDiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly hunkCount: number;
  readonly binary?: boolean;
  readonly similarity?: number;
}

export interface GitDiffFilesProjection {
  readonly schema: "git-diff";
  readonly version: typeof GIT_DIFF_VERSION;
  readonly summary: GitDiffSummary;
  readonly files: readonly GitDiffFileProjection[];
}

export interface GitDiffHunkProjection extends GitDiffHunk {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: GitDiffFileStatus;
}

export interface GitDiffHunksProjection {
  readonly schema: "git-diff";
  readonly version: typeof GIT_DIFF_VERSION;
  readonly summary: GitDiffSummary;
  readonly hunks: readonly GitDiffHunkProjection[];
}

export interface GitStatusSummaryProjection {
  readonly schema: "git-status";
  readonly version: typeof GIT_STATUS_VERSION;
  readonly summary: GitStatusSummary;
  readonly branch?: GitStatusBranch;
}

export interface GitStatusFilesProjection {
  readonly schema: "git-status";
  readonly version: typeof GIT_STATUS_VERSION;
  readonly summary: GitStatusSummary;
  readonly files: readonly GitStatusEntry[];
  readonly branch?: GitStatusBranch;
}

class GitInputError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = "GitInputError";
    this.path = path;
  }
}

interface MutableDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading?: string;
  lines: GitDiffLine[];
  noNewlineAtEnd?: boolean;
  oldSeen: number;
  newSeen: number;
}

interface MutableDiffFile {
  oldPath?: string;
  newPath?: string;
  statusHint?: GitDiffFileStatus;
  additions: number;
  deletions: number;
  hunks: MutableDiffHunk[];
  binary: boolean;
  similarity?: number;
}

export function decodeGitDiff(source: ProjectionSource): GitDiffSemanticModel {
  const text = decodeUtf8(source);
  return parseGitDiff(text);
}

export function decodeGitStatus(source: ProjectionSource): GitStatusSemanticModel {
  const text = decodeUtf8(source);
  return parseGitStatus(text);
}

function decodeUtf8(source: ProjectionSource): string {
  if (typeof source.content === "string") {
    return source.content;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source.content);
  } catch {
    throw new GitInputError("source content must be valid UTF-8");
  }
}

function parseGitDiff(text: string): GitDiffSemanticModel {
  const lines = splitTextLines(text);
  if (lines.length === 0) {
    return makeDiffModel([]);
  }

  const nameStatus = tryParseDiffNameStatus(lines);
  if (nameStatus !== undefined) {
    return makeDiffModel(nameStatus);
  }

  const files: MutableDiffFile[] = [];
  let current: MutableDiffFile | undefined;
  let hunk: MutableDiffHunk | undefined;

  const finishCurrent = (): void => {
    if (current !== undefined) {
      files.push(current);
    }
    current = undefined;
    hunk = undefined;
  };

  for (const [lineNumber, line] of lines.entries()) {
    const sourceLine = lineNumber + 1;
    if (line.startsWith("diff --git ")) {
      finishCurrent();
      const paths = parseDiffHeader(line.slice("diff --git ".length), sourceLine);
      current = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        additions: 0,
        deletions: 0,
        hunks: [],
        binary: false,
      };
      continue;
    }

    if (hunk !== undefined && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      appendHunkLine(requireCurrent(current, sourceLine), hunk, line);
      continue;
    }

    if (line.startsWith("--- ")) {
      if (current === undefined) {
        current = emptyDiffFile();
      }
      current.oldPath = parsePatchPath(line.slice(4), "a", sourceLine);
      hunk = undefined;
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (current === undefined) {
        throw invalidGitInput("new-file header has no file header", sourceLine);
      }
      current.newPath = parsePatchPath(line.slice(4), "b", sourceLine);
      hunk = undefined;
      continue;
    }

    if (line.startsWith("new file mode ")) {
      requireCurrent(current, sourceLine).statusHint = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      requireCurrent(current, sourceLine).statusHint = "deleted";
      continue;
    }
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      requireCurrent(current, sourceLine).statusHint = "type-changed";
      continue;
    }
    if (line.startsWith("rename from ")) {
      const active = requireCurrent(current, sourceLine);
      active.oldPath = normalizeGitPath(line.slice("rename from ".length), undefined, sourceLine);
      active.statusHint = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      const active = requireCurrent(current, sourceLine);
      active.newPath = normalizeGitPath(line.slice("rename to ".length), undefined, sourceLine);
      active.statusHint = "renamed";
      continue;
    }
    if (line.startsWith("copy from ")) {
      const active = requireCurrent(current, sourceLine);
      active.oldPath = normalizeGitPath(line.slice("copy from ".length), undefined, sourceLine);
      active.statusHint = "copied";
      continue;
    }
    if (line.startsWith("copy to ")) {
      const active = requireCurrent(current, sourceLine);
      active.newPath = normalizeGitPath(line.slice("copy to ".length), undefined, sourceLine);
      active.statusHint = "copied";
      continue;
    }
    if (line.startsWith("similarity index ")) {
      const active = requireCurrent(current, sourceLine);
      active.similarity = parsePercentage(line.slice("similarity index ".length), sourceLine);
      continue;
    }
    if (line.startsWith("dissimilarity index ")) {
      requireCurrent(current, sourceLine);
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      requireCurrent(current, sourceLine).binary = true;
      hunk = undefined;
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("mode ") || line === "") {
      continue;
    }

    if (line.startsWith("@@ ")) {
      const active = requireCurrent(current, sourceLine);
      hunk = parseHunkHeader(line, sourceLine);
      active.hunks.push(hunk);
      continue;
    }

    if (line === "\\ No newline at end of file") {
      if (hunk === undefined) {
        throw invalidGitInput("newline marker is outside a hunk", sourceLine);
      }
      hunk.noNewlineAtEnd = true;
      continue;
    }

    if (line.startsWith("literal ") || line.startsWith("delta ")) {
      requireCurrent(current, sourceLine).binary = true;
      hunk = undefined;
      continue;
    }

    if (line.trim() !== "") {
      throw invalidGitInput(`unsupported git diff record: ${line}`, sourceLine);
    }
  }

  finishCurrent();
  for (const [index, file] of files.entries()) {
    validateDiffFile(file, index + 1);
  }
  if (files.length === 0 && text.trim() !== "") {
    throw invalidGitInput("git diff input contains no recognized file records");
  }
  return makeDiffModel(files);
}

function tryParseDiffNameStatus(lines: readonly string[]): MutableDiffFile[] | undefined {
  const nonEmpty = lines.filter((line) => line !== "");
  if (nonEmpty.length === 0 || !nonEmpty.every((line) => /^[ACDMRTUXB][0-9]*\t/.test(line))) {
    return undefined;
  }
  return nonEmpty.map((line, index) => {
    const fields = line.split("\t");
    const code = fields.shift() ?? "";
    const statusCode = code[0];
    if (fields.length === 0 || statusCode === undefined) {
      throw invalidGitInput("name-status record is missing a path", index + 1);
    }
    const paths = fields.map((field) => normalizeGitPath(field, undefined, index + 1));
    const status = statusFromDiffCode(statusCode, index + 1);
    const oldPath = status === "added" ? undefined : paths[0];
    const newPath = status === "deleted" ? undefined : paths[paths.length - 1];
    if (newPath === undefined && oldPath === undefined) {
      throw invalidGitInput("name-status record has no usable path", index + 1);
    }
    return {
      oldPath,
      newPath,
      statusHint: status,
      additions: 0,
      deletions: 0,
      hunks: [],
      binary: false,
      ...(code.length > 1 && /^\d+$/.test(code.slice(1)) ? { similarity: Number(code.slice(1)) } : {}),
    };
  });
}

function makeDiffModel(files: readonly MutableDiffFile[]): GitDiffSemanticModel {
  const normalizedFiles = files.map(finalizeDiffFile).sort(compareDiffFiles);
  const summary = normalizedFiles.reduce<GitDiffSummary>(
    (total, file) => ({
      files: total.files + 1,
      hunks: total.hunks + file.hunks.length,
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
      added: total.added + (file.status === "added" ? 1 : 0),
      copied: total.copied + (file.status === "copied" ? 1 : 0),
      deleted: total.deleted + (file.status === "deleted" ? 1 : 0),
      modified: total.modified + (file.status === "modified" ? 1 : 0),
      renamed: total.renamed + (file.status === "renamed" ? 1 : 0),
      typeChanged: total.typeChanged + (file.status === "type-changed" ? 1 : 0),
      binary: total.binary + (file.binary === true ? 1 : 0),
    }),
    {
      files: 0,
      hunks: 0,
      additions: 0,
      deletions: 0,
      added: 0,
      copied: 0,
      deleted: 0,
      modified: 0,
      renamed: 0,
      typeChanged: 0,
      binary: 0,
    },
  );
  return {
    schema: "git-diff",
    version: GIT_DIFF_VERSION,
    summary,
    files: Object.freeze(normalizedFiles),
  };
}

function finalizeDiffFile(file: MutableDiffFile): GitDiffFile {
  for (const hunk of file.hunks) {
    if (hunk.oldSeen !== hunk.oldLines || hunk.newSeen !== hunk.newLines) {
      throw invalidGitInput("hunk line counts do not match its header");
    }
  }
  const status = inferDiffStatus(file);
  const path = status === "deleted" ? file.oldPath : (file.newPath ?? file.oldPath);
  if (path === undefined) {
    throw invalidGitInput("diff file has no path");
  }
  const oldPath = file.oldPath !== undefined && file.oldPath !== path ? file.oldPath : undefined;
  const hunks = file.hunks
    .map((item) => ({
      oldStart: item.oldStart,
      oldLines: item.oldLines,
      newStart: item.newStart,
      newLines: item.newLines,
      ...(item.heading === undefined ? {} : { heading: item.heading }),
      lines: Object.freeze([...item.lines]),
      ...(item.noNewlineAtEnd === true ? { noNewlineAtEnd: true } : {}),
    }))
    .sort((left, right) => left.oldStart - right.oldStart || left.newStart - right.newStart);
  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    status,
    additions: file.additions,
    deletions: file.deletions,
    hunks: Object.freeze(hunks),
    ...(file.binary ? { binary: true } : {}),
    ...(file.similarity === undefined ? {} : { similarity: file.similarity }),
  };
}

function inferDiffStatus(file: MutableDiffFile): GitDiffFileStatus {
  if (file.statusHint !== undefined) {
    return file.statusHint;
  }
  if (file.oldPath === undefined && file.newPath !== undefined) {
    return "added";
  }
  if (file.newPath === undefined && file.oldPath !== undefined) {
    return "deleted";
  }
  if (file.oldPath !== undefined && file.newPath !== undefined && file.oldPath !== file.newPath) {
    return file.similarity !== undefined ? "renamed" : "modified";
  }
  return "modified";
}

function compareDiffFiles(left: GitDiffFile, right: GitDiffFile): number {
  return compareStrings(left.path, right.path) || compareStrings(left.oldPath ?? "", right.oldPath ?? "");
}

function validateDiffFile(file: MutableDiffFile, lineNumber: number): void {
  if (file.oldPath === undefined && file.newPath === undefined) {
    throw invalidGitInput("diff file has no path", lineNumber);
  }
}

function emptyDiffFile(): MutableDiffFile {
  return { additions: 0, deletions: 0, hunks: [], binary: false };
}

function parseDiffHeader(value: string, lineNumber: number): { oldPath?: string; newPath?: string } {
  const trimmed = value.trim();
  let oldToken: string;
  let newToken: string;
  if (!trimmed.startsWith('"') && trimmed.startsWith("a/")) {
    const separator = trimmed.indexOf(" b/", 2);
    if (separator > 0) {
      oldToken = trimmed.slice(0, separator);
      newToken = trimmed.slice(separator + 1);
    } else {
      const tokens = readPathToken(trimmed, lineNumber);
      const second = readPathToken(tokens.rest, lineNumber);
      oldToken = tokens.value;
      newToken = second.value;
    }
  } else {
    const first = readPathToken(trimmed, lineNumber);
    const second = readPathToken(first.rest, lineNumber);
    oldToken = first.value;
    newToken = second.value;
  }
  return {
    oldPath: normalizeGitPath(oldToken, "a", lineNumber),
    newPath: normalizeGitPath(newToken, "b", lineNumber),
  };
}

function parsePatchPath(value: string, prefix: "a" | "b", lineNumber: number): string | undefined {
  const field = value.includes("\t") ? value.slice(0, value.indexOf("\t")) : value.trim();
  return normalizeGitPath(field, prefix, lineNumber);
}

function readPathToken(value: string, lineNumber: number): { value: string; rest: string } {
  const trimmed = value.trimStart();
  if (trimmed.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return { value: decodeGitQuotedPath(trimmed.slice(0, index + 1), lineNumber), rest: trimmed.slice(index + 1) };
      }
    }
    throw invalidGitInput("unterminated quoted git path", lineNumber);
  }
  const separator = trimmed.search(/\s/);
  if (separator === -1) {
    return { value: trimmed, rest: "" };
  }
  return { value: trimmed.slice(0, separator), rest: trimmed.slice(separator) };
}

function decodeGitQuotedPath(value: string, lineNumber: number): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw invalidGitInput("invalid quoted git path", lineNumber);
  }
  const bytes: number[] = [];
  let text = "";
  const flushText = (): void => {
    if (text !== "") {
      bytes.push(...new TextEncoder().encode(text));
      text = "";
    }
  };
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      text += character;
      continue;
    }
    const next = value[++index];
    if (next === undefined) {
      throw invalidGitInput("invalid escape in quoted git path", lineNumber);
    }
    const escapes: Record<string, string> = { a: "\u0007", b: "\b", t: "\t", n: "\n", v: "\u000b", f: "\f", r: "\r" };
    const replacement = escapes[next];
    if (replacement !== undefined) {
      text += replacement;
      continue;
    }
    if (next === "\\" || next === '"') {
      text += next;
      continue;
    }
    if (/^[0-7]$/.test(next)) {
      flushText();
      let octal = next;
      for (let count = 0; count < 2 && /^[0-7]$/.test(value[index + 1] ?? ""); count += 1) {
        octal += value[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    throw invalidGitInput(`unsupported escape in quoted git path: \\${next}`, lineNumber);
  }
  flushText();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw invalidGitInput("quoted git path is not valid UTF-8", lineNumber);
  }
}

function normalizeGitPath(value: string, prefix: "a" | "b" | undefined, lineNumber?: number): string | undefined {
  let path = value.trim();
  if (path.startsWith('"')) {
    path = decodeGitQuotedPath(path, lineNumber ?? 0);
  }
  if (path === "/dev/null") {
    return undefined;
  }
  if (prefix !== undefined && path.startsWith(`${prefix}/`)) {
    path = path.slice(2);
  }
  path = path.replaceAll("\\", "/");
  if (path.startsWith("/") || path === "") {
    throw invalidGitInput("git path must be relative and non-empty", lineNumber);
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        throw invalidGitInput("git path escapes repository root", lineNumber);
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    throw invalidGitInput("git path is empty after normalization", lineNumber);
  }
  return parts.join("/");
}

function parseHunkHeader(line: string, lineNumber: number): MutableDiffHunk {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/.exec(line);
  if (match === null) {
    throw invalidGitInput(`invalid hunk header: ${line}`, lineNumber);
  }
  const oldStart = parseCount(match[1], lineNumber);
  const oldLines = parseCount(match[2] ?? "1", lineNumber);
  const newStart = parseCount(match[3], lineNumber);
  const newLines = parseCount(match[4] ?? "1", lineNumber);
  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    ...(match[5] === undefined || match[5] === "" ? {} : { heading: match[5] }),
    lines: [],
    oldSeen: 0,
    newSeen: 0,
  };
}

function appendHunkLine(file: MutableDiffFile, hunk: MutableDiffHunk, line: string): void {
  const prefix = line[0];
  const content = line.slice(1);
  if (prefix === " ") {
    hunk.lines.push({
      kind: "context",
      text: content,
      oldLine: hunk.oldStart + hunk.oldSeen,
      newLine: hunk.newStart + hunk.newSeen,
    });
    hunk.oldSeen += 1;
    hunk.newSeen += 1;
  } else if (prefix === "+") {
    hunk.lines.push({ kind: "addition", text: content, newLine: hunk.newStart + hunk.newSeen });
    hunk.newSeen += 1;
    file.additions += 1;
  } else {
    hunk.lines.push({ kind: "deletion", text: content, oldLine: hunk.oldStart + hunk.oldSeen });
    hunk.oldSeen += 1;
    file.deletions += 1;
  }
}

function parseCount(value: string, lineNumber?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidGitInput("git line count must be a non-negative integer", lineNumber);
  }
  return parsed;
}

function parsePercentage(value: string, lineNumber: number): number {
  const match = /^(\d+)%$/.exec(value.trim());
  if (match === null) {
    throw invalidGitInput("git similarity index must be a percentage", lineNumber);
  }
  const percentage = Number(match[1]);
  if (percentage > 100) {
    throw invalidGitInput("git similarity index must not exceed 100", lineNumber);
  }
  return percentage;
}

function statusFromDiffCode(code: string, lineNumber?: number): GitDiffFileStatus {
  const statuses: Record<string, GitDiffFileStatus> = {
    A: "added",
    C: "copied",
    D: "deleted",
    M: "modified",
    R: "renamed",
    T: "type-changed",
    U: "unmerged",
    X: "unknown",
    B: "unknown",
  };
  const status = statuses[code];
  if (status === undefined) {
    throw invalidGitInput(`unsupported git diff status: ${code}`, lineNumber);
  }
  return status;
}

function requireCurrent(current: MutableDiffFile | undefined, lineNumber: number): MutableDiffFile {
  if (current === undefined) {
    throw invalidGitInput("git diff record has no active file", lineNumber);
  }
  return current;
}

function parseGitStatus(text: string): GitStatusSemanticModel {
  if (text === "") {
    return makeStatusModel([], undefined);
  }
  const entries: GitStatusEntry[] = [];
  let branch: GitStatusBranch | undefined;
  const records = text.includes("\0") ? parseNulStatusRecords(text) : splitTextLines(text);
  for (const [index, record] of records.entries()) {
    if (record === "") {
      continue;
    }
    if (record.startsWith("## ")) {
      branch = parseBranchRecord(record, index + 1);
      continue;
    }
    if (record.startsWith("# ")) {
      branch = parseV2BranchRecord(record, branch, index + 1);
      continue;
    }
    if (record.startsWith("1 ")) {
      entries.push(parseV2OrdinaryRecord(record, index + 1));
      continue;
    }
    if (record.startsWith("2 ")) {
      entries.push(parseV2RenameRecord(record, index + 1));
      continue;
    }
    if (record.startsWith("u ")) {
      entries.push(parseV2UnmergedRecord(record, index + 1));
      continue;
    }
    if (record.startsWith("? ")) {
      entries.push(makeStatusEntry(normalizeGitPath(record.slice(2), undefined, index + 1)!, "?", "?"));
      continue;
    }
    if (record.startsWith("! ")) {
      entries.push(makeStatusEntry(normalizeGitPath(record.slice(2), undefined, index + 1)!, "!", "!"));
      continue;
    }
    if (/^[ MADRCUT?!][ MADRCUT?!] /.test(record)) {
      entries.push(parseV1StatusRecord(record, index + 1));
      continue;
    }
    throw invalidGitInput(`unsupported git status record: ${record}`, index + 1);
  }
  return makeStatusModel(entries, branch);
}

function parseNulStatusRecords(text: string): string[] {
  const records: string[] = [];
  const chunks = text.split("\0");
  for (let index = 0; index < chunks.length; index += 1) {
    const record = chunks[index];
    if (record === undefined || record === "") {
      continue;
    }
    const v1Rename = /^[ MADRCUT?!][ MADRCUT?!] /.test(record) && (record[0] === "R" || record[0] === "C");
    const v2Rename = record.startsWith("2 ") && /[RC]/.test(record.split(" ")[1] ?? "");
    if (v1Rename || v2Rename) {
      const original = chunks[index + 1];
      if (original !== undefined) {
        records.push(`${record}\0${original}`);
        index += 1;
        continue;
      }
    }
    records.push(record);
  }
  return records;
}

function parseV1StatusRecord(record: string, lineNumber: number): GitStatusEntry {
  const index = record[0];
  const worktree = record[1];
  if (index === undefined || worktree === undefined) {
    throw invalidGitInput("git status record has no XY status", lineNumber);
  }
  const rawPath = record.slice(3);
  const rename = index === "R" || index === "C" || worktree === "R" || worktree === "C";
  const paths = rename ? splitRenamePath(rawPath, lineNumber) : { path: rawPath };
  const path = normalizeGitPath(paths.path, undefined, lineNumber);
  if (path === undefined) {
    throw invalidGitInput("git status record has no path", lineNumber);
  }
  return makeStatusEntry(path, index, worktree, paths.originalPath);
}

function parseV2OrdinaryRecord(record: string, lineNumber: number): GitStatusEntry {
  const fields = record.split(" ");
  if (fields.length < 9) {
    throw invalidGitInput("git status v2 ordinary record is incomplete", lineNumber);
  }
  const path = normalizeGitPath(fields.slice(8).join(" "), undefined, lineNumber);
  if (path === undefined) {
    throw invalidGitInput("git status v2 ordinary record has no path", lineNumber);
  }
  return makeStatusEntry(path, fields[1]!.charAt(0), fields[1]!.charAt(1));
}

function parseV2RenameRecord(record: string, lineNumber: number): GitStatusEntry {
  const nulSeparator = record.indexOf("\0");
  const beforeOriginal = nulSeparator === -1 ? record : record.slice(0, nulSeparator);
  const originalPath = nulSeparator === -1 ? undefined : record.slice(nulSeparator + 1);
  const fields = beforeOriginal.split(" ");
  if (fields.length < 10) {
    throw invalidGitInput("git status v2 rename record is incomplete", lineNumber);
  }
  const path = normalizeGitPath(fields.slice(9).join(" "), undefined, lineNumber);
  if (path === undefined) {
    throw invalidGitInput("git status v2 rename record has no path", lineNumber);
  }
  return makeStatusEntry(path, fields[1]!.charAt(0), fields[1]!.charAt(1), originalPath);
}

function parseV2UnmergedRecord(record: string, lineNumber: number): GitStatusEntry {
  const fields = record.split(" ");
  if (fields.length < 11) {
    throw invalidGitInput("git status v2 unmerged record is incomplete", lineNumber);
  }
  const path = normalizeGitPath(fields.slice(10).join(" "), undefined, lineNumber);
  if (path === undefined) {
    throw invalidGitInput("git status v2 unmerged record has no path", lineNumber);
  }
  return makeStatusEntry(path, fields[1]!.charAt(0), fields[1]!.charAt(1));
}

function splitRenamePath(value: string, lineNumber: number): { path: string; originalPath?: string } {
  const nulSeparator = value.indexOf("\0");
  if (nulSeparator !== -1) {
    return { originalPath: value.slice(nulSeparator + 1), path: value.slice(0, nulSeparator) };
  }
  const separator = value.indexOf(" -> ");
  if (separator === -1) {
    throw invalidGitInput("rename status record has no old/new path separator", lineNumber);
  }
  return { originalPath: value.slice(0, separator), path: value.slice(separator + 4) };
}

function parseBranchRecord(record: string, lineNumber: number): GitStatusBranch {
  const value = record.slice(3);
  const noCommitPrefix = "No commits yet on ";
  if (value.startsWith(noCommitPrefix)) {
    const head = value.slice(noCommitPrefix.length).trim();
    if (head === "") {
      throw invalidGitInput("git status branch record has no head", lineNumber);
    }
    return { head };
  }
  const separator = value.indexOf("...");
  const head = (separator === -1 ? value : value.slice(0, separator)).split(" ")[0];
  if (head === undefined || head === "") {
    throw invalidGitInput("git status branch record has no head", lineNumber);
  }
  const branch: { head: string; upstream?: string; ahead?: number; behind?: number } = { head };
  if (separator !== -1) {
    const remainder = value.slice(separator + 3);
    const upstream = remainder.split(" ")[0];
    if (upstream !== undefined && upstream !== "") {
      branch.upstream = upstream;
    }
    const ahead = /ahead (\d+)/.exec(remainder)?.[1];
    const behind = /behind (\d+)/.exec(remainder)?.[1];
    if (ahead !== undefined) branch.ahead = Number(ahead);
    if (behind !== undefined) branch.behind = Number(behind);
  }
  return branch;
}

function parseV2BranchRecord(record: string, branch: GitStatusBranch | undefined, lineNumber: number): GitStatusBranch {
  const value = record.slice(2);
  if (value.startsWith("branch.head ")) {
    const head = value.slice("branch.head ".length);
    if (head === "") throw invalidGitInput("git status v2 branch has no head", lineNumber);
    return { ...(branch ?? { head }), head };
  }
  if (value.startsWith("branch.upstream ")) {
    const upstream = value.slice("branch.upstream ".length);
    if (branch === undefined) throw invalidGitInput("git status v2 upstream precedes branch head", lineNumber);
    return { ...branch, upstream };
  }
  const ahead = value.startsWith("branch.ab ") ? /^branch\.ab \+(\d+) -(\d+)$/.exec(value) : null;
  if (ahead !== null) {
    if (branch === undefined) throw invalidGitInput("git status v2 ahead/behind precedes branch head", lineNumber);
    return { ...branch, ahead: Number(ahead[1]), behind: Number(ahead[2]) };
  }
  if (value.startsWith("branch.oid ")) {
    return branch ?? { head: "" };
  }
  throw invalidGitInput(`unsupported git status v2 header: ${record}`, lineNumber);
}

function makeStatusEntry(path: string, index: string, worktree: string, originalPath?: string): GitStatusEntry {
  return {
    path,
    ...(originalPath === undefined ? {} : { originalPath: normalizeGitPath(originalPath, undefined) }),
    index,
    worktree,
    classification: classifyStatus(index, worktree),
  };
}

function classifyStatus(index: string, worktree: string): GitStatusClass {
  if (index === "?" || worktree === "?") return "untracked";
  if (index === "!" || worktree === "!") return "ignored";
  if (index === "U" || worktree === "U") return "unmerged";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "C" || worktree === "C") return "copied";
  if (index === "A" || worktree === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "T" || worktree === "T") return "type-changed";
  if (index === "M" || worktree === "M") return "modified";
  return "unknown";
}

function makeStatusModel(
  entries: readonly GitStatusEntry[],
  branch: GitStatusBranch | undefined,
): GitStatusSemanticModel {
  const sorted = [...entries].sort(
    (left, right) =>
      compareStrings(left.path, right.path) || compareStrings(left.originalPath ?? "", right.originalPath ?? ""),
  );
  const summary = sorted.reduce<GitStatusSummary>(
    (total, entry) => {
      const key = entry.classification;
      return {
        files: total.files + 1,
        staged: total.staged + (entry.index !== " " && entry.index !== "?" && entry.index !== "!" ? 1 : 0),
        unstaged: total.unstaged + (entry.worktree !== " " && entry.worktree !== "?" && entry.worktree !== "!" ? 1 : 0),
        added: total.added + (key === "added" ? 1 : 0),
        copied: total.copied + (key === "copied" ? 1 : 0),
        deleted: total.deleted + (key === "deleted" ? 1 : 0),
        modified: total.modified + (key === "modified" ? 1 : 0),
        renamed: total.renamed + (key === "renamed" ? 1 : 0),
        typeChanged: total.typeChanged + (key === "type-changed" ? 1 : 0),
        unmerged: total.unmerged + (key === "unmerged" ? 1 : 0),
        untracked: total.untracked + (key === "untracked" ? 1 : 0),
        ignored: total.ignored + (key === "ignored" ? 1 : 0),
        unknown: total.unknown + (key === "unknown" ? 1 : 0),
      };
    },
    {
      files: 0,
      staged: 0,
      unstaged: 0,
      added: 0,
      copied: 0,
      deleted: 0,
      modified: 0,
      renamed: 0,
      typeChanged: 0,
      unmerged: 0,
      untracked: 0,
      ignored: 0,
      unknown: 0,
    },
  );
  return {
    schema: "git-status",
    version: GIT_STATUS_VERSION,
    summary,
    entries: Object.freeze(sorted),
    ...(branch === undefined || branch.head === "" ? {} : { branch }),
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function splitTextLines(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

function invalidGitInput(message: string, lineNumber?: number): GitInputError {
  return new GitInputError(lineNumber === undefined ? message : `${message} (line ${lineNumber})`);
}

function validationFor<T>(parse: (source: ProjectionSource) => T, source: ProjectionSource): ValidationResult {
  try {
    parse(source);
    return validationSuccess();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const issue: ValidationIssue = { code: "INVALID_GIT_INPUT", message };
    return validationFailure(issue);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelIssue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, ...(path === undefined ? {} : { path }) };
}

function validateDiffModel(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value) || value.schema !== "git-diff" || value.version !== GIT_DIFF_VERSION) {
    return validationFailure(modelIssue("INVALID_GIT_DIFF_MODEL", "value is not a git-diff model"));
  }
  if (
    !isRecord(value.summary) ||
    !isNonNegativeIntegerRecord(value.summary, ["files", "hunks", "additions", "deletions"])
  ) {
    issues.push(modelIssue("INVALID_GIT_DIFF_MODEL", "summary must contain non-negative integer counts", "summary"));
  }
  if (!Array.isArray(value.files)) {
    issues.push(modelIssue("INVALID_GIT_DIFF_MODEL", "files must be an array", "files"));
  } else {
    value.files.forEach((file, index) => {
      if (!isRecord(file) || typeof file.path !== "string" || typeof file.status !== "string") {
        issues.push(modelIssue("INVALID_GIT_DIFF_MODEL", "file requires path and status", `files[${index}]`));
      }
    });
  }
  return issues.length === 0 ? validationSuccess() : validationFailure(issues);
}

function validateStatusModel(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value) || value.schema !== "git-status" || value.version !== GIT_STATUS_VERSION) {
    return validationFailure(modelIssue("INVALID_GIT_STATUS_MODEL", "value is not a git-status model"));
  }
  if (!isRecord(value.summary) || !isNonNegativeIntegerRecord(value.summary, ["files", "staged", "unstaged"])) {
    issues.push(modelIssue("INVALID_GIT_STATUS_MODEL", "summary must contain non-negative integer counts", "summary"));
  }
  if (!Array.isArray(value.entries)) {
    issues.push(modelIssue("INVALID_GIT_STATUS_MODEL", "entries must be an array", "entries"));
  } else {
    value.entries.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.classification !== "string") {
        issues.push(
          modelIssue("INVALID_GIT_STATUS_MODEL", "entry requires path and classification", `entries[${index}]`),
        );
      }
    });
  }
  return issues.length === 0 ? validationSuccess() : validationFailure(issues);
}

function isNonNegativeIntegerRecord(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(
    (field) => typeof value[field] === "number" && Number.isSafeInteger(value[field]) && value[field] >= 0,
  );
}

export const gitDiffContract: SemanticContract<GitDiffSemanticModel> = Object.freeze({
  id: GIT_DIFF_ADAPTER_ID,
  version: GIT_DIFF_VERSION,
  semanticType: GIT_DIFF_SEMANTIC_TYPE,
  validate: validateDiffModel,
  normalize: (value: unknown) => value as GitDiffSemanticModel,
});

export const gitStatusContract: SemanticContract<GitStatusSemanticModel> = Object.freeze({
  id: GIT_STATUS_ADAPTER_ID,
  version: GIT_STATUS_VERSION,
  semanticType: GIT_STATUS_SEMANTIC_TYPE,
  validate: validateStatusModel,
  normalize: (value: unknown) => value as GitStatusSemanticModel,
});

export const gitDiffAdapter: Adapter<GitDiffSemanticModel> = Object.freeze({
  id: GIT_DIFF_ADAPTER_ID,
  version: GIT_DIFF_VERSION,
  semanticType: GIT_DIFF_SEMANTIC_TYPE,
  contract: { id: GIT_DIFF_ADAPTER_ID, version: GIT_DIFF_VERSION },
  validate: (source: ProjectionSource) => validationFor(decodeGitDiff, source),
  decode: decodeGitDiff,
});

export const gitStatusAdapter: Adapter<GitStatusSemanticModel> = Object.freeze({
  id: GIT_STATUS_ADAPTER_ID,
  version: GIT_STATUS_VERSION,
  semanticType: GIT_STATUS_SEMANTIC_TYPE,
  contract: { id: GIT_STATUS_ADAPTER_ID, version: GIT_STATUS_VERSION },
  validate: (source: ProjectionSource) => validationFor(decodeGitStatus, source),
  decode: decodeGitStatus,
});

export const gitDiffSummaryView: View<GitDiffSummaryProjection> = Object.freeze({
  id: "git-diff-summary",
  version: GIT_DIFF_VERSION,
  semanticType: GIT_DIFF_SEMANTIC_TYPE,
  meaning: {
    required: ["schema", "version", "summary.files", "summary.additions", "summary.deletions"],
    preserved: ["summary.hunks", "summary.added", "summary.deleted", "summary.modified", "summary.renamed"],
    discarded: ["files", "hunks"],
    priorities: ["summary.binary", "summary.typeChanged", "summary.renamed", "summary.modified"],
  },
  project: ({ semantic }: ViewProjectInput) => {
    const model = semantic as GitDiffSemanticModel;
    return { schema: model.schema, version: model.version, summary: model.summary };
  },
});

export const gitDiffFilesView: View<GitDiffFilesProjection> = Object.freeze({
  id: "git-diff-files",
  version: GIT_DIFF_VERSION,
  semanticType: GIT_DIFF_SEMANTIC_TYPE,
  meaning: {
    required: ["schema", "version", "summary.files"],
    preserved: ["summary", "files"],
    discarded: ["hunks", "files.hunks"],
    priorities: [
      { path: "summary.binary", priority: 30 },
      { path: "summary.typeChanged", priority: 25 },
      { path: "summary.renamed", priority: 20 },
      { path: "files", priority: 10 },
    ],
  },
  project: ({ semantic }: ViewProjectInput) => {
    const model = semantic as GitDiffSemanticModel;
    return {
      schema: model.schema,
      version: model.version,
      summary: model.summary,
      files: model.files.map((file) => ({
        path: file.path,
        ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        hunkCount: file.hunks.length,
        ...(file.binary === undefined ? {} : { binary: file.binary }),
        ...(file.similarity === undefined ? {} : { similarity: file.similarity }),
      })),
    };
  },
});

export const gitDiffHunksView: View<GitDiffHunksProjection> = Object.freeze({
  id: "git-diff-hunks",
  version: GIT_DIFF_VERSION,
  semanticType: GIT_DIFF_SEMANTIC_TYPE,
  meaning: {
    required: ["schema", "version", "summary.files"],
    preserved: ["summary", "hunks"],
    discarded: ["files"],
    priorities: [
      { path: "summary.binary", priority: 30 },
      { path: "hunks", priority: 10 },
    ],
  },
  project: ({ semantic }: ViewProjectInput) => {
    const model = semantic as GitDiffSemanticModel;
    const hunks = model.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        path: file.path,
        ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
        status: file.status,
        ...hunk,
      })),
    );
    return { schema: model.schema, version: model.version, summary: model.summary, hunks };
  },
});

export const gitStatusSummaryView: View<GitStatusSummaryProjection> = Object.freeze({
  id: "git-status-summary",
  version: GIT_STATUS_VERSION,
  semanticType: GIT_STATUS_SEMANTIC_TYPE,
  meaning: {
    required: ["schema", "version", "summary.files", "summary.staged", "summary.unstaged"],
    preserved: ["summary.added", "summary.deleted", "summary.modified", "summary.untracked", "branch"],
    discarded: ["entries"],
    priorities: ["summary.ignored", "summary.unknown", "branch"],
  },
  project: ({ semantic }: ViewProjectInput) => {
    const model = semantic as GitStatusSemanticModel;
    return {
      schema: model.schema,
      version: model.version,
      summary: model.summary,
      ...(model.branch === undefined ? {} : { branch: model.branch }),
    };
  },
});

export const gitStatusFilesView: View<GitStatusFilesProjection> = Object.freeze({
  id: "git-status-files",
  version: GIT_STATUS_VERSION,
  semanticType: GIT_STATUS_SEMANTIC_TYPE,
  meaning: {
    required: ["schema", "version", "summary.files"],
    preserved: ["summary", "files", "branch"],
    discarded: ["entries"],
    priorities: [
      { path: "summary.ignored", priority: 30 },
      { path: "summary.unknown", priority: 25 },
      { path: "branch", priority: 20 },
      { path: "files", priority: 10 },
    ],
  },
  project: ({ semantic }: ViewProjectInput) => {
    const model = semantic as GitStatusSemanticModel;
    return {
      schema: model.schema,
      version: model.version,
      summary: model.summary,
      files: model.entries,
      ...(model.branch === undefined ? {} : { branch: model.branch }),
    };
  },
});

export const builtinGitAdapters = Object.freeze([gitDiffAdapter, gitStatusAdapter]);
export const builtinGitContracts = Object.freeze([gitDiffContract, gitStatusContract]);
export const builtinGitViews = Object.freeze([
  gitDiffSummaryView,
  gitDiffFilesView,
  gitDiffHunksView,
  gitStatusSummaryView,
  gitStatusFilesView,
]);

export interface BuiltinGitComponents {
  readonly adapters: readonly Adapter[];
  readonly semanticContracts: readonly SemanticContract[];
  readonly views: readonly View[];
}

export const builtinGitComponents: BuiltinGitComponents = Object.freeze({
  adapters: builtinGitAdapters,
  semanticContracts: builtinGitContracts,
  views: builtinGitViews,
});

export function builtinGitComponentIdentities(): {
  readonly adapters: readonly ComponentIdentity[];
  readonly semanticContracts: readonly ComponentIdentity[];
  readonly views: readonly ComponentIdentity[];
} {
  return {
    adapters: builtinGitAdapters.map(identityOf),
    semanticContracts: builtinGitContracts.map(identityOf),
    views: builtinGitViews.map(identityOf),
  };
}

export function registerBuiltinGitComponents(core: ProjectionCore): ProjectionCore {
  core.adapters.registerMany(builtinGitAdapters);
  core.semanticContracts.registerMany(builtinGitContracts);
  core.views.registerMany(builtinGitViews);
  return core;
}

export function createGitProjectionCore(options: ProjectionCoreOptions = {}): ProjectionCore {
  return registerBuiltinGitComponents(new ProjectionCore(options));
}

function identityOf(component: ComponentIdentity): ComponentIdentity {
  return { id: component.id, version: component.version };
}

export const gitDiff = gitDiffAdapter;
export const gitStatus = gitStatusAdapter;
export const gitDiffSummary = gitDiffSummaryView;
export const gitDiffFiles = gitDiffFilesView;
export const gitDiffHunks = gitDiffHunksView;
export const gitStatusSummary = gitStatusSummaryView;
export const gitStatusFiles = gitStatusFilesView;
