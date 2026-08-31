import { normalize, resolve } from "node:path";
const ALLOWED_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);
const PROCESS_STATE_KEY = Symbol.for("opencode.startup-commands.state");
const processGlobal = globalThis;
function isStartupState(value) {
    if (typeof value !== "object" ||
        value === null ||
        !("started" in value) ||
        !(value.started instanceof Set)) {
        return false;
    }
    try {
        return [...value.started].every((key) => typeof key === "string");
    }
    catch {
        return false;
    }
}
export function getOrCreateProcessState(registry) {
    const existingState = registry[PROCESS_STATE_KEY];
    if (isStartupState(existingState)) {
        return existingState;
    }
    const state = { started: new Set() };
    registry[PROCESS_STATE_KEY] = state;
    return state;
}
export const processState = getOrCreateProcessState(processGlobal);
function getCommandSignature(command) {
    return JSON.stringify([command.executable, command.args]);
}
function getNormalizedProjectRoot(projectRoot) {
    const normalizedRoot = normalize(resolve(projectRoot));
    return process.platform === "win32"
        ? normalizedRoot.toLowerCase()
        : normalizedRoot;
}
function getProcessKey(command, signature) {
    if (command.scope === "global") {
        return `global:${signature}`;
    }
    return `project:${getNormalizedProjectRoot(command.projectRoot)}:${signature}`;
}
function getErrorCode(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        ALLOWED_ERROR_CODES.has(error.code)
        ? error.code
        : undefined);
}
function writeLog(logger, event) {
    try {
        logger.write(event);
    }
    catch {
        // Logging must not affect command execution or child lifecycle callbacks.
    }
}
export function runStartupCommands(commands, dependencies) {
    writeLog(dependencies.logger, {
        type: "plugin.initialized",
        commandCount: commands.length,
    });
    if (commands.length === 0) {
        writeLog(dependencies.logger, {
            type: "batch.skipped",
            reason: "no-valid-commands",
        });
        return;
    }
    const globalCommands = new Map();
    const projectCommands = new Map();
    const duplicateCommands = [];
    commands.forEach((command, order) => {
        const signature = getCommandSignature(command);
        const indexedCommand = { command, order, signature };
        if (command.scope === "global") {
            if (globalCommands.has(signature)) {
                duplicateCommands.push(indexedCommand);
            }
            else {
                globalCommands.set(signature, indexedCommand);
            }
            return;
        }
        const projectKey = getProcessKey(command, signature);
        if (projectCommands.has(projectKey)) {
            duplicateCommands.push(indexedCommand);
        }
        else {
            projectCommands.set(projectKey, indexedCommand);
        }
    });
    const uniqueProjectCommands = [...projectCommands.values()].filter((indexedCommand) => {
        if (globalCommands.has(indexedCommand.signature)) {
            duplicateCommands.push(indexedCommand);
            return false;
        }
        return true;
    });
    const uniqueCommands = [
        ...globalCommands.values(),
        ...uniqueProjectCommands,
    ];
    let commandStarted = false;
    duplicateCommands
        .sort((left, right) => left.order - right.order)
        .forEach(({ command }) => {
        writeLog(dependencies.logger, {
            type: "command.skipped",
            scope: command.scope,
            index: command.index,
            name: command.name,
            reason: "duplicate",
        });
    });
    uniqueCommands.forEach(({ command, signature }) => {
        const processKey = getProcessKey(command, signature);
        if (dependencies.state.started.has(processKey)) {
            writeLog(dependencies.logger, {
                type: "command.skipped",
                scope: command.scope,
                index: command.index,
                name: command.name,
                reason: "already-started",
            });
            return;
        }
        dependencies.state.started.add(processKey);
        commandStarted = true;
        const spawnOptions = {
            detached: false,
            stdio: "ignore",
            windowsHide: true,
        };
        if (command.scope === "project") {
            spawnOptions.cwd = command.projectRoot;
        }
        let child;
        try {
            child = dependencies.spawn(command.executable, command.args, spawnOptions);
        }
        catch (error) {
            writeLog(dependencies.logger, {
                type: "command.spawn-failed",
                scope: command.scope,
                index: command.index,
                name: command.name,
                code: getErrorCode(error),
            });
            return;
        }
        writeLog(dependencies.logger, {
            type: "command.spawned",
            scope: command.scope,
            index: command.index,
            name: command.name,
            pid: child.pid,
        });
        try {
            child.once("error", (error) => {
                writeLog(dependencies.logger, {
                    type: "command.child-error",
                    scope: command.scope,
                    index: command.index,
                    name: command.name,
                    code: getErrorCode(error),
                });
            });
        }
        catch {
            // A spawned child remains successful even if lifecycle hooks are unavailable.
        }
        try {
            child.once("exit", (exitCode, signal) => {
                writeLog(dependencies.logger, {
                    type: "command.exited",
                    scope: command.scope,
                    index: command.index,
                    name: command.name,
                    exitCode,
                    signal,
                });
            });
        }
        catch {
            // A spawned child remains successful even if lifecycle hooks are unavailable.
        }
        try {
            child.unref();
        }
        catch {
            // The child already started, so an unref failure is not a spawn failure.
        }
    });
    if (!commandStarted) {
        writeLog(dependencies.logger, {
            type: "batch.skipped",
            reason: "already-started",
        });
    }
}
//# sourceMappingURL=core.js.map