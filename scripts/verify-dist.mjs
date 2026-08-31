import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runChecked } from "./process.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function containsUntrackedPath(statusOutput) {
  return statusOutput
    .split(/\r?\n/)
    .some((statusLine) => statusLine.startsWith("?? "));
}

export function getVerifyDistCommands() {
  const compileArgs = ["run", "compile"];

  return [
    {
      tool: "git",
      args: ["diff", "--no-ext-diff", "--exit-code", "--", "dist"],
    },
    {
      tool: "git",
      args: [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "dist",
      ],
      captureOutput: true,
    },
    { tool: "bun", args: compileArgs },
    {
      tool: "git",
      args: ["diff", "--no-ext-diff", "--exit-code", "--", "dist"],
    },
    {
      tool: "git",
      args: [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "dist",
      ],
      captureOutput: true,
    },
  ];
}

export async function runVerifyDist(options = {}) {
  const copy = options.copy ?? cp;
  const makeTempDirectory =
    options.makeTempDirectory ??
    function () {
      return mkdtemp(join(tmpdir(), "opencode-startup-dist-"));
    };
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const run = options.run ?? runChecked;
  const remove = options.remove ?? rm;
  const commands = getVerifyDistCommands();
  const distPath = resolve(projectRoot, "dist");
  await run(commands[0].tool, commands[0].args, { cwd: projectRoot });
  const initialStatus = await run(commands[1].tool, commands[1].args, {
    captureOutput: true,
    cwd: projectRoot,
  });
  if (containsUntrackedPath(initialStatus.stdout)) {
    throw new Error("dist must be clean before verification");
  }

  const backupRoot = await makeTempDirectory();
  const backupDistPath = resolve(backupRoot, "dist");
  let backupReady = false;
  try {
    await copy(distPath, backupDistPath, {
      recursive: true,
      preserveTimestamps: true,
    });
    backupReady = true;
    await remove(distPath, { recursive: true, force: true });
    await run(commands[2].tool, commands[2].args, { cwd: projectRoot });
    await run(commands[3].tool, commands[3].args, { cwd: projectRoot });
    const finalStatus = await run(commands[4].tool, commands[4].args, {
      captureOutput: true,
      cwd: projectRoot,
    });
    if (containsUntrackedPath(finalStatus.stdout)) {
      throw new Error("dist contains untracked output");
    }
  } finally {
    try {
      if (backupReady) {
        await remove(distPath, { recursive: true, force: true });
        await copy(backupDistPath, distPath, {
          recursive: true,
          preserveTimestamps: true,
        });
      }
    } finally {
      await remove(backupRoot, { recursive: true, force: true });
    }
  }
}

const isEntryScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryScript) {
  runVerifyDist().catch((error) => {
    console.error(error instanceof Error ? error.message : "dist verification failed");
    process.exitCode = 1;
  });
}
