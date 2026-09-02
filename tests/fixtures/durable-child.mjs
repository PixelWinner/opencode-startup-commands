const timer = setInterval(() => {}, 1000);

function shutdown() {
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (process.argv[2] === "reap-on-stdin-close") {
  process.stdin.on("close", shutdown);
  process.stdin.resume();
}
