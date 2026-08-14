import { ProjectionCore, type ProjectionCoreOptions } from "./core.js";
import { typescriptDiagnosticsAdapter } from "./adapters/typescript-diagnostics.js";
import { vitestAdapter } from "./adapters/vitest.js";
import { diagnosticsContract } from "./diagnostics.js";
import { testResultContract } from "./test-result.js";
import { diagnosticsErrorsView, diagnosticsFilesView } from "./views/diagnostics.js";
import { testResultFailuresView, testResultSummaryView } from "./views/test-result.js";

export const builtinAdapters = Object.freeze([vitestAdapter, typescriptDiagnosticsAdapter]);
export const builtinSemanticContracts = Object.freeze([testResultContract, diagnosticsContract]);
export const builtinViews = Object.freeze([
  testResultSummaryView,
  testResultFailuresView,
  diagnosticsErrorsView,
  diagnosticsFilesView,
]);

/** Create a core with the v0 producer adapters and semantic views registered explicitly. */
export function createBuiltinProjectionCore(options: ProjectionCoreOptions = {}): ProjectionCore {
  return new ProjectionCore({
    ...options,
    adapters: [...builtinAdapters, ...(options.adapters ?? [])],
    semanticContracts: [...builtinSemanticContracts, ...(options.semanticContracts ?? options.contracts ?? [])],
    views: [...builtinViews, ...(options.views ?? [])],
  });
}

export const createBuiltinCore = createBuiltinProjectionCore;
