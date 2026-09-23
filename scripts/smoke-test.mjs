#!/usr/bin/env node
// Installs the packed tarball into an isolated directory and runs the
// installed bin through its real npm-generated launcher. `npm pack --dry-run`
// only lists file contents — it never proves install or execution actually
// work, which is the failure mode this guards against.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...options });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function fail(message) {
  console.error(`smoke test failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

// npm <12 reports `pack --json` results as a one-element array; npm >=12
// reports an object keyed by package name instead.
function parsePackInfo(stdout, name) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed[name];
}

function packageBinTargets(packageDirectory) {
  const installedPackageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const bin = installedPackageJson.bin;
  if (typeof bin !== "object" || bin === null) fail("installed package.json has no bin map");
  return Object.entries(bin).map(([name, relativeTarget]) => ({
    name,
    target: path.join(packageDirectory, relativeTarget),
  }));
}

function parseArgs(argv) {
  const index = argv.indexOf("--tarball");
  return { tarball: index === -1 ? undefined : argv[index + 1] };
}

function initVerificationRepository(repositoryDirectory, inputs) {
  fs.mkdirSync(repositoryDirectory, { recursive: true });
  run("git", ["init", "--quiet"], { cwd: repositoryDirectory });
  run("git", ["config", "user.email", "suzukuri@example.invalid"], { cwd: repositoryDirectory });
  run("git", ["config", "user.name", "Suzukuri Smoke Test"], { cwd: repositoryDirectory });
  for (const [name, contents] of Object.entries(inputs)) {
    fs.writeFileSync(path.join(repositoryDirectory, name), contents);
  }
  run("git", ["add", ...Object.keys(inputs)], { cwd: repositoryDirectory });
  run("git", ["commit", "--quiet", "-m", "verification inputs"], { cwd: repositoryDirectory });
}

function installedVerify(launcher, repositoryDirectory, configPath, expectedExitCode, label) {
  const result = spawnSync(launcher, ["verify", "--config", configPath], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== expectedExitCode) {
    fail(`${label} exited ${result.status}, expected ${expectedExitCode}:\n${result.stdout}\n${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${label} did not return machine JSON: ${result.stdout}`);
  }
}

function assertVerificationSteps(result, status, expectedSteps, label) {
  assert.equal(result.status, status, `${label} status`);
  assert.equal(result.completeness, "complete", `${label} completeness`);
  assert.deepEqual(
    result.steps?.map(({ name, execution }) => ({ name, execution })),
    expectedSteps,
    `${label} step executions`,
  );
  for (const step of result.steps ?? []) {
    const evidence = step.evidence;
    assert.ok(evidence, `${label} ${step.name} evidence`);
    assert.equal(evidence.version, 1, `${label} ${step.name} evidence version`);
    assert.equal(evidence.execution, step.execution, `${label} ${step.name} evidence execution`);
    for (const field of ["identity", "producerIdentity", "inputFingerprint", "resultIdentity"]) {
      assert.match(evidence[field], /^[a-f0-9]{64}$/, `${label} ${step.name} evidence ${field}`);
    }
  }
  return result.steps;
}

function certifyInstalledVerificationReuse(launcher, fixtureDirectory) {
  const directory = path.join(fixtureDirectory, "verification-reuse");
  const repositoryDirectory = path.join(directory, "repository");
  const configPath = path.join(directory, "commands.json");
  const firstProducer = path.join(directory, "scoped-producer.mjs");
  const changedProducer = path.join(directory, "changed-scoped-producer.mjs");
  const stableProducer = path.join(directory, "stable-producer.mjs");
  const firstCounter = path.join(directory, "scoped.count");
  const stableCounter = path.join(directory, "stable.count");
  fs.mkdirSync(directory, { recursive: true });
  initVerificationRepository(repositoryDirectory, { "one.txt": "one\n", "two.txt": "two\n" });

  const countedProducer = (counter) =>
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");\n`;
  fs.writeFileSync(firstProducer, countedProducer(firstCounter));
  fs.writeFileSync(changedProducer, countedProducer(firstCounter));
  fs.writeFileSync(stableProducer, countedProducer(stableCounter));

  const writeConfig = (scopedProducer) =>
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        commands: {
          verify: {
            projection: "verification-result",
            reuse: "fingerprint",
            tier: "authoritative",
            steps: [
              { name: "scoped", argv: [process.execPath, scopedProducer], inputs: ["one.txt"], tier: "focused" },
              { name: "stable", argv: [process.execPath, stableProducer], inputs: ["two.txt"] },
            ],
          },
        },
      }),
    );
  writeConfig(firstProducer);

  const first = installedVerify(launcher, repositoryDirectory, configPath, 0, "first tiered verify");
  const firstSteps = assertVerificationSteps(
    first,
    "passed",
    [
      { name: "scoped", execution: "executed" },
      { name: "stable", execution: "executed" },
    ],
    "first tiered verify",
  );
  assert.equal(firstSteps[0].evidence.tier, "focused");
  assert.equal(firstSteps[1].evidence.tier, "authoritative");

  const unchanged = installedVerify(launcher, repositoryDirectory, configPath, 0, "unchanged tiered verify");
  const unchangedSteps = assertVerificationSteps(
    unchanged,
    "passed",
    [
      { name: "scoped", execution: "reused" },
      { name: "stable", execution: "reused" },
    ],
    "unchanged tiered verify",
  );
  assert.equal(firstSteps[0].evidence.identity, unchangedSteps[0].evidence.identity);
  assert.equal(firstSteps[1].evidence.identity, unchangedSteps[1].evidence.identity);
  assert.equal(fs.readFileSync(firstCounter, "utf8"), "x");
  assert.equal(fs.readFileSync(stableCounter, "utf8"), "x");

  fs.writeFileSync(path.join(repositoryDirectory, "one.txt"), "changed one\n");
  const changedInput = installedVerify(launcher, repositoryDirectory, configPath, 0, "scoped-input verify");
  const changedInputSteps = assertVerificationSteps(
    changedInput,
    "passed",
    [
      { name: "scoped", execution: "executed" },
      { name: "stable", execution: "reused" },
    ],
    "scoped-input verify",
  );
  assert.notEqual(firstSteps[0].evidence.identity, changedInputSteps[0].evidence.identity);
  assert.equal(firstSteps[1].evidence.identity, changedInputSteps[1].evidence.identity);

  writeConfig(changedProducer);
  const changedDefinition = installedVerify(launcher, repositoryDirectory, configPath, 0, "producer-definition verify");
  const changedDefinitionSteps = assertVerificationSteps(
    changedDefinition,
    "passed",
    [
      { name: "scoped", execution: "executed" },
      { name: "stable", execution: "reused" },
    ],
    "producer-definition verify",
  );
  assert.notEqual(changedInputSteps[0].evidence.identity, changedDefinitionSteps[0].evidence.identity);
  assert.equal(changedInputSteps[1].evidence.identity, changedDefinitionSteps[1].evidence.identity);
  assert.equal(fs.readFileSync(firstCounter, "utf8"), "xxx");
  assert.equal(fs.readFileSync(stableCounter, "utf8"), "x");
}

function certifyInstalledFailureReuse(launcher, fixtureDirectory) {
  const directory = path.join(fixtureDirectory, "verification-failure");
  const repositoryDirectory = path.join(directory, "repository");
  const configPath = path.join(directory, "commands.json");
  const passProducer = path.join(directory, "pass-producer.mjs");
  const failProducer = path.join(directory, "fail-producer.mjs");
  const laterProducer = path.join(directory, "later-producer.mjs");
  const passCounter = path.join(directory, "pass.count");
  const failCounter = path.join(directory, "fail.count");
  const laterMarker = path.join(directory, "later.marker");
  fs.mkdirSync(directory, { recursive: true });
  initVerificationRepository(repositoryDirectory, { "pass.txt": "pass\n", "fail.txt": "fail\n" });
  fs.writeFileSync(passProducer, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(passCounter)}, "x");\n`);
  fs.writeFileSync(
    failProducer,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(failCounter)}, "x"); process.exitCode = 1;\n`,
  );
  fs.writeFileSync(
    laterProducer,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(laterMarker)}, "ran");\n`,
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        verify: {
          projection: "verification-result",
          reuse: "fingerprint",
          tier: "authoritative",
          steps: [
            { name: "pass", argv: [process.execPath, passProducer], inputs: ["pass.txt"], tier: "focused" },
            { name: "failure", argv: [process.execPath, failProducer], inputs: ["fail.txt"] },
            { name: "after-failure", argv: [process.execPath, laterProducer], inputs: ["pass.txt"] },
          ],
        },
      },
    }),
  );

  const first = installedVerify(launcher, repositoryDirectory, configPath, 1, "first failing verify");
  const firstSteps = assertVerificationSteps(
    first,
    "failed",
    [
      { name: "pass", execution: "executed" },
      { name: "failure", execution: "executed" },
    ],
    "first failing verify",
  );
  assert.equal(first.stage, "failure");
  assert.equal(firstSteps[0].evidence.tier, "focused");
  assert.equal(firstSteps[1].evidence.tier, "authoritative");

  const unchanged = installedVerify(launcher, repositoryDirectory, configPath, 1, "unchanged failing verify");
  const unchangedSteps = assertVerificationSteps(
    unchanged,
    "failed",
    [
      { name: "pass", execution: "reused" },
      { name: "failure", execution: "reused" },
    ],
    "unchanged failing verify",
  );
  assert.equal(unchanged.stage, "failure");
  assert.equal(firstSteps[0].evidence.identity, unchangedSteps[0].evidence.identity);
  assert.equal(firstSteps[1].evidence.identity, unchangedSteps[1].evidence.identity);
  assert.equal(fs.readFileSync(passCounter, "utf8"), "x");
  assert.equal(fs.readFileSync(failCounter, "utf8"), "x");
  assert.equal(fs.existsSync(laterMarker), false, "a step after a cached failure must not run");
}

function main() {
  const { tarball } = parseArgs(process.argv.slice(2));
  let tarballPath;
  let ownsTarball;
  if (tarball !== undefined) {
    tarballPath = path.resolve(tarball);
    ownsTarball = false;
    if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
  } else {
    console.log("packing tarball...");
    // Verifies the dist produced by the build step, not a re-built one:
    // prepack's implicit rebuild is intentionally not relied on here.
    const packResult = run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: repoRoot });
    const packInfo = parsePackInfo(packResult.stdout, packageName);
    tarballPath = path.join(repoRoot, packInfo.filename);
    ownsTarball = true;
  }

  const installDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  try {
    fs.writeFileSync(
      path.join(installDirectory, "package.json"),
      JSON.stringify({ name: "smoke-consumer", private: true, version: "0.0.0" }, null, 2),
    );

    console.log("installing packed tarball into isolated directory...");
    run("npm", ["install", "--no-save", tarballPath], { cwd: installDirectory });

    const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
    const installedPackageDirectory = scope
      ? path.join(installDirectory, "node_modules", scope, packageName.split("/")[1])
      : path.join(installDirectory, "node_modules", packageName);
    if (!fs.existsSync(installedPackageDirectory)) fail(`${packageName} was not installed under node_modules`);

    const binTargets = packageBinTargets(installedPackageDirectory);
    if (binTargets.length === 0) fail("package.json defines no bin entries to smoke test");

    for (const { name, target } of binTargets) {
      if (!fs.existsSync(target)) fail(`bin target for "${name}" does not exist at ${target}`);
    }

    // Goes through node_modules/.bin so a broken npm-generated launcher is
    // caught too — checking bin target existence alone would miss that.
    const binDirectory = path.join(installDirectory, "node_modules", ".bin");

    const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-profile-smoke-"));
    try {
      const profilePath = path.join(profileDirectory, "profiles.json");
      const profileFixture = JSON.parse(fs.readFileSync(path.join(repoRoot, ".suzukuri", "profiles.json"), "utf8"));
      fs.writeFileSync(profilePath, JSON.stringify(profileFixture));
      const profileInputs = {
        "json-keys": '{"z": 1, "a": 2, "message": "重要"}',
        "json-value": '{"z": 1, "a": 2, "message": "重要"}',
        "text-lines": "first line\n重要な二行目\nthird line",
        "text-summary": "A deterministic summary with multibyte text: 日本語",
        "text-value": "packed profile input with 日本語",
      };
      const profileNames = Object.keys(profileInputs);

      for (const { name } of binTargets) {
        const launcher = path.join(binDirectory, name);
        if (!fs.existsSync(launcher)) fail(`npm did not generate a launcher for "${name}" at ${launcher}`);

        console.log(`running ${name} --help through its installed launcher...`);
        const helpResult = spawnSync(launcher, ["--help"], {
          cwd: installDirectory,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (helpResult.error) fail(`launcher "${name}" failed to start: ${helpResult.error.message}`);
        if (helpResult.status !== 0) fail(`launcher "${name}" --help exited ${helpResult.status}, expected 0`);

        console.log(`running ${name} --version through its installed launcher...`);
        const versionResult = spawnSync(launcher, ["--version"], {
          cwd: installDirectory,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (versionResult.error) fail(`launcher "${name}" failed to start: ${versionResult.error.message}`);
        if (versionResult.status !== 0) fail(`launcher "${name}" --version exited ${versionResult.status}, expected 0`);
        if (versionResult.stdout.trim().length === 0) fail(`launcher "${name}" --version printed nothing`);

        console.log(`running ${name} profile validate through its installed launcher...`);
        const validateResult = run(launcher, ["profile", "validate", "--profiles", profilePath], {
          cwd: installDirectory,
        });
        const validation = JSON.parse(validateResult.stdout);
        if (validation.valid !== true || validation.profileCount !== profileNames.length) {
          fail(`installed profile validation returned an unexpected result: ${validateResult.stdout}`);
        }

        for (const profileName of profileNames) {
          const inputPath = path.join(profileDirectory, `${profileName}.input`);
          fs.writeFileSync(inputPath, profileInputs[profileName]);
          console.log(`running ${name} profile ${profileName} through its installed launcher...`);
          const profileResult = run(
            launcher,
            ["profile", "run", profileName, "--profiles", profilePath, "--input", inputPath],
            { cwd: installDirectory },
          );
          const profileOutput = JSON.parse(profileResult.stdout);
          if (profileOutput.profile !== profileName || typeof profileOutput.output !== "string") {
            fail(`installed profile ${profileName} returned an unexpected result: ${profileResult.stdout}`);
          }
        }

        const inputPath = path.join(profileDirectory, "text-value.input");
        console.log(`running ${name} project through its installed launcher...`);
        const projectResult = run(
          launcher,
          [
            "project",
            "--adapter",
            "profile-text",
            "--view",
            "profile-text",
            "--budget",
            "1024",
            "--renderer",
            "json",
            "--input",
            inputPath,
          ],
          { cwd: installDirectory },
        );
        const projectOutput = JSON.parse(projectResult.stdout);
        if (typeof projectOutput.output !== "string" || !projectOutput.output.includes("packed profile input")) {
          fail(`installed project returned an unexpected result: ${projectResult.stdout}`);
        }

        const testProducer = path.join(profileDirectory, "test-producer.mjs");
        const testConfig = path.join(profileDirectory, "commands.json");
        fs.writeFileSync(
          testProducer,
          "console.log('TAP version 13\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1');\n",
        );
        fs.writeFileSync(
          testConfig,
          JSON.stringify({ schemaVersion: 1, commands: { test: [process.execPath, testProducer] } }),
        );
        console.log(`running ${name} test through its installed launcher...`);
        const testResult = run(launcher, ["test", "--config", testConfig], { cwd: installDirectory });
        const testOutput = JSON.parse(testResult.stdout);
        if (testOutput.status !== "passed" || testOutput.counts?.total !== 1) {
          fail(`installed test returned an unexpected result: ${testResult.stdout}`);
        }

        const diffDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "suzukuri-diff-smoke-"));
        try {
          run("git", ["init", "--quiet"], { cwd: diffDirectory });
          run("git", ["config", "user.email", "suzukuri@example.invalid"], { cwd: diffDirectory });
          run("git", ["config", "user.name", "Suzukuri Smoke Test"], { cwd: diffDirectory });
          fs.writeFileSync(path.join(diffDirectory, "tracked.ts"), "export const value = 1;\n");
          run("git", ["add", "tracked.ts"], { cwd: diffDirectory });
          run("git", ["commit", "--quiet", "-m", "initial"], { cwd: diffDirectory });
          fs.writeFileSync(path.join(diffDirectory, "tracked.ts"), "export const value = 2;\n");
          console.log(`running ${name} diff through its installed launcher...`);
          const diffResult = run(launcher, ["diff", "--view", "files", "--budget", "4096"], {
            cwd: diffDirectory,
          });
          const diffOutput = JSON.parse(diffResult.stdout);
          if (typeof diffOutput.output !== "string" || !diffOutput.output.includes("tracked.ts")) {
            fail(`installed diff returned an unexpected result: ${diffResult.stdout}`);
          }
        } finally {
          fs.rmSync(diffDirectory, { recursive: true, force: true });
        }

        const verifyProducer = path.join(profileDirectory, "verify-producer.mjs");
        const verifyConfig = path.join(profileDirectory, "verify-commands.json");
        fs.writeFileSync(
          verifyProducer,
          "if (process.argv.slice(2).join(' ') !== 'format:check lint typecheck test governance:actions test:package') process.exit(2);\n" +
            "console.log('aggregate verify output that must not escape the bounded semantic result'.repeat(10000));\n",
        );
        fs.writeFileSync(
          verifyConfig,
          JSON.stringify({
            schemaVersion: 1,
            commands: {
              verify: [
                process.execPath,
                verifyProducer,
                "format:check",
                "lint",
                "typecheck",
                "test",
                "governance:actions",
                "test:package",
              ],
            },
          }),
        );
        console.log(`running ${name} verify through its installed launcher...`);
        const verifyResult = run(launcher, ["verify", "--config", verifyConfig], { cwd: installDirectory });
        const verifyOutput = JSON.parse(verifyResult.stdout);
        if (verifyOutput.status !== "passed" || verifyOutput.completeness !== "complete") {
          fail(`installed verify returned an unexpected result: ${verifyResult.stdout}`);
        }

        console.log(`certifying installed ${name} tiered verification reuse...`);
        certifyInstalledVerificationReuse(launcher, profileDirectory);
        console.log(`certifying installed ${name} reusable verification failure...`);
        certifyInstalledFailureReuse(launcher, profileDirectory);

        const runProducer = path.join(profileDirectory, "run-producer.mjs");
        const runConfig = path.join(profileDirectory, "run-commands.json");
        fs.writeFileSync(runProducer, "console.log('built'); process.exitCode = 0;\n");
        fs.writeFileSync(
          runConfig,
          JSON.stringify({ schemaVersion: 1, commands: { build: { argv: [process.execPath, runProducer] } } }),
        );
        console.log(`running ${name} run build through its installed launcher...`);
        const runResult = run(launcher, ["run", "build", "--config", runConfig], { cwd: installDirectory });
        const runOutput = JSON.parse(runResult.stdout);
        if (runOutput.command !== "build" || runOutput.status !== "passed") {
          fail(`installed run returned an unexpected result: ${runResult.stdout}`);
        }

        const callerScript = path.join(installDirectory, "external-caller.mjs");
        fs.writeFileSync(
          callerScript,
          `import { createProfileCore } from ${JSON.stringify(packageName)};\n` +
            "const core = createProfileCore();\n" +
            'const result = core.project({ source: { identity: "external-caller:observation-1", content: "external source" }, adapter: "profile-text", view: "profile-text", budget: 1024, renderer: "json" });\n' +
            'if (result.provenance.source?.identity !== "external-caller:observation-1") process.exit(1);\n' +
            'if (result.components.adapter.id !== "profile-text" || result.components.view.id !== "profile-text") process.exit(1);\n' +
            'if ("task" in result || "policy" in result) process.exit(1);\n' +
            'console.log("external caller integration passed");\n',
        );
        run(process.execPath, [callerScript], { cwd: installDirectory, stdio: "inherit" });
      }
    } finally {
      fs.rmSync(profileDirectory, { recursive: true, force: true });
    }

    console.log("smoke test passed.");
  } finally {
    fs.rmSync(installDirectory, { recursive: true, force: true });
    if (ownsTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
