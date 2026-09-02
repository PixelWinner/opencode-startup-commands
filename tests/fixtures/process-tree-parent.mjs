import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pidFile = process.argv[2];
const mode = process.argv[3] ?? "normal";
const childPath = fileURLToPath(
  new URL("./process-tree-child.mjs", import.meta.url),
);
const child = spawn(process.execPath, [childPath, mode], {
  detached: false,
  shell: false,
  stdio: "ignore",
  windowsHide: true,
});

writeFileSync(
  pidFile,
  JSON.stringify({ parentPid: process.pid, childPid: child.pid }),
  "utf8",
);

if (mode === "ignore-term" && process.platform !== "win32") {
  process.on("SIGTERM", () => {});
}

setInterval(() => {}, 1_000);
