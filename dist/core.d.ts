import type { ConfiguredCommand } from "./config.js";
import type { Logger } from "./logger.js";
export interface StartupState {
    started: Set<string>;
}
export interface SpawnedChild {
    readonly pid?: number;
    once(event: "error", listener: (error: Error) => void): SpawnedChild;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedChild;
    unref(): void;
}
export interface StartupSpawnOptions {
    cwd?: string;
    detached: false;
    stdio: "ignore";
    windowsHide: true;
}
export type SpawnFunction = (command: string, args: string[], options: StartupSpawnOptions) => SpawnedChild;
export interface StartupDependencies {
    spawn: SpawnFunction;
    state: StartupState;
    logger: Logger;
}
export declare function getOrCreateProcessState(registry: Record<symbol, unknown>): StartupState;
export declare const processState: StartupState;
export declare function runStartupCommands(commands: readonly ConfiguredCommand[], dependencies: StartupDependencies): void;
//# sourceMappingURL=core.d.ts.map