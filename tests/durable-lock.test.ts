import { describe, expect, test } from "bun:test";
import {
  createDurableLock,
  type DurableLockHolder,
} from "../src/durable-lock.js";
import type {
  ProcessIdentityController,
  ProcessProbeResult,
} from "../src/process-identity.js";

interface FakeFileSystem {
  directories: Set<string>;
  files: Map<string, string>;
  mtimes: Map<string, number>;
  mkdir(path: string): void;
  writeFile(path: string, content: string): void;
  readFile(path: string): string;
  rm(path: string): void;
  stat(path: string): { mtimeMs: number };
}

function errnoException(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createFakeFileSystem(nowMs: () => number = () => 0): FakeFileSystem {
  const directories = new Set<string>();
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();

  return {
    directories,
    files,
    mtimes,
    mkdir(path: string): void {
      if (directories.has(path)) {
        throw errnoException("EEXIST");
      }
      directories.add(path);
      mtimes.set(path, nowMs());
    },
    writeFile(path: string, content: string): void {
      files.set(path, content);
    },
    readFile(path: string): string {
      const content = files.get(path);
      if (content === undefined) {
        throw errnoException("ENOENT");
      }
      return content;
    },
    rm(path: string): void {
      directories.delete(path);
      mtimes.delete(path);
      files.delete(path);
      const prefix = `${path}/`;
      for (const filePath of [...files.keys()]) {
        if (filePath.startsWith(prefix)) {
          files.delete(filePath);
        }
      }
    },
    stat(path: string): { mtimeMs: number } {
      const mtimeMs = mtimes.get(path);
      if (mtimeMs === undefined) {
        throw errnoException("ENOENT");
      }
      return { mtimeMs };
    },
  };
}

const LOCK_DIRECTORY = "/state/registry.lock";
const LOCK_HOLDER_PATH = `${LOCK_DIRECTORY}/holder.json`;
const RECLAIM_GUARD_DIRECTORY = `${LOCK_DIRECTORY}.reclaim`;

function recordingIdentity(
  probeResult: ProcessProbeResult,
): ProcessIdentityController & {
  probeCalls: Array<{ pid: number | undefined; expectedToken: string }>;
} {
  const probeCalls: Array<{ pid: number | undefined; expectedToken: string }> =
    [];
  return {
    probeCalls,
    async describe() {
      return { status: "described", token: "linux1:boot-a:11" };
    },
    async probe(pid, expectedToken) {
      probeCalls.push({ pid, expectedToken });
      return probeResult;
    },
  };
}

function seedHolder(
  fs: FakeFileSystem,
  fields: { generation: string; pid: number; startToken: string },
): void {
  fs.directories.add(LOCK_DIRECTORY);
  fs.files.set(LOCK_HOLDER_PATH, JSON.stringify(fields));
}

const CONTENDER: DurableLockHolder = { pid: 9999, startToken: "linux1:boot-a:99" };

describe("durable-lock basic acquire/release", () => {
  test("acquires a free lock and writes generation, pid, and token", async () => {
    const fs = createFakeFileSystem();
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock({
      pid: 4242,
      startToken: "linux1:boot-a:11",
    });

    expect(result.status).toBe("acquired");
    const raw = JSON.parse(fs.files.get(LOCK_HOLDER_PATH)!);
    expect(raw.pid).toBe(4242);
    expect(raw.startToken).toBe("linux1:boot-a:11");
    expect(raw.generation).toMatch(/^[0-9a-f]+$/);
  });

  test("release removes the lock only while the generation still matches", async () => {
    const fs = createFakeFileSystem();
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const first = await lock.acquireLock({
      pid: 1,
      startToken: "linux1:boot-a:1",
    });
    if (first.status !== "acquired") {
      throw new Error("expected the first acquisition to succeed");
    }
    first.handle.release();
    expect(fs.directories.has(LOCK_DIRECTORY)).toBe(false);

    const second = await lock.acquireLock({
      pid: 2,
      startToken: "linux1:boot-a:2",
    });
    expect(second.status).toBe("acquired");

    first.handle.release();
    expect(fs.directories.has(LOCK_DIRECTORY)).toBe(true);
    expect(fs.files.get(LOCK_HOLDER_PATH)).toContain('"pid":2');
  });
});

describe("two contenders racing one stale lock never both acquire", () => {
  test("only one of two racing contenders ends up holding the lock", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });

    let aHasAcquired = false;
    let lockA: ReturnType<typeof createDurableLock>;

    const identityForA: ProcessIdentityController = {
      async describe() {
        return { status: "described", token: "linux1:boot-a:1" };
      },
      async probe() {
        return { status: "gone" };
      },
    };
    let clockA = 0;
    lockA = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity: identityForA,
      random: () => "A-gen",
      nowMs: () => clockA,
      lockTimeoutMs: 500,
      lockPollIntervalMs: 1,
      delay: async (ms) => {
        clockA += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const identityForB: ProcessIdentityController = {
      async describe() {
        return { status: "described", token: "linux1:boot-a:1" };
      },
      async probe(pid) {
        if (pid === 1 && !aHasAcquired) {
          const resultA = await lockA.acquireLock({
            pid: 2,
            startToken: "linux1:boot-a:2",
          });
          aHasAcquired = resultA.status === "acquired";
        }
        return pid === 1 ? { status: "gone" } : { status: "alive" };
      },
    };
    let clockB = 0;
    const lockB = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity: identityForB,
      random: () => "B-gen",
      nowMs: () => clockB,
      lockTimeoutMs: 500,
      lockPollIntervalMs: 1,
      delay: async (ms) => {
        clockB += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const resultB = await lockB.acquireLock(CONTENDER);

    expect(aHasAcquired).toBe(true);
    if (resultB.status === "acquired") {
      throw new Error(
        "both A and B report acquired -- the double-hold the generation fence prevents",
      );
    }
    expect(resultB.status).toBe("unavailable");
    const finalRaw = JSON.parse(fs.files.get(LOCK_HOLDER_PATH) ?? "{}");
    expect(finalRaw.generation).toBe("A-gen");
  });
});

describe("a removal is fenced by the generation that was probed", () => {
  test("a removal is refused when the holder file no longer shows the generation that was probed", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });

    const identity: ProcessIdentityController = {
      async describe() {
        return { status: "described", token: "linux1:boot-a:1" };
      },
      async probe(pid) {
        if (pid === 1) {
          fs.files.set(
            LOCK_HOLDER_PATH,
            JSON.stringify({
              generation: "intervening-gen",
              pid: 2,
              startToken: "linux1:boot-a:2",
            }),
          );
          return { status: "gone" };
        }
        return { status: "alive" };
      },
    };

    let clock = 0;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity,
      nowMs: () => clock,
      lockTimeoutMs: 30,
      lockPollIntervalMs: 1,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    const finalRaw = JSON.parse(fs.files.get(LOCK_HOLDER_PATH)!);
    expect(finalRaw.generation).toBe("intervening-gen");
  });
});

describe("cleanup after a failed holder write is guarded by emptiness", () => {
  test("cleans up the directory it created when the write fails and nothing else has claimed it", async () => {
    const fs = createFakeFileSystem();
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      mkdir: fs.mkdir,
      writeFile: () => {
        throw errnoException("ENOSPC");
      },
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.directories.has(LOCK_DIRECTORY)).toBe(false);
  });

  test("leaves the directory alone when a legitimate successor already wrote its own holder file", async () => {
    const fs = createFakeFileSystem();
    const writeFile = (path: string, content: string): void => {
      if (path === LOCK_HOLDER_PATH) {
        fs.files.set(
          LOCK_HOLDER_PATH,
          JSON.stringify({
            generation: "successor-gen",
            pid: 5,
            startToken: "linux1:boot-a:5",
          }),
        );
        throw errnoException("EACCES");
      }
      fs.writeFile(path, content);
    };
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      mkdir: fs.mkdir,
      writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.directories.has(LOCK_DIRECTORY)).toBe(true);
    const raw = JSON.parse(fs.files.get(LOCK_HOLDER_PATH)!);
    expect(raw.generation).toBe("successor-gen");
  });
});

describe("a busy reclaim guard blocks reclaim without touching the live lock", () => {
  test("skips reclaim for that poll and eventually times out without touching the live lock", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });
    fs.directories.add(RECLAIM_GUARD_DIRECTORY);
    fs.mtimes.set(RECLAIM_GUARD_DIRECTORY, 1000);

    const identity = recordingIdentity({ status: "gone" });
    let clock = 1000;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity,
      nowMs: () => clock,
      lockTimeoutMs: 50,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.files.get(LOCK_HOLDER_PATH)).toContain("H-gen");
    expect(fs.directories.has(RECLAIM_GUARD_DIRECTORY)).toBe(true);
    expect(fs.mtimes.get(RECLAIM_GUARD_DIRECTORY)).toBe(1000);
    expect(identity.probeCalls.length).toBeGreaterThan(0);
  });
});

describe("the reclaim guard's own mtime decides staleness", () => {
  test("a guard directory with no file inside it and an old mtime is reclaimed, not treated as fresh forever", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });
    fs.directories.add(RECLAIM_GUARD_DIRECTORY);
    fs.mtimes.set(RECLAIM_GUARD_DIRECTORY, 0);
    expect(
      [...fs.files.keys()].some((path) =>
        path.startsWith(`${RECLAIM_GUARD_DIRECTORY}/`),
      ),
    ).toBe(false);

    let clock = 20_000;
    const identity = recordingIdentity({ status: "gone" });
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity,
      nowMs: () => clock,
      lockTimeoutMs: 200,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result.status).toBe("acquired");
    const raw = JSON.parse(fs.files.get(LOCK_HOLDER_PATH)!);
    expect(raw.pid).toBe(CONTENDER.pid);
    expect(identity.probeCalls).toContainEqual({
      pid: 1,
      expectedToken: "linux1:boot-a:1",
    });
  });

  test("a guard that is not yet stale is left alone", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });
    fs.directories.add(RECLAIM_GUARD_DIRECTORY);
    fs.mtimes.set(RECLAIM_GUARD_DIRECTORY, 19_900);

    let clock = 20_000;
    const identity = recordingIdentity({ status: "gone" });
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity,
      nowMs: () => clock,
      lockTimeoutMs: 30,
      lockPollIntervalMs: 5,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.mtimes.get(RECLAIM_GUARD_DIRECTORY)).toBe(19_900);
  });

  test("the reclaim guard is never stamped -- nothing is ever written inside it", async () => {
    let clock = 0;
    const fs = createFakeFileSystem(() => clock);
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });

    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity: recordingIdentity({ status: "gone" }),
      nowMs: () => clock,
      lockTimeoutMs: 200,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result.status).toBe("acquired");
    expect(
      [...fs.files.keys()].some((path) =>
        path.startsWith(`${RECLAIM_GUARD_DIRECTORY}/`),
      ),
    ).toBe(false);
  });
});

describe("a missing holder file gets a two-poll grace covering the mkdir-then-write window", () => {
  test("a holder file missing on only the first poll is not reclaimed", async () => {
    const fs = createFakeFileSystem();
    fs.directories.add(LOCK_DIRECTORY);

    let clock = 0;
    let pollCount = 0;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      nowMs: () => clock,
      lockTimeoutMs: 100,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        pollCount += 1;
        clock += ms;
        if (pollCount === 1) {
          fs.files.set(
            LOCK_HOLDER_PATH,
            JSON.stringify({
              generation: "late-writer-gen",
              pid: 1,
              startToken: "linux1:boot-a:1",
            }),
          );
        }
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.files.get(LOCK_HOLDER_PATH)).toContain("late-writer-gen");
  });

  test("a holder file still missing on the second consecutive poll is reclaimed", async () => {
    const fs = createFakeFileSystem();
    fs.directories.add(LOCK_DIRECTORY);

    let clock = 0;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      nowMs: () => clock,
      lockTimeoutMs: 200,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result.status).toBe("acquired");
    const raw = JSON.parse(fs.files.get(LOCK_HOLDER_PATH)!);
    expect(raw.pid).toBe(CONTENDER.pid);
  });
});

describe("malformed reclaim is fenced by content, not just kind", () => {
  test("refuses to remove when a successor's mkdir-then-write gap is observed on the guarded re-check", async () => {
    const fs = createFakeFileSystem();
    fs.directories.add(LOCK_DIRECTORY);
    fs.files.set(LOCK_HOLDER_PATH, "{ bad json");

    const mkdir = (path: string): void => {
      fs.mkdir(path);
      if (path === RECLAIM_GUARD_DIRECTORY) {
        fs.rm(LOCK_DIRECTORY);
        fs.mkdir(LOCK_DIRECTORY);
      }
    };

    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      lockTimeoutMs: 3,
      lockPollIntervalMs: 5,
      mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.directories.has(LOCK_DIRECTORY)).toBe(true);
    expect(fs.files.has(LOCK_HOLDER_PATH)).toBe(false);
  });
});

describe("the default wait budget outlasts the stop budget held under the lock", () => {
  test("a contender keeps waiting on a live holder past 15 seconds before giving up", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });

    let clock = 0;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity: recordingIdentity({ status: "alive" }),
      nowMs: () => clock,
      lockPollIntervalMs: 1_000,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(clock).toBeGreaterThanOrEqual(15_000);
    expect(clock).toBeLessThan(17_000);
  });
});

describe("a throwing probe never escapes reclaim", () => {
  test("a rejecting probe leaves the live lock in place and still resolves", async () => {
    const fs = createFakeFileSystem();
    seedHolder(fs, {
      generation: "H-gen",
      pid: 1,
      startToken: "linux1:boot-a:1",
    });

    let probeCalls = 0;
    const identity: ProcessIdentityController = {
      async describe() {
        return { status: "described", token: "linux1:boot-a:1" };
      },
      async probe() {
        probeCalls += 1;
        throw new Error("probe facility unavailable");
      },
    };

    let clock = 0;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      identity,
      nowMs: () => clock,
      lockTimeoutMs: 30,
      lockPollIntervalMs: 5,
      delay: async (ms) => {
        clock += ms;
      },
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(probeCalls).toBeGreaterThan(0);
    expect(fs.directories.has(LOCK_DIRECTORY)).toBe(true);
    expect(fs.files.get(LOCK_HOLDER_PATH)).toContain("H-gen");
  });
});

describe("the missing-holder grace streak resets after a successful reclaim", () => {
  test("a fresh incarnation created by someone else right after a reclaim gets its own two-poll grace", async () => {
    const fs = createFakeFileSystem();
    fs.directories.add(LOCK_DIRECTORY);

    let mkdirCallsOnLockDirectory = 0;
    const mkdir = (path: string): void => {
      if (path === LOCK_DIRECTORY) {
        mkdirCallsOnLockDirectory += 1;
        if (mkdirCallsOnLockDirectory === 3) {
          fs.directories.add(LOCK_DIRECTORY);
          throw errnoException("EEXIST");
        }
      }
      fs.mkdir(path);
    };

    let clock = 0;
    let pollCount = 0;
    const lock = createDurableLock({
      lockDirectory: LOCK_DIRECTORY,
      lockHolderPath: LOCK_HOLDER_PATH,
      nowMs: () => clock,
      lockTimeoutMs: 100,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        pollCount += 1;
        clock += ms;
        if (pollCount === 2) {
          fs.files.set(
            LOCK_HOLDER_PATH,
            JSON.stringify({
              generation: "v2-gen",
              pid: 2,
              startToken: "linux1:boot-a:2",
            }),
          );
        }
      },
      mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      stat: fs.stat,
    });

    const result = await lock.acquireLock(CONTENDER);

    expect(result).toEqual({ status: "unavailable" });
    expect(fs.files.get(LOCK_HOLDER_PATH)).toContain("v2-gen");
  });
});
