import { expect, test } from "bun:test";
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
import type { LogEvent, Logger } from "../src/logger.js";
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
