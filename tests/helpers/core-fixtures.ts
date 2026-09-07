import type { ConfiguredCommand } from "../../src/config.js";
import {
  createStartupState,
  type SpawnFunction,
  type SpawnedChild,
  type StartupState,
} from "../../src/core.js";
import type {
  DurableLockResult,
  DurableReadResult,
  DurableRecord,
  DurableRegistry,
} from "../../src/durable-registry.js";
import type { LogEvent, Logger } from "../../src/logger.js";
import type { ProcessIdentityController } from "../../src/process-identity.js";
import type {
  ProcessTreeController,
  ProcessTreeStopOptions,
  ProcessTreeStopResult,
} from "../../src/process-tree.js";

export class FakeChild implements SpawnedChild {
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

export class FakeProcessTree implements ProcessTreeController {
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

export function deferred<T>(): {
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

export class DeferredProcessTree implements ProcessTreeController {
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

export function globalCommand(
  executable: string,
  args: string[] = [],
  name = "Global command",
  index = 0,
  policies: CommandPolicies = DEFAULT_POLICIES,
): ConfiguredCommand {
  return { name, executable, args, ...policies, scope: "global", index };
}

export function projectCommand(
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

export function createLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];

  return {
    events,
    write(event): void {
      events.push(event);
    },
  };
}

export function createSpawn(
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

export function createDependencies(
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

export function createGatedIdentityState(
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

export function seedAdopted(
  state: StartupState,
  processKey: string,
  pid: number,
  startToken: string,
): void {
  state.set(processKey, {
    processKey,
    records: [
      {
        origin: "adopted",
        pid,
        startToken,
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
  } as never);
}

export class FakeRegistry implements DurableRegistry {
  public readonly writes: DurableRecord[][] = [];
  public releases = 0;
  public acquireCalls = 0;

  public constructor(
    private readonly readResult: DurableReadResult = {
      status: "loaded",
      records: [],
    },
    private readonly lockAvailable = true,
    private readonly fileExists = true,
  ) {}

  public hashIdentity(signature: string): string {
    return `identity-${signature}`;
  }

  public hashProjectRoot(normalizedRoot: string): string {
    return `root-${normalizedRoot}`;
  }

  public exists(): boolean {
    return this.fileExists;
  }

  public read(): DurableReadResult {
    return this.readResult;
  }

  public write(records: readonly DurableRecord[]): boolean {
    this.writes.push([...records]);
    return true;
  }

  public async acquireLock(): Promise<DurableLockResult> {
    this.acquireCalls += 1;
    if (!this.lockAvailable) {
      return { status: "unavailable" };
    }
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

export class RoundTrippingRegistry implements DurableRegistry {
  private records: DurableRecord[] = [];
  public readonly writes: DurableRecord[][] = [];
  public releases = 0;

  public hashIdentity(signature: string): string {
    return `identity-${signature}`;
  }

  public hashProjectRoot(normalizedRoot: string): string {
    return `root-${normalizedRoot}`;
  }

  public exists(): boolean {
    return this.writes.length > 0;
  }

  public read(): DurableReadResult {
    return { status: "loaded", records: [...this.records] };
  }

  public write(records: readonly DurableRecord[]): boolean {
    this.records = [...records];
    this.writes.push([...records]);
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

export function aliveIdentity(token = "linux1:boot-a:11"): ProcessIdentityController {
  return {
    async describe() {
      return { status: "described" as const, token };
    },
    async probe() {
      return { status: "alive" as const };
    },
  };
}

const HELPER_IDENTITY = `identity-${JSON.stringify(["helper", []])}`;

export function persistedRecord(
  overrides: Partial<
    Pick<
      DurableRecord,
      "identityHash" | "pid" | "startToken" | "creationOrder" | "recordedAt"
    >
  > = {},
): DurableRecord {
  return {
    scope: "global",
    identityHash: HELPER_IDENTITY,
    pid: 4242,
    startToken: "linux1:boot-a:11",
    stopOnExit: false,
    creationOrder: 0,
    recordedAt: "2026-09-03T01:46:57.997Z",
    ...overrides,
  };
}

export function orphanRecord(
  overrides: Partial<
    Pick<
      DurableRecord,
      "identityHash" | "pid" | "startToken" | "creationOrder" | "recordedAt"
    >
  > = {},
): DurableRecord {
  return {
    scope: "global",
    identityHash: `identity-${JSON.stringify(["orphan-tool", []])}`,
    pid: 7777,
    startToken: "linux1:boot-a:99",
    stopOnExit: false,
    creationOrder: 0,
    recordedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}
