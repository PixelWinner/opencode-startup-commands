import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { posix, win32 } from "node:path";
import {
  createDurableLock,
  type DurableLockHolder,
  type DurableLockResult,
} from "./durable-lock.js";
import type { ProcessIdentityController } from "./process-identity.js";
import { getErrorCode } from "./error-code.js";

export type {
  DurableLockHandle,
  DurableLockHolder,
  DurableLockResult,
} from "./durable-lock.js";

interface DurableRecordFields {
  identityHash: string;
  pid: number;
  startToken: string;
  stopOnExit: false;
  creationOrder: number;
  recordedAt: string;
}

export type DurableRecord =
  | (DurableRecordFields & { scope: "global"; projectRootHash?: never })
  | (DurableRecordFields & { scope: "project"; projectRootHash: string });

export type DurableUnavailableReason =
  | "unreadable"
  | "malformed"
  | "unsupported-schema";

export type DurableReadResult =
  | { status: "loaded"; records: DurableRecord[]; quarantined?: true }
  | { status: "unavailable"; reason: DurableUnavailableReason };

export interface DurableRegistry {
  hashIdentity(signature: string): string;
  hashProjectRoot(normalizedRoot: string): string;
  exists(): boolean;
  read(): DurableReadResult;
  write(records: readonly DurableRecord[]): boolean;
  acquireLock(holder: DurableLockHolder): Promise<DurableLockResult>;
}

export interface DurableRegistryOptions {
  root?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  hostname?: string;
  random?: () => string;
  identity?: ProcessIdentityController;
  delay?: (milliseconds: number) => Promise<void>;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  clock?: {
    nowMs: () => number;
    stat: (path: string) => { mtimeMs: number };
  };
}

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

function sanitizeHostSegment(rawHostname: string): string {
  const segment = rawHostname
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .slice(0, HOST_SEGMENT_MAX_LENGTH)
    .replace(/^[.-]+|[.-]+$/g, "");
  return segment || UNKNOWN_HOST_SEGMENT;
}

export function resolveDurableStateRoot(
  options: Pick<
    DurableRegistryOptions,
    "platform" | "env" | "home" | "hostname"
  > = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const host = sanitizeHostSegment(options.hostname ?? hostname());

  if (platform === "win32") {
    const configuredRoot = env.LOCALAPPDATA?.trim();
    const root =
      configuredRoot && win32.isAbsolute(configuredRoot)
        ? configuredRoot
        : win32.join(home, "AppData", "Local");
    return win32.join(root, "opencode", "startup-commands", host);
  }

  if (platform === "darwin") {
    return posix.join(
      home,
      "Library",
      "Application Support",
      "OpenCode",
      "startup-commands",
      host,
    );
  }

  const configuredRoot = env.XDG_STATE_HOME?.trim();
  const root =
    configuredRoot && posix.isAbsolute(configuredRoot)
      ? configuredRoot
      : posix.join(home, ".local", "state");
  return posix.join(root, "opencode", "startup-commands", host);
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isValidRecord(value: unknown): value is DurableRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;

  if (
    !isHexDigest(candidate.identityHash) ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.startToken !== "string" ||
    !candidate.startToken ||
    candidate.stopOnExit !== false ||
    typeof candidate.creationOrder !== "number" ||
    !Number.isSafeInteger(candidate.creationOrder) ||
    candidate.creationOrder < 0 ||
    typeof candidate.recordedAt !== "string"
  ) {
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

export function createDurableRegistry(
  options: DurableRegistryOptions = {},
): DurableRegistry {
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

  function quarantineCorruptRegistry(): DurableReadResult {
    try {
      renameSync(registryPath, `${registryPath}.corrupt-${nowMs()}`);
    } catch {
      return { status: "unavailable", reason: "malformed" };
    }
    return { status: "loaded", records: [], quarantined: true };
  }

  return {
    hashIdentity(signature: string): string {
      return createHash("sha256")
        .update(IDENTITY_HASH_PREFIX + signature, "utf8")
        .digest("hex");
    },

    hashProjectRoot(normalizedRoot: string): string {
      return createHash("sha256")
        .update(PROJECT_ROOT_HASH_PREFIX + normalizedRoot, "utf8")
        .digest("hex");
    },

    exists(): boolean {
      try {
        statSync(registryPath);
        return true;
      } catch {
        return false;
      }
    },

    read(): DurableReadResult {
      let content: string;
      try {
        content = readFileSync(registryPath, "utf8");
      } catch (error) {
        return getErrorCode(error) === "ENOENT"
          ? { status: "loaded", records: [] }
          : { status: "unavailable", reason: "unreadable" };
      }

      let document: unknown;
      try {
        document = JSON.parse(content) as unknown;
      } catch {
        return quarantineCorruptRegistry();
      }

      if (typeof document !== "object" || document === null) {
        return quarantineCorruptRegistry();
      }
      const shape = document as Record<string, unknown>;

      if (shape.schemaVersion !== SCHEMA_VERSION) {
        return typeof shape.schemaVersion === "number"
          ? { status: "unavailable", reason: "unsupported-schema" }
          : quarantineCorruptRegistry();
      }
      if (
        !Array.isArray(shape.records) ||
        !shape.records.every(isValidRecord)
      ) {
        return quarantineCorruptRegistry();
      }

      return { status: "loaded", records: [...shape.records] };
    },

    write(records: readonly DurableRecord[]): boolean {
      if (!records.every(isValidRecord)) {
        return false;
      }

      const temporaryPath = `${registryPath}.${random()}.tmp`;

      try {
        mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
        writeFileSync(
          temporaryPath,
          `${JSON.stringify(
            { schemaVersion: SCHEMA_VERSION, records },
            undefined,
            2,
          )}\n`,
          { encoding: "utf8", mode: FILE_MODE },
        );
        renameSync(temporaryPath, registryPath);
        return true;
      } catch {
        return false;
      } finally {
        try {
          rmSync(temporaryPath, { force: true });
        } catch {}
      }
    },

    async acquireLock(holder: DurableLockHolder): Promise<DurableLockResult> {
      try {
        mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE });
      } catch {
        return { status: "unavailable" };
      }
      return lock.acquireLock(holder);
    },
  };
}
