import { createHash } from "node:crypto";
import {
  stableJsonStringify,
  validationFailure,
  validationSuccess,
  type SemanticContract,
  type ValidationResult,
} from "./core.js";
import type { ExecutionVerificationTier } from "./execution.js";

export const VERIFY_RESULT_SEMANTIC_TYPE = "verification-result";
export const VERIFY_RESULT_SCHEMA_VERSION = "1.0.0";

export type VerifyStatus = "passed" | "failed";
export type VerifyCompleteness = "complete" | "incomplete";

export const VERIFICATION_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Deterministic provenance for one reusable verification producer result. */
export interface VerificationEvidence {
  readonly version: typeof VERIFICATION_EVIDENCE_SCHEMA_VERSION;
  readonly identity: string;
  readonly producerIdentity: string;
  readonly inputFingerprint: string;
  readonly resultIdentity: string;
  readonly execution: "executed" | "reused";
  readonly tier?: ExecutionVerificationTier;
}

/**
 * The intentionally small semantic result of a repository verification run.
 *
 * A successful run carries no producer output. A failed run carries only the
 * bounded diagnostic tail observed by the execution runner and, when it can
 * be established from that observation, the failing repository stage.
 */
export interface VerifyResult {
  readonly version: typeof VERIFY_RESULT_SCHEMA_VERSION;
  readonly status: VerifyStatus;
  readonly completeness: VerifyCompleteness;
  readonly stage?: string;
  readonly diagnostic?: string;
  readonly truncated?: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly evidence?: VerificationEvidence;
  readonly steps?: readonly {
    readonly name: string;
    readonly execution: "executed" | "reused";
    readonly evidence?: VerificationEvidence;
  }[];
}

export const verifyResultContract: SemanticContract<VerifyResult> = Object.freeze({
  id: VERIFY_RESULT_SEMANTIC_TYPE,
  version: VERIFY_RESULT_SCHEMA_VERSION,
  semanticType: VERIFY_RESULT_SEMANTIC_TYPE,
  validate: validateVerifyResult,
  normalize: normalizeVerifyResult,
});

export function validateVerifyResult(value: unknown): ValidationResult {
  const issues: Array<{ code: string; message: string; path?: string }> = [];
  if (!isRecord(value)) {
    return validationFailure({ code: "type", message: "verification-result must be an object" });
  }
  if (value.version !== VERIFY_RESULT_SCHEMA_VERSION) {
    issues.push({
      code: "version",
      message: `version must be ${VERIFY_RESULT_SCHEMA_VERSION}`,
      path: "version",
    });
  }
  if (value.status !== "passed" && value.status !== "failed") {
    issues.push({ code: "status", message: "status must be passed or failed", path: "status" });
  }
  if (value.completeness !== "complete" && value.completeness !== "incomplete") {
    issues.push({
      code: "completeness",
      message: "completeness must be complete or incomplete",
      path: "completeness",
    });
  }
  if (value.stage !== undefined && (typeof value.stage !== "string" || value.stage.length === 0)) {
    issues.push({ code: "stage", message: "stage must be a non-empty string", path: "stage" });
  }
  if (value.diagnostic !== undefined && typeof value.diagnostic !== "string") {
    issues.push({ code: "diagnostic", message: "diagnostic must be a string", path: "diagnostic" });
  }
  if (value.truncated !== undefined && typeof value.truncated !== "boolean") {
    issues.push({ code: "truncated", message: "truncated must be a boolean", path: "truncated" });
  }
  if (
    value.exitCode !== undefined &&
    value.exitCode !== null &&
    (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)
  ) {
    issues.push({
      code: "exit-code",
      message: "exitCode must be null or a non-negative safe integer",
      path: "exitCode",
    });
  }
  if (value.signal !== undefined && value.signal !== null && typeof value.signal !== "string") {
    issues.push({ code: "signal", message: "signal must be null or a string", path: "signal" });
  }
  if (value.evidence !== undefined && !isVerificationEvidence(value.evidence)) {
    issues.push({
      code: "evidence",
      message: "evidence must contain canonical verification provenance",
      path: "evidence",
    });
  }
  if (value.status === "passed" && value.stage !== undefined) {
    issues.push({ code: "success-stage", message: "passed results must not identify a failing stage", path: "stage" });
  }
  if (value.status === "failed" && value.stage === undefined) {
    issues.push({
      code: "failure-stage",
      message: "failed results must identify a stage or unknown stage",
      path: "stage",
    });
  }
  if (value.status === "failed" && value.completeness === "incomplete" && value.stage !== "unknown") {
    issues.push({ code: "incomplete-stage", message: "incomplete failures must use the unknown stage", path: "stage" });
  }
  if (value.steps !== undefined && !isValidStepExecutions(value.steps)) {
    issues.push({ code: "steps", message: "steps must contain named executed or reused results", path: "steps" });
  }
  return issues.length === 0 ? validationSuccess() : validationFailure(issues);
}

export function normalizeVerifyResult(value: unknown): VerifyResult {
  const validation = validateVerifyResult(value);
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => `${issue.path ?? "value"}: ${issue.message}`).join("; "));
  }
  const input = value as VerifyResult;
  return {
    version: VERIFY_RESULT_SCHEMA_VERSION,
    status: input.status,
    completeness: input.completeness,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
    ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.evidence === undefined ? {} : { evidence: normalizeVerificationEvidence(input.evidence) }),
    ...(input.steps === undefined
      ? {}
      : {
          steps: input.steps.map((step) => ({
            ...step,
            ...(step.evidence === undefined ? {} : { evidence: normalizeVerificationEvidence(step.evidence) }),
          })),
        }),
  };
}

export function isVerifyResult(value: unknown): value is VerifyResult {
  return validateVerifyResult(value).valid;
}

function isValidStepExecutions(value: unknown): value is NonNullable<VerifyResult["steps"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (step) =>
        isRecord(step) &&
        typeof step.name === "string" &&
        step.name.length > 0 &&
        (step.execution === "executed" || step.execution === "reused") &&
        (step.evidence === undefined || isVerificationEvidence(step.evidence)),
    )
  );
}

export function isVerificationEvidence(value: unknown): value is VerificationEvidence {
  if (!isRecord(value) || value.version !== VERIFICATION_EVIDENCE_SCHEMA_VERSION) return false;
  if (typeof value.identity !== "string" || !isSha256Identity(value.identity)) return false;
  if (typeof value.producerIdentity !== "string" || !isSha256Identity(value.producerIdentity)) return false;
  if (typeof value.inputFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)) return false;
  if (typeof value.resultIdentity !== "string" || !isSha256Identity(value.resultIdentity)) return false;
  if (value.execution !== "executed" && value.execution !== "reused") return false;
  if (
    value.tier !== undefined &&
    value.tier !== "iteration" &&
    value.tier !== "focused" &&
    value.tier !== "authoritative"
  ) {
    return false;
  }
  const expectedIdentity = createHash("sha256")
    .update(
      stableJsonStringify({
        version: value.version,
        producerIdentity: value.producerIdentity,
        inputFingerprint: value.inputFingerprint,
        resultIdentity: value.resultIdentity,
      }),
    )
    .digest("hex");
  return value.identity === expectedIdentity;
}

function normalizeVerificationEvidence(evidence: VerificationEvidence): VerificationEvidence {
  return { ...evidence };
}

function isSha256Identity(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
