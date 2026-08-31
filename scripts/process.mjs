import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

const WINDOWS_EXECUTABLES = {
  bun: "bun.exe",
  git: "git.exe",
  node: "node.exe",
  npm: "node.exe",
};

function sanitizeProcessError(tool, code = "unknown") {
  return new Error(`${tool} exited with code ${code}`);
}

function resolveCanonicalNodeExecutable(dependencies) {
  const execPath = dependencies.execPath ?? process.execPath;
  const resolveRealpath = dependencies.realpathSync ?? realpathSync;

  try {
    const canonicalExecPath = resolveRealpath(execPath);
    if (
      win32.isAbsolute(canonicalExecPath) &&
      win32.basename(canonicalExecPath).toLowerCase() === "node.exe"
    ) {
      return canonicalExecPath;
    }
  } catch {}

  throw sanitizeProcessError("npm");
}

function isInsideWindowsRoot(rootPath, candidatePath) {
  const relativePath = win32.relative(
    rootPath.toLowerCase(),
    candidatePath.toLowerCase(),
  );

  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${win32.sep}`) &&
    !win32.isAbsolute(relativePath)
  );
}

export function resolveNpmCliPath(
  platform = process.platform,
  dependencies = {},
) {
  if (platform !== "win32") {
    return undefined;
  }

  const environment = dependencies.env ?? process.env;
  const pathExists = dependencies.existsSync ?? existsSync;
  const resolveRealpath = dependencies.realpathSync ?? realpathSync;
  const canonicalExecPath = resolveCanonicalNodeExecutable(dependencies);
  const trustedRoot = win32.dirname(canonicalExecPath);
  const candidates = [
    win32.join(
      trustedRoot,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];

  if (
    environment.npm_execpath &&
    win32.isAbsolute(environment.npm_execpath) &&
    win32.basename(environment.npm_execpath).toLowerCase() === "npm-cli.js"
  ) {
    candidates.push(environment.npm_execpath);
  }

  for (const candidate of candidates) {
    if (
      !win32.isAbsolute(candidate) ||
      win32.basename(candidate).toLowerCase() !== "npm-cli.js" ||
      !pathExists(candidate)
    ) {
      continue;
    }

    try {
      const resolvedCandidate = resolveRealpath(candidate);
      if (
        win32.isAbsolute(resolvedCandidate) &&
        win32.basename(resolvedCandidate).toLowerCase() === "npm-cli.js" &&
        isInsideWindowsRoot(trustedRoot, resolvedCandidate)
      ) {
        return resolvedCandidate;
      }
    } catch {
      continue;
    }
  }

  throw sanitizeProcessError("npm");
}

export function selectExecutable(tool, platform = process.platform) {
  if (typeof tool !== "string" || tool.length === 0) {
    throw new TypeError("Process tool must be a non-empty string");
  }

  if (platform === "win32" && Object.hasOwn(WINDOWS_EXECUTABLES, tool)) {
    return WINDOWS_EXECUTABLES[tool];
  }

  return tool;
}

export function createProcessInvocation(
  tool,
  args,
  options = {},
  platform = process.platform,
  dependencies = {},
) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("Process arguments must be an array of strings");
  }

  const { shell: _ignoredShell, ...safeOptions } = options;
  let executable = selectExecutable(tool, platform);
  let invocationArgs = [...args];

  if (tool === "npm" && platform === "win32") {
    executable = resolveCanonicalNodeExecutable(dependencies);
    invocationArgs = [
      resolveNpmCliPath(platform, dependencies),
      ...invocationArgs,
    ];
  }

  return {
    executable,
    args: invocationArgs,
    options: { ...safeOptions, shell: false },
  };
}

export function runChecked(tool, args, options = {}) {
  const { captureOutput = false, ...spawnOptions } = options;
  const invocation = createProcessInvocation(tool, args, {
    ...spawnOptions,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        invocation.executable,
        invocation.args,
        invocation.options,
      );
    } catch {
      reject(sanitizeProcessError(tool));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;

    if (captureOutput) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.once("error", () => {
      if (!settled) {
        settled = true;
        reject(sanitizeProcessError(tool));
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      if (code !== 0) {
        reject(sanitizeProcessError(tool, code ?? "unknown"));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
