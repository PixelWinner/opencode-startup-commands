import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ConfiguredCommand } from "../src/config.js";
import {
  createStartupState,
  getOrCreateProcessState,
  runStartupCommands,
  type SpawnFunction,
  type SpawnedChild,
  type StartupState,
} from "../src/core.js";
import type { LogEvent, Logger } from "../src/logger.js";
import type {
  ProcessTreeController,
  ProcessTreeStopOptions,
  ProcessTreeStopResult,
} from "../src/process-tree.js";

class FakeChild implements SpawnedChild {
  public readonly onceCalls: Array<"error" | "exit"> = [];
  public unrefCalls = 0;
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];

  public constructor(
    public readonly pid?: number,
    private readonly options: {
      throwOnOnce?: boolean;
      throwOnUnref?: boolean;
    } = {},
  ) {}

  public once(event: "error", listener: (error: Error) => void): this;
  public once(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): this;
  public once(
    event: "error" | "exit",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    this.onceCalls.push(event);

    if (this.options.throwOnOnce) {
      throw new Error("Test child once failure");
    }

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

    return this;
  }

  public unref(): void {
    this.unrefCalls += 1;

    if (this.options.throwOnUnref) {
      throw new Error("Test child unref failure");
    }
  }

  public emitError(error: Error): void {
    const listeners = this.errorListeners.splice(0);

    for (const listener of listeners) {
      listener(error);
    }
  }

  public emitExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const listeners = this.exitListeners.splice(0);

    for (const listener of listeners) {
      listener(code, signal);
    }
  }
}

class FakeProcessTree implements ProcessTreeController {
  public readonly calls: Array<{
    pid: number | undefined;
    options: ProcessTreeStopOptions;
  }> = [];

  public constructor(
    private readonly results: ProcessTreeStopResult[] = [
      { status: "stopped" },
    ],
  ) {}

  public async stop(
    pid: number | undefined,
    options: ProcessTreeStopOptions,
  ): Promise<ProcessTreeStopResult> {
    this.calls.push({ pid, options });
    return this.results.shift() ?? { status: "stopped" };
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class DeferredProcessTree implements ProcessTreeController {
  public readonly calls: Array<{
    pid: number | undefined;
    options: ProcessTreeStopOptions;
  }> = [];
  public readonly stops = new Map<
    number | undefined,
    ReturnType<typeof deferred<ProcessTreeStopResult>>
  >();

  public stop(
    pid: number | undefined,
    options: ProcessTreeStopOptions,
  ): Promise<ProcessTreeStopResult> {
    this.calls.push({ pid, options });
    const pending = deferred<ProcessTreeStopResult>();
    this.stops.set(pid, pending);
    return pending.promise;
  }
}

type CommandPolicies = Pick<
  ConfiguredCommand,
  "onExistingProcess" | "stopOnExit"
>;

const DEFAULT_POLICIES: CommandPolicies = {
  onExistingProcess: "skip",
  stopOnExit: true,
};

function globalCommand(
  executable: string,
  args: string[] = [],
  name = "Global command",
  index = 0,
  policies: CommandPolicies = DEFAULT_POLICIES,
): ConfiguredCommand {
  return { name, executable, args, ...policies, scope: "global", index };
}

function projectCommand(
  projectRoot: string,
  executable: string,
  args: string[] = [],
  name = "Project command",
  index = 0,
  policies: CommandPolicies = DEFAULT_POLICIES,
): ConfiguredCommand {
  return {
    name,
    executable,
    args,
    ...policies,
    scope: "project",
    projectRoot,
    index,
  };
}

function createLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];

  return {
    events,
    write(event): void {
      events.push(event);
    },
  };
}

function createSpawn(
  children: SpawnedChild[],
  calls: unknown[][],
): SpawnFunction {
  let childIndex = 0;

  return (executable, args, options) => {
    calls.push([executable, args, options]);
    const child = children[childIndex];
    childIndex += 1;

    if (!child) {
      throw new Error("Test did not provide a fake child");
    }

    return child;
  };
}

function createDependencies(
  children: SpawnedChild[] = [],
  processTree: ProcessTreeController = new FakeProcessTree(),
): {
  calls: unknown[][];
  logger: Logger & { events: LogEvent[] };
  processTree: ProcessTreeController;
  state: StartupState;
  spawn: SpawnFunction;
} {
  const calls: unknown[][] = [];

  return {
    calls,
    logger: createLogger(),
    processTree,
    state: createStartupState(),
    spawn: createSpawn(children, calls),
  };
}

function createGatedIdentityState(
  processKey: string,
  transitionTail: Promise<void>,
): StartupState {
  return new Map([
    [
      processKey,
      {
        processKey,
        records: [],
        cleanupUnconfirmed: false,
        status: "stable",
        transitionTail,
        pendingTransitions: 0,
        nextCreationOrder: 0,
      },
    ],
  ]) as StartupState;
}

describe("getOrCreateProcessState", () => {
  const stateKey = Symbol.for("opencode.startup-commands.state");

  test("creates one empty process-entry map", () => {
    const registry: Record<symbol, unknown> = {};
    const state = getOrCreateProcessState(registry);

    expect(state).toBeInstanceOf(Map);
    expect(state.size).toBe(0);
    expect(registry[stateKey]).toBe(state);
  });

  test("reuses a structurally valid process-entry map", () => {
    const processKey = 'global:["helper",["--watch"]]';
    const existing = new Map([
      [
        processKey,
        {
          processKey,
          records: [
            {
              child: new FakeChild(101),
              pid: 101,
              context: { scope: "global", index: 0, name: "Helper" },
              creationOrder: 0,
              owners: new Set([Symbol("owner")]),
              stopOnExit: true,
              status: "active",
              rootExited: false,
            },
          ],
          cleanupUnconfirmed: false,
          status: "stable",
          transitionTail: Promise.resolve(),
          pendingTransitions: 0,
          nextCreationOrder: 1,
        },
      ],
    ]) as StartupState;
    const registry: Record<symbol, unknown> = { [stateKey]: existing };

    expect(getOrCreateProcessState(registry)).toBe(existing);
  });

  test("assimilates a structurally valid then-only transition tail", async () => {
    const processKey = 'global:["helper",[]]';
    const thenOnlyTail = {
      then(onFulfilled: () => void): Promise<void> {
        return Promise.resolve().then(onFulfilled);
      },
    };
    const existing = new Map([
      [
        processKey,
        {
          processKey,
          records: [],
          cleanupUnconfirmed: false,
          status: "stable",
          transitionTail: thenOnlyTail,
          pendingTransitions: 0,
          nextCreationOrder: 0,
        },
      ],
    ]) as unknown as StartupState;
    const registry: Record<symbol, unknown> = { [stateKey]: existing };
    const dependencies = createDependencies([new FakeChild(101)]);
    dependencies.state = getOrCreateProcessState(registry);

    await runStartupCommands([globalCommand("helper")], dependencies);
    const entry = existing.get(processKey)!;
    await entry.transitionTail;
    await runStartupCommands([globalCommand("helper")], dependencies);

    expect(dependencies.state).toBe(existing);
    expect(dependencies.calls).toHaveLength(1);
    expect(entry.pendingTransitions).toBe(0);
    expect(entry.transitionTail).toBeInstanceOf(Promise);
    expect(entry.records[0]?.owners.size).toBe(2);
  });

  test("converts legacy identities into degraded cleanup blockers", () => {
    const legacy = {
      started: new Set([
        'global:["helper",["--watch"]]',
        'project:C:\\work:["project-helper",[]]',
      ]),
    };
    const registry: Record<symbol, unknown> = { [stateKey]: legacy };

    const state = getOrCreateProcessState(registry);

    expect(state).not.toBe(legacy);
    expect(registry[stateKey]).toBe(state);
    expect([...state.keys()]).toEqual([
      'global:["helper",["--watch"]]',
      'project:C:\\work:["project-helper",[]]',
    ]);
    for (const entry of state.values()) {
      expect(entry.records).toEqual([]);
      expect(entry.cleanupUnconfirmed).toBe(true);
      expect(entry.status).toBe("degraded");
      expect(entry.retryTombstone).toBeUndefined();
    }
  });

  test("replaces malformed map keys and entries", () => {
    const child = new FakeChild(101);
    const owner = Symbol("owner");
    const processKey = 'global:["helper",[]]';
    const validRecord = {
      child,
      pid: 101,
      context: { scope: "global", index: 0, name: "Helper" },
      creationOrder: 0,
      owners: new Set([owner]),
      stopOnExit: true,
      status: "active",
      rootExited: false,
    };
    const validEntry = {
      processKey,
      records: [validRecord],
      cleanupUnconfirmed: false,
      status: "stable",
      transitionTail: Promise.resolve(),
      pendingTransitions: 0,
      nextCreationOrder: 1,
    };
    const malformedMaps: Map<unknown, unknown>[] = [
      new Map([[1, validEntry]]),
      new Map([[processKey, { ...validEntry, processKey: "other" }]]),
      new Map([[processKey, { ...validEntry, records: {} }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, pid: 0 }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, child: {} }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, context: null }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, creationOrder: -1 }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, owners: new Set(["owner"]) }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, stopOnExit: "yes" }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, status: "unknown" }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, stopPromise: {} }] }]]),
      new Map([[processKey, { ...validEntry, records: [{ ...validRecord, rootExited: 0 }] }]]),
      new Map([[processKey, { ...validEntry, retryTombstone: "unknown" }]]),
      new Map([[processKey, { ...validEntry, retryTombstone: "spawn-failed" }]]),
      new Map([[processKey, { ...validEntry, cleanupUnconfirmed: "no" }]]),
      new Map([[processKey, { ...validEntry, status: "unknown" }]]),
      new Map([[processKey, { ...validEntry, transitionTail: {} }]]),
      new Map([[processKey, { ...validEntry, pendingTransitions: -1 }]]),
      new Map([[processKey, { ...validEntry, nextCreationOrder: 0 }]]),
      new Map([[processKey, { ...validEntry, records: [validRecord, validRecord], nextCreationOrder: 1 }]]),
    ];

    for (const malformedState of malformedMaps) {
      const registry: Record<symbol, unknown> = {
        [stateKey]: malformedState,
      };

      const state = getOrCreateProcessState(registry);

      expect(state).not.toBe(malformedState);
      expect(state).toBeInstanceOf(Map);
      expect(state.size).toBe(0);
      expect(registry[stateKey]).toBe(state);
    }
  });

  test.each([
    null,
    {},
    { started: false },
    { started: new Set<unknown>([1]) },
  ])("replaces malformed non-map process state: %p", (malformedState) => {
    const registry: Record<symbol, unknown> = {
      [stateKey]: malformedState,
    };

    const state = getOrCreateProcessState(registry);

    expect(state).not.toBe(malformedState);
    expect(state).toBeInstanceOf(Map);
    expect(state.size).toBe(0);
    expect(registry[stateKey]).toBe(state);
  });
});

describe("runStartupCommands", () => {
  test("launches global commands before project commands with scope-specific cwd", async () => {
    const firstChild = new FakeChild(101);
    const secondChild = new FakeChild(102);
    const dependencies = createDependencies([firstChild, secondChild]);
    const projectRoot = resolve("workspace", "project");

    await runStartupCommands(
      [
        globalCommand("C:\\Tools\\global.exe", ["", " spaced value "]),
        projectCommand(projectRoot, "project-tool", ["--watch"]),
      ],
      dependencies,
    );

    expect(dependencies.calls).toEqual([
      [
        "C:\\Tools\\global.exe",
        ["", " spaced value "],
        {
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      ],
      [
        "project-tool",
        ["--watch"],
        {
          cwd: projectRoot,
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      ],
    ]);
    expect(firstChild.unrefCalls).toBe(1);
    expect(secondChild.unrefCalls).toBe(1);
    expect(dependencies.state.size).toBe(2);
    expect([...dependencies.state.values()].map(({ records }) => records.map(({ pid }) => pid))).toEqual([
      [101],
      [102],
    ]);
    expect(
      [...dependencies.state.values()].map(({ records }) => records[0]?.owners.size),
    ).toEqual([1, 1]);
    expect(dependencies.logger.events).toEqual([
      { type: "plugin.initialized", commandCount: 2 },
      {
        type: "command.spawned",
        scope: "global",
        index: 0,
        name: "Global command",
        pid: 101,
      },
      {
        type: "command.spawned",
        scope: "project",
        index: 0,
        name: "Project command",
        pid: 102,
      },
    ]);
  });

  test("validates one PID snapshot before retaining or logging it", async () => {
    const pidReads = [0, 101, 101, -1];
    const child: SpawnedChild = {
      get pid(): number | undefined {
        return pidReads.shift();
      },
      once(): SpawnedChild {
        return child;
      },
      unref(): void {},
    };
    const dependencies = createDependencies([child]);

    await runStartupCommands([globalCommand("helper")], dependencies);

    expect(pidReads).toEqual([101, 101, -1]);
    expect([...dependencies.state.values()][0]?.records[0]?.pid).toBeUndefined();
    expect(dependencies.logger.events).toContainEqual({
      type: "command.spawned",
      scope: "global",
      index: 0,
      name: "Global command",
      pid: undefined,
    });
  });

  test.each(["start", "skip", "restart"] as const)(
    "spawns one owned record from an empty identity with %s",
    async (onExistingProcess) => {
      const dependencies = createDependencies([new FakeChild(101)]);

      await runStartupCommands(
        [
          globalCommand("helper", [], "Helper", 0, {
            onExistingProcess,
            stopOnExit: true,
          }),
        ],
        dependencies,
      );

      const entry = [...dependencies.state.values()][0];
      expect(dependencies.calls).toHaveLength(1);
      expect(dependencies.state.size).toBe(1);
      expect(entry?.records).toHaveLength(1);
      expect(entry?.records[0]?.pid).toBe(101);
      expect(entry?.records[0]?.owners.size).toBe(1);
    },
  );

  test("appends one separately owned record for each start activation", async () => {
    const dependencies = createDependencies([
      new FakeChild(101),
      new FakeChild(102),
      new FakeChild(103),
    ]);
    const command = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });

    await runStartupCommands([command], dependencies);
    await runStartupCommands([command], dependencies);
    await runStartupCommands([command], dependencies);

    const records = [...dependencies.state.values()][0]?.records ?? [];
    const owners = records.flatMap((record) => [...record.owners]);
    expect(dependencies.calls).toHaveLength(3);
    expect(records.map(({ pid }) => pid)).toEqual([101, 102, 103]);
    expect(records.map(({ owners }) => owners.size)).toEqual([1, 1, 1]);
    expect(new Set(owners).size).toBe(3);
  });

  test("skip claims only the oldest active record without changing its policy", async () => {
    const dependencies = createDependencies([
      new FakeChild(101),
      new FakeChild(102),
    ]);
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: false,
    });
    const skip = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "skip",
      stopOnExit: true,
    });

    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);
    await runStartupCommands([skip], dependencies);

    const records = [...dependencies.state.values()][0]?.records ?? [];
    expect(dependencies.calls).toHaveLength(2);
    expect(records).toHaveLength(2);
    expect(records[0]?.owners.size).toBe(2);
    expect(records[1]?.owners.size).toBe(1);
    expect(records[0]?.stopOnExit).toBe(false);
  });

  test("restart waits for every old record before spawning one owner-union replacement", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102), new FakeChild(103)],
      tree,
    );
    const persistentStart = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: false,
    });
    const stoppableStart = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });
    const restart = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "restart",
      stopOnExit: false,
    });

    await runStartupCommands([persistentStart], dependencies);
    await runStartupCommands([stoppableStart], dependencies);
    const restartPromise = runStartupCommands([restart], dependencies);
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls.map(({ pid }) => pid).sort()).toEqual([101, 102]);
    expect(dependencies.calls).toHaveLength(2);
    expect([...dependencies.state.values()][0]?.status).toBe("restarting");

    tree.stops.get(102)!.resolve({ status: "stopped" });
    await Promise.resolve();
    await Promise.resolve();
    expect(dependencies.calls).toHaveLength(2);

    tree.stops.get(101)!.resolve({ status: "stopped" });
    await restartPromise;

    const entry = [...dependencies.state.values()][0];
    expect(dependencies.calls).toHaveLength(3);
    expect(entry?.records).toHaveLength(1);
    expect(entry?.records[0]?.pid).toBe(103);
    expect(entry?.records[0]?.owners.size).toBe(3);
    expect(entry?.records[0]?.stopOnExit).toBe(false);
    expect(entry?.status).toBe("stable");
  });

  test("keeps complete restart cleanup final when replacement spawn fails", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102)],
      tree,
    );
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });

    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);
    const restartPromise = runStartupCommands(
      [
        globalCommand("helper", [], "Replacement", 4, {
          onExistingProcess: "restart",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls.map(({ pid }) => pid).sort()).toEqual([101, 102]);
    expect(dependencies.calls).toHaveLength(2);

    tree.stops.get(101)!.resolve({ status: "stopped" });
    tree.stops.get(102)!.resolve({ status: "stopped" });
    await restartPromise;

    const entry = [...dependencies.state.values()][0]!;
    expect(entry.records).toHaveLength(0);
    expect(entry.retryTombstone).toBe("spawn-failed");
    expect(entry.cleanupUnconfirmed).toBe(false);
    expect(entry.status).toBe("stable");
    expect(dependencies.calls).toHaveLength(3);

    for (const [index, onExistingProcess] of (
      ["start", "skip", "restart"] as const
    ).entries()) {
      const eventStart = dependencies.logger.events.length;
      await runStartupCommands(
        [
          globalCommand("helper", [], `Blocked ${onExistingProcess}`, index, {
            onExistingProcess,
            stopOnExit: true,
          }),
        ],
        dependencies,
      );
      expect(dependencies.logger.events.slice(eventStart)).toContainEqual({
        type: "command.skipped",
        scope: "global",
        index,
        name: `Blocked ${onExistingProcess}`,
        reason: "already-started",
      });
    }

    expect(dependencies.calls).toHaveLength(3);
    expect(entry.records).toHaveLength(0);
    expect(entry.retryTombstone).toBe("spawn-failed");
  });

  test("retains safe restart survivors and transfers stopped ownership to the oldest", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102), new FakeChild(103)],
      tree,
    );
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });
    const stoppedOwnerActivation = await runStartupCommands(
      [start],
      dependencies,
    );
    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const stoppedOwner = [...entry.records[0]!.owners][0]!;

    const restartPromise = runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 0, {
          onExistingProcess: "restart",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    tree.stops.get(103)!.resolve({
      status: "failed",
      reason: "facility-unavailable",
      addressability: "safe",
    });
    tree.stops.get(101)!.resolve({ status: "stopped" });
    tree.stops.get(102)!.resolve({
      status: "failed",
      reason: "permission-denied",
      addressability: "safe",
    });
    await restartPromise;

    expect(entry.status).toBe("degraded");
    expect(entry.cleanupUnconfirmed).toBe(false);
    expect(entry.records.map(({ pid }) => pid)).toEqual([102, 103]);
    expect(entry.records.map(({ owners }) => owners.size)).toEqual([3, 1]);
    expect(entry.records[0]!.owners.has(stoppedOwner)).toBe(true);
    expect(dependencies.calls).toHaveLength(3);

    await stoppedOwnerActivation.dispose();

    expect(entry.records[0]!.owners.has(stoppedOwner)).toBe(false);
    expect(entry.records.map(({ owners }) => owners.size)).toEqual([2, 1]);
    expect(tree.calls.map(({ pid }) => pid).sort()).toEqual([101, 102, 103]);
  });

  test("recovers from degraded safe survivors on a later restart", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [
        new FakeChild(101),
        new FakeChild(102),
        new FakeChild(103),
        new FakeChild(104),
      ],
      tree,
    );
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });
    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);

    const firstRestart = runStartupCommands(
      [
        globalCommand("helper", [], "First restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    tree.stops.get(101)!.resolve({ status: "stopped" });
    tree.stops.get(102)!.resolve({
      status: "failed",
      reason: "permission-denied",
      addressability: "safe",
    });
    tree.stops.get(103)!.resolve({
      status: "failed",
      reason: "facility-unavailable",
      addressability: "safe",
    });
    await firstRestart;

    const entry = [...dependencies.state.values()][0]!;
    expect(entry.status).toBe("degraded");
    expect(dependencies.calls).toHaveLength(3);

    const secondRestart = runStartupCommands(
      [
        globalCommand("helper", [], "Second restart", 2, {
          onExistingProcess: "restart",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls.map(({ pid }) => pid)).toEqual([
      101,
      102,
      103,
      102,
      103,
    ]);
    expect(dependencies.calls).toHaveLength(3);

    tree.stops.get(103)!.resolve({ status: "stopped" });
    tree.stops.get(102)!.resolve({ status: "stopped" });
    await secondRestart;

    expect(entry.records).toHaveLength(1);
    expect(entry.records[0]?.pid).toBe(104);
    expect(entry.records[0]?.owners.size).toBe(5);
    expect(entry.records[0]?.stopOnExit).toBe(false);
    expect(entry.status).toBe("stable");
    expect(entry.retryTombstone).toBeUndefined();
  });

  test("blocks restart after a lost stop while allowing known-record policies", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102), new FakeChild(103)],
      tree,
    );
    const executable = "C:\\LOST_SECRET\\helper.exe";
    const args = ["--token=LOST_SECRET"];
    const start = globalCommand(executable, args, "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });
    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);

    const firstRestart = runStartupCommands(
      [
        globalCommand(executable, args, "First restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    tree.stops.get(101)!.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    tree.stops.get(102)!.resolve({
      status: "failed",
      reason: "permission-denied",
      addressability: "safe",
    });
    await firstRestart;

    const entry = [...dependencies.state.values()][0]!;
    expect(entry.records.map(({ pid }) => pid)).toEqual([102]);
    expect(entry.records[0]?.owners.size).toBe(3);
    expect(entry.cleanupUnconfirmed).toBe(true);
    expect(entry.status).toBe("degraded");

    await runStartupCommands(
      [
        globalCommand(executable, args, "Additional start", 2, {
          onExistingProcess: "start",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    await runStartupCommands(
      [
        globalCommand(executable, args, "Known skip", 3, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    expect(entry.records.map(({ pid }) => pid)).toEqual([102, 103]);
    expect(entry.records.map(({ owners }) => owners.size)).toEqual([4, 1]);
    expect(entry.status).toBe("degraded");

    const eventStart = dependencies.logger.events.length;
    const stopCallStart = tree.calls.length;
    const blockedRestart = runStartupCommands(
      [
        globalCommand(executable, args, "Blocked restart", 7, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    for (const { pid } of tree.calls.slice(stopCallStart)) {
      tree.stops.get(pid)!.resolve({ status: "stopped" });
    }
    await blockedRestart;

    expect(tree.calls.map(({ pid }) => pid)).toEqual([101, 102]);
    expect(dependencies.calls).toHaveLength(3);
    expect(entry.records.map(({ pid }) => pid)).toEqual([102, 103]);
    expect(entry.cleanupUnconfirmed).toBe(true);
    expect(entry.status).toBe("degraded");
    expect(dependencies.logger.events.slice(eventStart)).toEqual([
      { type: "plugin.initialized", commandCount: 1 },
      {
        type: "command.stop-failed",
        scope: "global",
        index: 7,
        name: "Blocked restart",
        pid: undefined,
        trigger: "restart",
        reason: "unconfirmed",
      },
    ]);
    expect(
      JSON.stringify(dependencies.logger.events.slice(eventStart)),
    ).not.toContain("LOST_SECRET");
  });

  test("blocks every policy when lost cleanup leaves no known record", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies([new FakeChild(201)], tree);
    const initial = await runStartupCommands(
      [
        globalCommand("helper", [], "Initial", 0, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    const failedRestart = runStartupCommands(
      [
        globalCommand("helper", [], "Lost restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    tree.stops.get(201)!.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    await failedRestart;

    const entry = [...dependencies.state.values()][0]!;
    expect(entry.records).toHaveLength(0);
    expect(entry.cleanupUnconfirmed).toBe(true);
    expect(entry.status).toBe("degraded");
    expect(entry.retryTombstone).toBeUndefined();

    for (const [index, onExistingProcess] of (
      ["start", "skip", "restart"] as const
    ).entries()) {
      const eventStart = dependencies.logger.events.length;
      await runStartupCommands(
        [
          globalCommand("helper", [], `Blocked ${onExistingProcess}`, index, {
            onExistingProcess,
            stopOnExit: true,
          }),
        ],
        dependencies,
      );
      expect(dependencies.logger.events.slice(eventStart)).toContainEqual({
        type: "command.skipped",
        scope: "global",
        index,
        name: `Blocked ${onExistingProcess}`,
        reason: "already-started",
      });
    }

    await initial.dispose();

    expect(dependencies.calls).toHaveLength(1);
    expect(tree.calls.map(({ pid }) => pid)).toEqual([201]);
    expect(entry.records).toHaveLength(0);
    expect(entry.cleanupUnconfirmed).toBe(true);
    expect(entry.status).toBe("degraded");
  });

  test("blocks every policy after the first spawn attempt fails", async () => {
    const dependencies = createDependencies();

    await runStartupCommands(
      [
        globalCommand("helper", [], "Failed first spawn", 4, {
          onExistingProcess: "start",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    const entry = [...dependencies.state.values()][0]!;
    expect(entry.records).toHaveLength(0);
    expect(entry.retryTombstone).toBe("spawn-failed");
    expect(entry.cleanupUnconfirmed).toBe(false);
    expect(entry.status).toBe("stable");

    for (const [index, onExistingProcess] of (
      ["start", "skip", "restart"] as const
    ).entries()) {
      const eventStart = dependencies.logger.events.length;
      await runStartupCommands(
        [
          globalCommand("helper", [], `Blocked ${onExistingProcess}`, index, {
            onExistingProcess,
            stopOnExit: true,
          }),
        ],
        dependencies,
      );
      expect(dependencies.logger.events.slice(eventStart)).toContainEqual({
        type: "command.skipped",
        scope: "global",
        index,
        name: `Blocked ${onExistingProcess}`,
        reason: "already-started",
      });
    }

    expect(dependencies.calls).toHaveLength(1);
    expect(entry.records).toHaveLength(0);
    expect(entry.retryTombstone).toBe("spawn-failed");
  });

  test("preserves a live survivor when an additional start spawn fails", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies([new FakeChild(401)], tree);
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });
    await runStartupCommands([start], dependencies);
    const failedStart = await runStartupCommands([start], dependencies);

    const entry = [...dependencies.state.values()][0]!;
    expect(dependencies.calls).toHaveLength(2);
    expect(entry.records.map(({ pid }) => pid)).toEqual([401]);
    expect(entry.records[0]?.owners.size).toBe(1);
    expect(entry.retryTombstone).toBeUndefined();
    expect(entry.cleanupUnconfirmed).toBe(false);
    expect(entry.status).toBe("stable");

    await failedStart.dispose();
    await runStartupCommands(
      [
        globalCommand("helper", [], "Claim survivor", 1, {
          onExistingProcess: "skip",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(2);
    expect(entry.records.map(({ pid }) => pid)).toEqual([401]);
    expect(entry.records[0]?.owners.size).toBe(2);
    expect(entry.retryTombstone).toBeUndefined();
    expect(tree.calls).toHaveLength(0);
  });

  test.each(["throw", "reject"] as const)(
    "contains adapter %s failures while attempting restart siblings",
    async (failureMode) => {
      const rawError = new Error("RAW_ADAPTER_FAILURE");
      const stopCalls: Array<number | undefined> = [];
      const processTree: ProcessTreeController = {
        stop(pid): Promise<ProcessTreeStopResult> {
          stopCalls.push(pid);
          if (pid === 302) {
            return Promise.resolve({ status: "stopped" });
          }
          if (failureMode === "throw") {
            throw rawError;
          }
          return Promise.reject(rawError);
        },
      };
      const dependencies = createDependencies(
        [new FakeChild(301), new FakeChild(302)],
        processTree,
      );
      const start = globalCommand("helper", [], "Helper", 0, {
        onExistingProcess: "start",
        stopOnExit: true,
      });
      const first = await runStartupCommands([start], dependencies);
      const second = await runStartupCommands([start], dependencies);

      const restart = await runStartupCommands(
        [
          globalCommand("helper", [], "Rejected restart", 6, {
            onExistingProcess: "restart",
            stopOnExit: true,
          }),
        ],
        dependencies,
      );

      const entry = [...dependencies.state.values()][0]!;
      expect(stopCalls).toEqual([301, 302]);
      expect(entry.records.map(({ pid }) => pid)).toEqual([301]);
      expect(entry.records[0]?.owners.size).toBe(3);
      expect(entry.records[0]?.status).toBe("active");
      expect(entry.status).toBe("degraded");
      expect(dependencies.calls).toHaveLength(2);

      await expect(first.dispose()).resolves.toBeUndefined();
      await expect(second.dispose()).resolves.toBeUndefined();
      await expect(restart.dispose()).resolves.toBeUndefined();

      expect(stopCalls).toEqual([301, 302, 301]);
      expect(entry.records.map(({ pid }) => pid)).toEqual([301]);
      expect(entry.records[0]?.owners.size).toBe(0);
      expect(entry.records[0]?.status).toBe("active");
      expect(
        dependencies.logger.events.filter(
          (event) => event.type === "command.stop-failed",
        ),
      ).toEqual([
        {
          type: "command.stop-failed",
          scope: "global",
          index: 0,
          name: "Helper",
          pid: 301,
          trigger: "restart",
          reason: "unconfirmed",
        },
        {
          type: "command.stop-failed",
          scope: "global",
          index: 0,
          name: "Helper",
          pid: 301,
          trigger: "scope-disposed",
          reason: "unconfirmed",
        },
      ]);
      expect(JSON.stringify(dependencies.logger.events)).not.toContain(
        "RAW_ADAPTER_FAILURE",
      );
    },
  );

  test("spawns only once for same-batch duplicate start entries", async () => {
    const dependencies = createDependencies([new FakeChild(101)]);
    const start = {
      onExistingProcess: "start",
      stopOnExit: true,
    } as const;

    await runStartupCommands(
      [
        globalCommand("helper", [], "First", 0, start),
        globalCommand("helper", [], "Second", 1, start),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect([...dependencies.state.values()][0]?.records).toHaveLength(1);
  });

  test("uses both policies from the first same-scope duplicate", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102)],
      tree,
    );
    await runStartupCommands(
      [
        globalCommand("helper", [], "Initial", 0, {
          onExistingProcess: "start",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    await runStartupCommands(
      [
        globalCommand("helper", [], "Start winner", 0, {
          onExistingProcess: "start",
          stopOnExit: false,
        }),
        globalCommand("helper", [], "Restart duplicate", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    const records = [...dependencies.state.values()][0]?.records ?? [];
    expect(tree.calls).toHaveLength(0);
    expect(records.map(({ pid }) => pid)).toEqual([101, 102]);
    expect(records[1]?.stopOnExit).toBe(false);
  });

  test("uses global duplicate policies without giving the project duplicate an owner", async () => {
    const projectRoot = resolve("workspace", "project");
    const tree = new FakeProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102)],
      tree,
    );
    await runStartupCommands(
      [
        globalCommand("helper", [], "Initial", 0, {
          onExistingProcess: "start",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    await runStartupCommands(
      [
        projectCommand(projectRoot, "helper", [], "Project duplicate", 0, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
        globalCommand("helper", [], "Global winner", 0, {
          onExistingProcess: "start",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );

    const records = [...dependencies.state.values()][0]?.records ?? [];
    expect(dependencies.state.size).toBe(1);
    expect(tree.calls).toHaveLength(0);
    expect(records.map(({ owners }) => owners.size)).toEqual([1, 1]);
    expect(records[1]?.stopOnExit).toBe(false);
  });

  test("keeps identity stable when name and process policies change", async () => {
    const dependencies = createDependencies([new FakeChild(101)]);

    await runStartupCommands(
      [
        globalCommand("helper", ["--watch"], "Original", 0, {
          onExistingProcess: "start",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    await runStartupCommands(
      [
        globalCommand("helper", ["--watch"], "Changed", 7, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    const record = [...dependencies.state.values()][0]?.records[0];
    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.state.size).toBe(1);
    expect(record?.owners.size).toBe(2);
    expect(record?.stopOnExit).toBe(false);
  });

  test("stops a shared global record only after its final owner disposes", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies([new FakeChild(101)], tree);
    const command = globalCommand("helper");
    const first = await runStartupCommands([command], dependencies);
    const second = await runStartupCommands([command], dependencies);

    await first.dispose();
    expect(tree.calls).toHaveLength(0);

    const cleanup = second.dispose();
    const repeatedCleanup = second.dispose();
    expect(repeatedCleanup).toBe(cleanup);
    await Promise.all([cleanup, repeatedCleanup]);

    expect(tree.calls.map(({ pid }) => pid)).toEqual([101]);
    expect(dependencies.state.size).toBe(0);
  });

  test("does not stop a pre-existing ownerless true sibling it never owned", async () => {
    const tree = new FakeProcessTree([
      {
        status: "failed",
        reason: "unconfirmed",
        addressability: "safe",
      },
      { status: "stopped" },
    ]);
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102), new FakeChild(103)],
      tree,
    );
    const command = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });
    const first = await runStartupCommands([command], dependencies);
    await runStartupCommands([command], dependencies);

    await first.dispose();
    expect(tree.calls.map(({ pid }) => pid)).toEqual([101]);
    expect(
      [...dependencies.state.values()][0]?.records[0]?.owners.size,
    ).toBe(0);

    const third = await runStartupCommands([command], dependencies);
    await third.dispose();

    expect(tree.calls.map(({ pid }) => pid)).toEqual([101, 103]);
    expect(
      [...dependencies.state.values()][0]?.records.map(({ pid }) => pid),
    ).toEqual([101, 102]);
  });

  test("shares project ownership across equivalent normalized roots", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies([new FakeChild(101)], tree);
    const projectRoot = resolve("workspace", "project");
    const equivalentRoot = resolve(projectRoot, "nested", "..");
    const first = await runStartupCommands(
      [projectCommand(projectRoot, "helper")],
      dependencies,
    );
    const second = await runStartupCommands(
      [projectCommand(equivalentRoot, "helper")],
      dependencies,
    );

    await first.dispose();
    expect(tree.calls).toHaveLength(0);
    await second.dispose();

    expect(tree.calls.map(({ pid }) => pid)).toEqual([101]);
    expect(dependencies.state.size).toBe(0);
  });

  test("disposes identical project commands independently for different roots", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102)],
      tree,
    );
    const firstRoot = resolve("workspace", "first");
    const secondRoot = resolve("workspace", "second");
    const activation = await runStartupCommands(
      [
        projectCommand(firstRoot, "helper"),
        projectCommand(secondRoot, "helper", [], "Second", 1),
      ],
      dependencies,
    );

    await activation.dispose();

    expect(tree.calls.map(({ pid }) => pid).sort()).toEqual([101, 102]);
    expect(dependencies.state.size).toBe(0);
  });

  test("isolates failures while running disposal snapshots in parallel", async () => {
    const stopCalls: Array<{
      pid: number | undefined;
      options: ProcessTreeStopOptions;
    }> = [];
    const stopGates = new Map<
      number | undefined,
      ReturnType<typeof deferred<ProcessTreeStopResult>>
    >();
    const processTree: ProcessTreeController = {
      stop(pid, options): Promise<ProcessTreeStopResult> {
        stopCalls.push({ pid, options });
        if (pid === 901) {
          options.onForce();
        }
        const gate = deferred<ProcessTreeStopResult>();
        stopGates.set(pid, gate);
        return gate.promise;
      },
    };
    const attemptedEvents: LogEvent[] = [];
    const logger: Logger = {
      write(event): void {
        attemptedEvents.push(event);
        if (
          event.type === "command.stop-requested" ||
          event.type === "command.stop-forced" ||
          event.type === "command.stop-failed"
        ) {
          throw new Error("Test logger failure");
        }
      },
    };
    const dependencies = createDependencies(
      [
        new FakeChild(901),
        new FakeChild(902),
        new FakeChild(903),
        new FakeChild(904),
        new FakeChild(905),
        new FakeChild(906),
      ],
      processTree,
    );
    dependencies.logger = logger;
    const start = {
      onExistingProcess: "start",
      stopOnExit: true,
    } as const;
    const alpha = globalCommand("alpha", [], "Alpha", 0, start);
    const primary = await runStartupCommands(
      [
        alpha,
        globalCommand("beta", [], "Beta", 1),
        globalCommand("gamma", [], "Gamma", 2),
        globalCommand("delta", [], "Delta", 3),
      ],
      dependencies,
    );
    await runStartupCommands([alpha], dependencies);
    await runStartupCommands([alpha], dependencies);
    const alphaKey = 'global:["alpha",[]]';
    const alphaEntry = dependencies.state.get(alphaKey)!;
    const primaryOwner = [...alphaEntry.records[0]!.owners][0]!;
    for (const record of alphaEntry.records.slice(1)) {
      record.owners.clear();
      record.owners.add(primaryOwner);
    }

    const disposal = primary.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopCalls.map(({ pid }) => pid).sort()).toEqual([
      901,
      902,
      903,
      904,
      905,
      906,
    ]);
    expect(stopGates.size).toBe(6);

    stopGates.get(901)!.resolve({ status: "stopped" });
    stopGates.get(902)!.resolve({ status: "stopped" });
    stopGates.get(903)!.reject(new Error("RAW_ADAPTER_REJECTION"));
    stopGates.get(904)!.resolve({ status: "stopped" });
    stopGates.get(905)!.resolve({
      status: "failed",
      reason: "permission-denied",
      addressability: "safe",
    });
    stopGates.get(906)!.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });

    await expect(disposal).resolves.toBeUndefined();

    expect(alphaEntry.records.map(({ pid }) => pid)).toEqual([905]);
    expect(alphaEntry.records[0]?.owners.size).toBe(0);
    expect(alphaEntry.records[0]?.status).toBe("active");
    expect(alphaEntry.cleanupUnconfirmed).toBe(true);
    expect(alphaEntry.status).toBe("degraded");
    expect(dependencies.state.has('global:["beta",[]]')).toBe(false);
    expect(dependencies.state.has('global:["delta",[]]')).toBe(false);

    const rejectedEntry = dependencies.state.get('global:["gamma",[]]')!;
    expect(rejectedEntry.records.map(({ pid }) => pid)).toEqual([903]);
    expect(rejectedEntry.records[0]?.owners.size).toBe(0);
    expect(rejectedEntry.records[0]?.status).toBe("active");
    expect(rejectedEntry.cleanupUnconfirmed).toBe(false);
    expect(
      attemptedEvents.filter((event) => event.type === "command.stop-requested"),
    ).toHaveLength(6);
    expect(
      attemptedEvents.filter((event) => event.type === "command.stop-forced"),
    ).toEqual([
      {
        type: "command.stop-forced",
        scope: "global",
        index: 0,
        name: "Alpha",
        pid: 901,
        trigger: "scope-disposed",
      },
    ]);
    expect(
      attemptedEvents.filter((event) => event.type === "command.stop-failed"),
    ).toHaveLength(3);
    expect(JSON.stringify(attemptedEvents)).not.toContain(
      "RAW_ADAPTER_REJECTION",
    );
  });

  test("retains and reclaims an ownerless false record before restart", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102)],
      tree,
    );
    const persistent = globalCommand("helper", [], "Persistent", 0, {
      onExistingProcess: "skip",
      stopOnExit: false,
    });
    const first = await runStartupCommands([persistent], dependencies);
    const originalRecord = [...dependencies.state.values()][0]?.records[0];

    await first.dispose();
    expect(tree.calls).toHaveLength(0);
    expect(originalRecord?.owners.size).toBe(0);
    expect(dependencies.state.size).toBe(1);

    await runStartupCommands(
      [
        globalCommand("helper", [], "Reclaim", 0, {
          onExistingProcess: "skip",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    expect(dependencies.calls).toHaveLength(1);
    expect([...dependencies.state.values()][0]?.records[0]).toBe(originalRecord);
    expect(originalRecord?.owners.size).toBe(1);
    expect(originalRecord?.stopOnExit).toBe(false);

    await runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 0, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    expect(tree.calls.map(({ pid }) => pid)).toEqual([101]);
    expect(dependencies.calls).toHaveLength(2);
    expect([...dependencies.state.values()][0]?.records[0]?.pid).toBe(102);
  });

  test("reopens an identity after confirmed final cleanup", async () => {
    const tree = new FakeProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(101), new FakeChild(102)],
      tree,
    );
    const command = globalCommand("helper");
    const first = await runStartupCommands([command], dependencies);

    await first.dispose();
    expect(dependencies.state.size).toBe(0);

    await runStartupCommands([command], dependencies);

    expect(dependencies.calls).toHaveLength(2);
    expect([...dependencies.state.values()][0]?.records[0]?.pid).toBe(102);
  });

  test("never retains a failed stop result after the root exits", async () => {
    const child = new FakeChild(101);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies([child], tree);
    const activation = await runStartupCommands(
      [globalCommand("helper")],
      dependencies,
    );

    const cleanup = activation.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(tree.calls).toHaveLength(1);

    child.emitExit(0, null);
    tree.stops.get(101)!.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "safe",
    });
    await cleanup;

    const entry = [...dependencies.state.values()][0];
    expect(entry?.records).toEqual([]);
    expect(entry?.cleanupUnconfirmed).toBe(true);
    expect(entry?.status).toBe("degraded");
  });

  test("keeps a disposal stop authoritative in a stop/exit race", async () => {
    const child = new FakeChild(111);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies([child], tree);
    const activation = await runStartupCommands(
      [globalCommand("helper")],
      dependencies,
    );
    const entry = [...dependencies.state.values()][0]!;
    const record = entry.records[0]!;

    const cleanup = activation.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls).toHaveLength(1);
    expect(tree.calls[0]?.options.isRootExited()).toBe(false);

    child.emitExit(0, null);

    expect(record.rootExited).toBe(true);
    expect(tree.calls[0]?.options.isRootExited()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(tree.calls).toHaveLength(1);

    tree.stops.get(111)!.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "safe",
    });
    await cleanup;
    await entry.transitionTail;

    expect(tree.calls.map(({ pid }) => pid)).toEqual([111]);
    expect(entry.records).toEqual([]);
    expect(entry.cleanupUnconfirmed).toBe(true);
    expect(
      dependencies.logger.events.filter(
        (event) => event.type === "command.stop-requested",
      ),
    ).toEqual([
      {
        type: "command.stop-requested",
        scope: "global",
        index: 0,
        name: "Global command",
        pid: 111,
        trigger: "scope-disposed",
      },
    ]);
  });

  test("keeps a restart stop authoritative in a stop/exit race", async () => {
    const child = new FakeChild(121);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [child, new FakeChild(122)],
      tree,
    );
    await runStartupCommands([globalCommand("helper")], dependencies);
    const entry = [...dependencies.state.values()][0]!;

    const restart = runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls).toHaveLength(1);
    expect(tree.calls[0]?.options.isRootExited()).toBe(false);

    child.emitExit(0, null);

    expect(tree.calls[0]?.options.isRootExited()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(tree.calls).toHaveLength(1);

    tree.stops.get(121)!.resolve({ status: "stopped" });
    await restart;
    await entry.transitionTail;

    expect(tree.calls.map(({ pid }) => pid)).toEqual([121]);
    expect(entry.records.map(({ pid }) => pid)).toEqual([122]);
    expect(entry.retryTombstone).toBeUndefined();
  });

  test("ignores a stale old-child exit after successful restart", async () => {
    const oldChild = new FakeChild(131);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [oldChild, new FakeChild(132)],
      tree,
    );
    await runStartupCommands([globalCommand("helper")], dependencies);
    const entry = [...dependencies.state.values()][0]!;

    const restart = runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    tree.stops.get(131)!.resolve({ status: "stopped" });
    await restart;
    const replacement = entry.records[0]!;

    oldChild.emitExit(0, null);
    await entry.transitionTail;

    expect(tree.calls.map(({ pid }) => pid)).toEqual([131]);
    expect(entry.records).toEqual([replacement]);
    expect(replacement.pid).toBe(132);
    expect(entry.retryTombstone).toBeUndefined();
    expect(entry.cleanupUnconfirmed).toBe(false);
  });

  test("treats ordered arguments as part of the exact command signature", async () => {
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
    ]);

    await runStartupCommands(
      [
        globalCommand("tool", ["first", "second"]),
        globalCommand("tool", ["second", "first"], "Global command", 1),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(2);
    expect([...dependencies.state.keys()]).toEqual([
      'global:["tool",["first","second"]]',
      'global:["tool",["second","first"]]',
    ]);
  });

  test("suppresses exact duplicates in the current global-first command list", async () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([new FakeChild(201)]);

    await runStartupCommands(
      [
        globalCommand("tool", ["--same"], "Global winner"),
        globalCommand("tool", ["--same"], "Repeated global", 1),
        projectCommand(projectRoot, "tool", ["--same"], "Project duplicate"),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect([...dependencies.state.keys()]).toEqual([
      'global:["tool",["--same"]]',
    ]);
    expect([...dependencies.state.values()][0]?.records[0]?.owners.size).toBe(1);
    expect(dependencies.logger.events).toEqual([
      { type: "plugin.initialized", commandCount: 3 },
      {
        type: "command.skipped",
        scope: "global",
        index: 1,
        name: "Repeated global",
        reason: "duplicate",
      },
      {
        type: "command.skipped",
        scope: "project",
        index: 0,
        name: "Project duplicate",
        reason: "duplicate",
      },
      {
        type: "command.spawned",
        scope: "global",
        index: 0,
        name: "Global winner",
        pid: 201,
      },
    ]);
  });

  test("reports a same-project duplicate with its original index and name", async () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([new FakeChild(202)]);

    await runStartupCommands(
      [
        projectCommand(projectRoot, "tool", ["--same"], "Project winner"),
        projectCommand(
          projectRoot,
          "tool",
          ["--same"],
          "Repeated project",
          1,
        ),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.logger.events).toEqual([
      { type: "plugin.initialized", commandCount: 2 },
      {
        type: "command.skipped",
        scope: "project",
        index: 1,
        name: "Repeated project",
        reason: "duplicate",
      },
      {
        type: "command.spawned",
        scope: "project",
        index: 0,
        name: "Project winner",
        pid: 202,
      },
    ]);
  });

  test("processes globals first and lets an exact global duplicate win over an earlier project", async () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
      new FakeChild(),
      new FakeChild(),
      new FakeChild(),
    ]);

    await runStartupCommands(
      [
        projectCommand(projectRoot, "project-first", [], "Project first", 0),
        projectCommand(
          projectRoot,
          "shared",
          ["--same"],
          "Project duplicate",
          1,
        ),
        globalCommand("global-first", [], "Global first"),
        globalCommand("shared", ["--same"], "Global winner", 1),
        globalCommand("global-second", [], "Global second", 2),
        projectCommand(
          projectRoot,
          "project-second",
          [],
          "Project second",
          2,
        ),
      ],
      dependencies,
    );

    expect(dependencies.calls.map((call) => call[0])).toEqual([
      "global-first",
      "shared",
      "global-second",
      "project-first",
      "project-second",
    ]);
    expect(dependencies.calls[1]?.[2]).toEqual({
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(dependencies.logger.events).toContainEqual({
      type: "command.spawned",
      scope: "global",
      index: 1,
      name: "Global winner",
      pid: undefined,
    });
  });

  test("deduplicates the current list before checking process state so global still wins", async () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([new FakeChild()]);
    const command = globalCommand("tool", ["--same"]);

    await runStartupCommands([command], dependencies);
    await runStartupCommands(
      [command, projectCommand(projectRoot, "tool", ["--same"])],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect([...dependencies.state.keys()]).toEqual([
      'global:["tool",["--same"]]',
    ]);
    expect([...dependencies.state.values()][0]?.records[0]?.owners.size).toBe(2);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.skipped",
      scope: "project",
      index: 0,
      name: "Project command",
      reason: "duplicate",
    });
    expect(dependencies.logger.events).toContainEqual({
      type: "command.skipped",
      scope: "global",
      index: 0,
      name: "Global command",
      reason: "already-started",
    });
    expect(dependencies.logger.events.at(-1)).toEqual({
      type: "batch.skipped",
      reason: "already-started",
    });
  });

  test("starts the same global command once across repeated initialization", async () => {
    const dependencies = createDependencies([new FakeChild()]);
    const command = globalCommand(
      "launcher",
      ["--global"],
      "Global command",
      4,
    );

    await runStartupCommands([command], dependencies);
    await runStartupCommands([command], dependencies);

    expect(dependencies.calls).toHaveLength(1);
    expect([...dependencies.state.values()][0]?.records[0]?.owners.size).toBe(2);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.skipped",
      scope: "global",
      index: 4,
      name: "Global command",
      reason: "already-started",
    });
    expect(dependencies.logger.events.at(-1)).toEqual({
      type: "batch.skipped",
      reason: "already-started",
    });
  });

  test("starts the same project command once for equivalent normalized roots", async () => {
    const projectRoot = resolve("workspace", "project");
    const equivalentRoot = resolve(projectRoot, "nested", "..");
    const dependencies = createDependencies([new FakeChild()]);

    await runStartupCommands(
      [projectCommand(projectRoot, "launcher", ["--project"])],
      dependencies,
    );
    await runStartupCommands(
      [projectCommand(equivalentRoot, "launcher", ["--project"])],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.state.size).toBe(1);
    expect([...dependencies.state.values()][0]?.records[0]?.owners.size).toBe(2);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.skipped",
      scope: "project",
      index: 0,
      name: "Project command",
      reason: "already-started",
    });
  });

  test.skipIf(process.platform !== "win32")(
    "treats Windows project-root case variants as the same root",
    async () => {
      const projectRoot = resolve("workspace", "CaseSensitiveName");
      const dependencies = createDependencies([new FakeChild()]);

      await runStartupCommands(
        [projectCommand(projectRoot, "launcher")],
        dependencies,
      );
      await runStartupCommands(
        [projectCommand(projectRoot.toUpperCase(), "launcher")],
        dependencies,
      );

      expect(dependencies.calls).toHaveLength(1);
    },
  );

  test("starts identical project commands once in each different project root", async () => {
    const firstRoot = resolve("workspace", "first");
    const secondRoot = resolve("workspace", "second");
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
    ]);

    await runStartupCommands(
      [projectCommand(firstRoot, "launcher", ["--project"])],
      dependencies,
    );
    await runStartupCommands(
      [projectCommand(secondRoot, "launcher", ["--project"])],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(2);
    expect(dependencies.calls[0]?.[2]).toEqual({
      cwd: firstRoot,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(dependencies.calls[1]?.[2]).toEqual({
      cwd: secondRoot,
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  test("keeps identical project commands for different roots in the same batch", async () => {
    const firstRoot = resolve("workspace", "first");
    const secondRoot = resolve("workspace", "second");
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
    ]);

    await runStartupCommands(
      [
        projectCommand(firstRoot, "launcher", ["--project"]),
        projectCommand(
          secondRoot,
          "launcher",
          ["--project"],
          "Project command",
          1,
        ),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(2);
    expect(dependencies.calls.map((call) => call[2])).toEqual([
      {
        cwd: firstRoot,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
      {
        cwd: secondRoot,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    ]);
  });

  test("serializes concurrent empty skip activations into one record with two owners", async () => {
    const state = createStartupState();
    const logger = createLogger();
    const processTree = new FakeProcessTree();
    const calls: unknown[][] = [];
    const command = globalCommand("reentrant");
    const child = new FakeChild();
    let secondRun: ReturnType<typeof runStartupCommands> | undefined;
    let dependencies: {
      spawn: SpawnFunction;
      state: StartupState;
      processTree: ProcessTreeController;
      logger: Logger;
    };
    const spawn: SpawnFunction = (executable, args, options) => {
      calls.push([executable, args, options]);
      secondRun = runStartupCommands([command], dependencies);
      return child;
    };
    dependencies = { spawn, state, processTree, logger };

    await runStartupCommands([command], dependencies);
    await secondRun;

    expect(calls).toHaveLength(1);
    expect(child.unrefCalls).toBe(1);
    expect(state.size).toBe(1);
    expect([...state.values()][0]?.records).toHaveLength(1);
    expect([...state.values()][0]?.records[0]?.owners.size).toBe(2);
    expect(logger.events).toEqual([
      { type: "plugin.initialized", commandCount: 1 },
      { type: "plugin.initialized", commandCount: 1 },
      {
        type: "command.spawned",
        scope: "global",
        index: 0,
        name: "Global command",
        pid: undefined,
      },
      {
        type: "command.skipped",
        scope: "global",
        index: 0,
        name: "Global command",
        reason: "already-started",
      },
      { type: "batch.skipped", reason: "already-started" },
    ]);
  });

  test("orders restart before disposal and removes the inherited owner", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(801), new FakeChild(802)],
      tree,
    );
    const command = globalCommand("helper");
    const disposedActivation = await runStartupCommands(
      [command],
      dependencies,
    );
    await runStartupCommands([command], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const disposedOwner = [...entry.records[0]!.owners][0]!;

    const restart = runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls.map(({ pid }) => pid)).toEqual([801]);
    const disposal = disposedActivation.dispose();
    expect(entry.pendingTransitions).toBe(2);

    tree.stops.get(801)!.resolve({ status: "stopped" });
    await Promise.all([restart, disposal]);

    const replacement = entry.records[0]!;
    expect(replacement.pid).toBe(802);
    expect(replacement.owners.size).toBe(2);
    expect(replacement.owners.has(disposedOwner)).toBe(false);
    expect(tree.calls.map(({ pid }) => pid)).toEqual([801]);
  });

  test("orders disposal before restart and excludes the disposed owner", async () => {
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [new FakeChild(811), new FakeChild(812)],
      tree,
    );
    const command = globalCommand("helper");
    const disposedActivation = await runStartupCommands(
      [command],
      dependencies,
    );
    await runStartupCommands([command], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const disposedOwner = [...entry.records[0]!.owners][0]!;

    const disposal = disposedActivation.dispose();
    const restart = runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 1, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );
    await disposal;
    await Promise.resolve();
    await Promise.resolve();

    expect(tree.calls.map(({ pid }) => pid)).toEqual([811]);
    expect(entry.records[0]!.owners.has(disposedOwner)).toBe(false);

    tree.stops.get(811)!.resolve({ status: "stopped" });
    await Promise.all([disposal, restart]);

    const replacement = entry.records[0]!;
    expect(replacement.pid).toBe(812);
    expect(replacement.owners.size).toBe(2);
    expect(replacement.owners.has(disposedOwner)).toBe(false);
  });

  test("orders two gated empty skip activations into one spawn", async () => {
    const gate = deferred<void>();
    const processKey = 'global:["helper",[]]';
    const dependencies = createDependencies([new FakeChild(821)]);
    dependencies.state = createGatedIdentityState(processKey, gate.promise);
    const command = globalCommand("helper");

    const first = runStartupCommands([command], dependencies);
    const second = runStartupCommands([command], dependencies);
    await Promise.resolve();

    expect(dependencies.calls).toEqual([]);
    gate.resolve();
    await Promise.all([first, second]);

    const entry = dependencies.state.get(processKey)!;
    expect(dependencies.calls).toHaveLength(1);
    expect(entry.records).toHaveLength(1);
    expect(entry.records[0]?.pid).toBe(821);
    expect(entry.records[0]?.owners.size).toBe(2);
  });

  test("does not share queue state with a separately initiated key", async () => {
    const gate = deferred<void>();
    const blockedKey = 'global:["blocked",[]]';
    const dependencies = createDependencies([
      new FakeChild(832),
      new FakeChild(831),
    ]);
    dependencies.state = createGatedIdentityState(blockedKey, gate.promise);
    let blockedSettled = false;

    const blocked = runStartupCommands(
      [globalCommand("blocked")],
      dependencies,
    ).then((activation) => {
      blockedSettled = true;
      return activation;
    });
    const independent = runStartupCommands(
      [globalCommand("independent")],
      dependencies,
    );

    await independent;

    expect(blockedSettled).toBe(false);
    expect(dependencies.calls.map(([executable]) => executable)).toEqual([
      "independent",
    ]);

    gate.resolve();
    await blocked;

    expect(dependencies.calls.map(([executable]) => executable)).toEqual([
      "independent",
      "blocked",
    ]);
    expect(
      [...dependencies.state.values()].map(({ records }) => records[0]?.pid),
    ).toEqual([831, 832]);
  });

  test("does not retry after synchronous spawn failure and continues the batch", async () => {
    const logger = createLogger();
    const state = createStartupState();
    const processTree = new FakeProcessTree();
    const calls: unknown[][] = [];
    const secondChild = new FakeChild();
    const secret = "SYNC_SECRET_VALUE";
    const error = Object.assign(new Error(`spawn failed: ${secret}`), {
      code: "ENOENT",
    });
    const spawn: SpawnFunction = (executable, args, options) => {
      calls.push([executable, args, options]);

      if (executable.includes("first")) {
        throw error;
      }

      return secondChild;
    };
    const commands = [
      globalCommand(
        `C:\\${secret}\\first.exe`,
        [`--token=${secret}`],
        "First",
        3,
      ),
      globalCommand("second.exe", [], "Second", 4),
    ];
    const dependencies = { spawn, state, processTree, logger };

    await runStartupCommands(commands, dependencies);
    await runStartupCommands([commands[0]!], dependencies);

    expect(calls).toHaveLength(2);
    expect(secondChild.unrefCalls).toBe(1);
    expect(state.size).toBe(2);
    expect([...state.values()]).toContainEqual(
      expect.objectContaining({
        records: [],
        retryTombstone: "spawn-failed",
      }),
    );
    expect(logger.events).toContainEqual({
      type: "command.spawn-failed",
      scope: "global",
      index: 3,
      name: "First",
      code: "ENOENT",
    });
    expect(JSON.stringify(logger.events)).not.toContain(secret);
  });

  test("removes a final pre-PID child error and records a spawn tombstone", async () => {
    const child = new FakeChild();
    const dependencies = createDependencies([child]);

    await runStartupCommands([globalCommand("helper")], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const attemptedRecord = entry.records[0];

    child.emitError(Object.assign(new Error("launch failed"), { code: "ENOENT" }));
    await entry.transitionTail;

    expect(attemptedRecord).toBeDefined();
    expect(entry.records).toEqual([]);
    expect(entry.retryTombstone).toBe("spawn-failed");
    expect(dependencies.logger.events).toContainEqual({
      type: "command.child-error",
      scope: "global",
      index: 0,
      name: "Global command",
      code: "ENOENT",
    });
  });

  test("keeps a post-PID child error diagnostic until process cleanup", async () => {
    const child = new FakeChild(201);
    const dependencies = createDependencies([child]);

    await runStartupCommands([globalCommand("helper")], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const record = entry.records[0];

    child.emitError(new Error("runtime failure"));
    await entry.transitionTail;

    expect(entry.records).toEqual([record]);
    expect(entry.retryTombstone).toBeUndefined();
    expect(dependencies.logger.events).toContainEqual({
      type: "command.child-error",
      scope: "global",
      index: 0,
      name: "Global command",
      code: undefined,
    });
  });

  test("removes only the attempted sibling after a pre-PID child error", async () => {
    const survivor = new FakeChild(201);
    const failedChild = new FakeChild();
    const dependencies = createDependencies([survivor, failedChild]);
    const command = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });

    await runStartupCommands([command], dependencies);
    await runStartupCommands([command], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const survivorRecord = entry.records[0];
    const attemptedRecord = entry.records[1];

    failedChild.emitError(new Error("launch failed"));
    await entry.transitionTail;

    expect(entry.records).toEqual([survivorRecord]);
    expect(entry.records).not.toContain(attemptedRecord);
    expect(entry.retryTombstone).toBeUndefined();
  });

  test("cleans residual processes and tombstones a final natural exit", async () => {
    const child = new FakeChild(301);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies([child], tree);

    await runStartupCommands(
      [
        globalCommand("helper", [], "Helper", 0, {
          onExistingProcess: "skip",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    const entry = [...dependencies.state.values()][0]!;
    const record = entry.records[0]!;

    child.emitExit(0, null);

    expect(record.rootExited).toBe(true);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.exited",
      scope: "global",
      index: 0,
      name: "Helper",
      exitCode: 0,
      signal: null,
    });
    await Promise.resolve();
    await Promise.resolve();

    const stop = tree.stops.get(301);
    expect(tree.calls).toHaveLength(1);
    expect(stop).toBeDefined();
    expect(tree.calls[0]?.options.isRootExited()).toBe(true);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.stop-requested",
      scope: "global",
      index: 0,
      name: "Helper",
      pid: 301,
      trigger: "root-exited",
    });

    stop?.resolve({ status: "stopped" });
    await entry.transitionTail;

    expect(entry.records).toEqual([]);
    expect(entry.retryTombstone).toBe("natural-exit");
    expect(entry.cleanupUnconfirmed).toBe(false);
  });

  test("never reuses a PID after unconfirmed final natural exit cleanup", async () => {
    const child = new FakeChild(302);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [child, new FakeChild(303)],
      tree,
    );
    const command = globalCommand("helper");
    const activation = await runStartupCommands([command], dependencies);
    const entry = [...dependencies.state.values()][0]!;

    child.emitExit(1, null);
    await Promise.resolve();
    await Promise.resolve();

    const stop = tree.stops.get(302);
    expect(stop).toBeDefined();
    stop?.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    await entry.transitionTail;

    expect(entry.records).toEqual([]);
    expect(entry.retryTombstone).toBe("natural-exit");
    expect(entry.cleanupUnconfirmed).toBe(true);
    expect(entry.status).toBe("degraded");

    await activation.dispose();
    await runStartupCommands([command], dependencies);

    expect(tree.calls.map(({ pid }) => pid)).toEqual([302]);
    expect(dependencies.calls).toHaveLength(1);
    expect(entry.records).toEqual([]);
  });

  test("continues all policies after confirmed sibling natural exit cleanup", async () => {
    const exitedChild = new FakeChild(401);
    const survivor = new FakeChild(402);
    const tree = new FakeProcessTree();
    const dependencies = createDependencies(
      [exitedChild, survivor, new FakeChild(403), new FakeChild(404)],
      tree,
    );
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });

    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const survivorRecord = entry.records[1]!;

    exitedChild.emitExit(0, null);
    await entry.transitionTail;

    expect(entry.records).toEqual([survivorRecord]);
    expect(entry.retryTombstone).toBeUndefined();
    expect(entry.cleanupUnconfirmed).toBe(false);

    await runStartupCommands([start], dependencies);
    await runStartupCommands(
      [
        globalCommand("helper", [], "Skip", 1, {
          onExistingProcess: "skip",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );

    expect(entry.records.map(({ pid }) => pid)).toEqual([402, 403]);
    expect(survivorRecord.owners.size).toBe(2);

    await runStartupCommands(
      [
        globalCommand("helper", [], "Restart", 2, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    expect(tree.calls.map(({ pid }) => pid)).toEqual([401, 402, 403]);
    expect(entry.records.map(({ pid }) => pid)).toEqual([404]);
  });

  test("blocks only restart after unconfirmed sibling natural exit cleanup", async () => {
    const exitedChild = new FakeChild(501);
    const survivor = new FakeChild(502);
    const tree = new DeferredProcessTree();
    const dependencies = createDependencies(
      [exitedChild, survivor, new FakeChild(503)],
      tree,
    );
    const start = globalCommand("helper", [], "Helper", 0, {
      onExistingProcess: "start",
      stopOnExit: true,
    });

    await runStartupCommands([start], dependencies);
    await runStartupCommands([start], dependencies);
    const entry = [...dependencies.state.values()][0]!;
    const survivorRecord = entry.records[1]!;

    exitedChild.emitExit(0, null);
    await Promise.resolve();
    await Promise.resolve();

    const stop = tree.stops.get(501);
    expect(stop).toBeDefined();
    stop?.resolve({
      status: "failed",
      reason: "unconfirmed",
      addressability: "lost",
    });
    await entry.transitionTail;

    expect(entry.records).toEqual([survivorRecord]);
    expect(entry.retryTombstone).toBeUndefined();
    expect(entry.cleanupUnconfirmed).toBe(true);

    await runStartupCommands([start], dependencies);
    await runStartupCommands(
      [
        globalCommand("helper", [], "Skip", 1, {
          onExistingProcess: "skip",
          stopOnExit: false,
        }),
      ],
      dependencies,
    );
    await runStartupCommands(
      [
        globalCommand("helper", [], "Blocked restart", 2, {
          onExistingProcess: "restart",
          stopOnExit: true,
        }),
      ],
      dependencies,
    );

    expect(tree.calls.map(({ pid }) => pid)).toEqual([501]);
    expect(dependencies.calls).toHaveLength(3);
    expect(entry.records.map(({ pid }) => pid)).toEqual([502, 503]);
    expect(survivorRecord.owners.size).toBe(2);
    expect(entry.status).toBe("degraded");
  });

  test("contains logger failures during synchronous and asynchronous lifecycle logging", async () => {
    const child = new FakeChild(505);
    const attemptedEvents: LogEvent[] = [];
    const calls: unknown[][] = [];
    const logger: Logger = {
      write(event): void {
        attemptedEvents.push(event);
        throw new Error("Test logger failure");
      },
    };
    const dependencies = {
      spawn: createSpawn([child], calls),
      state: createStartupState(),
      processTree: new FakeProcessTree(),
      logger,
    };

    await expect(
      runStartupCommands([globalCommand("logger-failure")], dependencies),
    ).resolves.toBeDefined();
    expect(() => child.emitError(new Error("child failure"))).not.toThrow();
    expect(() => child.emitExit(0, null)).not.toThrow();
    await expect(
      runStartupCommands(
        [
          globalCommand("logger-failure"),
          globalCommand("logger-failure", [], "Repeated command", 1),
        ],
        dependencies,
      ),
    ).resolves.toBeDefined();

    expect(calls).toHaveLength(1);
    expect(child.unrefCalls).toBe(1);
    expect(attemptedEvents.map(({ type }) => type)).toEqual([
      "plugin.initialized",
      "command.spawned",
      "command.child-error",
      "command.exited",
      "plugin.initialized",
      "command.skipped",
      "command.stop-requested",
      "command.skipped",
      "batch.skipped",
    ]);
  });

  test("guards listener registration without reporting a successful spawn as failed", async () => {
    const child = new FakeChild(606, { throwOnOnce: true });
    const dependencies = createDependencies([child]);

    await expect(
      runStartupCommands([globalCommand("once-failure")], dependencies),
    ).resolves.toBeDefined();

    expect(child.onceCalls).toEqual(["error", "exit"]);
    expect(child.unrefCalls).toBe(1);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.spawned",
      scope: "global",
      index: 0,
      name: "Global command",
      pid: 606,
    });
    expect(dependencies.logger.events).not.toContainEqual(
      expect.objectContaining({ type: "command.spawn-failed" }),
    );
  });

  test("guards unref without reporting a successful spawn as failed", async () => {
    const child = new FakeChild(707, { throwOnUnref: true });
    const dependencies = createDependencies([child]);

    await expect(
      runStartupCommands([globalCommand("unref-failure")], dependencies),
    ).resolves.toBeDefined();

    expect(child.unrefCalls).toBe(1);
    expect(dependencies.logger.events).toContainEqual({
      type: "command.spawned",
      scope: "global",
      index: 0,
      name: "Global command",
      pid: 707,
    });
    expect(dependencies.logger.events).not.toContainEqual(
      expect.objectContaining({ type: "command.spawn-failed" }),
    );
  });

  test("logs PID, sanitized child errors, and exit lifecycle without unsafe command data", async () => {
    const child = new FakeChild(404);
    const dependencies = createDependencies([child]);
    const secret = "ASYNC_SECRET_VALUE";

    await runStartupCommands(
      [
        globalCommand(
          `C:\\${secret}\\launcher.exe`,
          [`--token=${secret}`],
          "Safe command name",
          6,
        ),
      ],
      dependencies,
    );
    child.emitError(
      Object.assign(new Error(`child emitted error: ${secret}`), {
        code: `SECRET_CODE_${secret}`,
      }),
    );
    child.emitExit(null, "SIGTERM");
    child.emitError(new Error("second error must not be observed"));
    child.emitExit(1, "SIGKILL");

    expect(dependencies.logger.events).toEqual([
      { type: "plugin.initialized", commandCount: 1 },
      {
        type: "command.spawned",
        scope: "global",
        index: 6,
        name: "Safe command name",
        pid: 404,
      },
      {
        type: "command.child-error",
        scope: "global",
        index: 6,
        name: "Safe command name",
        code: undefined,
      },
      {
        type: "command.exited",
        scope: "global",
        index: 6,
        name: "Safe command name",
        exitCode: null,
        signal: "SIGTERM",
      },
    ]);
    expect(JSON.stringify(dependencies.logger.events)).not.toContain(secret);
  });
});
