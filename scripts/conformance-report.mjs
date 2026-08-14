#!/usr/bin/env node
// Runs the executable v0 conformance suite against the built package surface.
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(path.join(repoRoot, "dist", "conformance.js")).href;
const { runConformance } = await import(moduleUrl);
const report = runConformance();

console.log(
  `conformance: ${report.caseCount} cases, ${report.profileCount} profiles, ` +
    `size reduction ${(report.sizeReductionRate * 100).toFixed(1)}%, ` +
    `projection latency ${report.projectionLatencyMs.toFixed(3)}ms, ` +
    `automatic fallback rate ${(report.fallbackRate * 100).toFixed(1)}%`,
);
console.log(JSON.stringify(report, null, 2));

if (report.profileCount < 5 || report.fallbackRate !== 0 || report.caseCount < 17) {
  console.error("conformance report did not satisfy the v0 release thresholds");
  process.exitCode = 1;
}
