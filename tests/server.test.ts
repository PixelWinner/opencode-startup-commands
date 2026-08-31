import { expect, test } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { ConfigLoadResult } from "../src/config.js";
import type { SpawnedChild, StartupSpawnOptions } from "../src/core.js";
import type { LogEvent, Logger } from "../src/logger.js";
import {
  createStartupCommandsServer,
  type StartupCommandsServerDependencies,
} from "../src/server-internal.js";
import serverModule from "../src/server.js";

const input = {
  worktree: "project-root",
} as PluginInput;

function createFixture(logger?: Logger) {
  const events: LogEvent[] = [];
  const configCalls: unknown[][] = [];
  const spawnCalls: Array<{
    executable: string;
    args: string[];
    options: StartupSpawnOptions;
  }> = [];
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
      options: StartupSpawnOptions,
    ): SpawnedChild {
      spawnCalls.push({ executable, args, options });

      const child: SpawnedChild = {
        pid: 1234,
        once(): SpawnedChild {
          return child;
        },
        unref(): void {},
      };

      return child;
    },
    state: { started: new Set<string>() },
    logger:
      logger ??
      {
        write(event: LogEvent): void {
          events.push(event);
        },
      },
  };

  return {
    configCalls,
    events,
    spawnCalls,
    server: createStartupCommandsServer(dependencies),
    setGlobalConfig(config: ConfigLoadResult): void {
      globalConfig = config;
    },
    setProjectConfig(config: ConfigLoadResult): void {
      projectConfig = config;
    },
  };
}

test("package adapter exposes only a compatible default export", async () => {
  const importedModule = await import("../src/server.js");

  expect(Object.keys(importedModule)).toEqual(["default"]);
  expect(serverModule.id).toBe("opencode-startup-commands");
  expect(typeof serverModule.server).toBe("function");
  expect("setup" in serverModule).toBe(false);
});

test("preserves scope-local config indexes through adapter lifecycle events", async () => {
  const fixture = createFixture();
  fixture.setGlobalConfig({
    commands: [
      {
        name: "Global helper",
        executable: "global-helper",
        args: ["--global"],
        scope: "global",
        index: 1,
      },
      {
        name: "Second global helper",
        executable: "second-global-helper",
        args: [],
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
      options: { detached: false, stdio: "ignore", windowsHide: true },
    },
    {
      executable: "second-global-helper",
      args: [],
      options: { detached: false, stdio: "ignore", windowsHide: true },
    },
    {
      executable: "project-helper",
      args: ["--project"],
      options: {
        cwd: input.worktree,
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      },
    },
  ]);
  expect(hooks).toEqual({});
});

test("runs valid global config when project config is missing", async () => {
  const fixture = createFixture();
  fixture.setGlobalConfig({
    commands: [
      {
        name: "Global helper",
        executable: "global-helper",
        args: [],
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

test("continues to core when config diagnostic logging throws", async () => {
  const fixture = createFixture({
    write(): void {
      throw new Error("logger unavailable");
    },
  });
  fixture.setGlobalConfig({
    commands: [
      {
        name: "Global helper",
        executable: "global-helper",
        args: [],
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
  expect(hooks).toEqual({});
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
