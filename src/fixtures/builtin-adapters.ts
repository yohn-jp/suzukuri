/** Representative producer fixtures kept as text so adapter behavior stays executable and reviewable. */
export const representativeVitestOutput = [
  " RUN  v3.2.4 /workspace",
  "",
  " ❯ src/math.test.ts (3 tests | 2 failed) 15ms",
  "   × math > adds numbers",
  "     → Expected: 3",
  "       Received: 4",
  "     ❯ src/math.test.ts:4:5",
  "     at node_modules/@vitest/runner/dist/index.js:100:10",
  "     at src/math.test.ts:4:5",
  "   × math > 日本語の比較",
  "     → 期待値が一致しませんでした。",
  "       複数行の診断メッセージ",
  " Test Files  1 failed (1)",
  "      Tests  2 failed | 1 passed (3)",
  "   Start at  12:00:00",
  "   Duration 15ms",
].join("\n");

export const representativeVitestJson = JSON.stringify({
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  testResults: [
    {
      name: "/workspace/src/math.test.ts",
      assertionResults: [
        {
          ancestorTitles: ["math"],
          fullName: "math > adds numbers",
          status: "failed",
          failureMessages: ["Expected: 3\nReceived: 4"],
          location: { line: 4, column: 5 },
          duration: 12,
          stack: "Error: mismatch\n    at src/math.test.ts:4:5",
        },
        { ancestorTitles: ["math"], fullName: "math > skipped", status: "pending" },
        { ancestorTitles: ["math"], fullName: "math > passes", status: "passed", duration: 3 },
      ],
    },
  ],
});

export const representativeTypeScriptDiagnostics = [
  "src/math.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  The expected type comes from property 'value' which is declared here.",
  "  Related information:",
  "  src/types.ts(1,1): message TS7006: The declaration is here.",
  "src/math.ts(8,1): warning TS6133: 'unused' is declared but its value is never read.",
  "  Suggestion: remove the unused declaration",
  "error TS2688: Cannot find type definition file for 'missing-package'.",
].join("\n");

export const representativeTypeScriptDiagnosticsJson = JSON.stringify({
  diagnostics: [
    {
      category: 1,
      code: 2322,
      fileName: "src/math.ts",
      start: { line: 2, character: 6 },
      messageText: "Type 'string' is not assignable to type 'number'.",
      relatedInformation: [
        {
          fileName: "src/types.ts",
          start: { line: 0, character: 0 },
          messageText: "The declaration is here.",
        },
      ],
    },
  ],
});
