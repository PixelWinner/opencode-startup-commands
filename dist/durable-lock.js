import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { randomBytes } from "node:crypto";
import { getErrorCode } from "./error-code.js";
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 50;
const GUARD_STALE_AFTER_MS = 1_000;
const RECLAIM_GUARD_SUFFIX = ".reclaim";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export function createDurableLock(options) {
    const { lockDirectory, lockHolderPath } = options;
    const identity = options.identity;
    const delay = options.delay ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const lockPollIntervalMs = options.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
    const nowMs = options.nowMs ?? Date.now;
    const random = options.random ?? (() => randomBytes(8).toString("hex"));
    const mkdir = options.mkdir ??
        ((path) => mkdirSync(path, { mode: DIRECTORY_MODE }));
    const writeFile = options.writeFile ??
        ((path, content) => writeFileSync(path, content, { encoding: "utf8", mode: FILE_MODE }));
    const readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
    const rm = options.rm ??
        ((path) => rmSync(path, { recursive: true, force: true }));
    const stat = options.stat ?? ((path) => statSync(path));
    const reclaimGuardDirectory = `${lockDirectory}${RECLAIM_GUARD_SUFFIX}`;
    function removeLock() {
        try {
            rm(lockDirectory);
            return true;
        }
        catch {
            return false;
        }
    }
    function isLockDirectoryEmpty() {
        try {
            readFile(lockHolderPath);
            return false;
        }
        catch (error) {
            return getErrorCode(error) === "ENOENT";
        }
    }
    function classifyHolderFile() {
        let content;
        try {
            content = readFile(lockHolderPath);
        }
        catch (error) {
            return getErrorCode(error) === "ENOENT"
                ? { kind: "missing" }
                : { kind: "malformed", content: undefined };
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            return { kind: "malformed", content };
        }
        if (typeof parsed !== "object" || parsed === null) {
            return { kind: "malformed", content };
        }
        const candidate = parsed;
        const generation = candidate.generation;
        const pid = candidate.pid;
        const startToken = candidate.startToken;
        if (typeof generation !== "string" ||
            !generation ||
            typeof pid !== "number" ||
            !Number.isSafeInteger(pid) ||
            pid <= 0 ||
            typeof startToken !== "string" ||
            !startToken) {
            return { kind: "malformed", content };
        }
        return { kind: "valid", generation, pid, startToken };
    }
    function isGuardStale() {
        let mtimeMs;
        try {
            mtimeMs = stat(reclaimGuardDirectory).mtimeMs;
        }
        catch {
            return false;
        }
        return nowMs() - mtimeMs > GUARD_STALE_AFTER_MS;
    }
    function tryAcquireGuard() {
        try {
            mkdir(reclaimGuardDirectory);
            return true;
        }
        catch (error) {
            if (getErrorCode(error) !== "EEXIST") {
                return false;
            }
            if (!isGuardStale()) {
                return false;
            }
            try {
                rm(reclaimGuardDirectory);
                mkdir(reclaimGuardDirectory);
                return true;
            }
            catch {
                return false;
            }
        }
    }
    function releaseGuard() {
        try {
            rm(reclaimGuardDirectory);
        }
        catch { }
    }
    async function attemptGuardedRemoval(expectation) {
        if (!tryAcquireGuard()) {
            return false;
        }
        try {
            const fresh = classifyHolderFile();
            if (expectation.kind === "valid") {
                return fresh.kind === "valid" &&
                    fresh.generation === expectation.generation
                    ? removeLock()
                    : false;
            }
            if (expectation.kind === "malformed") {
                return fresh.kind === "malformed" &&
                    fresh.content === expectation.content
                    ? removeLock()
                    : false;
            }
            return fresh.kind === "missing" ? removeLock() : false;
        }
        finally {
            releaseGuard();
        }
    }
    function createHandle(generation) {
        return {
            release() {
                try {
                    const parsed = JSON.parse(readFile(lockHolderPath));
                    if (parsed.generation !== generation) {
                        return;
                    }
                }
                catch {
                    return;
                }
                removeLock();
            },
        };
    }
    return {
        async acquireLock(holder) {
            const generation = random();
            const deadline = nowMs() + lockTimeoutMs;
            let missingHolderStreak = 0;
            async function tryReclaim() {
                const classification = classifyHolderFile();
                if (classification.kind === "missing") {
                    missingHolderStreak += 1;
                    if (missingHolderStreak < 2) {
                        return false;
                    }
                }
                else {
                    missingHolderStreak = 0;
                }
                let reclaimed;
                if (classification.kind === "valid") {
                    if (!identity) {
                        return false;
                    }
                    let probed;
                    try {
                        probed = await identity.probe(classification.pid, classification.startToken);
                    }
                    catch {
                        return false;
                    }
                    if (probed.status !== "gone") {
                        return false;
                    }
                    reclaimed = await attemptGuardedRemoval({
                        kind: "valid",
                        generation: classification.generation,
                    });
                }
                else if (classification.kind === "malformed") {
                    reclaimed = await attemptGuardedRemoval({
                        kind: "malformed",
                        content: classification.content,
                    });
                }
                else {
                    reclaimed = await attemptGuardedRemoval({ kind: "missing" });
                }
                if (reclaimed) {
                    missingHolderStreak = 0;
                }
                return reclaimed;
            }
            for (;;) {
                let createdLockDirectory = false;
                try {
                    mkdir(lockDirectory);
                    createdLockDirectory = true;
                    writeFile(lockHolderPath, JSON.stringify({
                        generation,
                        pid: holder.pid,
                        startToken: holder.startToken,
                    }));
                    return { status: "acquired", handle: createHandle(generation) };
                }
                catch (error) {
                    if (getErrorCode(error) !== "EEXIST") {
                        if (createdLockDirectory && isLockDirectoryEmpty()) {
                            removeLock();
                        }
                        return { status: "unavailable" };
                    }
                }
                if (nowMs() >= deadline) {
                    return { status: "unavailable" };
                }
                if (await tryReclaim()) {
                    continue;
                }
                await delay(lockPollIntervalMs + Math.floor(Math.random() * lockPollIntervalMs));
            }
        },
    };
}
//# sourceMappingURL=durable-lock.js.map