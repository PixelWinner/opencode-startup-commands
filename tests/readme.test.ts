import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const packageName = "opencode-startup-commands";
const npmRegistration = `${packageName}@1.2.0`;
const gitRegistration =
  `${packageName}@git+https://github.com/PixelWinner/` +
  `${packageName}.git#v1.2.0`;

function pluginRegistrations(markdown: string): string[] {
  const registrations: string[] = [];
  const jsonBlocks = markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g);

  for (const match of jsonBlocks) {
    const document = JSON.parse(match[1]) as { plugin?: unknown };
    if (Array.isArray(document.plugin)) {
      for (const registration of document.plugin) {
        if (typeof registration === "string") {
          registrations.push(registration);
        } else if (
          Array.isArray(registration) &&
          typeof registration[0] === "string"
        ) {
          registrations.push(registration[0]);
        }
      }
    }
  }

  return registrations;
}

function installationProblems(markdown: string): string[] {
  const problems: string[] = [];

  for (const registration of pluginRegistrations(markdown)) {
    if (registration === `${packageName}@latest`) {
      problems.push("latest npm registration");
    }
    if (registration === packageName) {
      problems.push("bare npm registration");
    }
    if (/#main\b/i.test(registration)) {
      problems.push("main branch fragment");
    }
    if (registration.includes("@git+") && registration !== gitRegistration) {
      problems.push("unpinned Git registration");
    }
  }

  return problems;
}

function pluginRegistrationFixture(registration: unknown): string {
  return `\`\`\`json\n${JSON.stringify({ plugin: [registration] }, null, 2)}\n\`\`\``;
}

test("documents only the exact npm release and immutable Git tag registrations", () => {
  expect(pluginRegistrations(readme)).toEqual([
    npmRegistration,
    gitRegistration,
  ]);
});

test("shows CI, npm version, and MIT license badges", () => {
  expect(readme).toMatch(
    /\[!\[CI\]\([^\n]*actions\/workflows\/ci\.yml\/badge\.svg\)\]\([^\n]*actions\/workflows\/ci\.yml\)/,
  );
  expect(readme).toMatch(
    /\[!\[npm version\]\([^\n]*npm\/v\/opencode-startup-commands[^\n]*\)\]\(https:\/\/www\.npmjs\.com\/package\/opencode-startup-commands\)/,
  );
  expect(readme).toMatch(
    /\[!\[License: MIT\]\([^\n]*License-MIT[^\n]*\)\]\(LICENSE\)/,
  );
});

test("keeps the concise approved public structure", () => {
  for (const heading of [
    "Compatibility",
    "Configuration",
    "Lifecycle and deduplication",
    "Process lifetime across OpenCode restarts",
    "Security",
    "Logging",
    "Development",
    "License",
  ]) {
    expect(readme).toContain(`## ${heading}`);
  }

  const lineCount = readme.trimEnd().split(/\r?\n/).length;
  expect(lineCount).toBeGreaterThanOrEqual(100);
  expect(lineCount).toBeLessThanOrEqual(180);
  expect(readme).toMatch(/unofficial[^\n]*not affiliated with[^\n]*OpenCode/i);
});

test("documents strict JSON configuration in global and project locations", () => {
  expect(readme).toContain("~/.config/opencode/startup-commands.json");
  expect(readme).toContain(
    "%USERPROFILE%\\.config\\opencode\\startup-commands.json",
  );
  expect(readme).toContain("<project-root>/.opencode/startup-commands.json");
  expect(readme).toMatch(/strict JSON/i);
  expect(readme).toMatch(/comments[^\n]*trailing commas[^\n]*(?:not|aren't)/i);
  expect(readme).toContain('"executable": "/absolute/path/to/helper"');
  expect(readme).toContain('"args": ["--watch"]');
  expect(readme).toContain('"onExistingProcess": "skip"');
  expect(readme).toContain('"stopOnExit": true');
  expect(readme).toMatch(/`onExistingProcess`[^\n]*defaults? to `skip`/i);
  expect(readme).toMatch(/`stopOnExit`[^\n]*defaults? to `true`/i);
  expect(readme).toMatch(/`onExistingProcess`[^\n]*only[^\n]*`start`[^\n]*`skip`[^\n]*`restart`/i);
  expect(readme).toMatch(/`stopOnExit`[^\n]*boolean/i);
  expect(readme).toMatch(/invalid entr(?:y|ies)[^\n]*later valid entr(?:y|ies)/i);
});

test("documents existing-process policy behavior and replacement ordering", () => {
  expect(readme).toMatch(/`start`[^\n]*additional[^\n]*separately owned[^\n]*record/i);
  expect(readme).toMatch(/`skip`[^\n]*current owner[^\n]*oldest[^\n]*record/i);
  expect(readme).toMatch(
    /`skip`[^\n]*without changing[^\n]*creation-time[^\n]*`stopOnExit`/i,
  );
  expect(readme).toMatch(/`restart`[^\n]*all[^\n]*one replacement/i);
  expect(readme).toMatch(/restart[^\n]*all plugin-owned[^\n]*records/i);
  expect(readme).toMatch(/restart[^\n]*regardless of[^\n]*stopOnExit/i);
  expect(readme).toMatch(
    /replacement[^\n]*only after[^\n]*confirmed[^\n]*cleanup/i,
  );
});

test("documents identity, duplicate precedence, and lifecycle-policy selection", () => {
  expect(readme).toMatch(/global[^\n]*before project/i);
  expect(readme).toMatch(/identity[^\n]*executable[^\n]*ordered[^\n]*args/i);
  expect(readme).toMatch(/project identit(?:y|ies)[^\n]*normalized root/i);
  expect(readme).toMatch(/global identit(?:y|ies)[^\n]*shared[^\n]*OpenCode instances/i);
  expect(readme).toMatch(
    /`name`[^\n]*`onExistingProcess`[^\n]*`stopOnExit`[^\n]*not part of identity/i,
  );
  expect(readme).toMatch(/first within (?:each )?scope/i);
  expect(readme).toMatch(
    /global[^\n]*first[^\n]*duplicate[^\n]*both policies[^\n]*before policy evaluation/i,
  );
});

test("documents normalized owners, final-owner cleanup, and same-process reopen", () => {
  expect(readme).toMatch(/project[^\n]*normalized root[^\n]*final owner/i);
  expect(readme).toMatch(/global[^\n]*final[^\n]*OpenCode[^\n]*owner/i);
  expect(readme).toMatch(/stopOnExit: false[^\n]*remain[^\n]*tracked/i);
  expect(readme).toMatch(/stopOnExit: true[^\n]*final owner[^\n]*stop/i);
  expect(readme).toMatch(/same-process reopen/i);
  expect(readme).toMatch(
    /confirmed successful[^\n]*cleanup[^\n]*releases the identity[^\n]*reopening[^\n]*same OpenCode process[^\n]*starts a new process/i,
  );
});

test("documents degraded restart blockers and process visibility", () => {
  expect(readme).toMatch(/partial[^\n]*restart[^\n]*degraded[^\n]*no replacement/i);
  expect(readme).toMatch(/survivor[^\n]*orphaned owners[^\n]*oldest survivor/i);
  expect(readme).toMatch(/tombstones[^\n]*blockers[^\n]*block/i);
  expect(readme).toMatch(/failed[^\n]*(?:not retried|no retry)/i);
  expect(readme).toMatch(
    /launch failures[^\n]*final natural exits[^\n]*unconfirmed stale cleanup[^\n]*same-process retry/i,
  );
  expect(readme).toMatch(/plugin[^\n]*launched[^\n]*current OpenCode process/i);
  expect(readme).toMatch(/does not scan[^\n]*OS[^\n]*(?:discover|adopt)/i);
  expect(readme).toMatch(/full OpenCode restart[^\n]*cannot rediscover/i);
  expect(readme).toMatch(/full OpenCode restart[^\n]*updating plugin code/i);
});

test("scopes rediscovery to recorded processes with a matching identity", () => {
  expect(readme).toMatch(
    /re-adopts only[^\n]*`stopOnExit: false`[^\n]*recorded in its (?:own )?registry/i,
  );
  expect(readme).toMatch(/whose `\(pid, startToken\)` pair still matches/i);
  expect(readme).toMatch(
    /cannot rediscover[^\n]*`stopOnExit: true`[^\n]*tracked only in memory/i,
  );
  expect(readme).toMatch(
    /processes it recorded[^\n]*registry[^\n]*did not launch/i,
  );
});

test("documents durable survival and re-adoption after a full OpenCode exit", () => {
  expect(readme).toMatch(
    /`stopOnExit: false`[^\n]*survives an OpenCode exit[^\n]*next OpenCode process re-adopts it/i,
  );
  expect(readme).toMatch(/instead of starting a second copy/i);
  expect(readme).toMatch(
    /`stopOnExit: true`[^\n]*never recorded[^\n]*never re-adopted/i,
  );
});

test("tabulates all six onExistingProcess and stopOnExit combinations", () => {
  for (const policy of ["start", "skip", "restart"]) {
    for (const stopOnExit of ["true", "false"]) {
      expect(readme).toMatch(
        new RegExp(`^\\| \`${policy}\` \\| \`${stopOnExit}\` \\| \\S`, "m"),
      );
    }
  }
  expect(readme).toMatch(/`skip` \| `false` \|[^\n]*Reuses the surviving process/i);
  expect(readme).toMatch(
    /`start` \| `false` \|[^\n]*starts one more[^\n]*both are remembered/i,
  );
  expect(readme).toMatch(
    /`restart` \| `false` \|[^\n]*Stops the surviving process[^\n]*exactly one replacement/i,
  );
  expect(readme).toMatch(/`skip` \| `true` \|[^\n]*Nothing survived/i);
  expect(readme).toMatch(/`start` \| `true` \|[^\n]*Nothing survived/i);
  expect(readme).toMatch(/`restart` \| `true` \|[^\n]*Nothing survived/i);
});

test("documents the deferred stopOnExit transition and configuration reconciliation", () => {
  expect(readme).toMatch(
    /Changing `stopOnExit` from `false` to `true`[^\n]*next activation[^\n]*not the running one/i,
  );
  expect(readme).toMatch(
    /surviving process is stopped[^\n]*replacement[^\n]*stopped when its session closes/i,
  );
  expect(readme).toMatch(
    /Removing a command from a cleanly loaded configuration stops its durable process/i,
  );
  expect(readme).toMatch(
    /kept unless that stop is confirmed[^\n]*retried on every later cleanly loaded activation[^\n]*waits out the stop budget/i,
  );
  expect(readme).toMatch(
    /configuration error stops nothing[^\n]*adoption still runs/i,
  );
  expect(readme).toMatch(
    /stopping is destructive[^\n]*both the global and the project file[^\n]*no error/i,
  );
});

test("documents the fail-closed probe rule and the absence of an external runtime", () => {
  expect(readme).toMatch(
    /cannot determine whether a remembered process is alive[^\n]*fails closed/i,
  );
  expect(readme).toMatch(
    /neither stops that process nor starts a duplicate/i,
  );
  expect(readme).toMatch(
    /No external runtime, daemon, or supervisor[^\n]*no runtime dependencies/i,
  );
});

test("documents what the registry stores, where, and how it is matched", () => {
  expect(readme).toContain(
    "%LOCALAPPDATA%\\opencode\\startup-commands\\<hostname>\\registry.json",
  );
  expect(readme).toContain(
    "~/Library/Application Support/OpenCode/startup-commands/<hostname>/registry.json",
  );
  expect(readme).toContain(
    "$XDG_STATE_HOME/opencode/startup-commands/<hostname>/registry.json",
  );
  expect(readme).toMatch(
    /hash of the command identity[^\n]*PID[^\n]*start token/i,
  );
  expect(readme).toMatch(
    /registry is kept per host[^\n]*`<hostname>` directory[^\n]*shared between machines keeps each machine's processes separate/i,
  );
  expect(readme).toMatch(
    /renaming the machine starts a new registry[^\n]*forgotten, never stopped[^\n]*launches fresh ones[^\n]*by hand after a rename/i,
  );
  expect(readme).toMatch(
    /re-identified by the `\(pid, startToken\)` pair, never by the token alone/i,
  );
  expect(readme).toMatch(
    /no token contains a PID[^\n]*can carry the same token/i,
  );
  expect(readme).toMatch(/every comparison[^\n]*keyed by PID/i);
  expect(readme).toMatch(
    /deleted registry file[^\n]*`\(pid, startToken\)` pair no longer matches[^\n]*forgotten rather than stopped[^\n]*starts fresh/i,
  );
  expect(readme).toMatch(
    /cannot be parsed is set aside[^\n]*continues with an empty registry[^\n]*forgotten rather than stopped/i,
  );
  expect(readme).toMatch(
    /cannot be read at all is left in place[^\n]*skipped for that activation rather than started/i,
  );
  expect(readme).toMatch(
    /Executable paths, arguments, environment variables, and project paths are never recorded/i,
  );
});

test("documents the one-time 1.1.0 to 1.2.0 migration", () => {
  expect(readme).toContain("### Upgrading from 1.1.0");
  expect(readme).toMatch(
    /1\.1\.0 kept no record[^\n]*1\.2\.0 cannot identify them/i,
  );
  expect(readme).toMatch(
    /^1\. Stop any helpers left running by `stopOnExit: false`\.\r?$/m,
  );
  expect(readme).toMatch(/^2\. Fully exit every OpenCode process\.\r?$/m);
  expect(readme).toMatch(/^3\. Install 1\.2\.0\.\r?$/m);
  expect(readme).toMatch(
    /^4\. Start OpenCode\. New `stopOnExit: false` commands are now remembered\.\r?$/m,
  );
});

test("documents platform stop escalation, limitations, and sanitized events", () => {
  expect(readme).toMatch(/POSIX[^\n]*SIGTERM[^\n]*5 seconds[^\n]*SIGKILL/i);
  expect(readme).toMatch(
    /Windows[^\n]*direct[^\n]*trusted[^\n]*taskkill\.exe[^\n]*\/T[^\n]*waits? 5 seconds[^\n]*only if the tree still remains[^\n]*taskkill\.exe[^\n]*\/T[^\n]*\/F/i,
  );
  expect(readme).toMatch(
    /best-effort[^\n]*detached[^\n]*escaped descendants[^\n]*forced OpenCode termination[^\n]*OS crash[^\n]*power loss/i,
  );
  expect(readme).toMatch(/sanitized[^\n]*requested[^\n]*forced[^\n]*failed stop events/i);
  expect(readme).toMatch(/stop events[^\n]*commands[^\n]*raw errors/i);
});

test("documents fail-closed Windows cleanup after the tracked root exits", () => {
  expect(readme).toMatch(
    /Windows[^\n]*tracked root exits before cleanup[^\n]*descendants cannot be addressed safely/i,
  );
  expect(readme).toMatch(/fails closed[^\n]*may leave descendants running/i);
  expect(readme).toMatch(/blocks restart[^\n]*identity/i);
  expect(readme).toMatch(/recovery[^\n]*full OpenCode restart/i);
});

test("distinguishes the original project cwd from the normalized deduplication key", () => {
  expect(readme).toMatch(
    /project commands receive the original OpenCode worktree root as `cwd`/i,
  );
  expect(readme).toMatch(/only the deduplication key normalizes (?:that|the) root/i);
  expect(readme).not.toMatch(/receive[^\n]*normalized[^\n]*root[^\n]*as `cwd`/i);
});

test("warns about arbitrary code and requests sanitized evidence", () => {
  expect(readme).toMatch(/arbitrary code/i);
  expect(readme).toMatch(/only[^\n]*source[^\n]*configuration[^\n]*trust/i);
  expect(readme).toMatch(/sanitiz(?:e|ed)[^\n]*(?:logs|configuration|evidence)/i);
  expect(readme).toMatch(/(?:secrets|credentials)[^\n]*personal data/i);
  expect(readme).toContain("SECURITY.md");
});

test("lists platform logs and their privacy and rotation behavior", () => {
  expect(readme).toContain(
    "%LOCALAPPDATA%\\opencode\\logs\\opencode-startup-commands.log",
  );
  expect(readme).toContain(
    "~/Library/Logs/OpenCode/opencode-startup-commands.log",
  );
  expect(readme).toContain(
    "$XDG_STATE_HOME/opencode/log/opencode-startup-commands.log",
  );
  expect(readme).toMatch(/1 MiB/i);
  expect(readme).toMatch(/omit[^\n]*(?:paths|arguments|environment variables)/i);
});

test("documents release checks, tracked dist, MIT, and the author", () => {
  for (const command of [
    "bun install --frozen-lockfile",
    "bun test",
    "bun run typecheck",
    "bun run compile",
    "bun run release:check",
  ]) {
    expect(readme).toContain(command);
  }
  expect(readme).toMatch(/dist\/[^\n]*tracked[^\n]*Git installation/i);
  expect(readme).toMatch(/MIT[^\n]*LICENSE/i);
  expect(readme).toContain("Oleksandr Khoroshykh (PixelWinner)");
  expect(readme).toContain("https://github.com/PixelWinner");
});

test("rejects moving, bare, default-branch, and unpinned registrations", () => {
  expect(installationProblems(readme)).toEqual([]);
});

test("examines and rejects plugin specs inside tuple registrations", () => {
  const fixture = pluginRegistrationFixture([
    "opencode-startup-commands@latest",
    {},
  ]);

  expect(pluginRegistrations(fixture)).toEqual([
    "opencode-startup-commands@latest",
  ]);
  expect(installationProblems(fixture)).toContain("latest npm registration");
});

test("allows harmless default-branch and main prose outside registrations", () => {
  const fixture = `${pluginRegistrationFixture(npmRegistration)}

The default branch is named main, but this guide does not recommend it for plugin installation.`;

  expect(installationProblems(fixture)).toEqual([]);
});
