import type { ConfiguredCommand } from "./config.js";
import type { Logger } from "./logger.js";
import type { ProcessTreeController, ProcessTreeStopResult } from "./process-tree.js";
export interface SpawnedChild {
    readonly pid?: number;
    once(event: "error", listener: (error: Error) => void): SpawnedChild;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedChild;
    unref(): void;
}
type OwnerToken = symbol;
type RetryTombstone = "spawn-failed" | "natural-exit";
type IdentityStatus = "stable" | "restarting" | "degraded";
type ProcessRecordStatus = "active" | "stopping";
interface ManagedCommandContext {
    scope: "global" | "project";
    index: number;
    name: string;
}
interface ProcessRecord {
    child: SpawnedChild;
    pid?: number;
    context: ManagedCommandContext;
    creationOrder: number;
    owners: Set<OwnerToken>;
    stopOnExit: boolean;
    status: ProcessRecordStatus;
    stopPromise?: Promise<ProcessTreeStopResult>;
    rootExited: boolean;
}
interface IdentityEntry {
    processKey: string;
    records: ProcessRecord[];
    retryTombstone?: RetryTombstone;
    cleanupUnconfirmed: boolean;
    status: IdentityStatus;
    transitionTail: Promise<void>;
    pendingTransitions: number;
    nextCreationOrder: number;
}
export type StartupState = Map<string, IdentityEntry>;
export interface StartupSpawnOptions {
    cwd?: string;
    detached: true;
    shell: false;
    stdio: "ignore";
    windowsHide: true;
}
export type SpawnFunction = (command: string, args: string[], options: StartupSpawnOptions) => SpawnedChild;
export interface StartupDependencies {
    spawn: SpawnFunction;
    state: StartupState;
    processTree: ProcessTreeController;
    logger: Logger;
}
export interface StartupActivation {
    dispose(): Promise<void>;
}
export declare function createStartupState(): StartupState;
export declare function getOrCreateProcessState(registry: Record<symbol, unknown>): StartupState;
export declare const processState: StartupState;
export declare function runStartupCommands(commands: readonly ConfiguredCommand[], dependencies: StartupDependencies): Promise<StartupActivation>;
export {};
//# sourceMappingURL=core.d.ts.map