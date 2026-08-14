import type { ProjectionSource, ValidationIssue } from "../core.js";

export class ProducerInputError extends Error {
  readonly code = "INVALID_PRODUCER_INPUT";

  constructor(
    readonly producer: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ProducerInputError";
  }
}

export function sourceText(source: ProjectionSource, producer: string): string {
  try {
    const text =
      typeof source.content === "string"
        ? source.content
        : new TextDecoder("utf-8", { fatal: true }).decode(source.content);
    if (text.trim().length === 0) {
      throw new ProducerInputError(producer, "producer output is empty");
    }
    return text;
  } catch (error) {
    if (error instanceof ProducerInputError) {
      throw error;
    }
    throw new ProducerInputError(producer, "producer output is not valid UTF-8", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function validationIssue(error: unknown, producer: string): ValidationIssue {
  if (error instanceof ProducerInputError) {
    return {
      code: error.code,
      message: error.message,
      details: { producer, ...error.details },
    };
  }
  return {
    code: "INVALID_PRODUCER_INPUT",
    message: error instanceof Error ? error.message : String(error),
    details: { producer },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function stableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : undefined;
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
