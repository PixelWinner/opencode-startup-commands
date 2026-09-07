import { normalizeProjectRoot, runStartupCommands, } from "./core.js";
async function resolveOwner(dependencies) {
    if (!dependencies.resolveOwnerIdentity) {
        return undefined;
    }
    try {
        return await dependencies.resolveOwnerIdentity();
    }
    catch {
        return undefined;
    }
}
function buildRunOptions(dependencies, worktree, authoritative) {
    const { registry, identity } = dependencies;
    if (!registry || !identity) {
        return undefined;
    }
    const projectRootHash = registry.hashProjectRoot(normalizeProjectRoot(worktree));
    return {
        authoritative,
        projectRootHash,
        resolveOwner: () => resolveOwner(dependencies),
    };
}
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
            const runOptions = buildRunOptions(dependencies, input.worktree, globalConfig.diagnostics.length === 0 &&
                projectConfig.diagnostics.length === 0);
            const activation = await runStartupCommands([...globalConfig.commands, ...projectConfig.commands], dependencies, runOptions);
            return {
                dispose: () => activation.dispose(),
            };
        },
    };
}
//# sourceMappingURL=server-internal.js.map