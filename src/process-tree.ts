import { spawn as spawnProcess } from "node:child_process";
import { win32 } from "node:path";

export type ProcessTreeFailureReason =
  | "missing-pid"
  | "permission-denied"
  | "facility-unavailable"
  | "unconfirmed";

export type ProcessTreeAddressability = "safe" | "lost";

export type ProcessTreeStopResult =
  | { status: "stopped" }
  | {
      status: "failed";
      reason: ProcessTreeFailureReason;
      addressability: ProcessTreeAddressability;
    };

export interface ProcessTreeStopOptions {
  isRootExited(): boolean;
  onForce(): void;
}

export interface ProcessTreeController {
  stop(
    pid: number | undefined,
    options: ProcessTreeStopOptions,
  ): Promise<ProcessTreeStopResult>;
}

export interface ProcessUtilityChild {
  once(event: "error", listener: (error: Error) => void): ProcessUtilityChild;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ProcessUtilityChild;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

export interface ProcessUtilitySpawnOptions {
  detached: false;
  shell: false;
  stdio: "ignore";
  windowsHide: true;
}

export type ProcessUtilitySpawn = (
  executable: string,
  args: string[],
  options: ProcessUtilitySpawnOptions,
) => ProcessUtilityChild;

export interface ProcessTreeControllerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  gracePeriodMs?: number;
  pollIntervalMs?: number;
  utilityTimeoutMs?: number;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  spawn?: ProcessUtilitySpawn;
  delay?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_GRACE_PERIOD_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_UTILITY_TIMEOUT_MS = 5_000;

type SignalResult =
  | { status: "sent" }
  | { status: "absent" }
  | { status: "failed"; reason: ProcessTreeFailureReason };

type UtilityResult =
  | { status: "stopped" }
  | {
      status: "failed";
      reason: ProcessTreeFailureReason;
      timedOut: boolean;
    };

type RootProbeResult =
  | { status: "present" }
  | { status: "lost" }
  | { status: "failed"; reason: ProcessTreeFailureReason };

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function signalProcess(
  kill: NonNullable<ProcessTreeControllerOptions["kill"]>,
  pid: number,
  signal: NodeJS.Signals | 0,
): SignalResult {
  try {
    return kill(pid, signal)
      ? { status: "sent" }
      : { status: "failed", reason: "unconfirmed" };
  } catch (error) {
    const code = getErrorCode(error);

    if (code === "ESRCH") {
      return { status: "absent" };
    }
    if (code === "EPERM" || code === "EACCES") {
      return { status: "failed", reason: "permission-denied" };
    }
    return { status: "failed", reason: "unconfirmed" };
  }
}

function failure(
  reason: ProcessTreeFailureReason,
  options: ProcessTreeStopOptions,
): ProcessTreeStopResult {
  let rootExited = true;

  try {
    rootExited = options.isRootExited();
  } catch {}

  return {
    status: "failed",
    reason,
    addressability: rootExited ? "lost" : "safe",
  };
}

function rootExited(options: ProcessTreeStopOptions): boolean {
  try {
    return options.isRootExited();
  } catch {
    return true;
  }
}

function lostFailure(): ProcessTreeStopResult {
  return {
    status: "failed",
    reason: "unconfirmed",
    addressability: "lost",
  };
}

function positiveFiniteOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonnegativeFiniteOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

async function stopPosixProcessGroup(
  pid: number,
  options: ProcessTreeStopOptions,
  dependencies: {
    gracePeriodMs: number;
    pollIntervalMs: number;
    kill: NonNullable<ProcessTreeControllerOptions["kill"]>;
    delay: NonNullable<ProcessTreeControllerOptions["delay"]>;
  },
): Promise<ProcessTreeStopResult> {
  const groupPid = -pid;
  const initialProbe = signalProcess(dependencies.kill, groupPid, 0);

  if (initialProbe.status === "absent") {
    return { status: "stopped" };
  }
  if (initialProbe.status === "failed") {
    return failure(initialProbe.reason, options);
  }

  const gracefulSignal = signalProcess(dependencies.kill, groupPid, "SIGTERM");
  if (gracefulSignal.status === "absent") {
    return { status: "stopped" };
  }
  if (gracefulSignal.status === "failed") {
    return failure(gracefulSignal.reason, options);
  }

  const graceProbeCount = Math.max(
    1,
    Math.ceil(dependencies.gracePeriodMs / dependencies.pollIntervalMs),
  );

  for (let index = 0; index < graceProbeCount; index += 1) {
    const remainingGrace = Math.max(
      0,
      dependencies.gracePeriodMs - index * dependencies.pollIntervalMs,
    );

    try {
      await dependencies.delay(
        Math.min(dependencies.pollIntervalMs, remainingGrace),
      );
    } catch {
      return failure("unconfirmed", options);
    }

    const probe = signalProcess(dependencies.kill, groupPid, 0);
    if (probe.status === "absent") {
      return { status: "stopped" };
    }
    if (probe.status === "failed") {
      return failure(probe.reason, options);
    }
  }

  try {
    options.onForce();
  } catch {}

  const forceSignal = signalProcess(dependencies.kill, groupPid, "SIGKILL");

  try {
    await dependencies.delay(dependencies.pollIntervalMs);
  } catch {
    return failure(
      forceSignal.status === "failed" ? forceSignal.reason : "unconfirmed",
      options,
    );
  }

  const finalProbe = signalProcess(dependencies.kill, groupPid, 0);
  if (finalProbe.status === "absent") {
    return { status: "stopped" };
  }
  if (finalProbe.status === "failed") {
    return failure(finalProbe.reason, options);
  }

  return failure(
    forceSignal.status === "failed" ? forceSignal.reason : "unconfirmed",
    options,
  );
}

function resolveTaskkillPath(env: NodeJS.ProcessEnv): string | undefined {
  const configuredRoot = env.SystemRoot;
  if (typeof configuredRoot !== "string") {
    return undefined;
  }

  const root = configuredRoot.trim();
  if (!root || !win32.isAbsolute(root)) {
    return undefined;
  }

  return win32.join(root, "System32", "taskkill.exe");
}

function utilityFailureReason(error: unknown): ProcessTreeFailureReason {
  const code = getErrorCode(error);
  if (code === "EPERM" || code === "EACCES") {
    return "permission-denied";
  }
  if (code === "ENOENT") {
    return "facility-unavailable";
  }
  return "unconfirmed";
}

function runUtility(
  spawn: ProcessUtilitySpawn,
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<UtilityResult> {
  let child: ProcessUtilityChild;

  try {
    child = spawn(executable, args, {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({
      status: "failed",
      reason: utilityFailureReason(error),
      timedOut: false,
    });
  }

  return new Promise<UtilityResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: UtilityResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    try {
      child.once("error", (error) => {
        settle({
          status: "failed",
          reason: utilityFailureReason(error),
          timedOut: false,
        });
      });
      child.once("exit", (code) => {
        settle(
          code === 0
            ? { status: "stopped" }
            : {
                status: "failed",
                reason: "unconfirmed",
                timedOut: false,
              },
        );
      });
    } catch (error) {
      settle({
        status: "failed",
        reason: utilityFailureReason(error),
        timedOut: false,
      });
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

        resolve({ status: "failed", reason: "unconfirmed", timedOut: true });
      }, timeoutMs);
    }
  });
}

function probeWindowsRoot(
  pid: number,
  options: ProcessTreeStopOptions,
  kill: NonNullable<ProcessTreeControllerOptions["kill"]>,
): RootProbeResult {
  if (rootExited(options)) {
    return { status: "lost" };
  }

  const probe = signalProcess(kill, pid, 0);
  if (probe.status === "absent") {
    return { status: "lost" };
  }
  if (probe.status === "failed") {
    return probe;
  }
  return { status: "present" };
}

function rootProbeFailure(
  probe: Exclude<RootProbeResult, { status: "present" }>,
  options: ProcessTreeStopOptions,
): ProcessTreeStopResult {
  return probe.status === "lost" ? lostFailure() : failure(probe.reason, options);
}

async function stopWindowsProcessTree(
  pid: number,
  options: ProcessTreeStopOptions,
  dependencies: {
    env: NodeJS.ProcessEnv;
    gracePeriodMs: number;
    utilityTimeoutMs: number;
    kill: NonNullable<ProcessTreeControllerOptions["kill"]>;
    spawn: ProcessUtilitySpawn;
    delay: NonNullable<ProcessTreeControllerOptions["delay"]>;
  },
): Promise<ProcessTreeStopResult> {
  if (rootExited(options)) {
    return lostFailure();
  }

  const taskkillPath = resolveTaskkillPath(dependencies.env);
  if (!taskkillPath) {
    return failure("facility-unavailable", options);
  }

  const gracefulResult = await runUtility(dependencies.spawn, taskkillPath, [
    "/PID",
    String(pid),
    "/T",
  ], dependencies.utilityTimeoutMs);
  if (gracefulResult.status === "stopped") {
    return gracefulResult;
  }
  if (gracefulResult.reason === "facility-unavailable") {
    return failure(gracefulResult.reason, options);
  }

  let rootProbe = probeWindowsRoot(pid, options, dependencies.kill);
  if (rootProbe.status !== "present") {
    return rootProbeFailure(rootProbe, options);
  }

  if (!gracefulResult.timedOut) {
    try {
      await dependencies.delay(dependencies.gracePeriodMs);
    } catch {
      return failure("unconfirmed", options);
    }
  }

  rootProbe = probeWindowsRoot(pid, options, dependencies.kill);
  if (rootProbe.status !== "present") {
    return rootProbeFailure(rootProbe, options);
  }

  try {
    options.onForce();
  } catch {}

  if (rootExited(options)) {
    return lostFailure();
  }

  const forcedResult = await runUtility(dependencies.spawn, taskkillPath, [
    "/PID",
    String(pid),
    "/T",
    "/F",
  ], dependencies.utilityTimeoutMs);
  if (forcedResult.status === "stopped") {
    return forcedResult;
  }

  rootProbe = probeWindowsRoot(pid, options, dependencies.kill);
  if (rootProbe.status !== "present") {
    return rootProbeFailure(rootProbe, options);
  }

  return failure(forcedResult.reason, options);
}

export function createProcessTreeController(
  options?: ProcessTreeControllerOptions,
): ProcessTreeController {
  const platform = options?.platform ?? process.platform;
  const gracePeriodMs = nonnegativeFiniteOrDefault(
    options?.gracePeriodMs,
    DEFAULT_GRACE_PERIOD_MS,
  );
  const pollIntervalMs = positiveFiniteOrDefault(
    options?.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const utilityTimeoutMs = nonnegativeFiniteOrDefault(
    options?.utilityTimeoutMs,
    DEFAULT_UTILITY_TIMEOUT_MS,
  );
  const kill = options?.kill ?? process.kill;
  const env = options?.env ?? process.env;
  const spawn: ProcessUtilitySpawn =
    options?.spawn ??
    ((executable, args, spawnOptions) =>
      spawnProcess(executable, args, spawnOptions));
  const delay =
    options?.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return {
    async stop(pid, stopOptions): Promise<ProcessTreeStopResult> {
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        return {
          status: "failed",
          reason: "missing-pid",
          addressability: "lost",
        };
      }

      if (platform !== "win32") {
        return stopPosixProcessGroup(pid, stopOptions, {
          gracePeriodMs,
          pollIntervalMs,
          kill,
          delay,
        });
      }

      return stopWindowsProcessTree(pid, stopOptions, {
        env,
        gracePeriodMs,
        utilityTimeoutMs,
        kill,
        spawn,
        delay,
      });
    },
  };
}
