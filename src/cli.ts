import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return command === undefined ? 1 : 0;
  }

  if (command === "--version") {
    console.log(getVersion());
    return 0;
  }

  console.error(`unknown command: ${command}`);
  printHelp();
  return 1;
}

function printHelp(): void {
  console.log(
    [
      "Usage: suzukuri <command> [options]",
      "",
      "Commands:",
      "  --help       Show this help",
      "  --version    Print the installed version",
    ].join("\n"),
  );
}

function getVersion(): string {
  return packageJson.version;
}
