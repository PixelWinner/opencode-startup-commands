export type ConfigScope = "global" | "project";
interface ConfiguredCommandFields {
    name: string;
    executable: string;
    args: string[];
    index: number;
}
export type ConfiguredCommand = (ConfiguredCommandFields & {
    scope: "global";
    projectRoot?: never;
}) | (ConfiguredCommandFields & {
    scope: "project";
    projectRoot: string;
});
export type ConfigDiagnosticReason = "file-unavailable" | "invalid-json" | "invalid-document" | "commands-required" | "invalid-command";
type ScopeConfigDiagnosticReason = Exclude<ConfigDiagnosticReason, "invalid-command">;
export type ConfigDiagnostic = {
    scope: ConfigScope;
    reason: "invalid-command";
    index: number;
    name?: string;
} | {
    scope: ConfigScope;
    reason: ScopeConfigDiagnosticReason;
    index?: never;
    name?: never;
};
export interface ConfigLoadResult {
    commands: ConfiguredCommand[];
    diagnostics: ConfigDiagnostic[];
}
export declare function resolveGlobalConfigPath(home?: string): string;
export declare function resolveProjectConfigPath(worktree: string): string;
export declare function loadConfigFile(scope: "global", filePath: string): ConfigLoadResult;
export declare function loadConfigFile(scope: "project", filePath: string, projectRoot: string): ConfigLoadResult;
export {};
//# sourceMappingURL=config.d.ts.map