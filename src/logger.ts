import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";

type LogErrorCode = "EACCES" | "ENOENT" | "EPERM";
type LogScope = "global" | "project";

export type LogEvent =
  | { type: "plugin.initialized"; commandCount: number }
  | {
      type: "configuration.invalid";
      scope: LogScope;
      reason:
        | "file-unavailable"
        | "invalid-json"
        | "invalid-document"
        | "commands-required";
    }
  | {
      type: "command.invalid";
      scope: LogScope;
      index: number;
      name?: string;
    }
  | {
      type: "batch.skipped";
      reason: "already-started" | "no-valid-commands";
    }
  | {
      type: "command.skipped";
      scope: LogScope;
      index: number;
      name: string;
      reason: "duplicate" | "already-started";
    }
  | {
      type: "command.spawned";
      scope: LogScope;
      index: number;
      name: string;
      pid?: number;
    }
  | {
      type: "command.spawn-failed";
      scope: LogScope;
      index: number;
      name: string;
      code?: LogErrorCode;
    }
  | {
      type: "command.child-error";
      scope: LogScope;
      index: number;
      name: string;
      code?: LogErrorCode;
    }
  | {
      type: "command.exited";
      scope: LogScope;
      index: number;
      name: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    };

export interface Logger {
  write(event: LogEvent): void;
}

interface LoggerConsole {
  error(message: string): void;
}

interface LoggerOptions {
  console?: LoggerConsole;
  filePath?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const MAX_NAME_LENGTH = 120;
const MAX_LOG_SIZE = 1024 * 1024;
const LOG_FILE_NAME = "opencode-startup-commands.log";

function sanitizeName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .slice(0, MAX_NAME_LENGTH);
}

function formatName(name: string): string {
  return JSON.stringify(sanitizeName(name));
}

function formatCode(code: LogErrorCode | undefined): string {
  return code ? ` code=${code}` : "";
}

function assertNeverEvent(event: never): never {
  throw new Error("Unhandled log event");
}

function formatConsoleEvent(event: LogEvent): string {
  switch (event.type) {
    case "plugin.initialized":
      return `initialized commandCount=${event.commandCount}`;
    case "configuration.invalid":
      return `invalid configuration scope=${event.scope} reason=${event.reason}`;
    case "command.invalid":
      return `invalid command scope=${event.scope} index=${event.index}${
        event.name ? ` name=${formatName(event.name)}` : ""
      }`;
    case "batch.skipped":
      return `batch skipped reason=${event.reason}`;
    case "command.skipped":
      return `command skipped scope=${event.scope} index=${event.index} name=${formatName(event.name)} reason=${event.reason}`;
    case "command.spawned":
      return `spawned scope=${event.scope} index=${event.index} name=${formatName(event.name)}${
        event.pid === undefined ? "" : ` pid=${event.pid}`
      }`;
    case "command.spawn-failed":
      return `spawn failed scope=${event.scope} index=${event.index} name=${formatName(event.name)}${formatCode(event.code)}`;
    case "command.child-error":
      return `child error scope=${event.scope} index=${event.index} name=${formatName(event.name)}${formatCode(event.code)}`;
    case "command.exited":
      return `exited scope=${event.scope} index=${event.index} name=${formatName(event.name)} exitCode=${
        event.exitCode === null ? "null" : event.exitCode
      } signal=${event.signal ?? "null"}`;
    default:
      return assertNeverEvent(event);
  }
}

function formatFileEvent(event: LogEvent): string {
  switch (event.type) {
    case "plugin.initialized":
      return `${event.type} commandCount=${event.commandCount}`;
    case "configuration.invalid":
      return `${event.type} scope=${event.scope} reason=${event.reason}`;
    case "command.invalid":
      return `${event.type} scope=${event.scope} index=${event.index}${
        event.name ? ` name=${formatName(event.name)}` : ""
      }`;
    case "batch.skipped":
      return `${event.type} reason=${event.reason}`;
    case "command.skipped":
      return `${event.type} scope=${event.scope} index=${event.index} name=${formatName(event.name)} reason=${event.reason}`;
    case "command.spawned":
      return `${event.type} scope=${event.scope} index=${event.index} name=${formatName(event.name)}${
        event.pid === undefined ? "" : ` pid=${event.pid}`
      }`;
    case "command.spawn-failed":
    case "command.child-error":
      return `${event.type} scope=${event.scope} index=${event.index} name=${formatName(event.name)}${formatCode(event.code)}`;
    case "command.exited":
      return `${event.type} scope=${event.scope} index=${event.index} name=${formatName(event.name)} exitCode=${
        event.exitCode === null ? "null" : event.exitCode
      } signal=${event.signal ?? "null"}`;
    default:
      return assertNeverEvent(event);
  }
}

function getDefaultLogPath(options: LoggerOptions): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  if (platform === "win32") {
    const configuredRoot = env.LOCALAPPDATA?.trim();
    const root =
      configuredRoot && win32.isAbsolute(configuredRoot)
        ? configuredRoot
        : join(home, "AppData", "Local");
    return join(root, "opencode", "logs", LOG_FILE_NAME);
  }

  if (platform === "darwin") {
    return join(home, "Library", "Logs", "OpenCode", LOG_FILE_NAME);
  }

  const configuredRoot = env.XDG_STATE_HOME?.trim();
  const root =
    configuredRoot && isAbsolute(configuredRoot)
      ? configuredRoot
      : join(home, ".local", "state");
  return join(root, "opencode", "log", LOG_FILE_NAME);
}

function appendEvent(
  filePath: string,
  timestamp: Date,
  event: LogEvent,
): void {
  mkdirSync(dirname(filePath), { recursive: true });

  try {
    if (statSync(filePath).size >= MAX_LOG_SIZE) {
      const archivePath = `${filePath}.1`;
      rmSync(archivePath, { force: true });
      renameSync(filePath, archivePath);
    }
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
        ? error.code
        : undefined;

    if (code !== "ENOENT") {
      throw error;
    }
  }

  appendFileSync(
    filePath,
    `${timestamp.toISOString()} ${formatFileEvent(event)}\n`,
    "utf8",
  );
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const output = options.console ?? console;
  const filePath = options.filePath ?? getDefaultLogPath(options);
  const now = options.now ?? (() => new Date());

  return {
    write(event): void {
      output.error(`startup-commands: ${formatConsoleEvent(event)}`);

      try {
        appendEvent(filePath, now(), event);
      } catch {
        output.error("startup-commands: log file unavailable");
      }
    },
  };
}
