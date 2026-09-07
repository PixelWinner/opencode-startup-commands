import { spawn } from "node:child_process";
import { loadConfigFile, resolveGlobalConfigPath, resolveProjectConfigPath, } from "./config.js";
import { processState } from "./core.js";
import { createDurableRegistry, resolveDurableStateRoot, } from "./durable-registry.js";
import { createLogger } from "./logger.js";
import { createProcessIdentityController } from "./process-identity.js";
import { createProcessTreeController } from "./process-tree.js";
import { createStartupCommandsServer } from "./server-internal.js";
const identity = createProcessIdentityController();
const startupCommandsServer = createStartupCommandsServer({
    loadConfigFile,
    resolveGlobalConfigPath,
    resolveProjectConfigPath,
    spawn,
    state: processState,
    processTree: createProcessTreeController(),
    logger: createLogger(),
    identity,
    registry: createDurableRegistry({
        root: resolveDurableStateRoot(),
        identity,
    }),
    async resolveOwnerIdentity() {
        const described = await identity.describe(process.pid);
        return described.status === "described"
            ? { pid: process.pid, startToken: described.token }
            : undefined;
    },
});
export default startupCommandsServer;
//# sourceMappingURL=server.js.map