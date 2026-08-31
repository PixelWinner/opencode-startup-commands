import { runStartupCommands, } from "./core.js";
function writeConfigDiagnostic(diagnostic, logger) {
    try {
        if (diagnostic.reason === "invalid-command") {
            logger.write({
                type: "command.invalid",
                scope: diagnostic.scope,
                index: diagnostic.index,
                name: diagnostic.name,
            });
            return;
        }
        logger.write({
            type: "configuration.invalid",
            scope: diagnostic.scope,
            reason: diagnostic.reason,
        });
    }
    catch {
        // Logging must not prevent valid commands from reaching core execution.
    }
}
export function createStartupCommandsServer(dependencies) {
    return {
        id: "opencode-startup-commands",
        async server(input) {
            const globalConfig = dependencies.loadConfigFile("global", dependencies.resolveGlobalConfigPath());
            const projectConfig = dependencies.loadConfigFile("project", dependencies.resolveProjectConfigPath(input.worktree), input.worktree);
            for (const diagnostic of [
                ...globalConfig.diagnostics,
                ...projectConfig.diagnostics,
            ]) {
                writeConfigDiagnostic(diagnostic, dependencies.logger);
            }
            runStartupCommands([...globalConfig.commands, ...projectConfig.commands], dependencies);
            return {};
        },
    };
}
//# sourceMappingURL=server-internal.js.map