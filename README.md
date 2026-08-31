# opencode-startup-commands

Launch trusted background commands when OpenCode initializes a project or directory.

This is an unofficial third-party plugin and is not affiliated with the OpenCode project.

[![CI](https://github.com/PixelWinner/opencode-startup-commands/actions/workflows/ci.yml/badge.svg)](https://github.com/PixelWinner/opencode-startup-commands/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/opencode-startup-commands.svg)](https://www.npmjs.com/package/opencode-startup-commands) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- Loads dedicated global and project command files in global-first order without blocking on child readiness.
- Deduplicates launches for each OpenCode process and normalized project root.
- Spawns the executable with its ordered arguments directly, without an implicit shell.
- Supports Linux, macOS, and Windows with sanitized console and rotating file logs.

## Compatibility

Supports OpenCode `1.18.x` and is compiled and directly tested against `1.18.25`.

## Installation

Register the exact npm release in `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-startup-commands@1.0.0"]
}
```

Alternatively, register the immutable Git tag:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-startup-commands@git+https://github.com/PixelWinner/opencode-startup-commands.git#v1.0.0"]
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
      "args": ["--watch"]
    }
  ]
}
```

`commands` must be an array. Each valid entry needs a non-empty `name`, a non-empty `executable`, and a string array named `args`; invalid entries are skipped without blocking later valid entries.

Project commands receive the original OpenCode worktree root as `cwd`; only the deduplication key normalizes that root. Global commands inherit OpenCode's current directory. Both inherit its environment and `PATH`.

## Lifecycle and deduplication

- Global commands are loaded before project commands; array order is preserved within each scope.
- One missing or invalid scope does not block valid commands from the other scope.
- Duplicate identity is the exact `executable` plus the ordered `args`; `name` is not part of identity.
- An exact global duplicate takes precedence over a project command.
- A global identity starts once per OpenCode process.
- A project identity starts once per normalized project root per OpenCode process.
- Identity is recorded before spawning, so failed launches are not retried in that process.
- Bare `opencode serve` does not launch commands until a project or directory initializes the plugin.

Fully restart OpenCode after changing registration, revision, or command files. Restarting reloads configuration and clears process-wide launch identities.

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

The active file rotates at 1 MiB and retains one `.1` archive. Logging failures do not prevent command startup. Logs omit configuration and executable paths, arguments, environment variables, raw configuration, and raw errors; they retain only sanitized lifecycle context such as scope, safe display name, PID, exit code, and signal.

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
