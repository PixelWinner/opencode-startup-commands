import { afterAll, describe, expect, test } from "bun:test";
import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfiguredCommand, OnExistingProcessPolicy } from "../src/config.js";
import {
  createStartupState,
  runStartupCommands,
  type SpawnFunction,
} from "../src/core.js";
import {
  createDurableRegistry,
  type DurableRecord,
  type DurableRegistry,
} from "../src/durable-registry.js";
import type { LogEvent, Logger } from "../src/logger.js";
import {
  createProcessIdentityController,
  type ProcessDescribeResult,
} from "../src/process-identity.js";
import { createProcessTreeController } from "../src/process-tree.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/durable-child.mjs", import.meta.url),
);

const identity = createProcessIdentityController();
const processTree = createProcessTreeController({
  gracePeriodMs: 100,
  pollIntervalMs: 10,
});

function isValidFixturePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function getErrorCodeForTest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(getErrorCodeForTest(error) === "ESRCH");
  }
}

function delayForTest(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessesAbsent(
  pids: number[],
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) {
      return true;
    }
    await delayForTest(10);
  }

  return pids.every((pid) => !processExists(pid));
}

async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Controlled operation did not settle")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

const everySpawnedPid = new Set<number>();

function trackPid(child: ChildProcess): void {
  if (isValidFixturePid(child.pid)) {
    everySpawnedPid.add(child.pid);
  }
}

async function terminateFixture(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!isValidFixturePid(pid) || !processExists(pid)) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  try {
    child.stdin?.end();
  } catch {}
  try {
    child.kill("SIGTERM");
  } catch {}

  await settleWithin(exited, 5_000).catch(() => {});

  if (processExists(pid)) {
    try {
      child.kill("SIGKILL");
    } catch {}
    await waitForProcessesAbsent([pid], 3_000);
  }
}

async function terminateAll(children: readonly ChildProcess[]): Promise<void> {
  await Promise.all(children.map((child) => terminateFixture(child)));
}

afterAll(async () => {
  const pids = [...everySpawnedPid];
  await waitForProcessesAbsent(pids, 2_000);
  const survivors = pids.filter(processExists);
  expect(survivors).toEqual([]);
});

function spawnDirectFixture(): ChildProcess {
  const child = spawnChildProcess(
    process.execPath,
    [fixturePath, "reap-on-stdin-close"],
    {
      detached: true,
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  child.unref();
  trackPid(child);
  return child;
}

async function waitForDescribed(
  pid: number,
  timeoutMs: number,
): Promise<{ status: "described"; token: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: ProcessDescribeResult = { status: "gone" };

  while (Date.now() < deadline) {
    last = await identity.describe(pid);
    if (last.status === "described") {
      return last;
    }
    await delayForTest(20);
  }

  throw new Error(
    `pid ${pid} never became describable within ${timeoutMs}ms: ${JSON.stringify(last)}`,
  );
}

function expectedTokenPattern(): RegExp {
  if (process.platform === "win32") {
    return /^win1:\d+$/;
  }
  if (process.platform === "darwin") {
    return /^mac1:.+$/;
  }
  return /^linux1:[0-9a-f-]{4,64}:\d+$/;
}

describe("process identity against a real OS process", () => {
  test(
    "describe() and probe() agree a freshly spawned real child is alive",
    async () => {
      const child = spawnDirectFixture();

      try {
        const pid = child.pid;
        if (!isValidFixturePid(pid)) {
          throw new Error("Fixture child did not receive a PID");
        }

        const described = await waitForDescribed(pid, 8_000);
        expect(described.token).toMatch(expectedTokenPattern());

        await expect(identity.probe(pid, described.token)).resolves.toEqual({
          status: "alive",
        });
      } finally {
        await terminateFixture(child);
      }
    },
    15_000,
  );

  test(
    "probe() reports gone once the child has actually exited",
    async () => {
      const child = spawnDirectFixture();

      try {
        const pid = child.pid;
        if (!isValidFixturePid(pid)) {
          throw new Error("Fixture child did not receive a PID");
        }

        const described = await waitForDescribed(pid, 8_000);
        await terminateFixture(child);
        expect(processExists(pid)).toBe(false);

        await expect(identity.probe(pid, described.token)).resolves.toEqual({
          status: "gone",
        });
      } finally {
        await terminateFixture(child);
      }
    },
    15_000,
  );

  test(
    "a dead process's (pid, startToken) pair is never mistaken for alive again -- the actual property recycled-PID rejection rests on",
    async () => {
      const child = spawnDirectFixture();

      try {
        const pid = child.pid;
        if (!isValidFixturePid(pid)) {
          throw new Error("Fixture child did not receive a PID");
        }

        const described = await waitForDescribed(pid, 8_000);
        await expect(identity.probe(pid, described.token)).resolves.toEqual({
          status: "alive",
        });

        await terminateFixture(child);
        expect(processExists(pid)).toBe(false);

        await expect(identity.probe(pid, described.token)).resolves.toEqual({
          status: "gone",
        });
      } finally {
        await terminateFixture(child);
      }
    },
    15_000,
  );
});

function createTestLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return {
    events,
    write(event): void {
      events.push(event);
    },
  };
}

function fixtureCommand(
  onExistingProcess: OnExistingProcessPolicy,
): ConfiguredCommand {
  return {
    name: "Durable fixture",
    executable: process.execPath,
    args: [fixturePath],
    onExistingProcess,
    stopOnExit: false,
    index: 0,
    scope: "global",
  };
}

function createTrackingSpawn(collected: ChildProcess[]): SpawnFunction {
  return (executable, args, options) => {
    const child = spawnChildProcess(executable, args, options);
    collected.push(child);
    trackPid(child);
    return child;
  };
}

function temporaryRegistryRoot(): string {
  return mkdtempSync(join(tmpdir(), "durable-integration-"));
}

function loadedRecords(registry: DurableRegistry): DurableRecord[] {
  const result = registry.read();
  if (result.status !== "loaded") {
    throw new Error(`Expected the registry to load; got: ${result.status}`);
  }
  return result.records;
}

const UNUSED_PROJECT_ROOT_HASH = "unused-project-root-hash";

describe("durable registry round trip through a real OS process", () => {
  test(
    "a fresh process adopts a durable child and skip spawns nothing new",
    async () => {
      const root = temporaryRegistryRoot();
      const spawnedChildren: ChildProcess[] = [];
      const logger = createTestLogger();
      const registry = createDurableRegistry({ root, identity });
      const command = fixtureCommand("skip");

      try {
        const firstActivation = await runStartupCommands(
          [command],
          {
            spawn: createTrackingSpawn(spawnedChildren),
            state: createStartupState(),
            processTree,
            logger,
            registry,
            identity,
          },
          { authoritative: true, projectRootHash: UNUSED_PROJECT_ROOT_HASH },
        );
        await firstActivation.dispose();

        expect(existsSync(join(root, "registry.json"))).toBe(true);
        expect(spawnedChildren).toHaveLength(1);
        const firstPid = spawnedChildren[0]?.pid;
        if (!isValidFixturePid(firstPid)) {
          throw new Error("Fixture child did not receive a PID");
        }

        const afterFirstRun = loadedRecords(registry);
        expect(afterFirstRun).toHaveLength(1);
        expect(afterFirstRun[0]?.pid).toBe(firstPid);

        const secondActivation = await runStartupCommands(
          [command],
          {
            spawn: createTrackingSpawn(spawnedChildren),
            state: createStartupState(),
            processTree,
            logger,
            registry,
            identity,
          },
          { authoritative: true, projectRootHash: UNUSED_PROJECT_ROOT_HASH },
        );
        await secondActivation.dispose();

        expect(spawnedChildren).toHaveLength(1);
        expect(processExists(firstPid)).toBe(true);

        const afterSecondRun = loadedRecords(registry);
        expect(afterSecondRun).toHaveLength(1);
        expect(afterSecondRun[0]?.pid).toBe(firstPid);
        expect(
          logger.events.some(
            (event) =>
              event.type === "command.skipped" &&
              event.reason === "already-started",
          ),
        ).toBe(true);
      } finally {
        await terminateAll(spawnedChildren);
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "restart stops the durable child and registers exactly one replacement",
    async () => {
      const root = temporaryRegistryRoot();
      const spawnedChildren: ChildProcess[] = [];
      const logger = createTestLogger();
      const registry = createDurableRegistry({ root, identity });
      const command = fixtureCommand("restart");

      try {
        const firstActivation = await settleWithin(
          runStartupCommands(
            [command],
            {
              spawn: createTrackingSpawn(spawnedChildren),
              state: createStartupState(),
              processTree,
              logger,
              registry,
              identity,
            },
            { authoritative: true, projectRootHash: UNUSED_PROJECT_ROOT_HASH },
          ),
          15_000,
        );
        await firstActivation.dispose();

        expect(spawnedChildren).toHaveLength(1);
        const firstPid = spawnedChildren[0]?.pid;
        if (!isValidFixturePid(firstPid)) {
          throw new Error("Fixture child did not receive a PID");
        }
        expect(processExists(firstPid)).toBe(true);

        const secondActivation = await settleWithin(
          runStartupCommands(
            [command],
            {
              spawn: createTrackingSpawn(spawnedChildren),
              state: createStartupState(),
              processTree,
              logger,
              registry,
              identity,
            },
            { authoritative: true, projectRootHash: UNUSED_PROJECT_ROOT_HASH },
          ),
          15_000,
        );
        await secondActivation.dispose();

        expect(spawnedChildren).toHaveLength(2);
        const secondPid = spawnedChildren[1]?.pid;
        if (!isValidFixturePid(secondPid)) {
          throw new Error("Replacement fixture child did not receive a PID");
        }
        expect(secondPid).not.toBe(firstPid);

        expect(await waitForProcessesAbsent([firstPid], 5_000)).toBe(true);
        expect(processExists(secondPid)).toBe(true);

        const afterRestart = loadedRecords(registry);
        expect(afterRestart).toHaveLength(1);
        expect(afterRestart[0]?.pid).toBe(secondPid);
      } finally {
        await terminateAll(spawnedChildren);
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "a mutated start token (simulated reboot) drops the stale record without touching the still-live process, and spawns a fresh one",
    async () => {
      const root = temporaryRegistryRoot();
      const spawnedChildren: ChildProcess[] = [];
      const logger = createTestLogger();
      const registry = createDurableRegistry({ root, identity });
      const command = fixtureCommand("skip");

      try {
        const firstActivation = await runStartupCommands(
          [command],
          {
            spawn: createTrackingSpawn(spawnedChildren),
            state: createStartupState(),
            processTree,
            logger,
            registry,
            identity,
          },
          { authoritative: true, projectRootHash: UNUSED_PROJECT_ROOT_HASH },
        );
        await firstActivation.dispose();

        expect(spawnedChildren).toHaveLength(1);
        const firstPid = spawnedChildren[0]?.pid;
        if (!isValidFixturePid(firstPid)) {
          throw new Error("Fixture child did not receive a PID");
        }

        const [original] = loadedRecords(registry);
        if (!original) {
          throw new Error("Expected a persisted durable record after the first run");
        }
        expect(original.pid).toBe(firstPid);

        const mutatedToken = `${original.startToken}-mutated-for-test`;
        const mutatedRecord: DurableRecord = {
          ...original,
          startToken: mutatedToken,
        };
        expect(registry.write([mutatedRecord])).toBe(true);

        const secondActivation = await runStartupCommands(
          [command],
          {
            spawn: createTrackingSpawn(spawnedChildren),
            state: createStartupState(),
            processTree,
            logger,
            registry,
            identity,
          },
          { authoritative: true, projectRootHash: UNUSED_PROJECT_ROOT_HASH },
        );
        await secondActivation.dispose();

        expect(spawnedChildren).toHaveLength(2);
        const secondPid = spawnedChildren[1]?.pid;
        if (!isValidFixturePid(secondPid)) {
          throw new Error("Replacement fixture child did not receive a PID");
        }
        expect(secondPid).not.toBe(firstPid);

        expect(processExists(firstPid)).toBe(true);
        expect(
          logger.events.some(
            (event) =>
              event.type === "durable.record-dropped" && event.pid === firstPid,
          ),
        ).toBe(true);

        const afterReboot = loadedRecords(registry);
        expect(afterReboot).toHaveLength(1);
        expect(afterReboot[0]?.pid).toBe(secondPid);
        expect(afterReboot[0]?.startToken).not.toBe(mutatedToken);
      } finally {
        await terminateAll(spawnedChildren);
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
