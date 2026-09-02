import type { PluginModule } from "@opencode-ai/plugin";
import type {
  ConfigDiagnostic,
  loadConfigFile,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from "./config.js";
import {
  normalizeProjectRoot,
  runStartupCommands,
  type StartupDependencies,
  type StartupRunOptions,
} from "./core.js";
import type { Logger } from "./logger.js";

export interface StartupOwnerIdentity {
  readonly pid: number;
  readonly startToken: string;
}

export interface StartupCommandsServerDependencies
  extends StartupDependencies {
  loadConfigFile: typeof loadConfigFile;
  resolveGlobalConfigPath: typeof resolveGlobalConfigPath;
  resolveProjectConfigPath: typeof resolveProjectConfigPath;
  resolveOwnerIdentity?(): Promise<StartupOwnerIdentity | undefined>;
}

async function resolveOwner(
  dependencies: StartupCommandsServerDependencies,
): Promise<StartupOwnerIdentity | undefined> {
  if (!dependencies.resolveOwnerIdentity) {
    return undefined;
  }
  try {
    return await dependencies.resolveOwnerIdentity();
  } catch {
    return undefined;
  }
}

function buildRunOptions(
  dependencies: StartupCommandsServerDependencies,
  worktree: string,
  authoritative: boolean,
): StartupRunOptions | undefined {
  const { registry, identity } = dependencies;
  if (!registry || !identity) {
    return undefined;
  }

  const projectRootHash = registry.hashProjectRoot(
    normalizeProjectRoot(worktree),
  );

  return {
    authoritative,
    projectRootHash,
    resolveOwner: () => resolveOwner(dependencies),
  };
}

function writeConfigDiagnostic(
  diagnostic: ConfigDiagnostic,
  logger: Logger,
): void {
  try {
    if (diagnostic.reason === "invalid-command") {
      logger.write({
        type: "command.invalid",
        scope: diagnostic.scope,
        index: diagnostic.index,
        name: diagnostic.name,
      });
      return;
    }

    logger.write({
      type: "configuration.invalid",
      scope: diagnostic.scope,
      reason: diagnostic.reason,
    });
  } catch {
  }
}

export function createStartupCommandsServer(
  dependencies: StartupCommandsServerDependencies,
): PluginModule {
  return {
    id: "opencode-startup-commands",
    async server(input) {
      const globalConfig = dependencies.loadConfigFile(
        "global",
        dependencies.resolveGlobalConfigPath(),
      );
      const projectConfig = dependencies.loadConfigFile(
        "project",
        dependencies.resolveProjectConfigPath(input.worktree),
        input.worktree,
      );

      for (const diagnostic of [
        ...globalConfig.diagnostics,
        ...projectConfig.diagnostics,
      ]) {
        writeConfigDiagnostic(diagnostic, dependencies.logger);
      }

      const runOptions = buildRunOptions(
        dependencies,
        input.worktree,
        globalConfig.diagnostics.length === 0 &&
          projectConfig.diagnostics.length === 0,
      );

      const activation = await runStartupCommands(
        [...globalConfig.commands, ...projectConfig.commands],
        dependencies,
        runOptions,
      );

      return {
        dispose: () => activation.dispose(),
      };
    },
  };
}
