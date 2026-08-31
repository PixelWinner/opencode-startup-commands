import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runChecked } from "./process.mjs";
import { runReleaseToolPreflight } from "./release-package.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function getReleaseCheckCommands() {
  return [
    { tool: "bun", args: ["test"] },
    { tool: "bun", args: ["run", "typecheck"] },
    { tool: "bun", args: ["run", "verify:dist"] },
    { tool: "bun", args: ["run", "package:check"] },
  ];
}

export async function runReleaseCheck(options = {}) {
  const run = options.run ?? runChecked;
  const preflight =
    options.preflight ??
    function () {
      return runReleaseToolPreflight({ cwd: PROJECT_ROOT });
    };

  await preflight();
  for (const command of getReleaseCheckCommands()) {
    await run(command.tool, command.args, { cwd: PROJECT_ROOT });
  }
}

const isEntryScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryScript) {
  runReleaseCheck().catch((error) => {
    console.error(error instanceof Error ? error.message : "Release check failed");
    process.exitCode = 1;
  });
}
