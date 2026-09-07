import { type DurableLockHolder, type DurableLockResult } from "./durable-lock.js";
import type { ProcessIdentityController } from "./process-identity.js";
export type { DurableLockHandle, DurableLockHolder, DurableLockResult, } from "./durable-lock.js";
interface DurableRecordFields {
    identityHash: string;
    pid: number;
    startToken: string;
    stopOnExit: false;
    creationOrder: number;
    recordedAt: string;
}
export type DurableRecord = (DurableRecordFields & {
    scope: "global";
    projectRootHash?: never;
}) | (DurableRecordFields & {
    scope: "project";
    projectRootHash: string;
});
export type DurableUnavailableReason = "unreadable" | "malformed" | "unsupported-schema";
export type DurableReadResult = {
    status: "loaded";
    records: DurableRecord[];
    quarantined?: true;
} | {
    status: "unavailable";
    reason: DurableUnavailableReason;
};
export interface DurableRegistry {
    hashIdentity(signature: string): string;
    hashProjectRoot(normalizedRoot: string): string;
    exists(): boolean;
    read(): DurableReadResult;
    write(records: readonly DurableRecord[]): boolean;
    acquireLock(holder: DurableLockHolder): Promise<DurableLockResult>;
}
export interface DurableRegistryOptions {
    root?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    hostname?: string;
    random?: () => string;
    identity?: ProcessIdentityController;
    delay?: (milliseconds: number) => Promise<void>;
    lockTimeoutMs?: number;
    lockPollIntervalMs?: number;
    clock?: {
        nowMs: () => number;
        stat: (path: string) => {
            mtimeMs: number;
        };
    };
}
export declare function resolveDurableStateRoot(options?: Pick<DurableRegistryOptions, "platform" | "env" | "home" | "hostname">): string;
export declare function createDurableRegistry(options?: DurableRegistryOptions): DurableRegistry;
//# sourceMappingURL=durable-registry.d.ts.map