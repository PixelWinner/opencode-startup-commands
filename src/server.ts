import { spawn } from "node:child_process";
import {
  loadConfigFile,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from "./config.js";
import { processState } from "./core.js";
import { createLogger } from "./logger.js";
import { createProcessTreeController } from "./process-tree.js";
import { createStartupCommandsServer } from "./server-internal.js";

const startupCommandsServer = createStartupCommandsServer({
  loadConfigFile,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
  spawn,
  state: processState,
  processTree: createProcessTreeController(),
  logger: createLogger(),
});

export default startupCommandsServer;
