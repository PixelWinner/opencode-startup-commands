import { spawn as spawnProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { getErrorCode } from "./error-code.js";

export type ProcessIdentityUnknownReason =
  | "permission-denied"
  | "facility-unavailable"
  | "malformed-output"
  | "timeout"
  | "unconfirmed";

export type ProcessDescribeResult =
  | { status: "described"; token: string }
  | { status: "gone" }
  | { status: "unknown"; reason: ProcessIdentityUnknownReason };

export type ProcessProbeResult =
  | { status: "alive" }
  | { status: "gone" }
  | { status: "unknown"; reason: ProcessIdentityUnknownReason };

export interface ProcessIdentityController {
  describe(pid: number | undefined): Promise<ProcessDescribeResult>;
  probe(
    pid: number | undefined,
    expectedToken: string,
  ): Promise<ProcessProbeResult>;
}

export interface ProcessQuerySpawnOptions {
  detached: false;
  shell: false;
  stdio: ["ignore", "pipe", "ignore"];
  windowsHide: true;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessQueryChild {
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  once(event: "error", listener: (error: Error) => void): ProcessQueryChild;
  once(
    event: "close",
    listener: (code: number | null) => void,
  ): ProcessQueryChild;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

export type ProcessQuerySpawn = (
  executable: string,
  args: string[],
  options: ProcessQuerySpawnOptions,
) => ProcessQueryChild;

export interface ProcessIdentityControllerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readTextFile?: (path: string) => string;
  spawn?: ProcessQuerySpawn;
  timeoutMs?: number;
}

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const DEFAULT_TIMEOUT_MS = 5_000;

function isValidPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function unknownReasonFor(error: unknown): ProcessIdentityUnknownReason {
  const code = getErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return "permission-denied";
  }
  return "unconfirmed";
}

function tokenTagFor(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "win1";
  }
  if (platform === "darwin") {
    return "mac1";
  }
  return "linux1";
}

function parseStartTicks(statContent: string): string | undefined {
  const tailStart = statContent.lastIndexOf(")");
  if (tailStart < 0) {
    return undefined;
  }
  const fields = statContent
    .slice(tailStart + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  return startTicks !== undefined && /^\d+$/.test(startTicks)
    ? startTicks
    : undefined;
}

function describeLinux(
  pid: number,
  readTextFile: (path: string) => string,
): ProcessDescribeResult {
  let bootId: string;
  try {
    bootId = readTextFile(LINUX_BOOT_ID_PATH).trim();
  } catch (error) {
    return { status: "unknown", reason: unknownReasonFor(error) };
  }
  if (!/^[0-9a-f-]{4,64}$/.test(bootId)) {
    return { status: "unknown", reason: "malformed-output" };
  }

  let statContent: string;
  try {
    statContent = readTextFile(`/proc/${pid}/stat`);
  } catch (error) {
    return getErrorCode(error) === "ENOENT"
      ? { status: "gone" }
      : { status: "unknown", reason: unknownReasonFor(error) };
  }

  const startTicks = parseStartTicks(statContent);
  return startTicks === undefined
    ? { status: "unknown", reason: "malformed-output" }
    : { status: "described", token: `linux1:${bootId}:${startTicks}` };
}

type QueryOutcome =
  | { status: "completed"; output: string; exitCode: number | null }
  | { status: "failed"; reason: ProcessIdentityUnknownReason };

const MAX_QUERY_OUTPUT_BYTES = 4096;

function runQuery(
  spawn: ProcessQuerySpawn,
  executable: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<QueryOutcome> {
  let child: ProcessQueryChild;
  try {
    child = spawn(executable, args, {
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      ...(env ? { env } : {}),
    });
  } catch (error) {
    return Promise.resolve({
      status: "failed",
      reason:
        getErrorCode(error) === "ENOENT"
          ? "facility-unavailable"
          : unknownReasonFor(error),
    });
  }

  return new Promise<QueryOutcome>((resolve) => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: QueryOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(outcome);
    };

    try {
      child.stdout?.on("data", (chunk) => {
        if (output.length < MAX_QUERY_OUTPUT_BYTES) {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          output += text.slice(0, MAX_QUERY_OUTPUT_BYTES - output.length);
        }
      });
      child.once("error", (error) => {
        settle({
          status: "failed",
          reason:
            getErrorCode(error) === "ENOENT"
              ? "facility-unavailable"
              : unknownReasonFor(error),
        });
      });
      child.once("close", (exitCode) => {
        settle({ status: "completed", output, exitCode });
      });
    } catch (error) {
      settle({ status: "failed", reason: unknownReasonFor(error) });
    }

    if (!settled) {
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {}
        try {
          child.unref();
        } catch {}
        resolve({ status: "failed", reason: "timeout" });
      }, timeoutMs);
    }
  });
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv): string | undefined {
  const configuredRoot = env.SystemRoot;
  if (typeof configuredRoot !== "string") {
    return undefined;
  }
  const root = configuredRoot.trim();
  if (!root || !win32.isAbsolute(root)) {
    return undefined;
  }
  return win32.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function describeWindows(
  pid: number,
  env: NodeJS.ProcessEnv,
  spawn: ProcessQuerySpawn,
  timeoutMs: number,
): Promise<ProcessDescribeResult> {
  const powerShellPath = resolvePowerShellPath(env);
  if (!powerShellPath) {
    return { status: "unknown", reason: "facility-unavailable" };
  }

  const outcome = await runQuery(
    spawn,
    powerShellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { try { $p.StartTime.ToUniversalTime().Ticks } catch { 'denied' } }`,
    ],
    timeoutMs,
  );

  if (outcome.status === "failed") {
    return { status: "unknown", reason: outcome.reason };
  }

  const value = outcome.output.trim();
  if (value === "absent") {
    return { status: "gone" };
  }
  if (value === "denied") {
    return { status: "unknown", reason: "permission-denied" };
  }
  return /^\d+$/.test(value)
    ? { status: "described", token: `win1:${value}` }
    : { status: "unknown", reason: "malformed-output" };
}

async function describeDarwin(
  pid: number,
  env: NodeJS.ProcessEnv,
  spawn: ProcessQuerySpawn,
  timeoutMs: number,
): Promise<ProcessDescribeResult> {
  const outcome = await runQuery(
    spawn,
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    timeoutMs,
    { ...env, TZ: "UTC", LC_ALL: "C" },
  );

  if (outcome.status === "failed") {
    return { status: "unknown", reason: outcome.reason };
  }

  const value = outcome.output.trim().replace(/\s+/g, " ");
  if (!value) {
    return { status: "gone" };
  }
  return { status: "described", token: `mac1:${value}` };
}

export function createProcessIdentityController(
  options: ProcessIdentityControllerOptions = {},
): ProcessIdentityController {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const readTextFile =
    options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const spawn: ProcessQuerySpawn =
    options.spawn ??
    ((executable, args, spawnOptions) =>
      spawnProcess(executable, args, spawnOptions));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller: ProcessIdentityController = {
    async describe(pid): Promise<ProcessDescribeResult> {
      if (!isValidPid(pid)) {
        return { status: "gone" };
      }
      if (platform === "linux") {
        return describeLinux(pid, readTextFile);
      }
      if (platform === "win32") {
        return describeWindows(pid, env, spawn, timeoutMs);
      }
      if (platform === "darwin") {
        return describeDarwin(pid, env, spawn, timeoutMs);
      }
      return { status: "unknown", reason: "facility-unavailable" };
    },

    async probe(pid, expectedToken): Promise<ProcessProbeResult> {
      if (!expectedToken.startsWith(`${tokenTagFor(platform)}:`)) {
        return { status: "gone" };
      }
      const described = await controller.describe(pid);
      if (described.status === "unknown") {
        return described;
      }
      if (described.status === "gone") {
        return { status: "gone" };
      }
      return described.token === expectedToken
        ? { status: "alive" }
        : { status: "gone" };
    },
  };

  return controller;
}
