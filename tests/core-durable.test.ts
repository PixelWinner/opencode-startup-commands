import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import {
  createStartupState,
  getOrCreateProcessState,
  runStartupCommands,
  type SpawnFunction,
} from "../src/core.js";
import { createDurableRegistry } from "../src/durable-registry.js";
import type {
  DurableLockResult,
  DurableReadResult,
  DurableRecord,
  DurableRegistry,
} from "../src/durable-registry.js";
import {
  aliveIdentity,
  createLogger,
  FakeChild,
  FakeProcessTree,
  FakeRegistry,
  globalCommand,
  orphanRecord,
  persistedRecord,
  projectCommand,
  RoundTrippingRegistry,
  seedAdopted,
} from "./helpers/core-fixtures.js";

const DURABLE_SKIP = {
  onExistingProcess: "skip",
  stopOnExit: false,
} as const;

describe("adopted records", () => {
  const helperProcessKey = `global:${JSON.stringify(["helper", []])}`;

  test("an adopted record is accepted by the state validator", () => {
    const registry: Record<symbol, unknown> = {};
    const state = createStartupState();
    seedAdopted(state, helperProcessKey, 4242, "linux1:boot-a:11");

    registry[Symbol.for("opencode.startup-commands.state")] = state;

    expect(getOrCreateProcessState(registry)).toBe(state);
  });

  test("stopping an adopted record probes liveness instead of trusting a field", async () => {
    const probes: Array<[number | undefined, string]> = [];
    const processTree = new FakeProcessTree([{ status: "stopped" }]);
    const state = createStartupState();

    seedAdopted(state, helperProcessKey, 4242, "linux1:boot-a:11");

    const activation = await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "restart",
          stopOnExit: false,
        }),
      ],
      {
        spawn: () => new FakeChild(5555),
        state,
        processTree,
        logger: createLogger(),
        identity: {
          async describe() {
            return { status: "described", token: "linux1:boot-a:11" };
          },
          async probe(pid, expectedToken) {
            probes.push([pid, expectedToken]);
            return { status: "alive" };
          },
        },
      },
    );
    await activation.dispose();

    expect(probes[0]).toEqual([4242, "linux1:boot-a:11"]);
    expect(processTree.calls[0]?.options.isRootExited()).toBe(false);
  });

  test("an unverifiable adopted record reports rootExited so it is never signalled", async () => {
    const processTree = new FakeProcessTree([{ status: "stopped" }]);
    const state = createStartupState();
    seedAdopted(state, helperProcessKey, 4242, "linux1:boot-a:11");

    const activation = await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "restart",
          stopOnExit: false,
        }),
      ],
      {
        spawn: () => new FakeChild(5555),
        state,
        processTree,
        logger: createLogger(),
        identity: {
          async describe() {
            return { status: "unknown", reason: "permission-denied" };
          },
          async probe() {
            return { status: "unknown", reason: "permission-denied" };
          },
        },
      },
    );
    await activation.dispose();

    expect(processTree.calls[0]?.options.isRootExited()).toBe(true);
  });

  test("without an identity controller, an adopted record can never be verified", async () => {
    const processTree = new FakeProcessTree([{ status: "stopped" }]);
    const state = createStartupState();
    seedAdopted(state, helperProcessKey, 4242, "linux1:boot-a:11");

    const activation = await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "restart",
          stopOnExit: false,
        }),
      ],
      {
        spawn: () => new FakeChild(5555),
        state,
        processTree,
        logger: createLogger(),
      },
    );
    await activation.dispose();

    expect(processTree.calls[0]?.options.isRootExited()).toBe(true);
  });
});

describe("durable seeding", () => {
  test("skip adopts a live persisted record instead of spawning", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord()],
    });
    const logger = createLogger();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(0);
    expect(
      logger.events.some((event) => event.type === "durable.record-adopted"),
    ).toBe(true);
    expect(
      logger.events.some(
        (event) =>
          event.type === "command.skipped" &&
          event.reason === "already-started",
      ),
    ).toBe(true);
    expect(registry.writes.at(-1)).toHaveLength(1);
    expect(registry.releases).toBe(1);
  });

  test("start keeps the adopted record, appends one more, and persists both", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord()],
    });
    const processTree = new FakeProcessTree();
    const logger = createLogger();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "start",
          stopOnExit: false,
        }),
      ],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(1);
    expect(processTree.calls).toHaveLength(0);
    expect(
      logger.events.some((event) => event.type === "durable.record-adopted"),
    ).toBe(true);
    expect(
      (registry.writes.at(-1) ?? [])
        .map((record) => record.pid)
        .sort((left, right) => left - right),
    ).toEqual([4242, 9999]);
  });

  test("a gone record is dropped and the command spawns fresh", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord()],
    });
    const logger = createLogger();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:boot-a:77" };
          },
          async probe() {
            return { status: "gone" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(
      logger.events.some((event) => event.type === "durable.record-dropped"),
    ).toBe(true);
    expect(logger.events.some((event) => event.type === "command.spawned")).toBe(
      true,
    );
    expect(registry.writes.at(-1)?.[0]?.pid).toBe(9999);
    expect(registry.writes.at(-1)?.[0]?.startToken).toBe("linux1:boot-a:77");
  });

  test("an unverifiable record fails closed without spawning or stopping", async () => {
    const processTree = new FakeProcessTree();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord()],
    });
    const logger = createLogger();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:e2e:1" };
          },
          async probe() {
            return { status: "unknown", reason: "permission-denied" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(0);
    expect(processTree.calls).toHaveLength(0);
    expect(
      logger.events.some(
        (event) => event.type === "durable.record-unverifiable",
      ),
    ).toBe(true);
    expect(registry.writes.at(-1)).toHaveLength(1);
  });

  test("this process's own identity cannot be described blocks durable commands without ever acquiring the lock", async () => {
    const registry = new FakeRegistry();
    const logger = createLogger();
    const processTree = new FakeProcessTree();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: {
          async describe() {
            return { status: "unknown", reason: "permission-denied" };
          },
          async probe() {
            return { status: "alive" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(0);
    expect(processTree.calls).toHaveLength(0);
    expect(registry.writes).toHaveLength(0);
    expect(registry.acquireCalls).toBe(0);
    expect(
      logger.events.some(
        (event) =>
          event.type === "durable.unavailable" &&
          event.cause === "identity-unavailable",
      ),
    ).toBe(true);
  });

  test("a stopOnExit true command is never persisted", async () => {
    const registry = new FakeRegistry();

    const activation = await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(registry.writes.at(-1)).toEqual([]);
  });

  test("an unavailable lock blocks durable commands and keeps direct ones", async () => {
    const registry = new FakeRegistry({ status: "loaded", records: [] }, false);
    const logger = createLogger();
    const spawned: string[] = [];

    const activation = await runStartupCommands(
      [
        globalCommand("durable", [], "Durable", 0, DURABLE_SKIP),
        globalCommand("direct", [], "Direct", 1, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      {
        spawn: (command) => {
          spawned.push(command);
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawned).toEqual(["direct"]);
    expect(
      logger.events.some(
        (event) =>
          event.type === "durable.unavailable" &&
          event.cause === "lock-unavailable",
      ),
    ).toBe(true);
    expect(registry.writes).toHaveLength(0);
  });

  test("a blocked durable command is skipped as durable-unavailable, never as already-started", async () => {
    const registry = new FakeRegistry({ status: "loaded", records: [] }, false);
    const logger = createLogger();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(
      logger.events
        .filter((event) => event.type === "command.skipped")
        .map((event) => event.reason),
    ).toEqual(["durable-unavailable"]);
  });

  test("a malformed registry blocks durable commands and writes nothing", async () => {
    const registry = new FakeRegistry({
      status: "unavailable",
      reason: "malformed",
    });
    const logger = createLogger();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(0);
    expect(registry.writes).toHaveLength(0);
    expect(
      logger.events.some(
        (event) =>
          event.type === "durable.unavailable" &&
          event.cause === "registry-malformed",
      ),
    ).toBe(true);
  });

  test("a quarantined registry is reported once and durable commands keep running", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [],
      quarantined: true,
    });
    const logger = createLogger();
    const spawned: string[] = [];

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: (command) => {
          spawned.push(command);
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawned).toEqual(["helper"]);
    expect(
      logger.events.filter(
        (event) => event.type === "durable.registry-quarantined",
      ),
    ).toHaveLength(1);
    expect(
      logger.events.some((event) => event.type === "durable.unavailable"),
    ).toBe(false);
    expect(registry.writes.at(-1)).toHaveLength(1);
  });

  test("records for another project root survive the rewrite untouched", async () => {
    const foreign: DurableRecord = {
      scope: "project",
      identityHash: "f".repeat(64),
      projectRootHash: "e".repeat(64),
      pid: 1111,
      startToken: "linux1:boot-a:1",
      stopOnExit: false,
      creationOrder: 0,
      recordedAt: "2026-09-03T01:00:00.000Z",
    };
    const registry = new FakeRegistry({
      status: "loaded",
      records: [foreign],
    });
    let probeCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:boot-a:11" };
          },
          async probe() {
            probeCalls += 1;
            return { status: "alive" };
          },
        },
      },
      { authoritative: true, projectRootHash: "d".repeat(64) },
    );
    await activation.dispose();

    expect(probeCalls).toBe(0);
    expect(registry.writes.at(-1)).toContainEqual(foreign);
  });

  test("multiple foreign records for one foreign identity are concatenated verbatim, not reordered", async () => {
    const foreignHigh: DurableRecord = {
      scope: "project",
      identityHash: "f".repeat(64),
      projectRootHash: "e".repeat(64),
      pid: 1111,
      startToken: "linux1:boot-a:1",
      stopOnExit: false,
      creationOrder: 5,
      recordedAt: "2026-09-03T01:00:00.000Z",
    };
    const foreignLow: DurableRecord = {
      scope: "project",
      identityHash: "f".repeat(64),
      projectRootHash: "e".repeat(64),
      pid: 2222,
      startToken: "linux1:boot-a:2",
      stopOnExit: false,
      creationOrder: 2,
      recordedAt: "2026-09-03T02:00:00.000Z",
    };
    const registry = new FakeRegistry({
      status: "loaded",
      records: [foreignHigh, foreignLow],
    });

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "d".repeat(64) },
    );
    await activation.dispose();

    const written = registry.writes.at(-1) ?? [];
    const foreignPids = written
      .filter((record) => record.pid === 1111 || record.pid === 2222)
      .map((record) => record.pid);
    expect(foreignPids).toEqual([1111, 2222]);
  });

  test("without a registry the behavior is unchanged", async () => {
    const logger = createLogger();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
      },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(1);
    expect(logger.events.some((event) => event.type.startsWith("durable."))).toBe(
      false,
    );
  });

  test("a dropped record's creationOrder ordinal is never reused", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord({ creationOrder: 5 })],
    });

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:boot-a:77" };
          },
          async probe() {
            return { status: "gone" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    const written = registry.writes.at(-1)?.[0];
    expect(written?.pid).toBe(9999);
    expect(written?.creationOrder).toBe(6);
  });

  test("a write failure logs registry-unwritable instead of failing silently", async () => {
    class UnwritableRegistry implements DurableRegistry {
      public releases = 0;
      public hashIdentity(signature: string): string {
        return `identity-${signature}`;
      }
      public hashProjectRoot(normalizedRoot: string): string {
        return `root-${normalizedRoot}`;
      }
      public exists(): boolean {
        return true;
      }
      public read(): DurableReadResult {
        return { status: "loaded", records: [] };
      }
      public write(): boolean {
        return false;
      }
      public async acquireLock(): Promise<DurableLockResult> {
        return {
          status: "acquired",
          handle: {
            release: () => {
              this.releases += 1;
            },
          },
        };
      }
    }
    const registry = new UnwritableRegistry();
    const logger = createLogger();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(registry.releases).toBe(1);
    expect(
      logger.events.some(
        (event) =>
          event.type === "durable.unavailable" &&
          event.cause === "registry-unwritable",
      ),
    ).toBe(true);
  });

  test("a throwing registry read still releases the lock instead of leaking it", async () => {
    class ThrowingReadRegistry implements DurableRegistry {
      public releases = 0;
      public hashIdentity(signature: string): string {
        return `identity-${signature}`;
      }
      public hashProjectRoot(normalizedRoot: string): string {
        return `root-${normalizedRoot}`;
      }
      public exists(): boolean {
        return true;
      }
      public read(): DurableReadResult {
        throw new Error("simulated read failure");
      }
      public write(): boolean {
        return true;
      }
      public async acquireLock(): Promise<DurableLockResult> {
        return {
          status: "acquired",
          handle: {
            release: () => {
              this.releases += 1;
            },
          },
        };
      }
    }
    const registry = new ThrowingReadRegistry();

    await expect(
      runStartupCommands(
        [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
        {
          spawn: () => new FakeChild(9999),
          state: createStartupState(),
          processTree: new FakeProcessTree(),
          logger: createLogger(),
          registry,
          identity: aliveIdentity(),
        },
        { authoritative: true, projectRootHash: "unused-project-root-hash" },
      ),
    ).rejects.toThrow("simulated read failure");

    expect(registry.releases).toBe(1);
  });

  test("a record whose pid could not be validated is logged, not dropped silently", async () => {
    const registry = new FakeRegistry();
    const logger = createLogger();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(undefined),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(
      logger.events.some(
        (event) =>
          event.type === "durable.record-unverifiable" &&
          event.pid === undefined,
      ),
    ).toBe(true);
    expect(registry.writes.at(-1)).toEqual([]);
  });
});

describe("durable seeding across multiple activations in one process", () => {
  test("a second activation against the same registry and state map does not duplicate the adopted record", async () => {
    const registry = new RoundTrippingRegistry();
    const state = createStartupState();
    const identity = aliveIdentity();
    let spawnCalls = 0;
    const spawn: SpawnFunction = () => {
      spawnCalls += 1;
      return new FakeChild(5001);
    };
    const command = globalCommand("helper", [], "Helper", 0, DURABLE_SKIP);

    const activation1 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity,
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation1.dispose();

    const activation2 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity,
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation2.dispose();

    expect(spawnCalls).toBe(1);

    const finalRecords = registry.writes.at(-1) ?? [];
    expect(finalRecords).toHaveLength(1);
    expect(finalRecords[0]?.pid).toBe(5001);
    expect(finalRecords[0]?.creationOrder).toBe(0);

    const entry = state.get(`global:${JSON.stringify(["helper", []])}`);
    expect(entry?.records).toHaveLength(1);
    expect(entry?.nextCreationOrder).toBe(1);
  });

  test("four activations stay flat rather than growing 2^n", async () => {
    const registry = new RoundTrippingRegistry();
    const state = createStartupState();
    const identity = aliveIdentity();
    let spawnCalls = 0;
    const spawn: SpawnFunction = () => {
      spawnCalls += 1;
      return new FakeChild(5001);
    };
    const command = globalCommand("helper", [], "Helper", 0, DURABLE_SKIP);

    for (let i = 0; i < 4; i += 1) {
      const activation = await runStartupCommands(
        [command],
        {
          spawn,
          state,
          processTree: new FakeProcessTree(),
          logger: createLogger(),
          registry,
          identity,
        },
        { authoritative: true, projectRootHash: "unused-project-root-hash" },
      );
      await activation.dispose();
    }

    expect(spawnCalls).toBe(1);
    const finalRecords = registry.writes.at(-1) ?? [];
    expect(finalRecords).toHaveLength(1);
    expect(finalRecords[0]?.creationOrder).toBe(0);
  });
});

describe("an already-tracked record survives a failed re-describe", () => {
  test("the file record fills the gap when the state walk's re-describe fails", async () => {
    const helperProcessKey = `global:${JSON.stringify(["helper", []])}`;
    const state = createStartupState();
    const trackedPid = process.pid + 1;
    state.set(helperProcessKey, {
      processKey: helperProcessKey,
      records: [
        {
          origin: "spawned",
          child: new FakeChild(trackedPid),
          pid: trackedPid,
          context: { scope: "global", index: 0, name: "Helper" },
          creationOrder: 0,
          owners: new Set<symbol>(),
          stopOnExit: false,
          status: "active",
          rootExited: false,
        },
      ],
      cleanupUnconfirmed: false,
      status: "stable",
      transitionTail: Promise.resolve(),
      pendingTransitions: 0,
      nextCreationOrder: 1,
    });

    const registry = new FakeRegistry({
      status: "loaded",
      records: [
        persistedRecord({ pid: trackedPid, startToken: "linux1:boot-a:11" }),
      ],
    });

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: {
          async describe(pid) {
            if (pid === trackedPid) {
              return { status: "unknown", reason: "permission-denied" };
            }
            return { status: "described", token: "linux1:owner:1" };
          },
          async probe() {
            return { status: "alive" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    const written = registry.writes.at(-1) ?? [];
    expect(written.some((record) => record.pid === trackedPid)).toBe(true);
  });
});

describe("restart + stopOnExit:false on the durable path", () => {
  test("a successful restart drops the stopped pid's record instead of writing it alongside the replacement", async () => {
    const registry = new RoundTrippingRegistry();
    const state = createStartupState();
    let spawnCount = 0;
    const spawn: SpawnFunction = () => {
      spawnCount += 1;
      return new FakeChild(spawnCount === 1 ? 7001 : 7002);
    };
    const command = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "restart",
      stopOnExit: false,
    });

    const activation1 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation1.dispose();
    expect(registry.writes.at(-1)).toHaveLength(1);
    expect(registry.writes.at(-1)?.[0]?.pid).toBe(7001);

    const activation2 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree([{ status: "stopped" }]),
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation2.dispose();

    expect(spawnCount).toBe(2);

    const written = registry.writes.at(-1) ?? [];
    expect(written).toHaveLength(1);
    expect(written[0]?.pid).toBe(7002);

    const entry = state.get(`global:${JSON.stringify(["helper", []])}`);
    expect(entry?.status).not.toBe("degraded");
    expect(entry?.cleanupUnconfirmed).toBe(false);
  });
});

describe("epilogue dedupe and creationOrder ordering, discriminated separately", () => {
  test("an unknown probe on an already-tracked record does not grow the file by one record per activation", async () => {
    const registry = new RoundTrippingRegistry();
    const state = createStartupState();
    let spawnCalls = 0;
    const spawn: SpawnFunction = () => {
      spawnCalls += 1;
      return new FakeChild(5002);
    };
    const command = globalCommand("helper", [], "Helper", 0, DURABLE_SKIP);

    const activation1 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation1.dispose();
    expect(registry.writes.at(-1)).toHaveLength(1);

    const activation2 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:boot-a:11" };
          },
          async probe() {
            return { status: "unknown", reason: "permission-denied" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation2.dispose();

    expect(spawnCalls).toBe(1);
    expect(registry.writes.at(-1)).toHaveLength(1);
  });

  test("records for one identity are written in ascending creationOrder even when assembled descending", async () => {
    const helperProcessKey = `global:${JSON.stringify(["helper", []])}`;
    const state = createStartupState();
    state.set(helperProcessKey, {
      processKey: helperProcessKey,
      records: [
        {
          origin: "adopted",
          pid: 9002,
          startToken: "linux1:boot-a:22",
          context: { scope: "global", index: 0, name: "Helper" },
          creationOrder: 2,
          owners: new Set<symbol>(),
          stopOnExit: false,
          status: "active",
          rootExited: false,
        },
      ],
      cleanupUnconfirmed: false,
      status: "stable",
      transitionTail: Promise.resolve(),
      pendingTransitions: 0,
      nextCreationOrder: 3,
    });

    const registry = new FakeRegistry({
      status: "loaded",
      records: [
        persistedRecord({
          pid: 9001,
          creationOrder: 5,
          startToken: "linux1:boot-a:11",
        }),
      ],
    });

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:boot-a:11" };
          },
          async probe() {
            return { status: "unknown", reason: "permission-denied" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    const written = registry.writes.at(-1) ?? [];
    expect(written).toHaveLength(2);
    expect(written.map((record) => record.creationOrder)).toEqual([2, 5]);
  });
});

describe("a project command's durable scope uses options.projectRootHash", () => {
  test("a supplied hash unrelated to command.projectRoot still round-trips: adopted, not respawned", async () => {
    const registry = new RoundTrippingRegistry();
    const state = createStartupState();
    const identity = aliveIdentity();
    let spawnCalls = 0;
    const spawn: SpawnFunction = () => {
      spawnCalls += 1;
      return new FakeChild(6001);
    };
    const suppliedProjectRootHash = "caller-supplied-hash-unrelated-to-path";
    const command = projectCommand(
      "/some/worktree/project",
      "helper",
      [],
      "Helper",
      0,
      DURABLE_SKIP,
    );

    const activation1 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity,
      },
      { authoritative: true, projectRootHash: suppliedProjectRootHash },
    );
    await activation1.dispose();

    const firstWrite = registry.writes.at(-1) ?? [];
    expect(firstWrite).toHaveLength(1);
    const persisted = firstWrite[0];
    expect(persisted?.scope).toBe("project");
    if (persisted?.scope === "project") {
      expect(persisted.projectRootHash).toBe(suppliedProjectRootHash);
    }

    const activation2 = await runStartupCommands(
      [command],
      {
        spawn,
        state,
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity,
      },
      { authoritative: true, projectRootHash: suppliedProjectRootHash },
    );
    await activation2.dispose();

    expect(spawnCalls).toBe(1);
    expect(registry.writes.at(-1)).toHaveLength(1);
  });

  test("a project command is excluded from the durable plan when options itself is absent, rather than guessing a hash", async () => {
    const registry = new FakeRegistry();
    const command = projectCommand(
      "/some/worktree/project",
      "helper",
      [],
      "Helper",
      0,
      DURABLE_SKIP,
    );

    const activation = await runStartupCommands([command], {
      spawn: () => new FakeChild(6002),
      state: createStartupState(),
      processTree: new FakeProcessTree(),
      logger: createLogger(),
      registry,
      identity: aliveIdentity(),
    });
    await activation.dispose();

    expect(registry.writes.at(-1)).toEqual([]);
  });

  test("a project durable command with no scope info still blocks when the plan is disabled for an unrelated reason", async () => {
    const registry = new FakeRegistry({ status: "loaded", records: [] }, false);
    const logger = createLogger();
    const command = projectCommand(
      "/some/worktree/project",
      "helper",
      [],
      "Helper",
      0,
      DURABLE_SKIP,
    );
    let spawnCalls = 0;

    const activation = await runStartupCommands([command], {
      spawn: () => {
        spawnCalls += 1;
        return new FakeChild(9999);
      },
      state: createStartupState(),
      processTree: new FakeProcessTree(),
      logger,
      registry,
      identity: aliveIdentity(),
    });
    await activation.dispose();

    expect(spawnCalls).toBe(0);
    expect(
      logger.events.some(
        (event) =>
          event.type === "command.skipped" &&
          event.reason === "durable-unavailable",
      ),
    ).toBe(true);
  });
});

describe("orphaned records (no matching command)", () => {
  test("gone: dropped from the rewritten registry, and nothing is stopped", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphanRecord()],
    });
    const processTree = new FakeProcessTree();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:e2e:1" };
          },
          async probe() {
            return { status: "gone" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(0);
    const written = registry.writes.at(-1) ?? [];
    expect(written.some((record) => record.pid === 7777)).toBe(false);
  });

  test("alive: preserved verbatim in the rewritten registry, and nothing is stopped", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:e2e:1" };
          },
          async probe() {
            return { status: "alive" };
          },
        },
      },
      { authoritative: false, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(0);
    expect(registry.writes.at(-1)).toContainEqual(orphan);
  });

  test("unknown: preserved verbatim in the rewritten registry, and nothing is stopped", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree();

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:e2e:1" };
          },
          async probe() {
            return { status: "unknown", reason: "permission-denied" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(0);
    expect(registry.writes.at(-1)).toContainEqual(orphan);
  });
});

describe("the durable transaction is skipped when nothing needs it", () => {
  const DIRECT_SKIP = {
    onExistingProcess: "skip",
    stopOnExit: true,
  } as const;

  function temporaryStateRoot(): { parent: string; root: string } {
    const parent = mkdtempSync(join(tmpdir(), "durable-fast-path-"));
    return { parent, root: join(parent, "state") };
  }

  test("no durable command and no registry file: no owner resolution and no state directory", async () => {
    const { parent, root } = temporaryStateRoot();
    let resolveOwnerCalls = 0;
    let describeCalls = 0;

    try {
      const activation = await runStartupCommands(
        [globalCommand("helper", [], "Helper", 0, DIRECT_SKIP)],
        {
          spawn: () => new FakeChild(9999),
          state: createStartupState(),
          processTree: new FakeProcessTree(),
          logger: createLogger(),
          registry: createDurableRegistry({ root }),
          identity: {
            async describe() {
              describeCalls += 1;
              return { status: "described", token: "linux1:boot-a:11" };
            },
            async probe() {
              return { status: "alive" };
            },
          },
        },
        {
          authoritative: true,
          projectRootHash: "unused-project-root-hash",
          resolveOwner: async () => {
            resolveOwnerCalls += 1;
            return { pid: 4242, startToken: "linux1:boot-a:11" };
          },
        },
      );
      await activation.dispose();

      expect(resolveOwnerCalls).toBe(0);
      expect(describeCalls).toBe(0);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("no durable command but a registry file exists: the transaction still reconciles", async () => {
    const { parent, root } = temporaryStateRoot();

    try {
      const registry = createDurableRegistry({ root });
      const stale: DurableRecord = {
        scope: "global",
        identityHash: registry.hashIdentity("retired-helper"),
        pid: 7777,
        startToken: "linux1:boot-a:99",
        stopOnExit: false,
        creationOrder: 0,
        recordedAt: "2026-09-03T00:00:00.000Z",
      };
      expect(registry.write([stale])).toBe(true);

      const activation = await runStartupCommands(
        [globalCommand("helper", [], "Helper", 0, DIRECT_SKIP)],
        {
          spawn: () => new FakeChild(9999),
          state: createStartupState(),
          processTree: new FakeProcessTree(),
          logger: createLogger(),
          registry,
          identity: {
            async describe() {
              return { status: "described", token: "linux1:boot-a:11" };
            },
            async probe() {
              return { status: "gone" };
            },
          },
        },
        { authoritative: true, projectRootHash: "unused-project-root-hash" },
      );
      await activation.dispose();

      expect(registry.read()).toEqual({ status: "loaded", records: [] });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("one durable command and no registry file: the transaction runs and writes one", async () => {
    const { parent, root } = temporaryStateRoot();
    let resolveOwnerCalls = 0;

    try {
      const registry = createDurableRegistry({ root });

      const activation = await runStartupCommands(
        [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
        {
          spawn: () => new FakeChild(9999),
          state: createStartupState(),
          processTree: new FakeProcessTree(),
          logger: createLogger(),
          registry,
          identity: aliveIdentity(),
        },
        {
          authoritative: true,
          projectRootHash: "unused-project-root-hash",
          resolveOwner: async () => {
            resolveOwnerCalls += 1;
            return { pid: 4242, startToken: "linux1:boot-a:11" };
          },
        },
      );
      await activation.dispose();

      expect(resolveOwnerCalls).toBe(1);
      expect(existsSync(join(root, "registry.json"))).toBe(true);
      const loaded = registry.read();
      expect(loaded.status === "loaded" && loaded.records).toHaveLength(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the owner thunk supplies the lock holder instead of this process's own identity", async () => {
    const acquired: Array<{ pid: number; startToken: string }> = [];
    const registry: DurableRegistry = {
      hashIdentity: (signature) => `identity-${signature}`,
      hashProjectRoot: (normalizedRoot) => `root-${normalizedRoot}`,
      exists: () => false,
      read: () => ({ status: "loaded", records: [] }),
      write: () => true,
      async acquireLock(holder) {
        acquired.push(holder);
        return { status: "unavailable" };
      },
    };

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree: new FakeProcessTree(),
        logger: createLogger(),
        registry,
        identity: {
          describe() {
            throw new Error("the owner thunk already supplied an identity");
          },
          async probe() {
            return { status: "alive" };
          },
        },
      },
      {
        authoritative: true,
        projectRootHash: "unused-project-root-hash",
        resolveOwner: async () => ({
          pid: 4242,
          startToken: "linux1:boot-a:11",
        }),
      },
    );
    await activation.dispose();

    expect(acquired).toEqual([{ pid: 4242, startToken: "linux1:boot-a:11" }]);
  });
});

describe("durable registry privacy end-to-end", () => {
  test("a real activation persists only hashes, never the executable, args, or project root", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "durable-registry-e2e-"));

    try {
      const registry = createDurableRegistry({ root: stateRoot });
      const rawExecutable = "/usr/bin/very-secret-watcher";
      const rawArgs = ["--token", "TOP_SECRET_ARGUMENT_VALUE"];
      const rawProjectRoot = join(stateRoot, "workspace", "secret-project-name");
      const command = projectCommand(
        rawProjectRoot,
        rawExecutable,
        rawArgs,
        "Secret helper",
        0,
        { onExistingProcess: "skip", stopOnExit: false },
      );

      const normalizedRoot =
        process.platform === "win32"
          ? normalize(resolve(rawProjectRoot)).toLowerCase()
          : normalize(resolve(rawProjectRoot));
      const expectedIdentityHash = registry.hashIdentity(
        JSON.stringify([rawExecutable, rawArgs]),
      );
      const expectedProjectRootHash = registry.hashProjectRoot(normalizedRoot);

      const activation = await runStartupCommands(
        [command],
        {
          spawn: () => new FakeChild(4321),
          state: createStartupState(),
          processTree: new FakeProcessTree(),
          logger: createLogger(),
          registry,
          identity: {
            async describe() {
              return { status: "described", token: "linux1:e2e-boot:1" };
            },
            async probe() {
              return { status: "alive" };
            },
          },
        },
        { authoritative: true, projectRootHash: expectedProjectRootHash },
      );
      await activation.dispose();

      const bytes = readFileSync(join(stateRoot, "registry.json"), "utf8");

      expect(bytes).toContain(expectedIdentityHash);
      expect(bytes).toContain(expectedProjectRootHash);
      expect(bytes).not.toContain(rawExecutable);
      expect(bytes).not.toContain("TOP_SECRET_ARGUMENT_VALUE");
      expect(bytes).not.toContain("secret-project-name");
      expect(bytes).not.toContain(rawProjectRoot);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("reconciliation and the authoritativeness gate", () => {
  test("an orphan (command removed) probing alive is stopped and dropped when authoritative", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree([{ status: "stopped" }]);
    const logger = createLogger();

    const activation = await runStartupCommands(
      [],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(1);
    expect(processTree.calls[0]?.pid).toBe(7777);
    expect(registry.writes.at(-1)).toEqual([]);
    expect(
      logger.events.some(
        (event) =>
          event.type === "durable.reconciled" &&
          event.scope === "global" &&
          event.stoppedCount === 1,
      ),
    ).toBe(true);
  });

  test("an orphan whose stop loses addressability is preserved, not dropped", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree([
      { status: "failed", reason: "unconfirmed", addressability: "lost" },
    ]);
    const logger = createLogger();

    const activation = await runStartupCommands(
      [],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(1);
    expect(registry.writes.at(-1)).toEqual([orphan]);
    expect(
      logger.events.some((event) => event.type === "durable.reconciled"),
    ).toBe(false);
  });

  test("an orphan whose stop fails while still addressable is preserved", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree([
      { status: "failed", reason: "permission-denied", addressability: "safe" },
    ]);

    const activation = await runStartupCommands(
      [],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(1);
    expect(registry.writes.at(-1)).toEqual([orphan]);
  });

  test("the same orphan is preserved and never stopped when not authoritative", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree();
    const logger = createLogger();

    const activation = await runStartupCommands(
      [],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: false, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(0);
    expect(registry.writes.at(-1)).toEqual([orphan]);
    expect(
      logger.events.some((event) => event.type === "durable.reconciled"),
    ).toBe(false);
  });

  test("a matched record is still adopted when not authoritative", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord()],
    });
    const processTree = new FakeProcessTree();
    const logger = createLogger();
    let spawnCalls = 0;

    const activation = await runStartupCommands(
      [globalCommand("helper", [], "Helper", 0, DURABLE_SKIP)],
      {
        spawn: () => {
          spawnCalls += 1;
          return new FakeChild(9999);
        },
        state: createStartupState(),
        processTree,
        logger,
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: false, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(spawnCalls).toBe(0);
    expect(processTree.calls).toHaveLength(0);
    expect(
      logger.events.some((event) => event.type === "durable.record-adopted"),
    ).toBe(true);
    expect(registry.writes.at(-1)).toHaveLength(1);
  });

  test("stopOnExit flipped to true stops the old durable process and spawns fresh", async () => {
    const registry = new FakeRegistry({
      status: "loaded",
      records: [persistedRecord()],
    });
    const processTree = new FakeProcessTree([
      { status: "stopped" },
      { status: "stopped" },
    ]);
    const spawnedPids: Array<number | undefined> = [];

    const activation = await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      {
        spawn: () => {
          const child = new FakeChild(9999);
          spawnedPids.push(child.pid);
          return child;
        },
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: aliveIdentity(),
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );

    expect(processTree.calls[0]?.pid).toBe(4242);
    expect(spawnedPids).toEqual([9999]);
    expect(registry.writes.at(-1)).toEqual([]);

    await activation.dispose();
    expect(processTree.calls.map((call) => call.pid)).toEqual([4242, 9999]);
  });

  test("an orphan probing unknown is never stopped, matched or not", async () => {
    const orphan = orphanRecord();
    const registry = new FakeRegistry({
      status: "loaded",
      records: [orphan],
    });
    const processTree = new FakeProcessTree();

    const activation = await runStartupCommands(
      [],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:e2e:1" };
          },
          async probe() {
            return { status: "unknown", reason: "permission-denied" };
          },
        },
      },
      { authoritative: true, projectRootHash: "unused-project-root-hash" },
    );
    await activation.dispose();

    expect(processTree.calls).toHaveLength(0);
    expect(registry.writes.at(-1)).toEqual([orphan]);
  });

  test("a foreign project's orphan is never probed and never stopped", async () => {
    const foreign: DurableRecord = {
      scope: "project",
      identityHash: `identity-${JSON.stringify(["orphan-tool", []])}`,
      projectRootHash: "someone-elses-root-hash",
      pid: 1111,
      startToken: "linux1:boot-a:1",
      stopOnExit: false,
      creationOrder: 0,
      recordedAt: "2026-09-03T01:00:00.000Z",
    };
    const registry = new FakeRegistry({
      status: "loaded",
      records: [foreign],
    });
    const processTree = new FakeProcessTree();
    let probeCalls = 0;

    const activation = await runStartupCommands(
      [],
      {
        spawn: () => new FakeChild(9999),
        state: createStartupState(),
        processTree,
        logger: createLogger(),
        registry,
        identity: {
          async describe() {
            return { status: "described", token: "linux1:e2e:1" };
          },
          async probe() {
            probeCalls += 1;
            return { status: "alive" };
          },
        },
      },
      { authoritative: true, projectRootHash: "our-project-root-hash" },
    );
    await activation.dispose();

    expect(probeCalls).toBe(0);
    expect(processTree.calls).toHaveLength(0);
    expect(registry.writes.at(-1)).toEqual([foreign]);
  });
});
