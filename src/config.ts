import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ConfigScope = "global" | "project";

interface ConfiguredCommandFields {
  name: string;
  executable: string;
  args: string[];
  index: number;
}

export type ConfiguredCommand =
  | (ConfiguredCommandFields & {
      scope: "global";
      projectRoot?: never;
    })
  | (ConfiguredCommandFields & {
      scope: "project";
      projectRoot: string;
    });

export type ConfigDiagnosticReason =
  | "file-unavailable"
  | "invalid-json"
  | "invalid-document"
  | "commands-required"
  | "invalid-command";

type ScopeConfigDiagnosticReason = Exclude<
  ConfigDiagnosticReason,
  "invalid-command"
>;

export type ConfigDiagnostic =
  | {
      scope: ConfigScope;
      reason: "invalid-command";
      index: number;
      name?: string;
    }
  | {
      scope: ConfigScope;
      reason: ScopeConfigDiagnosticReason;
      index?: never;
      name?: never;
    };

export interface ConfigLoadResult {
  commands: ConfiguredCommand[];
  diagnostics: ConfigDiagnostic[];
}

const CONFIG_FILE_NAME = "startup-commands.json";

export function resolveGlobalConfigPath(home: string = homedir()): string {
  return join(home, ".config", "opencode", CONFIG_FILE_NAME);
}

export function resolveProjectConfigPath(worktree: string): string {
  return join(worktree, ".opencode", CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    isRecord(error) && "code" in error && error.code === "ENOENT"
  );
}

function invalidCommandDiagnostic(
  scope: ConfigScope,
  index: number,
  value: unknown,
): ConfigDiagnostic {
  const diagnostic: ConfigDiagnostic = {
    scope,
    reason: "invalid-command",
    index,
  };

  if (isRecord(value) && typeof value.name === "string") {
    const name = value.name.trim();
    if (name) {
      diagnostic.name = name;
    }
  }

  return diagnostic;
}

export function loadConfigFile(
  scope: "global",
  filePath: string,
): ConfigLoadResult;
export function loadConfigFile(
  scope: "project",
  filePath: string,
  projectRoot: string,
): ConfigLoadResult;
export function loadConfigFile(
  ...args:
    | [scope: "global", filePath: string]
    | [scope: "project", filePath: string, projectRoot: string]
): ConfigLoadResult {
  const [scope, filePath, projectRoot] = args;
  let content: string;

  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      commands: [],
      diagnostics: isMissingFile(error)
        ? []
        : [{ scope, reason: "file-unavailable" }],
    };
  }

  let document: unknown;

  try {
    const jsonContent = content.startsWith("\uFEFF")
      ? content.slice(1)
      : content;
    document = JSON.parse(jsonContent) as unknown;
  } catch {
    return {
      commands: [],
      diagnostics: [{ scope, reason: "invalid-json" }],
    };
  }

  if (!isRecord(document)) {
    return {
      commands: [],
      diagnostics: [{ scope, reason: "invalid-document" }],
    };
  }

  if (!Array.isArray(document.commands)) {
    return {
      commands: [],
      diagnostics: [{ scope, reason: "commands-required" }],
    };
  }

  const commands: ConfiguredCommand[] = [];
  const diagnostics: ConfigDiagnostic[] = [];

  document.commands.forEach((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      typeof value.executable !== "string" ||
      !value.executable.trim() ||
      !Array.isArray(value.args) ||
      !value.args.every((argument) => typeof argument === "string")
    ) {
      diagnostics.push(invalidCommandDiagnostic(scope, index, value));
      return;
    }

    const commandFields: ConfiguredCommandFields = {
      name: value.name.trim(),
      executable: value.executable,
      args: value.args,
      index,
    };

    if (scope === "project") {
      commands.push({ ...commandFields, scope, projectRoot });
    } else {
      commands.push({ ...commandFields, scope });
    }
  });

  return { commands, diagnostics };
}
