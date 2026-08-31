import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ConfiguredCommand } from "../src/config.js";
import {
  getOrCreateProcessState,
  runStartupCommands,
  type SpawnFunction,
  type SpawnedChild,
  type StartupState,
} from "../src/core.js";
import type { LogEvent, Logger } from "../src/logger.js";

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

function globalCommand(
  executable: string,
  args: string[] = [],
  name = "Global command",
  index = 0,
): ConfiguredCommand {
  return { name, executable, args, scope: "global", index };
}

function projectCommand(
  projectRoot: string,
  executable: string,
  args: string[] = [],
  name = "Project command",
  index = 0,
): ConfiguredCommand {
  return {
    name,
    executable,
    args,
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
): {
  calls: unknown[][];
  logger: Logger & { events: LogEvent[] };
  state: StartupState;
  spawn: SpawnFunction;
} {
  const calls: unknown[][] = [];

  return {
    calls,
    logger: createLogger(),
    state: { started: new Set<string>() },
    spawn: createSpawn(children, calls),
  };
}

describe("getOrCreateProcessState", () => {
  const stateKey = Symbol.for("opencode.startup-commands.state");

  test("creates and stores a new state when none exists", () => {
    const registry: Record<symbol, unknown> = {};

    const state = getOrCreateProcessState(registry);

    expect(state.started).toEqual(new Set<string>());
    expect(registry[stateKey]).toBe(state);
  });

  test("reuses an existing state containing a string Set", () => {
    const existing: StartupState = { started: new Set(["global:signature"]) };
    const registry: Record<symbol, unknown> = { [stateKey]: existing };

    expect(getOrCreateProcessState(registry)).toBe(existing);
  });

  test.each([
    null,
    {},
    { started: false },
    { started: { has(): boolean { return false; } } },
    { started: new Set<unknown>([1]) },
  ])("replaces malformed process state: %p", (malformedState) => {
    const registry: Record<symbol, unknown> = {
      [stateKey]: malformedState,
    };

    const state = getOrCreateProcessState(registry);

    expect(state).not.toBe(malformedState);
    expect(state.started).toEqual(new Set<string>());
    expect(registry[stateKey]).toBe(state);
  });
});

describe("runStartupCommands", () => {
  test("launches global commands before project commands with scope-specific cwd", () => {
    const firstChild = new FakeChild(101);
    const secondChild = new FakeChild(102);
    const dependencies = createDependencies([firstChild, secondChild]);
    const projectRoot = resolve("workspace", "project");

    runStartupCommands(
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
          detached: false,
          stdio: "ignore",
          windowsHide: true,
        },
      ],
      [
        "project-tool",
        ["--watch"],
        {
          cwd: projectRoot,
          detached: false,
          stdio: "ignore",
          windowsHide: true,
        },
      ],
    ]);
    expect(firstChild.unrefCalls).toBe(1);
    expect(secondChild.unrefCalls).toBe(1);
    expect(dependencies.state.started).toHaveLength(2);
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

  test("treats ordered arguments as part of the exact command signature", () => {
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
    ]);

    runStartupCommands(
      [
        globalCommand("tool", ["first", "second"]),
        globalCommand("tool", ["second", "first"], "Global command", 1),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(2);
    expect(dependencies.state.started).toEqual(
      new Set([
        'global:["tool",["first","second"]]',
        'global:["tool",["second","first"]]',
      ]),
    );
  });

  test("suppresses exact duplicates in the current global-first command list", () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([new FakeChild(201)]);

    runStartupCommands(
      [
        globalCommand("tool", ["--same"], "Global winner"),
        globalCommand("tool", ["--same"], "Repeated global", 1),
        projectCommand(projectRoot, "tool", ["--same"], "Project duplicate"),
      ],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.state.started).toEqual(
      new Set(['global:["tool",["--same"]]']),
    );
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

  test("reports a same-project duplicate with its original index and name", () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([new FakeChild(202)]);

    runStartupCommands(
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

  test("processes globals first and lets an exact global duplicate win over an earlier project", () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
      new FakeChild(),
      new FakeChild(),
      new FakeChild(),
    ]);

    runStartupCommands(
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
      detached: false,
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

  test("deduplicates the current list before checking process state so global still wins", () => {
    const projectRoot = resolve("workspace", "project");
    const dependencies = createDependencies([new FakeChild()]);
    const command = globalCommand("tool", ["--same"]);

    runStartupCommands([command], dependencies);
    runStartupCommands(
      [command, projectCommand(projectRoot, "tool", ["--same"])],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
    expect(dependencies.state.started).toEqual(
      new Set(['global:["tool",["--same"]]']),
    );
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

  test("starts the same global command once across repeated initialization", () => {
    const dependencies = createDependencies([new FakeChild()]);
    const command = globalCommand(
      "launcher",
      ["--global"],
      "Global command",
      4,
    );

    runStartupCommands([command], dependencies);
    runStartupCommands([command], dependencies);

    expect(dependencies.calls).toHaveLength(1);
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

  test("starts the same project command once for equivalent normalized roots", () => {
    const projectRoot = resolve("workspace", "project");
    const equivalentRoot = resolve(projectRoot, "nested", "..");
    const dependencies = createDependencies([new FakeChild()]);

    runStartupCommands(
      [projectCommand(projectRoot, "launcher", ["--project"])],
      dependencies,
    );
    runStartupCommands(
      [projectCommand(equivalentRoot, "launcher", ["--project"])],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(1);
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
    () => {
      const projectRoot = resolve("workspace", "CaseSensitiveName");
      const dependencies = createDependencies([new FakeChild()]);

      runStartupCommands(
        [projectCommand(projectRoot, "launcher")],
        dependencies,
      );
      runStartupCommands(
        [projectCommand(projectRoot.toUpperCase(), "launcher")],
        dependencies,
      );

      expect(dependencies.calls).toHaveLength(1);
    },
  );

  test("starts identical project commands once in each different project root", () => {
    const firstRoot = resolve("workspace", "first");
    const secondRoot = resolve("workspace", "second");
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
    ]);

    runStartupCommands(
      [projectCommand(firstRoot, "launcher", ["--project"])],
      dependencies,
    );
    runStartupCommands(
      [projectCommand(secondRoot, "launcher", ["--project"])],
      dependencies,
    );

    expect(dependencies.calls).toHaveLength(2);
    expect(dependencies.calls[0]?.[2]).toEqual({
      cwd: firstRoot,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(dependencies.calls[1]?.[2]).toEqual({
      cwd: secondRoot,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  test("keeps identical project commands for different roots in the same batch", () => {
    const firstRoot = resolve("workspace", "first");
    const secondRoot = resolve("workspace", "second");
    const dependencies = createDependencies([
      new FakeChild(),
      new FakeChild(),
    ]);

    runStartupCommands(
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
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      },
      {
        cwd: secondRoot,
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      },
    ]);
  });

  test("inserts the identity before spawn so a concurrent reentrant run is suppressed", () => {
    const state: StartupState = { started: new Set<string>() };
    const logger = createLogger();
    const calls: unknown[][] = [];
    const command = globalCommand("reentrant");
    const child = new FakeChild();
    let dependencies: {
      spawn: SpawnFunction;
      state: StartupState;
      logger: Logger;
    };
    const spawn: SpawnFunction = (executable, args, options) => {
      calls.push([executable, args, options]);
      runStartupCommands([command], dependencies);
      return child;
    };
    dependencies = { spawn, state, logger };

    runStartupCommands([command], dependencies);

    expect(calls).toHaveLength(1);
    expect(child.unrefCalls).toBe(1);
    expect(logger.events).toEqual([
      { type: "plugin.initialized", commandCount: 1 },
      { type: "plugin.initialized", commandCount: 1 },
      {
        type: "command.skipped",
        scope: "global",
        index: 0,
        name: "Global command",
        reason: "already-started",
      },
      { type: "batch.skipped", reason: "already-started" },
      {
        type: "command.spawned",
        scope: "global",
        index: 0,
        name: "Global command",
        pid: undefined,
      },
    ]);
  });

  test("does not retry after synchronous spawn failure and continues the batch", () => {
    const logger = createLogger();
    const state: StartupState = { started: new Set<string>() };
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
    const dependencies = { spawn, state, logger };

    runStartupCommands(commands, dependencies);
    runStartupCommands([commands[0]!], dependencies);

    expect(calls).toHaveLength(2);
    expect(secondChild.unrefCalls).toBe(1);
    expect(logger.events).toContainEqual({
      type: "command.spawn-failed",
      scope: "global",
      index: 3,
      name: "First",
      code: "ENOENT",
    });
    expect(JSON.stringify(logger.events)).not.toContain(secret);
  });

  test("contains logger failures during synchronous and asynchronous lifecycle logging", () => {
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
      state: { started: new Set<string>() },
      logger,
    };

    expect(() =>
      runStartupCommands([globalCommand("logger-failure")], dependencies),
    ).not.toThrow();
    expect(() => child.emitError(new Error("child failure"))).not.toThrow();
    expect(() => child.emitExit(0, null)).not.toThrow();
    expect(() =>
      runStartupCommands(
        [
          globalCommand("logger-failure"),
          globalCommand("logger-failure", [], "Repeated command", 1),
        ],
        dependencies,
      ),
    ).not.toThrow();

    expect(calls).toHaveLength(1);
    expect(child.unrefCalls).toBe(1);
    expect(attemptedEvents.map(({ type }) => type)).toEqual([
      "plugin.initialized",
      "command.spawned",
      "command.child-error",
      "command.exited",
      "plugin.initialized",
      "command.skipped",
      "command.skipped",
      "batch.skipped",
    ]);
  });

  test("guards listener registration without reporting a successful spawn as failed", () => {
    const child = new FakeChild(606, { throwOnOnce: true });
    const dependencies = createDependencies([child]);

    expect(() =>
      runStartupCommands([globalCommand("once-failure")], dependencies),
    ).not.toThrow();

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

  test("guards unref without reporting a successful spawn as failed", () => {
    const child = new FakeChild(707, { throwOnUnref: true });
    const dependencies = createDependencies([child]);

    expect(() =>
      runStartupCommands([globalCommand("unref-failure")], dependencies),
    ).not.toThrow();

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

  test("logs PID, sanitized child errors, and exit lifecycle without unsafe command data", () => {
    const child = new FakeChild(404);
    const dependencies = createDependencies([child]);
    const secret = "ASYNC_SECRET_VALUE";

    runStartupCommands(
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
