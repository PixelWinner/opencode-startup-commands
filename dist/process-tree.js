import { spawn as spawnProcess } from "node:child_process";
import { win32 } from "node:path";
const DEFAULT_GRACE_PERIOD_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_UTILITY_TIMEOUT_MS = 5_000;
function getErrorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === "string" ? code : undefined;
}
function signalProcess(kill, pid, signal) {
    try {
        return kill(pid, signal)
            ? { status: "sent" }
            : { status: "failed", reason: "unconfirmed" };
    }
    catch (error) {
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
function failure(reason, options) {
    let rootExited = true;
    try {
        rootExited = options.isRootExited();
    }
    catch { }
    return {
        status: "failed",
        reason,
        addressability: rootExited ? "lost" : "safe",
    };
}
function rootExited(options) {
    try {
        return options.isRootExited();
    }
    catch {
        return true;
    }
}
function lostFailure() {
    return {
        status: "failed",
        reason: "unconfirmed",
        addressability: "lost",
    };
}
function positiveFiniteOrDefault(value, fallback) {
    return value !== undefined && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}
function nonnegativeFiniteOrDefault(value, fallback) {
    return value !== undefined && Number.isFinite(value) && value >= 0
        ? value
        : fallback;
}
async function stopPosixProcessGroup(pid, options, dependencies) {
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
    const graceProbeCount = Math.max(1, Math.ceil(dependencies.gracePeriodMs / dependencies.pollIntervalMs));
    for (let index = 0; index < graceProbeCount; index += 1) {
        const remainingGrace = Math.max(0, dependencies.gracePeriodMs - index * dependencies.pollIntervalMs);
        try {
            await dependencies.delay(Math.min(dependencies.pollIntervalMs, remainingGrace));
        }
        catch {
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
    }
    catch { }
    const forceSignal = signalProcess(dependencies.kill, groupPid, "SIGKILL");
    try {
        await dependencies.delay(dependencies.pollIntervalMs);
    }
    catch {
        return failure(forceSignal.status === "failed" ? forceSignal.reason : "unconfirmed", options);
    }
    const finalProbe = signalProcess(dependencies.kill, groupPid, 0);
    if (finalProbe.status === "absent") {
        return { status: "stopped" };
    }
    if (finalProbe.status === "failed") {
        return failure(finalProbe.reason, options);
    }
    return failure(forceSignal.status === "failed" ? forceSignal.reason : "unconfirmed", options);
}
function resolveTaskkillPath(env) {
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
function utilityFailureReason(error) {
    const code = getErrorCode(error);
    if (code === "EPERM" || code === "EACCES") {
        return "permission-denied";
    }
    if (code === "ENOENT") {
        return "facility-unavailable";
    }
    return "unconfirmed";
}
function runUtility(spawn, executable, args, timeoutMs) {
    let child;
    try {
        child = spawn(executable, args, {
            detached: false,
            shell: false,
            stdio: "ignore",
            windowsHide: true,
        });
    }
    catch (error) {
        return Promise.resolve({
            status: "failed",
            reason: utilityFailureReason(error),
            timedOut: false,
        });
    }
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const settle = (result) => {
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
                settle(code === 0
                    ? { status: "stopped" }
                    : {
                        status: "failed",
                        reason: "unconfirmed",
                        timedOut: false,
                    });
            });
        }
        catch (error) {
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
                }
                catch { }
                try {
                    child.unref();
                }
                catch { }
                resolve({ status: "failed", reason: "unconfirmed", timedOut: true });
            }, timeoutMs);
        }
    });
}
function probeWindowsRoot(pid, options, kill) {
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
function rootProbeFailure(probe, options) {
    return probe.status === "lost" ? lostFailure() : failure(probe.reason, options);
}
async function stopWindowsProcessTree(pid, options, dependencies) {
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
        }
        catch {
            return failure("unconfirmed", options);
        }
    }
    rootProbe = probeWindowsRoot(pid, options, dependencies.kill);
    if (rootProbe.status !== "present") {
        return rootProbeFailure(rootProbe, options);
    }
    try {
        options.onForce();
    }
    catch { }
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
export function createProcessTreeController(options) {
    const platform = options?.platform ?? process.platform;
    const gracePeriodMs = nonnegativeFiniteOrDefault(options?.gracePeriodMs, DEFAULT_GRACE_PERIOD_MS);
    const pollIntervalMs = positiveFiniteOrDefault(options?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    const utilityTimeoutMs = nonnegativeFiniteOrDefault(options?.utilityTimeoutMs, DEFAULT_UTILITY_TIMEOUT_MS);
    const kill = options?.kill ?? process.kill;
    const env = options?.env ?? process.env;
    const spawn = options?.spawn ??
        ((executable, args, spawnOptions) => spawnProcess(executable, args, spawnOptions));
    const delay = options?.delay ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    return {
        async stop(pid, stopOptions) {
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
//# sourceMappingURL=process-tree.js.map