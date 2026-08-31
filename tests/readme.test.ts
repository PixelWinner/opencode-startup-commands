import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const packageName = "opencode-startup-commands";
const npmRegistration = `${packageName}@1.0.0`;
const gitRegistration =
  `${packageName}@git+https://github.com/PixelWinner/` +
  `${packageName}.git#v1.0.0`;

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
    "Security",
    "Logging",
    "Development",
    "License",
  ]) {
    expect(readme).toContain(`## ${heading}`);
  }

  const lineCount = readme.trimEnd().split(/\r?\n/).length;
  expect(lineCount).toBeGreaterThanOrEqual(100);
  expect(lineCount).toBeLessThanOrEqual(120);
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
});

test("documents global-first lifecycle and process-root deduplication", () => {
  expect(readme).toMatch(/global[^\n]*before project/i);
  expect(readme).toMatch(/global[^\n]*once per OpenCode process/i);
  expect(readme).toMatch(/project[^\n]*once per normalized project root/i);
  expect(readme).toMatch(/identity[^\n]*executable[^\n]*ordered[^\n]*args/i);
  expect(readme).toMatch(/failed[^\n]*(?:not retried|no retry)/i);
  expect(readme).toMatch(/restart OpenCode/i);
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
