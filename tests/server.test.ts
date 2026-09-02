import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import type {
  ConfigLoadResult,
  ConfiguredCommand,
} from "../src/config.js";
import {
  createStartupState,
  type SpawnedChild,
  type StartupSpawnOptions,
} from "../src/core.js";
import type { DurableRecord, DurableRegistry } from "../src/durable-registry.js";
import type { LogEvent, Logger } from "../src/logger.js";
import type { ProcessIdentityController } from "../src/process-identity.js";
import type {
  ProcessTreeController,
  ProcessTreeStopResult,
} from "../src/process-tree.js";
import {
  createStartupCommandsServer,
  type StartupCommandsServerDependencies,
} from "../src/server-internal.js";
import serverModule from "../src/server.js";

const input = {
  worktree: "project-root",
} as PluginInput;

interface FixtureOptions {
  logger?: Logger;
  pids?: readonly number[];
  stop?: ProcessTreeController["stop"];
  registry?: DurableRegistry;
  identity?: ProcessIdentityController;
  resolveOwnerIdentity?: StartupCommandsServerDependencies["resolveOwnerIdentity"];
}

function createFixture(options?: FixtureOptions) {
  const events: LogEvent[] = [];
  const configCalls: unknown[][] = [];
  const stopCalls: Array<number | undefined> = [];
  const spawnCalls: Array<{
    executable: string;
    args: string[];
    options: StartupSpawnOptions;
  }> = [];
  const state = createStartupState();
  const processTree: ProcessTreeController = {
    async stop(pid, stopOptions): Promise<ProcessTreeStopResult> {
      stopCalls.push(pid);
      if (options?.stop) {
        return options.stop(pid, stopOptions);
      }
      return { status: "stopped" };
    },
  };
  let globalConfig: ConfigLoadResult = { commands: [], diagnostics: [] };
  let projectConfig: ConfigLoadResult = { commands: [], diagnostics: [] };

  function loadConfigFile(
    scope: "global",
    filePath: string,
  ): ConfigLoadResult;
  function loadConfigFile(
    scope: "project",
    filePath: string,
    projectRoot: string,
  ): ConfigLoadResult;
  function loadConfigFile(
    scope: "global" | "project",
    filePath: string,
    projectRoot?: string,
  ): ConfigLoadResult {
    configCalls.push(["load", scope, filePath, projectRoot]);
    return scope === "global" ? globalConfig : projectConfig;
  }

  const dependencies: StartupCommandsServerDependencies = {
    loadConfigFile,
    resolveGlobalConfigPath(): string {
      configCalls.push(["resolve-global"]);
      return "global-config";
    },
    resolveProjectConfigPath(worktree: string): string {
      configCalls.push(["resolve-project", worktree]);
      return "project-config";
    },
    spawn(
      executable: string,
      args: string[],
      spawnOptions: StartupSpawnOptions,
    ): SpawnedChild {
      const pid = options?.pids?.[spawnCalls.length] ?? 1234;
      spawnCalls.push({ executable, args, options: spawnOptions });

      const child: SpawnedChild = {
        pid,
        once(): SpawnedChild {
          return child;
        },
        unref(): void {},
      };

      return child;
    },
    state,
    processTree,
    logger:
      options?.logger ??
      {
        write(event: LogEvent): void {
          events.push(event);
        },
      },
    registry: options?.registry,
    identity: options?.identity,
    resolveOwnerIdentity: options?.resolveOwnerIdentity,
  };

  return {
    configCalls,
    events,
    processTree,
    spawnCalls,
    state,
    stopCalls,
    server: createStartupCommandsServer(dependencies),
    setGlobalConfig(config: ConfigLoadResult): void {
      globalConfig = config;
    },
    setProjectConfig(config: ConfigLoadResult): void {
      projectConfig = config;
    },
  };
}

function globalCommand(executable = "global-helper"): ConfiguredCommand {
  return {
    name: "Global helper",
    executable,
    args: [],
    onExistingProcess: "skip",
    stopOnExit: true,
    scope: "global",
    index: 0,
  };
}

function projectCommand(
  projectRoot: string,
  executable = "project-helper",
): ConfiguredCommand {
  return {
    name: "Project helper",
    executable,
    args: [],
    onExistingProcess: "skip",
    stopOnExit: true,
    scope: "project",
    projectRoot,
    index: 0,
  };
}

test("package adapter exposes only a compatible default export", async () => {
  const importedModule = await import("../src/server.js");

  expect(Object.keys(importedModule)).toEqual(["default"]);
  expect(serverModule.id).toBe("opencode-startup-commands");
  expect(typeof serverModule.server).toBe("function");
  expect("setup" in serverModule).toBe(false);
});

test("production adapter owns one process-tree controller and no host exit listeners", async () => {
  const [serverSource, internalSource] = await Promise.all([
    Bun.file(new URL("../src/server.ts", import.meta.url)).text(),
    Bun.file(new URL("../src/server-internal.ts", import.meta.url)).text(),
  ]);
  const hostExitListener =
    /process\.(?:on|once|addListener)\(\s*["'](?:SIGINT|SIGTERM|beforeExit|exit)["']/;

  expect(
    serverSource.match(/processTree:\s*createProcessTreeController\(\)/g),
  ).toHaveLength(1);
  expect(serverSource.match(/state:\s*processState/g)).toHaveLength(1);
  expect(serverSource.match(/logger:\s*createLogger\(\)/g)).toHaveLength(1);
  expect(serverSource).not.toMatch(hostExitListener);
  expect(internalSource).not.toMatch(hostExitListener);
});

test("preserves scope-local config indexes through adapter lifecycle events", async () => {
  const fixture = createFixture();
  fixture.setGlobalConfig({
    commands: [
      {
        name: "Global helper",
        executable: "global-helper",
        args: ["--global"],
        onExistingProcess: "skip",
        stopOnExit: true,
        scope: "global",
        index: 1,
      },
      {
        name: "Second global helper",
        executable: "second-global-helper",
        args: [],
        onExistingProcess: "skip",
        stopOnExit: true,
        scope: "global",
        index: 2,
      },
    ],
    diagnostics: [
      {
        scope: "global",
        reason: "invalid-command",
        index: 0,
        name: "Invalid global helper",
      },
    ],
  });
  fixture.setProjectConfig({
    commands: [
      {
        name: "Project helper",
        executable: "project-helper",
        args: ["--project"],
        onExistingProcess: "skip",
        stopOnExit: true,
        scope: "project",
        projectRoot: input.worktree,
        index: 1,
      },
    ],
    diagnostics: [
      {
        scope: "project",
        reason: "invalid-command",
        index: 0,
        name: "Invalid project helper",
      },
    ],
  });

  const hooks = await fixture.server.server(input);

  expect(fixture.configCalls).toEqual([
    ["resolve-global"],
    ["load", "global", "global-config", undefined],
    ["resolve-project", input.worktree],
    ["load", "project", "project-config", input.worktree],
  ]);
  expect(fixture.events).toEqual([
    {
      type: "command.invalid",
      scope: "global",
      index: 0,
      name: "Invalid global helper",
    },
    {
      type: "command.invalid",
      scope: "project",
      index: 0,
      name: "Invalid project helper",
    },
    { type: "plugin.initialized", commandCount: 3 },
    {
      type: "command.spawned",
      scope: "global",
      index: 1,
      name: "Global helper",
      pid: 1234,
    },
    {
      type: "command.spawned",
      scope: "global",
      index: 2,
      name: "Second global helper",
      pid: 1234,
    },
    {
      type: "command.spawned",
      scope: "project",
      index: 1,
      name: "Project helper",
      pid: 1234,
    },
  ]);
  expect(fixture.spawnCalls).toEqual([
    {
      executable: "global-helper",
      args: ["--global"],
      options: {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    },
    {
      executable: "second-global-helper",
      args: [],
      options: {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    },
    {
      executable: "project-helper",
      args: ["--project"],
      options: {
        cwd: input.worktree,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    },
  ]);
  expect(Object.keys(hooks)).toEqual(["dispose"]);
  expect(typeof hooks.dispose).toBe("function");
});

test("stops one global and project command once across repeated disposal", async () => {
  const fixture = createFixture({ pids: [2001, 2002] });
  fixture.setGlobalConfig({
    commands: [globalCommand()],
    diagnostics: [],
  });
  fixture.setProjectConfig({
    commands: [projectCommand(input.worktree)],
    diagnostics: [],
  });

  const hooks = await fixture.server.server(input);

  expect(Object.keys(hooks)).toEqual(["dispose"]);
  expect(typeof hooks.dispose).toBe("function");
  await hooks.dispose?.();
  await hooks.dispose?.();

  expect(fixture.stopCalls).toEqual([2001, 2002]);
  expect(fixture.state.size).toBe(0);
});

test("stops a shared default-skip global command after its final owner disposes", async () => {
  const fixture = createFixture({ pids: [2101] });
  fixture.setGlobalConfig({
    commands: [globalCommand()],
    diagnostics: [],
  });

  const firstHooks = await fixture.server.server(input);
  const secondHooks = await fixture.server.server(input);

  expect(fixture.spawnCalls).toHaveLength(1);
  await firstHooks.dispose?.();
  expect(fixture.stopCalls).toEqual([]);
  await secondHooks.dispose?.();
  expect(fixture.stopCalls).toEqual([2101]);
});

test("shares same-root project ownership while different roots dispose independently", async () => {
  const fixture = createFixture({ pids: [2201, 2202] });
  const firstInput = { worktree: "first-root" } as PluginInput;
  const secondInput = { worktree: "second-root" } as PluginInput;
  fixture.setProjectConfig({
    commands: [projectCommand(firstInput.worktree)],
    diagnostics: [],
  });

  const firstHooks = await fixture.server.server(firstInput);
  const sameRootHooks = await fixture.server.server(firstInput);

  fixture.setProjectConfig({
    commands: [projectCommand(secondInput.worktree)],
    diagnostics: [],
  });
  const differentRootHooks = await fixture.server.server(secondInput);

  expect(fixture.spawnCalls).toHaveLength(2);
  await firstHooks.dispose?.();
  expect(fixture.stopCalls).toEqual([]);
  await differentRootHooks.dispose?.();
  expect(fixture.stopCalls).toEqual([2202]);
  await sameRootHooks.dispose?.();
  expect(fixture.stopCalls).toEqual([2202, 2201]);
});

test("runs valid global config when project config is missing", async () => {
  const fixture = createFixture();
  fixture.setGlobalConfig({
    commands: [
      {
        name: "Global helper",
        executable: "global-helper",
        args: [],
        onExistingProcess: "skip",
        stopOnExit: true,
        scope: "global",
        index: 0,
      },
    ],
    diagnostics: [],
  });

  await fixture.server.server(input);

  expect(fixture.spawnCalls.map(({ executable }) => executable)).toEqual([
    "global-helper",
  ]);
});

test("runs valid project config when global config is invalid", async () => {
  const fixture = createFixture();
  fixture.setGlobalConfig({
    commands: [],
    diagnostics: [{ scope: "global", reason: "invalid-document" }],
  });
  fixture.setProjectConfig({
    commands: [
      {
        name: "Project helper",
        executable: "project-helper",
        args: [],
        onExistingProcess: "skip",
        stopOnExit: true,
        scope: "project",
        projectRoot: input.worktree,
        index: 0,
      },
    ],
    diagnostics: [],
  });

  await fixture.server.server(input);

  expect(fixture.events[0]).toEqual({
    type: "configuration.invalid",
    scope: "global",
    reason: "invalid-document",
  });
  expect(fixture.spawnCalls.map(({ executable }) => executable)).toEqual([
    "project-helper",
  ]);
});

test("continues to activation and cleanup when config diagnostic logging throws", async () => {
  const fixture = createFixture({
    logger: {
      write(event): void {
        if (event.type === "configuration.invalid") {
          throw new Error("logger unavailable");
        }
      },
    },
  });
  fixture.setGlobalConfig({
    commands: [
      {
        name: "Global helper",
        executable: "global-helper",
        args: [],
        onExistingProcess: "skip",
        stopOnExit: true,
        scope: "global",
        index: 0,
      },
    ],
    diagnostics: [{ scope: "global", reason: "invalid-json" }],
  });

  const hooks = await fixture.server.server(input);

  expect(fixture.spawnCalls.map(({ executable }) => executable)).toEqual([
    "global-helper",
  ]);
  expect(Object.keys(hooks)).toEqual(["dispose"]);
  expect(typeof hooks.dispose).toBe("function");
  await hooks.dispose?.();
  expect(fixture.stopCalls).toEqual([1234]);
});

test("contains process-tree adapter failures during disposal", async () => {
  const fixture = createFixture({
    pids: [2301],
    stop(): Promise<ProcessTreeStopResult> {
      return Promise.reject(new Error("adapter unavailable"));
    },
  });
  fixture.setGlobalConfig({
    commands: [globalCommand()],
    diagnostics: [],
  });
  const hooks = await fixture.server.server(input);

  await hooks.dispose?.();

  expect(fixture.stopCalls).toEqual([2301]);
});

test("contains stop-event logger failures during disposal", async () => {
  const fixture = createFixture({
    logger: {
      write(event): void {
        if (event.type === "command.stop-requested") {
          throw new Error("logger unavailable");
        }
      },
    },
    pids: [2401],
  });
  fixture.setGlobalConfig({
    commands: [globalCommand()],
    diagnostics: [],
  });
  const hooks = await fixture.server.server(input);

  await hooks.dispose?.();

  expect(fixture.stopCalls).toEqual([2401]);
});

test("returns an idempotent async disposer for an empty command list", async () => {
  const fixture = createFixture();

  const hooks = await fixture.server.server(input);

  expect(Object.keys(hooks)).toEqual(["dispose"]);
  expect(typeof hooks.dispose).toBe("function");
  await hooks.dispose?.();
  await hooks.dispose?.();
  expect(fixture.stopCalls).toEqual([]);
  expect(fixture.state.size).toBe(0);
});

test("ignores legacy tuple options", async () => {
  const fixture = createFixture();

  await fixture.server.server(input, {
    commands: [
      {
        name: "Legacy helper",
        command: "legacy-helper",
        args: [],
      },
    ],
  });

  expect(fixture.spawnCalls).toEqual([]);
  expect(fixture.events).toEqual([
    { type: "plugin.initialized", commandCount: 0 },
    { type: "batch.skipped", reason: "no-valid-commands" },
  ]);
});

test("computes projectRootHash as a real 64-character lowercase hex digest", async () => {
  const hashProjectRootCalls: string[] = [];
  const writes: DurableRecord[][] = [];
  const expectedNormalizedRoot =
    process.platform === "win32"
      ? normalize(resolve(input.worktree)).toLowerCase()
      : normalize(resolve(input.worktree));
  const expectedProjectRootHash = createHash("sha256")
    .update(expectedNormalizedRoot)
    .digest("hex");
  const command: ConfiguredCommand = {
    ...projectCommand(input.worktree),
    stopOnExit: false,
  };
  const expectedIdentityHash = createHash("sha256")
    .update(JSON.stringify([command.executable, command.args]))
    .digest("hex");
  const persisted: DurableRecord = {
    scope: "project",
    identityHash: expectedIdentityHash,
    projectRootHash: expectedProjectRootHash,
    pid: 4321,
    startToken: "linux1:boot-a:1",
    stopOnExit: false,
    creationOrder: 0,
    recordedAt: "2026-09-03T00:00:00.000Z",
  };

  const registry: DurableRegistry = {
    hashIdentity(signature: string): string {
      return createHash("sha256").update(signature).digest("hex");
    },
    hashProjectRoot(normalizedRoot: string): string {
      hashProjectRootCalls.push(normalizedRoot);
      return createHash("sha256").update(normalizedRoot).digest("hex");
    },
    exists: () => true,
    read() {
      return { status: "loaded", records: [persisted] };
    },
    write(records) {
      writes.push([...records]);
      return true;
    },
    async acquireLock() {
      return { status: "acquired", handle: { release: () => {} } };
    },
  };
  const identity: ProcessIdentityController = {
    describe() {
      throw new Error(
        "describe should not run: the owner thunk resolves an identity, " +
          "and the only persisted record is adopted, not spawned",
      );
    },
    async probe() {
      return { status: "alive" };
    },
  };
  const fixture = createFixture({
    registry,
    identity,
    resolveOwnerIdentity: async () => ({
      pid: 4242,
      startToken: "owner-token-abc",
    }),
  });
  fixture.setProjectConfig({
    commands: [command],
    diagnostics: [],
  });

  await fixture.server.server(input);

  expect(hashProjectRootCalls).toEqual([expectedNormalizedRoot]);
  expect(fixture.spawnCalls).toEqual([]);
  expect(
    fixture.events.some((event) => event.type === "durable.record-adopted"),
  ).toBe(true);
  const written = writes.at(-1) ?? [];
  expect(written).toHaveLength(1);
  expect(written[0]?.scope).toBe("project");
  expect(written[0]?.identityHash).toBe(expectedIdentityHash);
  expect(written[0]?.projectRootHash).toBe(expectedProjectRootHash);
  expect(written[0]?.pid).toBe(4321);
});

test("never calls the durable registry when the identity dependency is absent", async () => {
  const fixture = createFixture({
    registry: {
      hashIdentity(): string {
        throw new Error("registry must not be used without identity");
      },
      hashProjectRoot(): string {
        throw new Error("registry must not be used without identity");
      },
      exists(): boolean {
        throw new Error("registry must not be used without identity");
      },
      read() {
        throw new Error("registry must not be used without identity");
      },
      write() {
        throw new Error("registry must not be used without identity");
      },
      acquireLock() {
        throw new Error("registry must not be used without identity");
      },
    },
  });
  fixture.setGlobalConfig({ commands: [globalCommand()], diagnostics: [] });

  const hooks = await fixture.server.server(input);

  expect(fixture.spawnCalls).toHaveLength(1);
  expect(typeof hooks.dispose).toBe("function");
});

test("never calls the durable registry when the registry dependency is absent", async () => {
  const identity: ProcessIdentityController = {
    describe() {
      throw new Error("identity must not be used without a registry");
    },
    probe() {
      throw new Error("identity must not be used without a registry");
    },
  };
  const fixture = createFixture({ identity });
  fixture.setGlobalConfig({ commands: [globalCommand()], diagnostics: [] });

  const hooks = await fixture.server.server(input);

  expect(fixture.spawnCalls).toHaveLength(1);
  expect(typeof hooks.dispose).toBe("function");
});

test("passes a resolved owner identity through to the durable lock holder", async () => {
  const acquireLockCalls: Array<{ pid: number; startToken: string }> = [];
  const registry: DurableRegistry = {
    hashIdentity(signature: string): string {
      return createHash("sha256").update(signature).digest("hex");
    },
    hashProjectRoot(normalizedRoot: string): string {
      return createHash("sha256").update(normalizedRoot).digest("hex");
    },
    exists: () => true,
    read() {
      throw new Error("not exercised by this test");
    },
    write() {
      throw new Error("not exercised by this test");
    },
    async acquireLock(holder) {
      acquireLockCalls.push(holder);
      return { status: "unavailable" };
    },
  };
  const identity: ProcessIdentityController = {
    describe() {
      throw new Error(
        "describe should not run when the owner thunk resolves an identity",
      );
    },
    probe() {
      throw new Error("probe is not exercised by this test");
    },
  };
  const fixture = createFixture({
    registry,
    identity,
    resolveOwnerIdentity: async () => ({
      pid: 4242,
      startToken: "owner-token-abc",
    }),
  });
  fixture.setProjectConfig({
    commands: [projectCommand(input.worktree)],
    diagnostics: [],
  });

  await fixture.server.server(input);

  expect(acquireLockCalls).toEqual([{ pid: 4242, startToken: "owner-token-abc" }]);
});

test("falls back to core's identity resolution instead of fabricating a token", async () => {
  const acquireLockCalls: Array<{ pid: number; startToken: string }> = [];
  const describeCalls: Array<number | undefined> = [];
  const registry: DurableRegistry = {
    hashIdentity(signature: string): string {
      return createHash("sha256").update(signature).digest("hex");
    },
    hashProjectRoot(normalizedRoot: string): string {
      return createHash("sha256").update(normalizedRoot).digest("hex");
    },
    exists: () => true,
    read() {
      throw new Error("not exercised by this test");
    },
    write() {
      throw new Error("not exercised by this test");
    },
    async acquireLock(holder) {
      acquireLockCalls.push(holder);
      return { status: "unavailable" };
    },
  };
  const identity: ProcessIdentityController = {
    async describe(pid) {
      describeCalls.push(pid);
      return { status: "described", token: "fallback-token" };
    },
    probe() {
      throw new Error("probe is not exercised by this test");
    },
  };
  const fixture = createFixture({
    registry,
    identity,
    resolveOwnerIdentity: async () => {
      throw new Error("identity source unavailable");
    },
  });
  fixture.setProjectConfig({
    commands: [projectCommand(input.worktree)],
    diagnostics: [],
  });

  const hooks = await fixture.server.server(input);

  expect(describeCalls).toEqual([process.pid]);
  expect(acquireLockCalls).toEqual([
    { pid: process.pid, startToken: "fallback-token" },
  ]);
  expect(typeof hooks.dispose).toBe("function");
});

test("resolves authoritative to false when either config scope has diagnostics", async () => {
  const acquireLockCalls: Array<{ pid: number; startToken: string }> = [];
  const registry: DurableRegistry = {
    hashIdentity(signature: string): string {
      return createHash("sha256").update(signature).digest("hex");
    },
    hashProjectRoot(normalizedRoot: string): string {
      return createHash("sha256").update(normalizedRoot).digest("hex");
    },
    exists: () => true,
    read() {
      throw new Error("not exercised by this test");
    },
    write() {
      throw new Error("not exercised by this test");
    },
    async acquireLock(holder) {
      acquireLockCalls.push(holder);
      return { status: "unavailable" };
    },
  };
  const identity: ProcessIdentityController = {
    describe() {
      throw new Error(
        "describe should not run when the owner thunk resolves an identity",
      );
    },
    probe() {
      throw new Error("probe is not exercised by this test");
    },
  };
  const fixture = createFixture({
    registry,
    identity,
    resolveOwnerIdentity: async () => ({
      pid: 4242,
      startToken: "owner-token-abc",
    }),
  });
  fixture.setGlobalConfig({
    commands: [],
    diagnostics: [{ scope: "global", reason: "invalid-document" }],
  });
  fixture.setProjectConfig({
    commands: [projectCommand(input.worktree)],
    diagnostics: [],
  });

  await fixture.server.server(input);

  expect(acquireLockCalls).toEqual([{ pid: 4242, startToken: "owner-token-abc" }]);
});
