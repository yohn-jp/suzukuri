/** A one-based source position used by builtin semantic models. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/** A source range. End positions are optional when the producer reports only a start. */
export interface SourceRange {
  readonly start: SourcePosition;
  readonly end?: SourcePosition;
}

export function isSourcePosition(value: unknown): value is SourcePosition {
  if (!isRecord(value)) return false;
  const line = value.line;
  const column = value.column;
  return Number.isSafeInteger(line) && (line as number) >= 1 && Number.isSafeInteger(column) && (column as number) >= 1;
}

export function isSourceRange(value: unknown): value is SourceRange {
  return isRecord(value) && isSourcePosition(value.start) && (value.end === undefined || isSourcePosition(value.end));
}

export function compareSourceRanges(left?: SourceRange, right?: SourceRange): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return (
    left.start.line - right.start.line ||
    left.start.column - right.start.column ||
    (left.end?.line ?? 0) - (right.end?.line ?? 0) ||
    (left.end?.column ?? 0) - (right.end?.column ?? 0)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
