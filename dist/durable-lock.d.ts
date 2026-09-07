import type { ProcessIdentityController } from "./process-identity.js";
export interface DurableLockHolder {
    pid: number;
    startToken: string;
}
export interface DurableLockHandle {
    release(): void;
}
export type DurableLockResult = {
    status: "acquired";
    handle: DurableLockHandle;
} | {
    status: "unavailable";
};
export interface DurableLock {
    acquireLock(holder: DurableLockHolder): Promise<DurableLockResult>;
}
export interface DurableLockOptions {
    lockDirectory: string;
    lockHolderPath: string;
    identity?: ProcessIdentityController;
    delay?: (milliseconds: number) => Promise<void>;
    lockTimeoutMs?: number;
    lockPollIntervalMs?: number;
    nowMs?: () => number;
    random?: () => string;
    mkdir?: (path: string) => void;
    writeFile?: (path: string, content: string) => void;
    readFile?: (path: string) => string;
    rm?: (path: string) => void;
    stat?: (path: string) => {
        mtimeMs: number;
    };
}
export declare function createDurableLock(options: DurableLockOptions): DurableLock;
//# sourceMappingURL=durable-lock.d.ts.map