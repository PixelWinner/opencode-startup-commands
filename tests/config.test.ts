import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadConfigFile,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from "../src/config.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "startup-commands-config-"));
  tempDirectories.push(directory);
  return directory;
}

function writeConfig(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

describe("Configuration paths", () => {
  test("resolves the global path from an injected home directory", () => {
    const home = join("safe", "home");

    expect(resolveGlobalConfigPath(home)).toBe(
      join(home, ".config", "opencode", "startup-commands.json"),
    );
  });

  test("resolves the project path from an injected worktree", () => {
    const worktree = join("safe", "worktree");

    expect(resolveProjectConfigPath(worktree)).toBe(
      join(worktree, ".opencode", "startup-commands.json"),
    );
  });
});

describe("Configuration loading", () => {
  test("treats a missing file as an empty configuration", () => {
    const filePath = join(createTempDirectory(), "missing.json");

    expect(loadConfigFile("global", filePath)).toEqual({
      commands: [],
      diagnostics: [],
    });
  });

  test("loads valid global commands and preserves executable and args", () => {
    const filePath = join(createTempDirectory(), "global.json");
    writeConfig(
      filePath,
      JSON.stringify({
        commands: [
          {
            name: "  Global Helper  ",
            executable: "  /opt/helper  ",
            args: ["", "  exact argument  "],
          },
        ],
      }),
    );

    expect(loadConfigFile("global", filePath)).toEqual({
      commands: [
        {
          name: "Global Helper",
          executable: "  /opt/helper  ",
          args: ["", "  exact argument  "],
          onExistingProcess: "skip",
          stopOnExit: true,
          scope: "global",
          index: 0,
        },
      ],
      diagnostics: [],
    });
  });

  test("loads valid project commands with their project root", () => {
    const directory = createTempDirectory();
    const projectRoot = join(directory, "worktree");
    const filePath = resolveProjectConfigPath(projectRoot);
    writeConfig(
      filePath,
      JSON.stringify({
        commands: [
          {
            name: "Project Helper",
            executable: "project-helper",
            args: ["--project"],
          },
        ],
      }),
    );

    expect(loadConfigFile("project", filePath, projectRoot)).toEqual({
      commands: [
        {
          name: "Project Helper",
          executable: "project-helper",
          args: ["--project"],
          onExistingProcess: "skip",
          stopOnExit: true,
          scope: "project",
          projectRoot,
          index: 0,
        },
      ],
      diagnostics: [],
    });
  });

  test.each([
    {
      configured: {},
      expected: { onExistingProcess: "skip", stopOnExit: true },
    },
    {
      configured: { onExistingProcess: "start", stopOnExit: false },
      expected: { onExistingProcess: "start", stopOnExit: false },
    },
    {
      configured: { onExistingProcess: "skip", stopOnExit: true },
      expected: { onExistingProcess: "skip", stopOnExit: true },
    },
    {
      configured: { onExistingProcess: "restart", stopOnExit: false },
      expected: { onExistingProcess: "restart", stopOnExit: false },
    },
  ])("normalizes lifecycle policy %#", ({ configured, expected }) => {
    const filePath = join(createTempDirectory(), "lifecycle.json");
    writeConfig(
      filePath,
      JSON.stringify({
        commands: [
          {
            name: "Lifecycle helper",
            executable: "helper",
            args: ["--watch"],
            ...configured,
          },
        ],
      }),
    );

    expect(loadConfigFile("global", filePath).commands).toEqual([
      {
        name: "Lifecycle helper",
        executable: "helper",
        args: ["--watch"],
        ...expected,
        scope: "global",
        index: 0,
      },
    ]);
  });

  test.each([
    { configured: { onExistingProcess: "replace" } },
    { configured: { onExistingProcess: 1 } },
    { configured: { onExistingProcess: null } },
    { configured: { stopOnExit: "yes" } },
    { configured: { stopOnExit: 1 } },
    { configured: { stopOnExit: null } },
  ])("isolates invalid lifecycle policy %#", ({ configured }) => {
    const filePath = join(createTempDirectory(), "invalid-lifecycle.json");
    writeConfig(
      filePath,
      JSON.stringify({
        commands: [
          {
            name: "Invalid lifecycle",
            executable: "invalid-helper",
            args: [],
            ...configured,
          },
          {
            name: "Valid lifecycle",
            executable: "valid-helper",
            args: [],
            onExistingProcess: "start",
            stopOnExit: false,
          },
        ],
      }),
    );

    expect(loadConfigFile("global", filePath)).toEqual({
      commands: [
        {
          name: "Valid lifecycle",
          executable: "valid-helper",
          args: [],
          onExistingProcess: "start",
          stopOnExit: false,
          scope: "global",
          index: 1,
        },
      ],
      diagnostics: [
        {
          scope: "global",
          reason: "invalid-command",
          index: 0,
          name: "Invalid lifecycle",
        },
      ],
    });
  });

  test("loads a valid document with one leading UTF-8 BOM", () => {
    const filePath = join(createTempDirectory(), "bom.json");
    writeConfig(
      filePath,
      `\uFEFF${JSON.stringify({
        commands: [
          {
            name: "BOM Helper",
            executable: "helper",
            args: [],
          },
        ],
      })}`,
    );

    expect(loadConfigFile("global", filePath)).toEqual({
      commands: [
        {
          name: "BOM Helper",
          executable: "helper",
          args: [],
          onExistingProcess: "skip",
          stopOnExit: true,
          scope: "global",
          index: 0,
        },
      ],
      diagnostics: [],
    });
  });

  test("reports malformed JSON without exposing parser details", () => {
    const filePath = join(createTempDirectory(), "malformed.json");
    writeConfig(filePath, '{"commands":[SECRET_MALFORMED_JSON');

    const result = loadConfigFile("global", filePath);

    expect(result).toEqual({
      commands: [],
      diagnostics: [{ scope: "global", reason: "invalid-json" }],
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "SECRET_MALFORMED_JSON",
    );
  });

  test.each([[null], [[]], ["text"], [42]])(
    "reports a non-object document: %p",
    (document) => {
      const projectRoot = createTempDirectory();
      const filePath = join(projectRoot, "invalid-document.json");
      writeConfig(filePath, JSON.stringify(document));

      expect(loadConfigFile("project", filePath, projectRoot)).toEqual({
        commands: [],
        diagnostics: [{ scope: "project", reason: "invalid-document" }],
      });
    },
  );

  test.each([[{}], [{ commands: null }], [{ commands: {} }]])(
    "reports missing or non-array commands: %p",
    (document) => {
      const filePath = join(createTempDirectory(), "invalid-commands.json");
      writeConfig(filePath, JSON.stringify(document));

      expect(loadConfigFile("global", filePath)).toEqual({
        commands: [],
        diagnostics: [{ scope: "global", reason: "commands-required" }],
      });
    },
  );

  test("skips invalid entries and retains later valid entries", () => {
    const filePath = join(createTempDirectory(), "entries.json");
    writeConfig(
      filePath,
      JSON.stringify({
        commands: [
          null,
          { name: " ", executable: "helper", args: [] },
          { name: "Missing executable", args: [] },
          { name: "Blank executable", executable: "\t", args: [] },
          { name: "Missing args", executable: "helper" },
          {
            name: "Non-string arg",
            executable: "helper",
            args: [1],
          },
          { executable: "helper", args: [] },
          { name: 1, executable: "helper", args: [] },
          { name: "Non-string executable", executable: 1, args: [] },
          { name: "Non-array args", executable: "helper", args: "--safe" },
          {
            name: "  Retained Helper  ",
            executable: " helper ",
            args: ["--safe"],
          },
        ],
      }),
    );

    expect(loadConfigFile("global", filePath)).toEqual({
      commands: [
        {
          name: "Retained Helper",
          executable: " helper ",
          args: ["--safe"],
          onExistingProcess: "skip",
          stopOnExit: true,
          scope: "global",
          index: 10,
        },
      ],
      diagnostics: [
        { scope: "global", reason: "invalid-command", index: 0 },
        { scope: "global", reason: "invalid-command", index: 1 },
        {
          scope: "global",
          reason: "invalid-command",
          index: 2,
          name: "Missing executable",
        },
        {
          scope: "global",
          reason: "invalid-command",
          index: 3,
          name: "Blank executable",
        },
        {
          scope: "global",
          reason: "invalid-command",
          index: 4,
          name: "Missing args",
        },
        {
          scope: "global",
          reason: "invalid-command",
          index: 5,
          name: "Non-string arg",
        },
        { scope: "global", reason: "invalid-command", index: 6 },
        { scope: "global", reason: "invalid-command", index: 7 },
        {
          scope: "global",
          reason: "invalid-command",
          index: 8,
          name: "Non-string executable",
        },
        {
          scope: "global",
          reason: "invalid-command",
          index: 9,
          name: "Non-array args",
        },
      ],
    });
  });

  test("diagnostics never expose paths, content, executables, args, or system errors", () => {
    const secret = "SECRET_CONFIG_SENTINEL";
    const directory = createTempDirectory();
    const unreadablePath = join(directory, secret);
    mkdirSync(unreadablePath);
    const readFailure = loadConfigFile("global", unreadablePath);

    const invalidPath = join(directory, `${secret}.json`);
    writeConfig(
      invalidPath,
      JSON.stringify({
        commands: [
          {
            name: "Safe label",
            executable: secret,
            args: [secret, 1],
          },
        ],
        extra: secret,
      }),
    );
    const validationFailure = loadConfigFile("project", invalidPath, directory);

    expect(readFailure).toEqual({
      commands: [],
      diagnostics: [{ scope: "global", reason: "file-unavailable" }],
    });
    expect(validationFailure.diagnostics).toEqual([
      {
        scope: "project",
        reason: "invalid-command",
        index: 0,
        name: "Safe label",
      },
    ]);
    expect(
      JSON.stringify([
        ...readFailure.diagnostics,
        ...validationFailure.diagnostics,
      ]),
    ).not.toContain(secret);
  });
});
