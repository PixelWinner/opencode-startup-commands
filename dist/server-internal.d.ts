import type { PluginModule } from "@opencode-ai/plugin";
import type { loadConfigFile, resolveGlobalConfigPath, resolveProjectConfigPath } from "./config.js";
import { type StartupDependencies } from "./core.js";
export interface StartupOwnerIdentity {
    readonly pid: number;
    readonly startToken: string;
}
export interface StartupCommandsServerDependencies extends StartupDependencies {
    loadConfigFile: typeof loadConfigFile;
    resolveGlobalConfigPath: typeof resolveGlobalConfigPath;
    resolveProjectConfigPath: typeof resolveProjectConfigPath;
    resolveOwnerIdentity?(): Promise<StartupOwnerIdentity | undefined>;
}
export declare function createStartupCommandsServer(dependencies: StartupCommandsServerDependencies): PluginModule;
//# sourceMappingURL=server-internal.d.ts.map