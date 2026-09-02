export type ProcessTreeFailureReason = "missing-pid" | "permission-denied" | "facility-unavailable" | "unconfirmed";
export type ProcessTreeAddressability = "safe" | "lost";
export type ProcessTreeStopResult = {
    status: "stopped";
} | {
    status: "failed";
    reason: ProcessTreeFailureReason;
    addressability: ProcessTreeAddressability;
};
export interface ProcessTreeStopOptions {
    isRootExited(): boolean;
    onForce(): void;
}
export interface ProcessTreeController {
    stop(pid: number | undefined, options: ProcessTreeStopOptions): Promise<ProcessTreeStopResult>;
}
export interface ProcessUtilityChild {
    once(event: "error", listener: (error: Error) => void): ProcessUtilityChild;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): ProcessUtilityChild;
    kill(signal?: NodeJS.Signals | number): boolean;
    unref(): void;
}
export interface ProcessUtilitySpawnOptions {
    detached: false;
    shell: false;
    stdio: "ignore";
    windowsHide: true;
}
export type ProcessUtilitySpawn = (executable: string, args: string[], options: ProcessUtilitySpawnOptions) => ProcessUtilityChild;
export interface ProcessTreeControllerOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    gracePeriodMs?: number;
    pollIntervalMs?: number;
    utilityTimeoutMs?: number;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    spawn?: ProcessUtilitySpawn;
    delay?: (milliseconds: number) => Promise<void>;
}
export declare function createProcessTreeController(options?: ProcessTreeControllerOptions): ProcessTreeController;
//# sourceMappingURL=process-tree.d.ts.map