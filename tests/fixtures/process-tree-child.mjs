if (process.argv[2] === "ignore-term" && process.platform !== "win32") {
  process.on("SIGTERM", () => {});
}

setInterval(() => {}, 1_000);
