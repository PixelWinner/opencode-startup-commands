import { describe, expect, test } from "bun:test";
import { spawn as spawnFixtureProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProcessTreeController,
  type ProcessTreeController,
  type ProcessTreeStopResult,
  type ProcessUtilityChild,
  type ProcessUtilitySpawn,
} from "../src/process-tree.js";

const stopped = { status: "stopped" } satisfies ProcessTreeStopResult;
const lostFailure = {
  status: "failed",
  reason: "unconfirmed",
  addressability: "lost",
} satisfies ProcessTreeStopResult;
void stopped;
void lostFailure;

function acceptsController(controller: ProcessTreeController): void {
  void controller;
}

acceptsController(createProcessTreeController());

describe("process-tree controller contract", () => {
  test("exports utility child and spawn types", () => {
    const acceptsUtilityChild = (child: ProcessUtilityChild): void => {
      void child;
    };
    const acceptsUtilitySpawn = (spawn: ProcessUtilitySpawn): void => {
      void spawn;
    };

    expect(typeof acceptsUtilityChild).toBe("function");
    expect(typeof acceptsUtilitySpawn).toBe("function");
  });
});

describe("PID validation", () => {
  test.each([
    undefined,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects an unsafe process identifier: %p", async (pid) => {
    let killCalls = 0;
    const controller = createProcessTreeController({
      platform: "linux",
      kill(): boolean {
        killCalls += 1;
        return true;
      },
    });

    await expect(
      controller.stop(pid, {
        isRootExited: () => false,
        onForce(): void {},
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "missing-pid",
      addressability: "lost",
    });
    expect(killCalls).toBe(0);
  });
});

type SignalCall = [number, NodeJS.Signals | 0 | undefined];

function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error("Controlled process error"), { code });
}

type UtilityOutcome =
  | { event: "error"; error: Error }
  | {
      event: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    };

class FakeUtilityChild implements ProcessUtilityChild {
  public readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  public unrefCalls = 0;
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private scheduled = false;

  public constructor(
    private readonly outcome?: UtilityOutcome,
    private readonly behavior: {
      throwOnKill?: boolean;
      throwOnUnref?: boolean;
    } = {},
  ) {}

  public once(event: "error", listener: (error: Error) => void): this;
  public once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  public once(
    event: "error" | "exit",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    if (event === "error") {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.exitListeners.push(
        listener as (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => void,
      );
    }
    this.scheduleOutcome();
    return this;
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    if (this.behavior.throwOnKill) {
      throw new Error("Controlled utility kill failure");
    }
    return true;
  }

  public unref(): void {
    this.unrefCalls += 1;
    if (this.behavior.throwOnUnref) {
      throw new Error("Controlled utility unref failure");
    }
  }

  private scheduleOutcome(): void {
    if (!this.outcome || this.scheduled) {
      return;
    }
    this.scheduled = true;

    queueMicrotask(() => {
      if (this.outcome?.event === "error") {
        for (const listener of this.errorListeners.splice(0)) {
          listener(this.outcome.error);
        }
      } else if (this.outcome?.event === "exit") {
        for (const listener of this.exitListeners.splice(0)) {
          listener(this.outcome.code, this.outcome.signal);
        }
      }
    });
  }
}

interface UtilityCall {
  executable: string;
  args: string[];
  options: Parameters<ProcessUtilitySpawn>[2];
}

function utilityExit(code: number | null): FakeUtilityChild {
  return new FakeUtilityChild({ event: "exit", code, signal: null });
}

function utilityError(code: string): FakeUtilityChild {
  return new FakeUtilityChild({ event: "error", error: systemError(code) });
}

function createUtilitySpawn(
  children: ProcessUtilityChild[],
  calls: UtilityCall[],
): ProcessUtilitySpawn {
  let childIndex = 0;

  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = children[childIndex];
    childIndex += 1;
    if (!child) {
      throw new Error("Test did not provide a utility child");
    }
    return child;
  };
}

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
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

interface FixturePids {
  parentPid: number;
  childPid: number;
}

function isValidFixturePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(getErrorCodeForTest(error) === "ESRCH");
  }
}

function getErrorCodeForTest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function delayForTest(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFixturePids(
  pidFile: string,
  timeoutMs: number,
): Promise<FixturePids> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as Partial<FixturePids>;
      if (
        isValidFixturePid(parsed.parentPid) &&
        isValidFixturePid(parsed.childPid)
      ) {
        return { parentPid: parsed.parentPid, childPid: parsed.childPid };
      }
    } catch {}

    await delayForTest(10);
  }

  throw new Error("Fixture PID file did not become ready");
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

function killExactFixturePid(pid: number): void {
  if (!isValidFixturePid(pid) || !processExists(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

describe("POSIX process groups", () => {
  test("stops a group gracefully when the second probe confirms absence", async () => {
    const calls: SignalCall[] = [];
    const delays: number[] = [];
    let probeCount = 0;
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "linux",
      gracePeriodMs: 100,
      pollIntervalMs: 10,
      async delay(milliseconds): Promise<void> {
        delays.push(milliseconds);
      },
      kill(pid, signal): boolean {
        calls.push([pid, signal]);
        if (signal === 0 && ++probeCount === 2) {
          throw systemError("ESRCH");
        }
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({ status: "stopped" });
    expect(calls.every(([pid]) => pid === -42)).toBe(true);
    expect(calls).toContainEqual([-42, "SIGTERM"]);
    expect(calls).not.toContainEqual([-42, "SIGKILL"]);
    expect(delays).toEqual([10]);
    expect(forceCount).toBe(0);
  });

  test("bounds grace probes before forcing and confirms final absence", async () => {
    const calls: SignalCall[] = [];
    const actions: string[] = [];
    const delays: number[] = [];
    let forced = false;
    const controller = createProcessTreeController({
      platform: "darwin",
      gracePeriodMs: 25,
      pollIntervalMs: 10,
      async delay(milliseconds): Promise<void> {
        delays.push(milliseconds);
      },
      kill(pid, signal): boolean {
        calls.push([pid, signal]);
        actions.push(String(signal));
        if (signal === "SIGKILL") {
          forced = true;
        } else if (signal === 0 && forced) {
          throw systemError("ESRCH");
        }
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {
          actions.push("onForce");
        },
      }),
    ).resolves.toEqual({ status: "stopped" });

    const forceIndex = calls.findIndex(([, signal]) => signal === "SIGKILL");
    expect([
      calls[0],
      calls[1],
      calls[forceIndex],
      calls[forceIndex + 1],
    ]).toEqual([
      [-42, 0],
      [-42, "SIGTERM"],
      [-42, "SIGKILL"],
      [-42, 0],
    ]);
    expect(calls.slice(2, forceIndex)).toHaveLength(3);
    expect(calls.slice(2, forceIndex).every(([, signal]) => signal === 0)).toBe(
      true,
    );
    expect(delays).toEqual([10, 10, 5, 10]);
    expect(actions.filter((action) => action === "onForce")).toHaveLength(1);
    expect(actions.indexOf("onForce")).toBe(actions.indexOf("SIGKILL") - 1);
  });

  test("performs one immediate grace probe for a zero grace period", async () => {
    const calls: SignalCall[] = [];
    const delays: number[] = [];
    let forced = false;
    const controller = createProcessTreeController({
      platform: "linux",
      gracePeriodMs: 0,
      pollIntervalMs: 10,
      async delay(milliseconds): Promise<void> {
        delays.push(milliseconds);
      },
      kill(pid, signal): boolean {
        calls.push([pid, signal]);
        if (signal === "SIGKILL") {
          forced = true;
        } else if (signal === 0 && forced) {
          throw systemError("ESRCH");
        }
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {},
      }),
    ).resolves.toEqual({ status: "stopped" });

    const forceIndex = calls.findIndex(([, signal]) => signal === "SIGKILL");
    expect(calls.slice(2, forceIndex)).toEqual([[-42, 0]]);
    expect(delays).toEqual([0, 10]);
  });

  test("treats an initially absent group as stopped", async () => {
    const calls: SignalCall[] = [];
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "linux",
      kill(pid, signal): boolean {
        calls.push([pid, signal]);
        throw systemError("ESRCH");
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => true,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({ status: "stopped" });
    expect(calls).toEqual([[-42, 0]]);
    expect(forceCount).toBe(0);
  });

  test.each([
    ["EPERM", "permission-denied"],
    ["EACCES", "permission-denied"],
    ["UNKNOWN", "unconfirmed"],
  ] as const)(
    "maps %s signal failures to %s while the root is addressable",
    async (code, reason) => {
      const controller = createProcessTreeController({
        platform: "linux",
        kill(): boolean {
          throw systemError(code);
        },
      });

      await expect(
        controller.stop(42, {
          isRootExited: () => false,
          onForce(): void {},
        }),
      ).resolves.toEqual({
        status: "failed",
        reason,
        addressability: "safe",
      });
    },
  );

  test("evaluates root exit dynamically when a POSIX operation fails", async () => {
    let rootExited = false;
    const controller = createProcessTreeController({
      platform: "linux",
      kill(): boolean {
        rootExited = true;
        throw systemError("UNKNOWN");
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => rootExited,
        onForce(): void {},
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
  });
});

describe("Windows process trees", () => {
  test("fails closed before targeting an initially exited root", async () => {
    let utilityCalls = 0;
    let rootProbeCalls = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawn(): ProcessUtilityChild {
        utilityCalls += 1;
        return utilityExit(0);
      },
      kill(): boolean {
        rootProbeCalls += 1;
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => true,
        onForce(): void {},
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    expect(utilityCalls).toBe(0);
    expect(rootProbeCalls).toBe(0);
  });

  test("invokes the absolute system taskkill utility directly", async () => {
    const calls: UtilityCall[] = [];
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawn: createUtilitySpawn([utilityExit(0)], calls),
      kill(): boolean {
        throw new Error("A successful utility call must not probe the root");
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {},
      }),
    ).resolves.toEqual({ status: "stopped" });
    expect(calls).toEqual([
      {
        executable: "C:\\Windows\\System32\\taskkill.exe",
        args: ["/PID", "42", "/T"],
        options: {
          detached: false,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      },
    ]);
  });

  test("waits the production grace period before a forced utility call", async () => {
    const calls: UtilityCall[] = [];
    const delays: number[] = [];
    const rootProbes: SignalCall[] = [];
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawn: createUtilitySpawn([utilityExit(1), utilityExit(0)], calls),
      async delay(milliseconds): Promise<void> {
        delays.push(milliseconds);
      },
      kill(pid, signal): boolean {
        rootProbes.push([pid, signal]);
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({ status: "stopped" });
    expect(delays).toEqual([5_000]);
    expect(rootProbes).toEqual([
      [42, 0],
      [42, 0],
    ]);
    expect(forceCount).toBe(1);
    expect(calls.map(({ args }) => args)).toEqual([
      ["/PID", "42", "/T"],
      ["/PID", "42", "/T", "/F"],
    ]);
  });

  test.each([
    {},
    { SystemRoot: "   " },
    { SystemRoot: "Windows" },
  ])("rejects an unavailable SystemRoot: %p", async (env) => {
    let spawnCalls = 0;
    let rootProbeCalls = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env,
      spawn(): ProcessUtilityChild {
        spawnCalls += 1;
        return utilityExit(0);
      },
      kill(): boolean {
        rootProbeCalls += 1;
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {},
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "facility-unavailable",
      addressability: "safe",
    });
    expect(spawnCalls).toBe(0);
    expect(rootProbeCalls).toBe(0);
  });

  test("maps utility spawn permission failures without rejecting", async () => {
    let spawnCalls = 0;
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      gracePeriodMs: 1,
      async delay(): Promise<void> {},
      spawn(): ProcessUtilityChild {
        spawnCalls += 1;
        throw systemError("EACCES");
      },
      kill(): boolean {
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "permission-denied",
      addressability: "safe",
    });
    expect(spawnCalls).toBe(2);
    expect(forceCount).toBe(1);
  });

  test.each([
    ["EPERM", "permission-denied", 2],
    ["ENOENT", "facility-unavailable", 1],
    ["UNKNOWN", "unconfirmed", 2],
  ] as const)(
    "maps utility child %s errors to %s",
    async (code, reason, expectedCalls) => {
      const calls: UtilityCall[] = [];
      let forceCount = 0;
      const controller = createProcessTreeController({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        gracePeriodMs: 1,
        async delay(): Promise<void> {},
        spawn: createUtilitySpawn(
          [utilityError(code), utilityError(code)],
          calls,
        ),
        kill(): boolean {
          return true;
        },
      });

      await expect(
        controller.stop(42, {
          isRootExited: () => false,
          onForce(): void {
            forceCount += 1;
          },
        }),
      ).resolves.toEqual({
        status: "failed",
        reason,
        addressability: "safe",
      });
      expect(calls).toHaveLength(expectedCalls);
      expect(forceCount).toBe(code === "ENOENT" ? 0 : 1);
    },
  );

  test("maps nonzero utility exits to an unconfirmed final state", async () => {
    const calls: UtilityCall[] = [];
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      gracePeriodMs: 1,
      async delay(): Promise<void> {},
      spawn: createUtilitySpawn([utilityExit(5), utilityExit(1)], calls),
      kill(): boolean {
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "unconfirmed",
      addressability: "safe",
    });
    expect(calls).toHaveLength(2);
    expect(forceCount).toBe(1);
  });

  test("does not force after the root exits during the grace period", async () => {
    const calls: UtilityCall[] = [];
    let rootExited = false;
    let rootProbeCalls = 0;
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      gracePeriodMs: 10,
      spawn: createUtilitySpawn([utilityExit(1)], calls),
      async delay(): Promise<void> {
        rootExited = true;
      },
      kill(): boolean {
        rootProbeCalls += 1;
        return true;
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => rootExited,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    expect(calls).toHaveLength(1);
    expect(rootProbeCalls).toBe(1);
    expect(forceCount).toBe(0);
  });

  test("rechecks root exit after onForce before spawning the forced utility", async () => {
    const calls: UtilityCall[] = [];
    let rootExited = false;
    let rootProbeCalls = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      gracePeriodMs: 1,
      spawn: createUtilitySpawn([utilityExit(1), utilityExit(0)], calls),
      async delay(): Promise<void> {},
      kill(): boolean {
        rootProbeCalls += 1;
        return true;
      },
    });

    const result = await controller.stop(42, {
      isRootExited: () => rootExited,
      onForce(): void {
        rootExited = true;
      },
    });

    expect(calls.map(({ args }) => args)).toEqual([["/PID", "42", "/T"]]);
    expect(rootProbeCalls).toBe(2);
    expect(result).toEqual({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
  });

  test("maps a denied Windows root probe to a safe failure", async () => {
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawn: createUtilitySpawn([utilityExit(1)], []),
      kill(): boolean {
        throw systemError("EPERM");
      },
    });

    await expect(
      controller.stop(42, {
        isRootExited: () => false,
        onForce(): void {
          forceCount += 1;
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "permission-denied",
      addressability: "safe",
    });
    expect(forceCount).toBe(0);
  });

  test(
    "bounds a hung graceful utility and proceeds directly to force",
    async () => {
      const calls: UtilityCall[] = [];
      const hungChild = new FakeUtilityChild(undefined, { throwOnKill: true });
      let delayCalls = 0;
      let forceCount = 0;
      const controller = createProcessTreeController({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        utilityTimeoutMs: 1,
        spawn: createUtilitySpawn([hungChild, utilityExit(1)], calls),
        async delay(): Promise<void> {
          delayCalls += 1;
        },
        kill(): boolean {
          return true;
        },
      });

      const result = await settleWithin(
        controller.stop(42, {
          isRootExited: () => false,
          onForce(): void {
            forceCount += 1;
          },
        }),
        100,
      );

      expect(result).toEqual({
        status: "failed",
        reason: "unconfirmed",
        addressability: "safe",
      });
      expect(calls.map(({ args }) => args)).toEqual([
        ["/PID", "42", "/T"],
        ["/PID", "42", "/T", "/F"],
      ]);
      expect(delayCalls).toBe(0);
      expect(forceCount).toBe(1);
      expect(hungChild.killCalls).toEqual(["SIGKILL"]);
      expect(hungChild.unrefCalls).toBe(1);
    },
  );

  test(
    "bounds a hung forced utility and returns an unconfirmed result",
    async () => {
      const hungChild = new FakeUtilityChild(undefined, { throwOnUnref: true });
      let forceCount = 0;
      const controller = createProcessTreeController({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        gracePeriodMs: 1,
        utilityTimeoutMs: 1,
        spawn: createUtilitySpawn([utilityExit(1), hungChild], []),
        async delay(): Promise<void> {},
        kill(): boolean {
          return true;
        },
      });

      const result = await settleWithin(
        controller.stop(42, {
          isRootExited: () => false,
          onForce(): void {
            forceCount += 1;
          },
        }),
        100,
      );

      expect(result).toEqual({
        status: "failed",
        reason: "unconfirmed",
        addressability: "safe",
      });
      expect(forceCount).toBe(1);
      expect(hungChild.killCalls).toEqual(["SIGKILL"]);
      expect(hungChild.unrefCalls).toBe(1);
    },
  );

  test("rechecks root exit after a graceful utility timeout", async () => {
    const calls: UtilityCall[] = [];
    const hungChild = new FakeUtilityChild();
    let rootExited = false;
    let rootProbeCalls = 0;
    let forceCount = 0;
    const controller = createProcessTreeController({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      utilityTimeoutMs: 1,
      spawn: createUtilitySpawn([hungChild, utilityExit(0)], calls),
      kill(): boolean {
        rootProbeCalls += 1;
        rootExited = true;
        return true;
      },
    });

    const result = await settleWithin(
      controller.stop(42, {
        isRootExited: () => rootExited,
        onForce(): void {
          forceCount += 1;
        },
      }),
      100,
    );

    expect(result).toEqual({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    expect(calls).toHaveLength(1);
    expect(rootProbeCalls).toBe(1);
    expect(forceCount).toBe(0);
    expect(hungChild.killCalls).toEqual(["SIGKILL"]);
    expect(hungChild.unrefCalls).toBe(1);
  });
});

describe("host-platform process trees", () => {
  test(
    "stops a real fixture parent and descendant",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "startup-process-tree-"));
      const pidFile = join(directory, "fixture-pids.json");
      const parentPath = fileURLToPath(
        new URL("./fixtures/process-tree-parent.mjs", import.meta.url),
      );
      const knownPids = new Set<number>();

      try {
        const fixture = spawnFixtureProcess(
          process.execPath,
          [
            parentPath,
            pidFile,
            process.platform === "win32" ? "normal" : "ignore-term",
          ],
          {
            detached: true,
            shell: false,
            stdio: "ignore",
            windowsHide: true,
          },
        );
        if (isValidFixturePid(fixture.pid)) {
          knownPids.add(fixture.pid);
        }
        fixture.unref();

        const fixturePids = await waitForFixturePids(pidFile, 3_000);
        knownPids.add(fixturePids.parentPid);
        knownPids.add(fixturePids.childPid);
        let forceCount = 0;
        const controller = createProcessTreeController({
          gracePeriodMs: 100,
          pollIntervalMs: 10,
        });

        const result = await settleWithin(
          controller.stop(fixturePids.parentPid, {
            isRootExited: () => !processExists(fixturePids.parentPid),
            onForce(): void {
              forceCount += 1;
            },
          }),
          12_000,
        );

        expect(result).toEqual({ status: "stopped" });
        expect(
          await waitForProcessesAbsent(
            [fixturePids.parentPid, fixturePids.childPid],
            5_000,
          ),
        ).toBe(true);
        if (process.platform !== "win32") {
          expect(forceCount).toBe(1);
        }
      } finally {
        const exactPids = [...knownPids];
        for (const pid of exactPids) {
          killExactFixturePid(pid);
        }
        await waitForProcessesAbsent(exactPids, 2_000);
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
