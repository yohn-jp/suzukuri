#!/usr/bin/env node
// Installs the packed tarball into an isolated directory and runs the
// installed bin through its real npm-generated launcher. `npm pack --dry-run`
// only lists file contents — it never proves install or execution actually
// work, which is the failure mode this guards against.
import { spawnSync } from "node:child_process";
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
    const [packInfo] = JSON.parse(packResult.stdout);
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
