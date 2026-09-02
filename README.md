# opencode-startup-commands

Launch trusted background commands when OpenCode initializes a project or directory.

This is an unofficial third-party plugin and is not affiliated with the OpenCode project.

[![CI](https://github.com/PixelWinner/opencode-startup-commands/actions/workflows/ci.yml/badge.svg)](https://github.com/PixelWinner/opencode-startup-commands/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/opencode-startup-commands.svg)](https://www.npmjs.com/package/opencode-startup-commands) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- Loads dedicated global and project command files in global-first order without blocking on child readiness.
- Deduplicates launches for each OpenCode process and normalized project root.
- Remembers `stopOnExit: false` processes across OpenCode restarts and re-adopts them instead of starting duplicates.
- Spawns the executable with its ordered arguments directly, without an implicit shell.
- Supports Linux, macOS, and Windows with sanitized console and rotating file logs.

## Compatibility

Supports OpenCode `1.18.x` and is compiled and directly tested against `1.18.28`.

## Installation

Register the exact npm release in `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-startup-commands@1.2.0"]
}
```

Alternatively, register the immutable Git tag:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-startup-commands@git+https://github.com/PixelWinner/opencode-startup-commands.git#v1.2.0"]
}
```

Plugin options are not used. Commands belong in the files below.

## Configuration

| Scope | Location |
| --- | --- |
| Global, Linux/macOS | `~/.config/opencode/startup-commands.json` |
| Global, Windows | `%USERPROFILE%\.config\opencode\startup-commands.json` |
| Project | `<project-root>/.opencode/startup-commands.json` |

Each file is strict JSON; comments and trailing commas are not accepted. A missing file is normal.

```json
{
  "commands": [
    {
      "name": "Start helper",
      "executable": "/absolute/path/to/helper",
      "args": ["--watch"],
      "onExistingProcess": "skip",
      "stopOnExit": true
    }
  ]
}
```

`commands` must be an array. Each valid entry needs a non-empty `name`, a non-empty `executable`, and a string array named `args`. `onExistingProcess` accepts only `start`, `skip`, or `restart` and defaults to `skip`; `stopOnExit` must be a boolean and defaults to `true`. Invalid entries are skipped without blocking later valid entries.

Project commands receive the original OpenCode worktree root as `cwd`; only the deduplication key normalizes that root. Global commands inherit OpenCode's current directory. Both inherit its environment and `PATH`.

## Lifecycle and deduplication

- Global commands are loaded before project commands; array order is preserved within each scope.
- One missing or invalid scope does not block valid commands from the other scope.
- Process identity is the exact `executable` plus the ordered `args`; project identities also include the normalized root, while global identities are shared by OpenCode instances in one process. `name`, `onExistingProcess`, and `stopOnExit` are not part of identity.
- Same-batch duplicate removal is global-first and first within each scope: the global/first duplicate winner supplies both policies before policy evaluation.
- `start` appends one additional, separately owned process record.
- `skip` attaches the current owner to and reuses the oldest active process record without changing its creation-time `stopOnExit`.
- `restart` stops all plugin-owned tracked records, regardless of `stopOnExit`, and starts one replacement only after complete confirmed cleanup.
- For `stopOnExit: true`, project ownership uses the normalized root and cleanup waits for that project's final owner; global cleanup waits for the final OpenCode plugin-instance owner.
- `stopOnExit: false` records remain tracked when ownerless for later `skip` or `restart`; `stopOnExit: true` records wait for the final owner, then stop. A same-process reopen can attach a new owner to a still-tracked record. Confirmed successful final cleanup instead releases the identity, so reopening in the same OpenCode process starts a new process.
- Failed launches are not retried in that process; launch failures, final natural exits, and unconfirmed stale cleanup create tombstones and blockers that block same-process retry as applicable.
- A partial restart leaves safely addressable survivors in degraded state, transfers orphaned owners to the oldest survivor, and starts no replacement.
- Tracking covers processes the plugin launched during the current OpenCode process, plus the `stopOnExit: false` processes it recorded in its own registry; it does not scan the OS to discover or adopt processes it did not launch.
- Bare `opencode serve` does not launch commands until a project or directory initializes the plugin.

A full OpenCode restart is required after updating plugin code or changing registration, revision, or command files; after that restart the plugin cannot rediscover `stopOnExit: true` processes, which are tracked only in memory, and re-adopts only the `stopOnExit: false` processes recorded in its registry whose `(pid, startToken)` pair still matches.

### Process stopping

- On POSIX, process-group cleanup sends `SIGTERM`, waits 5 seconds, then sends `SIGKILL`.
- On Windows, the plugin directly invokes trusted `taskkill.exe /T` and waits 5 seconds; only if the tree still remains does it invoke `taskkill.exe /T /F` for forced cleanup.
- On Windows, if the tracked root exits before cleanup, its descendants cannot be addressed safely. The plugin fails closed, which may leave descendants running, blocks restart for that identity, and recovery requires a full OpenCode restart.
- Cleanup is best-effort for deliberately detached or escaped descendants, forced OpenCode termination, OS crash, and power loss.

## Process lifetime across OpenCode restarts

A `stopOnExit: false` process survives an OpenCode exit, and the next OpenCode process re-adopts it from a registry file instead of starting a second copy. A `stopOnExit: true` process is stopped when its final owner disposes, is never recorded, and is never re-adopted.

The table covers the first activation after a full OpenCode exit, with the command's configuration unchanged since the previous start; within one OpenCode process the policies behave as described above.

| `onExistingProcess` | `stopOnExit` | Behavior at the next OpenCode start |
| --- | --- | --- |
| `skip` | `false` | Reuses the surviving process and starts nothing. |
| `start` | `false` | Keeps the surviving process and starts one more beside it; both are remembered. |
| `restart` | `false` | Stops the surviving process, waits for confirmed cleanup, then starts exactly one replacement. |
| `skip` | `true` | Nothing survived, so one process starts and is stopped again on exit. |
| `start` | `true` | Nothing survived, so one process starts and is stopped again on exit. |
| `restart` | `true` | Nothing survived, so one process starts and is stopped again on exit. |

- Changing `stopOnExit` from `false` to `true` takes effect at the next activation, not the running one: the surviving process is stopped, one replacement starts in per-session mode, and that replacement is stopped when its session closes.
- Removing a command from a cleanly loaded configuration stops its durable process. The record is kept unless that stop is confirmed, so a process that cannot be confirmed stopped is retried on every later cleanly loaded activation, and each retry waits out the stop budget before other durable work proceeds. A configuration error stops nothing: adoption still runs, because refusing to adopt over a typo would create the duplicate processes this section exists to prevent, while stopping is destructive and requires both the global and the project file to load with no error at all, including a single invalid entry.
- If the plugin cannot determine whether a remembered process is alive, such as when a probe is denied permission, it fails closed: it neither stops that process nor starts a duplicate, and retries at a later activation.
- No external runtime, daemon, or supervisor process is added, and the plugin declares no runtime dependencies.

### What is remembered

A registry file records, for each surviving process, a hash of the command identity, its PID, and a start token:

| Platform | Registry file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\opencode\startup-commands\<hostname>\registry.json` |
| macOS | `~/Library/Application Support/OpenCode/startup-commands/<hostname>/registry.json` |
| Linux | `$XDG_STATE_HOME/opencode/startup-commands/<hostname>/registry.json`, or `~/.local/state/opencode/startup-commands/<hostname>/registry.json` |

The registry is kept per host, under a sanitized `<hostname>` directory, so a home directory shared between machines keeps each machine's processes separate. Because that key is the hostname, renaming the machine starts a new registry: helpers recorded under the old name are forgotten, never stopped, and the next start launches fresh ones beside them, so stop the old ones once by hand after a rename. A remembered process is re-identified by the `(pid, startToken)` pair, never by the token alone. A start token is only a start timestamp at the platform's own granularity: 100-nanosecond ticks on Windows, one kernel clock tick on Linux (10 ms on the kernels measured), and one second on macOS. No token contains a PID, so two processes started inside one such window can carry the same token; that is safe because every comparison the plugin makes is keyed by PID as well.

A deleted registry file, or a record whose `(pid, startToken)` pair no longer matches, for example after a reboot, means the process it described is forgotten rather than stopped, and the command starts fresh. A registry file that cannot be parsed is set aside under a `.corrupt-` name and the plugin continues with an empty registry, so the processes it described are likewise forgotten rather than stopped. A registry file that cannot be read at all is left in place instead, and `stopOnExit: false` commands are skipped for that activation rather than started. Executable paths, arguments, environment variables, and project paths are never recorded.

### Upgrading from 1.1.0

Version 1.1.0 kept no record of the processes it left running, so 1.2.0 cannot identify them. Once, before upgrading:

1. Stop any helpers left running by `stopOnExit: false`.
2. Fully exit every OpenCode process.
3. Install 1.2.0.
4. Start OpenCode. New `stopOnExit: false` commands are now remembered.

## Security

> [!WARNING]
> This plugin performs arbitrary code execution with the OpenCode user's permissions. Install only from a plugin source and command configuration you trust, and inspect project-controlled command files before opening a repository.

The plugin launches executables directly and does not add shell expansion, interpolation, pipes, redirection, or wildcards. Configure a trusted shell explicitly only when shell behavior is required.

Use absolute executable and script paths when predictable resolution matters. Do not place secrets, credentials, or personal data in names or arguments; local process tools may expose arguments even though plugin logs do not.

Before reporting a problem, sanitize logs, configuration, and other evidence. Follow [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Logging

Events appear as `startup-commands:` messages on OpenCode's stderr and in:

| Platform | Log file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\opencode\logs\opencode-startup-commands.log` |
| macOS | `~/Library/Logs/OpenCode/opencode-startup-commands.log` |
| Linux | `$XDG_STATE_HOME/opencode/log/opencode-startup-commands.log`, or `~/.local/state/opencode/log/opencode-startup-commands.log` |

The active file rotates at 1 MiB and retains one `.1` archive. Logging failures do not prevent command startup. Logs omit configuration and executable paths, arguments, environment variables, raw configuration, and raw errors; they retain only sanitized lifecycle context such as scope, safe display name, PID, exit code, and signal. Stop logging uses sanitized requested, forced, and failed stop events without process commands or raw errors.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run compile
bun run release:check
```

`dist/` remains tracked for immutable Git installation. After runtime source changes, compile and keep the generated output synchronized with the source.

## License

Released under the [MIT License](LICENSE).

Author: [Oleksandr Khoroshykh (PixelWinner)](https://github.com/PixelWinner).
