import type { PluginModule } from "@opencode-ai/plugin";
import type { loadConfigFile, resolveGlobalConfigPath, resolveProjectConfigPath } from "./config.js";
import { type SpawnFunction, type StartupState } from "./core.js";
import type { Logger } from "./logger.js";
export interface StartupCommandsServerDependencies {
    loadConfigFile: typeof loadConfigFile;
    resolveGlobalConfigPath: typeof resolveGlobalConfigPath;
    resolveProjectConfigPath: typeof resolveProjectConfigPath;
    spawn: SpawnFunction;
    state: StartupState;
    logger: Logger;
}
export declare function createStartupCommandsServer(dependencies: StartupCommandsServerDependencies): PluginModule;
//# sourceMappingURL=server-internal.d.ts.map