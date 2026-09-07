import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createDurableRegistry,
  resolveDurableStateRoot,
  type DurableLockHolder,
  type DurableRecord,
} from "../src/durable-registry.js";
import type {
  ProcessIdentityController,
  ProcessProbeResult,
} from "../src/process-identity.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "startup-registry-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function record(
  overrides: Partial<Omit<DurableRecord, "scope" | "projectRootHash">> = {},
): DurableRecord {
  return {
    scope: "global",
    identityHash: "a".repeat(64),
    pid: 4242,
    startToken: "linux1:boot-a:11",
    stopOnExit: false,
    creationOrder: 0,
    recordedAt: "2026-09-03T01:46:57.997Z",
    ...overrides,
  };
}

describe("state root resolution", () => {
  test("windows uses LOCALAPPDATA and ends at the host segment", () => {
    expect(
      resolveDurableStateRoot({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
        home: "C:\\Users\\dev",
        hostname: "build-box",
      }),
    ).toBe(
      "C:\\Users\\dev\\AppData\\Local\\opencode\\startup-commands\\build-box",
    );
  });

  test("linux prefers XDG_STATE_HOME and ends at the host segment", () => {
    expect(
      resolveDurableStateRoot({
        platform: "linux",
        env: { XDG_STATE_HOME: "/home/dev/.state" },
        home: "/home/dev",
        hostname: "build-box",
      }),
    ).toBe("/home/dev/.state/opencode/startup-commands/build-box");
  });

  test("linux falls back to ~/.local/state for a relative XDG_STATE_HOME", () => {
    expect(
      resolveDurableStateRoot({
        platform: "linux",
        env: { XDG_STATE_HOME: "relative/path" },
        home: "/home/dev",
        hostname: "build-box",
      }),
    ).toBe("/home/dev/.local/state/opencode/startup-commands/build-box");
  });

  test("macos uses Application Support and ends at the host segment", () => {
    expect(
      resolveDurableStateRoot({
        platform: "darwin",
        env: {},
        home: "/Users/dev",
        hostname: "build-box",
      }),
    ).toBe(
      "/Users/dev/Library/Application Support/OpenCode/startup-commands/build-box",
    );
  });

  test("two hosts sharing one home directory resolve to different roots", () => {
    const shared = { platform: "linux" as const, env: {}, home: "/home/dev" };

    expect(resolveDurableStateRoot({ ...shared, hostname: "host-a" })).not.toBe(
      resolveDurableStateRoot({ ...shared, hostname: "host-b" }),
    );
  });
});

function hostSegment(hostname: string): string {
  return basename(
    resolveDurableStateRoot({
      platform: "linux",
      env: {},
      home: "/home/dev",
      hostname,
    }),
  );
}

describe("host segment sanitization", () => {
  test("lowercases a mixed-case hostname", () => {
    expect(hostSegment("My-Host")).toBe("my-host");
  });

  test("replaces unsupported characters and trims the trailing separator", () => {
    expect(hostSegment("host name!")).toBe("host-name");
  });

  test("falls back to unknown-host for an empty hostname", () => {
    expect(hostSegment("")).toBe("unknown-host");
  });

  test("never yields a relative path segment", () => {
    expect(hostSegment("..")).toBe("unknown-host");
  });

  test("truncates an over-long hostname to 64 characters", () => {
    expect(hostSegment("a".repeat(65))).toBe("a".repeat(64));
  });

  test("truncation never leaves a trailing separator for the filesystem to strip", () => {
    expect(hostSegment(`${"a".repeat(63)}-${"b".repeat(10)}`)).toBe(
      "a".repeat(63),
    );
    expect(hostSegment(`${"a".repeat(63)}.${"b".repeat(10)}`)).toBe(
      "a".repeat(63),
    );
  });
});

describe("identity hashing", () => {
  test("produces a stable unkeyed sha256 hex digest", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });
    const signature = JSON.stringify(["/usr/bin/node", ["watch.js"]]);

    const first = registry.hashIdentity(signature);
    const second = registry.hashIdentity(signature);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("node");
  });

  test("different signatures produce different digests", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });

    expect(registry.hashIdentity(JSON.stringify(["a", []]))).not.toBe(
      registry.hashIdentity(JSON.stringify(["b", []])),
    );
  });

  test("identity and project-root namespaces cannot collide", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });

    expect(registry.hashIdentity("same")).not.toBe(
      registry.hashProjectRoot("same"),
    );
  });
});

describe("read and write", () => {
  test("a missing file reads as loaded and empty", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });

    expect(registry.read()).toEqual({ status: "loaded", records: [] });
  });

  test("written records round-trip", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });

    expect(registry.write([record()])).toBe(true);
    expect(registry.read()).toEqual({
      status: "loaded",
      records: [record()],
    });
  });

  test("the written file contains hashes, never the raw values they were derived from", () => {
    const root = temporaryRoot();
    const registry = createDurableRegistry({ root });

    const identityHash = registry.hashIdentity(
      JSON.stringify(["/usr/bin/node", ["watch.js"]]),
    );
    const projectRootHash = registry.hashProjectRoot("/home/dev/project");
    const projectRecord: DurableRecord = {
      scope: "project",
      identityHash,
      projectRootHash,
      pid: 4242,
      startToken: "linux1:boot-a:11",
      stopOnExit: false,
      creationOrder: 0,
      recordedAt: "2026-09-03T01:46:57.997Z",
    };

    registry.write([projectRecord]);
    const raw = readFileSync(join(root, "registry.json"), "utf8");

    expect(raw).toContain(identityHash);
    expect(raw).toContain(projectRootHash);
    expect(raw).not.toContain("node");
    expect(raw).not.toContain("watch.js");
    expect(raw).not.toContain("/home/dev/project");
    expect(JSON.parse(raw).schemaVersion).toBe(1);
  });

  test("write rejects a global-scoped record that also carries a project root hash", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });
    const invalid = {
      ...record(),
      projectRootHash: "b".repeat(64),
    } as DurableRecord;

    expect(registry.write([invalid])).toBe(false);
  });

  test("write rejects a project-scoped record with no project root hash", () => {
    const registry = createDurableRegistry({ root: temporaryRoot() });
    const invalid = { ...record(), scope: "project" } as DurableRecord;

    expect(registry.write([invalid])).toBe(false);
  });

  test("a rejected write leaves an existing registry.json byte-identical", () => {
    const root = temporaryRoot();
    const registry = createDurableRegistry({ root });
    expect(registry.write([record()])).toBe(true);
    const before = readFileSync(join(root, "registry.json"), "utf8");

    const invalid = { ...record(), scope: "project" } as DurableRecord;
    expect(registry.write([invalid])).toBe(false);

    expect(readFileSync(join(root, "registry.json"), "utf8")).toBe(before);
  });

  test("malformed json is set aside and read continues with an empty registry", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "registry.json"), "{ not json", "utf8");
    const registry = createDurableRegistry({
      root,
      clock: { nowMs: () => 1234, stat: () => ({ mtimeMs: 0 }) },
    });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
    expect(existsSync(join(root, "registry.json"))).toBe(false);
    expect(
      readFileSync(join(root, "registry.json.corrupt-1234"), "utf8"),
    ).toBe("{ not json");
  });

  test("a registry that cannot be set aside is still reported as malformed", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "registry.json"), "{ not json", "utf8");
    const occupiedTarget = join(root, "registry.json.corrupt-1234");
    mkdirSync(occupiedTarget);
    writeFileSync(join(occupiedTarget, "occupied"), "", "utf8");
    const registry = createDurableRegistry({
      root,
      clock: { nowMs: () => 1234, stat: () => ({ mtimeMs: 0 }) },
    });

    expect(registry.read()).toEqual({
      status: "unavailable",
      reason: "malformed",
    });
    expect(readFileSync(join(root, "registry.json"), "utf8")).toBe(
      "{ not json",
    );
  });

  test("an unknown schema version is reported and never set aside", () => {
    const root = temporaryRoot();
    const original = JSON.stringify({ schemaVersion: 99, records: [] });
    writeFileSync(join(root, "registry.json"), original, "utf8");
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "unavailable",
      reason: "unsupported-schema",
    });
    expect(readFileSync(join(root, "registry.json"), "utf8")).toBe(original);
    expect(
      readdirSync(root).some((entry) => entry.includes(".corrupt-")),
    ).toBe(false);
  });

  test("a registry that cannot be read is reported and never set aside", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "registry.json"));
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "unavailable",
      reason: "unreadable",
    });
    expect(existsSync(join(root, "registry.json"))).toBe(true);
    expect(
      readdirSync(root).some((entry) => entry.includes(".corrupt-")),
    ).toBe(false);
  });

  test("an invalid record quarantines the whole file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), pid: -1 }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("a project record without a root hash quarantines the file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), scope: "project" }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("a global-scope record carrying a project root hash quarantines the file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), projectRootHash: "b".repeat(64) }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("a non-integer pid quarantines the file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), pid: 1.5 }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("stopOnExit: true quarantines the file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), stopOnExit: true }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("a negative creationOrder quarantines the file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), creationOrder: -1 }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("an unknown scope value quarantines the file and reads empty", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: [{ ...record(), scope: "bogus" }],
      }),
      "utf8",
    );
    const registry = createDurableRegistry({ root });

    expect(registry.read()).toEqual({
      status: "loaded",
      records: [],
      quarantined: true,
    });
  });

  test("no temporary file is left behind after a write", () => {
    const root = temporaryRoot();
    const registry = createDurableRegistry({ root, random: () => "fixed" });

    registry.write([record()]);

    expect(() =>
      readFileSync(join(root, "registry.json.fixed.tmp"), "utf8"),
    ).toThrow();
  });

  test("the state directory and registry file get restrictive POSIX permissions", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = join(temporaryRoot(), "state");
    const registry = createDurableRegistry({ root });
    registry.write([record()]);

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "registry.json")).mode & 0o777).toBe(0o600);
  });
});

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
    async probe(pid, expectedToken): Promise<ProcessProbeResult> {
      probeCalls.push({ pid, expectedToken });
      return probeResult;
    },
  };
}

const HOLDER: DurableLockHolder = {
  pid: 4242,
  startToken: "linux1:boot-a:11",
};

describe("locking", () => {
  test("a root that exists as a plain file fails fast instead of polling the full timeout", async () => {
    const parent = temporaryRoot();
    const rootAsFile = join(parent, "not-a-directory");
    writeFileSync(rootAsFile, "oops", "utf8");

    const registry = createDurableRegistry({
      root: rootAsFile,
      lockTimeoutMs: 5000,
    });

    const start = Date.now();
    const result = await registry.acquireLock(HOLDER);
    const elapsedMs = Date.now() - start;

    expect(result).toEqual({ status: "unavailable" });
    expect(elapsedMs).toBeLessThan(1000);
  });

  test("an injected clock keeps nowMs and stat consistent through the registry surface", async () => {
    const root = temporaryRoot();

    const setupRegistry = createDurableRegistry({
      root,
      identity: recordingIdentity({ status: "gone" }),
    });
    expect((await setupRegistry.acquireLock(HOLDER)).status).toBe("acquired");

    mkdirSync(join(root, "registry.lock.reclaim"));

    let clock = 3_600_000;
    const registry = createDurableRegistry({
      root,
      identity: recordingIdentity({ status: "gone" }),
      lockTimeoutMs: 200,
      lockPollIntervalMs: 10,
      delay: async (ms) => {
        clock += ms;
      },
      clock: {
        nowMs: () => clock,
        stat: () => ({ mtimeMs: 0 }),
      },
    });

    const result = await registry.acquireLock({
      pid: 5555,
      startToken: "linux1:boot-a:55",
    });

    expect(result.status).toBe("acquired");
  });

  test("acquires a free lock and releases it", async () => {
    const registry = createDurableRegistry({
      root: temporaryRoot(),
      identity: recordingIdentity({ status: "gone" }),
    });

    const first = await registry.acquireLock(HOLDER);
    expect(first.status).toBe("acquired");

    if (first.status === "acquired") {
      first.handle.release();
    }

    const second = await registry.acquireLock(HOLDER);
    expect(second.status).toBe("acquired");
  });

  test("a live holder is never displaced", async () => {
    const registry = createDurableRegistry({
      root: temporaryRoot(),
      identity: recordingIdentity({ status: "alive" }),
      lockTimeoutMs: 60,
      lockPollIntervalMs: 10,
    });

    expect((await registry.acquireLock(HOLDER)).status).toBe("acquired");
    expect(
      await registry.acquireLock({
        pid: 9999,
        startToken: "linux1:boot-a:99",
      }),
    ).toEqual({ status: "unavailable" });
  });

  test("an unverifiable holder is never displaced", async () => {
    const registry = createDurableRegistry({
      root: temporaryRoot(),
      identity: recordingIdentity({
        status: "unknown",
        reason: "permission-denied",
      }),
      lockTimeoutMs: 60,
      lockPollIntervalMs: 10,
    });

    expect((await registry.acquireLock(HOLDER)).status).toBe("acquired");
    expect(
      await registry.acquireLock({
        pid: 9999,
        startToken: "linux1:boot-a:99",
      }),
    ).toEqual({ status: "unavailable" });
  });

  test("a provably dead holder's lock is reclaimed", async () => {
    const identity = recordingIdentity({ status: "gone" });
    const registry = createDurableRegistry({
      root: temporaryRoot(),
      identity,
      lockTimeoutMs: 200,
      lockPollIntervalMs: 10,
    });

    expect((await registry.acquireLock(HOLDER)).status).toBe("acquired");

    const reclaimed = await registry.acquireLock({
      pid: 9999,
      startToken: "linux1:boot-a:99",
    });
    expect(reclaimed.status).toBe("acquired");

    expect(identity.probeCalls).toContainEqual({
      pid: HOLDER.pid,
      expectedToken: HOLDER.startToken,
    });
    for (const call of identity.probeCalls) {
      expect(call.pid).not.toBe(9999);
    }
  });

  test("a zero wait budget refuses even a provably dead holder's lock", async () => {
    const registry = createDurableRegistry({
      root: temporaryRoot(),
      identity: recordingIdentity({ status: "gone" }),
      lockTimeoutMs: 0,
    });

    expect((await registry.acquireLock(HOLDER)).status).toBe("acquired");

    const result = await registry.acquireLock({
      pid: 9999,
      startToken: "linux1:boot-a:99",
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  test("a corrupt holder record is reclaimable, not permanent", async () => {
    const root = temporaryRoot();
    const registry = createDurableRegistry({
      root,
      identity: recordingIdentity({ status: "alive" }),
      lockTimeoutMs: 200,
      lockPollIntervalMs: 10,
    });

    expect((await registry.acquireLock(HOLDER)).status).toBe("acquired");
    writeFileSync(join(root, "registry.lock", "holder.json"), "{ bad", "utf8");

    const reclaimed = await registry.acquireLock(HOLDER);
    expect(reclaimed.status).toBe("acquired");
  });

  test("a holder file that parses but is not a plain object is reclaimable, not a rejection", async () => {
    for (const holderFileContent of ["null", "[]", "42"]) {
      const root = temporaryRoot();
      const registry = createDurableRegistry({
        root,
        identity: recordingIdentity({ status: "alive" }),
        lockTimeoutMs: 200,
        lockPollIntervalMs: 10,
      });

      expect((await registry.acquireLock(HOLDER)).status).toBe("acquired");
      writeFileSync(
        join(root, "registry.lock", "holder.json"),
        holderFileContent,
        "utf8",
      );

      const reclaimed = await registry.acquireLock(HOLDER);
      expect(reclaimed.status).toBe("acquired");
    }
  });

  test("releasing a lock the caller no longer owns does nothing", async () => {
    const registry = createDurableRegistry({
      root: temporaryRoot(),
      identity: recordingIdentity({ status: "alive" }),
      lockTimeoutMs: 60,
      lockPollIntervalMs: 10,
    });

    const first = await registry.acquireLock(HOLDER);
    if (first.status !== "acquired") {
      throw new Error("expected the first acquisition to succeed");
    }
    first.handle.release();

    const second = await registry.acquireLock(HOLDER);
    expect(second.status).toBe("acquired");

    first.handle.release();

    const third = await registry.acquireLock({
      pid: 5555,
      startToken: "linux1:boot-a:55",
    });
    expect(third).toEqual({ status: "unavailable" });
  });

  test("the lock holder file carries a generation, pid, and token", async () => {
    const root = temporaryRoot();
    const registry = createDurableRegistry({
      root,
      identity: recordingIdentity({ status: "gone" }),
    });

    await registry.acquireLock(HOLDER);
    const raw = readFileSync(join(root, "registry.lock", "holder.json"), "utf8");

    expect(JSON.parse(raw).pid).toBe(4242);
    expect(JSON.parse(raw).startToken).toBe("linux1:boot-a:11");
    expect(JSON.parse(raw).generation).toMatch(/^[0-9a-f]+$/);
  });
});
