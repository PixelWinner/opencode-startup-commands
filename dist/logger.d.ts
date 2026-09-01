import type { ProcessTreeFailureReason } from "./process-tree.js";
type LogErrorCode = "EACCES" | "ENOENT" | "EPERM";
type LogScope = "global" | "project";
export type CommandStopTrigger = "scope-disposed" | "root-exited" | "restart";
interface CommandStopContext {
    scope: LogScope;
    index: number;
    name: string;
    pid?: number;
    trigger: CommandStopTrigger;
}
export type LogEvent = {
    type: "plugin.initialized";
    commandCount: number;
} | {
    type: "configuration.invalid";
    scope: LogScope;
    reason: "file-unavailable" | "invalid-json" | "invalid-document" | "commands-required";
} | {
    type: "command.invalid";
    scope: LogScope;
    index: number;
    name?: string;
} | {
    type: "batch.skipped";
    reason: "already-started" | "no-valid-commands";
} | {
    type: "command.skipped";
    scope: LogScope;
    index: number;
    name: string;
    reason: "duplicate" | "already-started";
} | {
    type: "command.spawned";
    scope: LogScope;
    index: number;
    name: string;
    pid?: number;
} | {
    type: "command.spawn-failed";
    scope: LogScope;
    index: number;
    name: string;
    code?: LogErrorCode;
} | {
    type: "command.child-error";
    scope: LogScope;
    index: number;
    name: string;
    code?: LogErrorCode;
} | {
    type: "command.exited";
    scope: LogScope;
    index: number;
    name: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
} | ({
    type: "command.stop-requested";
} & CommandStopContext) | ({
    type: "command.stop-forced";
} & CommandStopContext) | ({
    type: "command.stop-failed";
    reason: ProcessTreeFailureReason;
} & CommandStopContext);
export interface Logger {
    write(event: LogEvent): void;
}
interface LoggerConsole {
    error(message: string): void;
}
interface LoggerOptions {
    console?: LoggerConsole;
    filePath?: string;
    now?: () => Date;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
}
export declare function createLogger(options?: LoggerOptions): Logger;
export {};
//# sourceMappingURL=logger.d.ts.map