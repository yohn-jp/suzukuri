import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runBoundedProcess } from "./execution.js";

export const REPOSITORY_FINGERPRINT_ALGORITHM = "sha256" as const;

/**
 * Suzukuri-owned cache state excluded from the fingerprint regardless of the
 * target repository's own `.gitignore`, so cache lookup/storage can never
 * recursively affect the fingerprint it is keyed on.
 */
const SUZUKURI_OWNED_CACHE_PATHSPEC = ":(exclude).suzukuri/cache";

export type RepositoryFingerprintErrorCode = "REPOSITORY_FINGERPRINT_UNAVAILABLE" | "REPOSITORY_FINGERPRINT_UNSTABLE";

const ERROR_MESSAGES: Record<RepositoryFingerprintErrorCode, string> = {
  REPOSITORY_FINGERPRINT_UNAVAILABLE: "The repository content fingerprint could not be acquired.",
  REPOSITORY_FINGERPRINT_UNSTABLE: "The repository content fingerprint could not be proven stable.",
};

export class RepositoryFingerprintError extends Error {
  readonly code: RepositoryFingerprintErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RepositoryFingerprintErrorCode, details: Readonly<Record<string, unknown>> = {}) {
    super(ERROR_MESSAGES[code]);
    this.name = "RepositoryFingerprintError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Fingerprints exactly the git-tracked files plus non-ignored untracked
 * files beneath `cwd`, keyed on canonical repository-relative path bytes and
 * exact file bytes, independent of worktree path, branch, commit, index
 * state, and mtime.
 */
export async function computeRepositoryFingerprint(cwd = process.cwd(), inputs?: readonly string[]): Promise<string> {
  if (
    inputs !== undefined &&
    (inputs.length === 0 ||
      inputs.some(
        (input) =>
          typeof input !== "string" ||
          input === "" ||
          input.startsWith("/") ||
          input.includes("\\") ||
          input.includes("\0") ||
          input.split("/").some((part) => part === "" || part === "." || part === "..") ||
          input === ".git" ||
          input.startsWith(".git/") ||
          input === ".suzukuri/cache" ||
          input.startsWith(".suzukuri/cache/"),
      ))
  ) {
    throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNAVAILABLE", { reason: "invalid input scope" });
  }
  const paths = (await listFingerprintedPaths(cwd)).filter(
    (relativePath) =>
      inputs === undefined || inputs.some((input) => relativePath === input || relativePath.startsWith(`${input}/`)),
  );
  const hash = createHash(REPOSITORY_FINGERPRINT_ALGORITHM);
  for (const relativePath of paths) {
    const entry = readEntry(cwd, relativePath);
    const pathBytes = Buffer.from(relativePath, "utf8");
    hash.update(uint64Length(pathBytes.byteLength));
    hash.update(pathBytes);
    // A one-byte kind tag keeps a symlink's target bytes from aliasing a
    // regular file whose content happens to equal that target string.
    hash.update(Buffer.from([entry.kind]));
    hash.update(uint64Length(entry.bytes.byteLength));
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

const enum EntryKind {
  File = 0,
  Symlink = 1,
}

interface FingerprintedEntry {
  readonly kind: EntryKind;
  readonly bytes: Buffer;
}

/**
 * Reads the exact bytes that identify a listed path's content: a symlink is
 * fingerprinted by its link target bytes (never dereferenced, so a link
 * whose target moves outside the repository cannot pull in unrelated
 * content, and a changed link target always changes the fingerprint), and a
 * regular file by its file bytes. Any other file kind (directory, fifo,
 * socket, device) is not a stable, unambiguous content source, so it fails
 * closed rather than being silently skipped or misrepresented.
 */
function readEntry(cwd: string, relativePath: string): FingerprintedEntry {
  const absolutePath = path.resolve(cwd, relativePath);
  try {
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      return { kind: EntryKind.Symlink, bytes: Buffer.from(fs.readlinkSync(absolutePath), "utf8") };
    }
    if (stats.isFile()) {
      return { kind: EntryKind.File, bytes: fs.readFileSync(absolutePath) };
    }
    throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNSTABLE", {
      path: relativePath,
      reason: "listed path is neither a regular file nor a symbolic link",
    });
  } catch (error) {
    if (error instanceof RepositoryFingerprintError) throw error;
    // The path was listed by git but is no longer readable: the snapshot
    // is not stable, so fail closed to producer execution instead of
    // fingerprinting a moving target.
    throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNSTABLE", {
      path: relativePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function listFingerprintedPaths(cwd: string): Promise<string[]> {
  const result = await runGitLsFiles(cwd);
  const paths = result
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort(compareUtf8Bytes);
  assertNoDuplicates(paths);
  return paths;
}

async function runGitLsFiles(cwd: string): Promise<string> {
  let result;
  try {
    result = await runBoundedProcess(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", SUZUKURI_OWNED_CACHE_PATHSPEC],
      { cwd, maxOutputBytes: 256 * 1024 * 1024 },
    );
  } catch (error) {
    throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNAVAILABLE", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNAVAILABLE", {
      exitCode: result.exitCode,
      signal: result.signal,
      stderr: result.stderr,
    });
  }
  if (result.truncated) {
    // A truncated file list cannot be proven complete: fail closed.
    throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNSTABLE", { reason: "file list truncated" });
  }
  return result.stdout;
}

function assertNoDuplicates(paths: readonly string[]): void {
  for (let index = 1; index < paths.length; index += 1) {
    if (paths[index] === paths[index - 1]) {
      throw new RepositoryFingerprintError("REPOSITORY_FINGERPRINT_UNSTABLE", { path: paths[index] });
    }
  }
}

function compareUtf8Bytes(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

function uint64Length(value: number): Buffer {
  // An explicit 8-byte big-endian length prefix keeps the path/content
  // boundary unambiguous: no separator byte could alias into either field.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}
