import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { homedir, hostname } from "node:os";
import { posix, win32 } from "node:path";
import { createDurableLock, } from "./durable-lock.js";
import { getErrorCode } from "./error-code.js";
const SCHEMA_VERSION = 1;
const REGISTRY_FILE_NAME = "registry.json";
const LOCK_DIRECTORY_NAME = "registry.lock";
const LOCK_HOLDER_FILE_NAME = "holder.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const IDENTITY_HASH_PREFIX = "identity:";
const PROJECT_ROOT_HASH_PREFIX = "project-root:";
const HOST_SEGMENT_MAX_LENGTH = 64;
const UNKNOWN_HOST_SEGMENT = "unknown-host";
function sanitizeHostSegment(rawHostname) {
    const segment = rawHostname
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, "-")
        .slice(0, HOST_SEGMENT_MAX_LENGTH)
        .replace(/^[.-]+|[.-]+$/g, "");
    return segment || UNKNOWN_HOST_SEGMENT;
}
export function resolveDurableStateRoot(options = {}) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const host = sanitizeHostSegment(options.hostname ?? hostname());
    if (platform === "win32") {
        const configuredRoot = env.LOCALAPPDATA?.trim();
        const root = configuredRoot && win32.isAbsolute(configuredRoot)
            ? configuredRoot
            : win32.join(home, "AppData", "Local");
        return win32.join(root, "opencode", "startup-commands", host);
    }
    if (platform === "darwin") {
        return posix.join(home, "Library", "Application Support", "OpenCode", "startup-commands", host);
    }
    const configuredRoot = env.XDG_STATE_HOME?.trim();
    const root = configuredRoot && posix.isAbsolute(configuredRoot)
        ? configuredRoot
        : posix.join(home, ".local", "state");
    return posix.join(root, "opencode", "startup-commands", host);
}
function isHexDigest(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isValidRecord(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value;
    if (!isHexDigest(candidate.identityHash) ||
        typeof candidate.pid !== "number" ||
        !Number.isSafeInteger(candidate.pid) ||
        candidate.pid <= 0 ||
        typeof candidate.startToken !== "string" ||
        !candidate.startToken ||
        candidate.stopOnExit !== false ||
        typeof candidate.creationOrder !== "number" ||
        !Number.isSafeInteger(candidate.creationOrder) ||
        candidate.creationOrder < 0 ||
        typeof candidate.recordedAt !== "string") {
        return false;
    }
    if (candidate.scope === "global") {
        return candidate.projectRootHash === undefined;
    }
    if (candidate.scope === "project") {
        return isHexDigest(candidate.projectRootHash);
    }
    return false;
}
export function createDurableRegistry(options = {}) {
    const root = options.root ?? resolveDurableStateRoot(options);
    const random = options.random ?? (() => randomBytes(8).toString("hex"));
    const nowMs = options.clock?.nowMs ?? Date.now;
    const platform = options.platform ?? process.platform;
    const joinPath = platform === "win32" ? win32.join : posix.join;
    const registryPath = joinPath(root, REGISTRY_FILE_NAME);
    const lockDirectory = joinPath(root, LOCK_DIRECTORY_NAME);
    const lockHolderPath = joinPath(lockDirectory, LOCK_HOLDER_FILE_NAME);
    const lock = createDurableLock({
        lockDirectory,
        lockHolderPath,
        identity: options.identity,
        delay: options.delay,
        lockTimeoutMs: options.lockTimeoutMs,
        lockPollIntervalMs: options.lockPollIntervalMs,
        nowMs: options.clock?.nowMs,
        stat: options.clock?.stat,
        random,
    });
    function quarantineCorruptRegistry() {
        try {
            renameSync(registryPath, `${registryPath}.corrupt-${nowMs()}`);
        }
        catch {
            return { status: "unavailable", reason: "malformed" };
        }
        return { status: "loaded", records: [], quarantined: true };
    }
    return {
        hashIdentity(signature) {
            return createHash("sha256")
                .update(IDENTITY_HASH_PREFIX + signature, "utf8")
                .digest("hex");
        },
        hashProjectRoot(normalizedRoot) {
            return createHash("sha256")
                .update(PROJECT_ROOT_HASH_PREFIX + normalizedRoot, "utf8")
                .digest("hex");
        },
        exists() {
            try {
                statSync(registryPath);
                return true;
            }
            catch {
                return false;
            }
        },
        read() {
            let content;
            try {
                content = readFileSync(registryPath, "utf8");
            }
            catch (error) {
                return getErrorCode(error) === "ENOENT"
                    ? { status: "loaded", records: [] }
                    : { status: "unavailable", reason: "unreadable" };
            }
            let document;
            try {
                document = JSON.parse(content);
            }
            catch {
                return quarantineCorruptRegistry();
            }
            if (typeof document !== "object" || document === null) {
                return quarantineCorruptRegistry();
            }
            const shape = document;
            if (shape.schemaVersion !== SCHEMA_VERSION) {
                return typeof shape.schemaVersion === "number"
                    ? { status: "unavailable", reason: "unsupported-schema" }
                    : quarantineCorruptRegistry();
            }
            if (!Array.isArray(shape.records) ||
                !shape.records.every(isValidRecord)) {
                return quarantineCorruptRegistry();
            }
            return { status: "loaded", records: [...shape.records] };
        },
        write(records) {
            if (!records.every(isValidRecord)) {
                return false;
            }
            const temporaryPath = `${registryPath}.${random()}.tmp`;
            try {
                mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
                writeFileSync(temporaryPath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }, undefined, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
                renameSync(temporaryPath, registryPath);
                return true;
            }
            catch {
                return false;
            }
            finally {
                try {
                    rmSync(temporaryPath, { force: true });
                }
                catch { }
            }
        },
        async acquireLock(holder) {
            try {
                mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
            }
            catch {
                return { status: "unavailable" };
            }
            return lock.acquireLock(holder);
        },
    };
}
//# sourceMappingURL=durable-registry.js.map