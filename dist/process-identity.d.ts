export type ProcessIdentityUnknownReason = "permission-denied" | "facility-unavailable" | "malformed-output" | "timeout" | "unconfirmed";
export type ProcessDescribeResult = {
    status: "described";
    token: string;
} | {
    status: "gone";
} | {
    status: "unknown";
    reason: ProcessIdentityUnknownReason;
};
export type ProcessProbeResult = {
    status: "alive";
} | {
    status: "gone";
} | {
    status: "unknown";
    reason: ProcessIdentityUnknownReason;
};
export interface ProcessIdentityController {
    describe(pid: number | undefined): Promise<ProcessDescribeResult>;
    probe(pid: number | undefined, expectedToken: string): Promise<ProcessProbeResult>;
}
export interface ProcessQuerySpawnOptions {
    detached: false;
    shell: false;
    stdio: ["ignore", "pipe", "ignore"];
    windowsHide: true;
    env?: NodeJS.ProcessEnv;
}
export interface ProcessQueryChild {
    readonly stdout: {
        on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    } | null;
    once(event: "error", listener: (error: Error) => void): ProcessQueryChild;
    once(event: "close", listener: (code: number | null) => void): ProcessQueryChild;
    kill(signal?: NodeJS.Signals | number): boolean;
    unref(): void;
}
export type ProcessQuerySpawn = (executable: string, args: string[], options: ProcessQuerySpawnOptions) => ProcessQueryChild;
export interface ProcessIdentityControllerOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    readTextFile?: (path: string) => string;
    spawn?: ProcessQuerySpawn;
    timeoutMs?: number;
}
export declare function createProcessIdentityController(options?: ProcessIdentityControllerOptions): ProcessIdentityController;
//# sourceMappingURL=process-identity.d.ts.map