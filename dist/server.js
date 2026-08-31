import { spawn } from "node:child_process";
import { loadConfigFile, resolveGlobalConfigPath, resolveProjectConfigPath, } from "./config.js";
import { processState } from "./core.js";
import { createLogger } from "./logger.js";
import { createStartupCommandsServer } from "./server-internal.js";
const startupCommandsServer = createStartupCommandsServer({
    loadConfigFile,
    resolveGlobalConfigPath,
    resolveProjectConfigPath,
    spawn,
    state: processState,
    logger: createLogger(),
});
export default startupCommandsServer;
//# sourceMappingURL=server.js.map