import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import type {
  ProcessIdentityController,
  ProcessProbeResult,
} from "./process-identity.js";
import { getErrorCode } from "./error-code.js";

export interface DurableLockHolder {
  pid: number;
  startToken: string;
}

export interface DurableLockHandle {
  release(): void;
}

export type DurableLockResult =
  | { status: "acquired"; handle: DurableLockHandle }
  | { status: "unavailable" };

export interface DurableLock {
  acquireLock(holder: DurableLockHolder): Promise<DurableLockResult>;
}

export interface DurableLockOptions {
  lockDirectory: string;
  lockHolderPath: string;
  identity?: ProcessIdentityController;
  delay?: (milliseconds: number) => Promise<void>;
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  nowMs?: () => number;
  random?: () => string;
  mkdir?: (path: string) => void;
  writeFile?: (path: string, content: string) => void;
  readFile?: (path: string) => string;
  rm?: (path: string) => void;
  stat?: (path: string) => { mtimeMs: number };
}

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 50;
const GUARD_STALE_AFTER_MS = 1_000;
const RECLAIM_GUARD_SUFFIX = ".reclaim";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

type HolderClassification =
  | { kind: "valid"; generation: string; pid: number; startToken: string }
  | { kind: "missing" }
  | { kind: "malformed"; content: string | undefined };

export function createDurableLock(options: DurableLockOptions): DurableLock {
  const { lockDirectory, lockHolderPath } = options;
  const identity = options.identity;
  const delay =
    options.delay ??
    ((milliseconds: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockPollIntervalMs =
    options.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const random = options.random ?? (() => randomBytes(8).toString("hex"));
  const mkdir =
    options.mkdir ??
    ((path: string) => mkdirSync(path, { mode: DIRECTORY_MODE }));
  const writeFile =
    options.writeFile ??
    ((path: string, content: string) =>
      writeFileSync(path, content, { encoding: "utf8", mode: FILE_MODE }));
  const readFile =
    options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const rm =
    options.rm ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));
  const stat = options.stat ?? ((path: string) => statSync(path));

  const reclaimGuardDirectory = `${lockDirectory}${RECLAIM_GUARD_SUFFIX}`;

  function removeLock(): boolean {
    try {
      rm(lockDirectory);
      return true;
    } catch {
      return false;
    }
  }

  function isLockDirectoryEmpty(): boolean {
    try {
      readFile(lockHolderPath);
      return false;
    } catch (error) {
      return getErrorCode(error) === "ENOENT";
    }
  }

  function classifyHolderFile(): HolderClassification {
    let content: string;
    try {
      content = readFile(lockHolderPath);
    } catch (error) {
      return getErrorCode(error) === "ENOENT"
        ? { kind: "missing" }
        : { kind: "malformed", content: undefined };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { kind: "malformed", content };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "malformed", content };
    }
    const candidate = parsed as {
      generation?: unknown;
      pid?: unknown;
      startToken?: unknown;
    };
    const generation = candidate.generation;
    const pid = candidate.pid;
    const startToken = candidate.startToken;
    if (
      typeof generation !== "string" ||
      !generation ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof startToken !== "string" ||
      !startToken
    ) {
      return { kind: "malformed", content };
    }

    return { kind: "valid", generation, pid, startToken };
  }

  function isGuardStale(): boolean {
    let mtimeMs: number;
    try {
      mtimeMs = stat(reclaimGuardDirectory).mtimeMs;
    } catch {
      return false;
    }
    return nowMs() - mtimeMs > GUARD_STALE_AFTER_MS;
  }

  function tryAcquireGuard(): boolean {
    try {
      mkdir(reclaimGuardDirectory);
      return true;
    } catch (error) {
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
      } catch {
        return false;
      }
    }
  }

  function releaseGuard(): void {
    try {
      rm(reclaimGuardDirectory);
    } catch {}
  }

  type ReclaimExpectation =
    | { kind: "valid"; generation: string }
    | { kind: "malformed"; content: string | undefined }
    | { kind: "missing" };

  async function attemptGuardedRemoval(
    expectation: ReclaimExpectation,
  ): Promise<boolean> {
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
    } finally {
      releaseGuard();
    }
  }

  function createHandle(generation: string): DurableLockHandle {
    return {
      release(): void {
        try {
          const parsed = JSON.parse(readFile(lockHolderPath)) as {
            generation?: unknown;
          };
          if (parsed.generation !== generation) {
            return;
          }
        } catch {
          return;
        }
        removeLock();
      },
    };
  }

  return {
    async acquireLock(holder: DurableLockHolder): Promise<DurableLockResult> {
      const generation = random();
      const deadline = nowMs() + lockTimeoutMs;
      let missingHolderStreak = 0;

      async function tryReclaim(): Promise<boolean> {
        const classification = classifyHolderFile();

        if (classification.kind === "missing") {
          missingHolderStreak += 1;
          if (missingHolderStreak < 2) {
            return false;
          }
        } else {
          missingHolderStreak = 0;
        }

        let reclaimed: boolean;
        if (classification.kind === "valid") {
          if (!identity) {
            return false;
          }
          let probed: ProcessProbeResult;
          try {
            probed = await identity.probe(
              classification.pid,
              classification.startToken,
            );
          } catch {
            return false;
          }
          if (probed.status !== "gone") {
            return false;
          }
          reclaimed = await attemptGuardedRemoval({
            kind: "valid",
            generation: classification.generation,
          });
        } else if (classification.kind === "malformed") {
          reclaimed = await attemptGuardedRemoval({
            kind: "malformed",
            content: classification.content,
          });
        } else {
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
          writeFile(
            lockHolderPath,
            JSON.stringify({
              generation,
              pid: holder.pid,
              startToken: holder.startToken,
            }),
          );
          return { status: "acquired", handle: createHandle(generation) };
        } catch (error) {
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

        await delay(
          lockPollIntervalMs + Math.floor(Math.random() * lockPollIntervalMs),
        );
      }
    },
  };
}
