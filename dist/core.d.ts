import type { ConfiguredCommand } from "./config.js";
import type { DurableLockHolder, DurableRegistry } from "./durable-registry.js";
import type { Logger } from "./logger.js";
import type { ProcessIdentityController } from "./process-identity.js";
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
interface ProcessRecordBase {
    pid?: number;
    context: ManagedCommandContext;
    creationOrder: number;
    owners: Set<OwnerToken>;
    stopOnExit: boolean;
    status: ProcessRecordStatus;
    stopPromise?: Promise<ProcessTreeStopResult>;
    rootExited: boolean;
}
type ProcessRecord = (ProcessRecordBase & {
    origin: "spawned";
    child: SpawnedChild;
}) | (ProcessRecordBase & {
    origin: "adopted";
    startToken: string;
});
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
    identity?: ProcessIdentityController;
    registry?: DurableRegistry;
}
export interface StartupActivation {
    dispose(): Promise<void>;
}
export interface StartupRunOptions {
    authoritative: boolean;
    projectRootHash: string;
    resolveOwner?: () => Promise<DurableLockHolder | undefined>;
}
export declare function createStartupState(): StartupState;
export declare function getOrCreateProcessState(registry: Record<symbol, unknown>): StartupState;
export declare const processState: StartupState;
declare function getNormalizedProjectRoot(projectRoot: string): string;
export { getNormalizedProjectRoot as normalizeProjectRoot };
export declare function runStartupCommands(commands: readonly ConfiguredCommand[], dependencies: StartupDependencies, options?: StartupRunOptions): Promise<StartupActivation>;
//# sourceMappingURL=core.d.ts.map