/** Representative, caller-shaped inputs used by the v0 conformance suite. */

export const conformanceProfileInputs = Object.freeze({
  "json-keys": '{"z": 1, "a": 2, "message": "重要"}',
  "json-value": '{"z": 1, "a": 2, "message": "重要"}',
  "text-lines": "first line\n重要な二行目\nthird line",
  "text-summary": "A deterministic summary with multibyte text: 日本語",
  "text-value": "A deterministic text observation with multibyte text: 日本語",
});

export const conformanceGitDiff = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..e69de29",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,3 @@",
  "+export const answer = 42;",
  "+export const greeting = 'こんにちは';",
  "+",
].join("\n");

export const conformanceGitStatus = [
  "# branch.oid abc123",
  "# branch.head main",
  "1 .M N... 100644 100644 100644 abc123 def456 src/changed.ts",
  "? src/new file.ts",
].join("\n");

export const conformanceSource = [
  "export interface User {",
  "  name: string;",
  "}",
  "",
  "export function greet(user: User): string {",
  "  return `Hello ${user.name}`;",
  "}",
  "",
  "export const answer: number = 42;",
].join("\n");

export const conformanceGenericText = "  first line\r\nsecond line\rthird line\n";
