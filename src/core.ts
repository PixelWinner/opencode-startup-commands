import { normalize, resolve } from "node:path";
import type { ConfiguredCommand } from "./config.js";
import type { LogEvent, Logger } from "./logger.js";

type LogErrorCode = NonNullable<
  Extract<LogEvent, { type: "command.spawn-failed" }>["code"]
>;

export interface StartupState {
  started: Set<string>;
}

export interface SpawnedChild {
  readonly pid?: number;
  once(event: "error", listener: (error: Error) => void): SpawnedChild;
  once(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): SpawnedChild;
  unref(): void;
}

export interface StartupSpawnOptions {
  cwd?: string;
  detached: false;
  stdio: "ignore";
  windowsHide: true;
}

export type SpawnFunction = (
  command: string,
  args: string[],
  options: StartupSpawnOptions,
) => SpawnedChild;

export interface StartupDependencies {
  spawn: SpawnFunction;
  state: StartupState;
  logger: Logger;
}

interface IndexedCommand {
  command: ConfiguredCommand;
  order: number;
  signature: string;
}

const ALLOWED_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);
const PROCESS_STATE_KEY = Symbol.for("opencode.startup-commands.state");
const processGlobal = globalThis as unknown as Record<symbol, unknown>;

function isStartupState(value: unknown): value is StartupState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("started" in value) ||
    !(value.started instanceof Set)
  ) {
    return false;
  }

  try {
    return [...value.started].every((key) => typeof key === "string");
  } catch {
    return false;
  }
}

export function getOrCreateProcessState(
  registry: Record<symbol, unknown>,
): StartupState {
  const existingState = registry[PROCESS_STATE_KEY];

  if (isStartupState(existingState)) {
    return existingState;
  }

  const state: StartupState = { started: new Set<string>() };
  registry[PROCESS_STATE_KEY] = state;

  return state;
}

export const processState = getOrCreateProcessState(processGlobal);

function getCommandSignature(command: ConfiguredCommand): string {
  return JSON.stringify([command.executable, command.args]);
}

function getNormalizedProjectRoot(projectRoot: string): string {
  const normalizedRoot = normalize(resolve(projectRoot));

  return process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
}

function getProcessKey(
  command: ConfiguredCommand,
  signature: string,
): string {
  if (command.scope === "global") {
    return `global:${signature}`;
  }

  return `project:${getNormalizedProjectRoot(command.projectRoot)}:${signature}`;
}

function getErrorCode(error: unknown): LogErrorCode | undefined {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    ALLOWED_ERROR_CODES.has(error.code)
      ? error.code
      : undefined
  ) as LogErrorCode | undefined;
}

function writeLog(logger: Logger, event: LogEvent): void {
  try {
    logger.write(event);
  } catch {
    // Logging must not affect command execution or child lifecycle callbacks.
  }
}

export function runStartupCommands(
  commands: readonly ConfiguredCommand[],
  dependencies: StartupDependencies,
): void {
  writeLog(dependencies.logger, {
    type: "plugin.initialized",
    commandCount: commands.length,
  });

  if (commands.length === 0) {
    writeLog(dependencies.logger, {
      type: "batch.skipped",
      reason: "no-valid-commands",
    });
    return;
  }

  const globalCommands = new Map<string, IndexedCommand>();
  const projectCommands = new Map<string, IndexedCommand>();
  const duplicateCommands: IndexedCommand[] = [];

  commands.forEach((command, order) => {
    const signature = getCommandSignature(command);
    const indexedCommand = { command, order, signature };

    if (command.scope === "global") {
      if (globalCommands.has(signature)) {
        duplicateCommands.push(indexedCommand);
      } else {
        globalCommands.set(signature, indexedCommand);
      }
      return;
    }

    const projectKey = getProcessKey(command, signature);

    if (projectCommands.has(projectKey)) {
      duplicateCommands.push(indexedCommand);
    } else {
      projectCommands.set(projectKey, indexedCommand);
    }
  });

  const uniqueProjectCommands = [...projectCommands.values()].filter(
    (indexedCommand) => {
      if (globalCommands.has(indexedCommand.signature)) {
        duplicateCommands.push(indexedCommand);
        return false;
      }

      return true;
    },
  );
  const uniqueCommands = [
    ...globalCommands.values(),
    ...uniqueProjectCommands,
  ];
  let commandStarted = false;

  duplicateCommands
    .sort((left, right) => left.order - right.order)
    .forEach(({ command }) => {
      writeLog(dependencies.logger, {
        type: "command.skipped",
        scope: command.scope,
        index: command.index,
        name: command.name,
        reason: "duplicate",
      });
    });

  uniqueCommands.forEach(({ command, signature }) => {
    const processKey = getProcessKey(command, signature);

    if (dependencies.state.started.has(processKey)) {
      writeLog(dependencies.logger, {
        type: "command.skipped",
        scope: command.scope,
        index: command.index,
        name: command.name,
        reason: "already-started",
      });
      return;
    }

    dependencies.state.started.add(processKey);
    commandStarted = true;

    const spawnOptions: StartupSpawnOptions = {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    };

    if (command.scope === "project") {
      spawnOptions.cwd = command.projectRoot;
    }

    let child: SpawnedChild;

    try {
      child = dependencies.spawn(
        command.executable,
        command.args,
        spawnOptions,
      );
    } catch (error) {
      writeLog(dependencies.logger, {
        type: "command.spawn-failed",
        scope: command.scope,
        index: command.index,
        name: command.name,
        code: getErrorCode(error),
      });
      return;
    }

    writeLog(dependencies.logger, {
      type: "command.spawned",
      scope: command.scope,
      index: command.index,
      name: command.name,
      pid: child.pid,
    });

    try {
      child.once("error", (error) => {
        writeLog(dependencies.logger, {
          type: "command.child-error",
          scope: command.scope,
          index: command.index,
          name: command.name,
          code: getErrorCode(error),
        });
      });
    } catch {
      // A spawned child remains successful even if lifecycle hooks are unavailable.
    }

    try {
      child.once("exit", (exitCode, signal) => {
        writeLog(dependencies.logger, {
          type: "command.exited",
          scope: command.scope,
          index: command.index,
          name: command.name,
          exitCode,
          signal,
        });
      });
    } catch {
      // A spawned child remains successful even if lifecycle hooks are unavailable.
    }

    try {
      child.unref();
    } catch {
      // The child already started, so an unref failure is not a spawn failure.
    }
  });

  if (!commandStarted) {
    writeLog(dependencies.logger, {
      type: "batch.skipped",
      reason: "already-started",
    });
  }
}
