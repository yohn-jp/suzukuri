export const GENERIC_RESULT_SCHEMA_VERSION = "1.0.0";

/**
 * The bounded outcome of a repository command that has no specialized
 * semantic projection. Preserves command identity, exit/signal outcome,
 * duration, bounded stdout/stderr, and truncation/completeness — enough for
 * a caller to judge success/failure and inspect diagnostics without
 * Suzukuri understanding the command's domain semantics.
 */
export interface GenericCommandResult {
  readonly version: typeof GENERIC_RESULT_SCHEMA_VERSION;
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly completeness: "complete" | "incomplete";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly stage?: string;
}

export function isGenericCommandResult(value: unknown): value is GenericCommandResult {
  return (
    isRecord(value) &&
    value.version === GENERIC_RESULT_SCHEMA_VERSION &&
    (value.status === "passed" || value.status === "failed") &&
    (value.completeness === "complete" || value.completeness === "incomplete") &&
    typeof value.command === "string" &&
    typeof value.durationMs === "number" &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.truncated === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
