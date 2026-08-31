import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const CONFIG_FILE_NAME = "startup-commands.json";
export function resolveGlobalConfigPath(home = homedir()) {
    return join(home, ".config", "opencode", CONFIG_FILE_NAME);
}
export function resolveProjectConfigPath(worktree) {
    return join(worktree, ".opencode", CONFIG_FILE_NAME);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissingFile(error) {
    return (isRecord(error) && "code" in error && error.code === "ENOENT");
}
function invalidCommandDiagnostic(scope, index, value) {
    const diagnostic = {
        scope,
        reason: "invalid-command",
        index,
    };
    if (isRecord(value) && typeof value.name === "string") {
        const name = value.name.trim();
        if (name) {
            diagnostic.name = name;
        }
    }
    return diagnostic;
}
export function loadConfigFile(...args) {
    const [scope, filePath, projectRoot] = args;
    let content;
    try {
        content = readFileSync(filePath, "utf8");
    }
    catch (error) {
        return {
            commands: [],
            diagnostics: isMissingFile(error)
                ? []
                : [{ scope, reason: "file-unavailable" }],
        };
    }
    let document;
    try {
        const jsonContent = content.startsWith("\uFEFF")
            ? content.slice(1)
            : content;
        document = JSON.parse(jsonContent);
    }
    catch {
        return {
            commands: [],
            diagnostics: [{ scope, reason: "invalid-json" }],
        };
    }
    if (!isRecord(document)) {
        return {
            commands: [],
            diagnostics: [{ scope, reason: "invalid-document" }],
        };
    }
    if (!Array.isArray(document.commands)) {
        return {
            commands: [],
            diagnostics: [{ scope, reason: "commands-required" }],
        };
    }
    const commands = [];
    const diagnostics = [];
    document.commands.forEach((value, index) => {
        if (!isRecord(value) ||
            typeof value.name !== "string" ||
            !value.name.trim() ||
            typeof value.executable !== "string" ||
            !value.executable.trim() ||
            !Array.isArray(value.args) ||
            !value.args.every((argument) => typeof argument === "string")) {
            diagnostics.push(invalidCommandDiagnostic(scope, index, value));
            return;
        }
        const commandFields = {
            name: value.name.trim(),
            executable: value.executable,
            args: value.args,
            index,
        };
        if (scope === "project") {
            commands.push({ ...commandFields, scope, projectRoot });
        }
        else {
            commands.push({ ...commandFields, scope });
        }
    });
    return { commands, diagnostics };
}
//# sourceMappingURL=config.js.map