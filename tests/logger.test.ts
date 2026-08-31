import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type LogEvent } from "../src/logger.js";

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
  const directory = mkdtempSync(join(tmpdir(), "startup-commands-"));
  tempDirectories.push(directory);
  return directory;
}

function createConsole(): {
  lines: string[];
  error(message: string): void;
} {
  const lines: string[] = [];

  return {
    lines,
    error(message: string): void {
      lines.push(message);
    },
  };
}

const FILE_EVENT_CASES = [
  {
    label: "global unavailable configuration",
    event: {
      type: "configuration.invalid",
      scope: "global",
      reason: "file-unavailable",
    },
    expected: "configuration.invalid scope=global reason=file-unavailable",
  },
  {
    label: "project unavailable configuration",
    event: {
      type: "configuration.invalid",
      scope: "project",
      reason: "file-unavailable",
    },
    expected: "configuration.invalid scope=project reason=file-unavailable",
  },
  {
    label: "global invalid JSON configuration",
    event: {
      type: "configuration.invalid",
      scope: "global",
      reason: "invalid-json",
    },
    expected: "configuration.invalid scope=global reason=invalid-json",
  },
  {
    label: "project invalid JSON configuration",
    event: {
      type: "configuration.invalid",
      scope: "project",
      reason: "invalid-json",
    },
    expected: "configuration.invalid scope=project reason=invalid-json",
  },
  {
    label: "global missing commands configuration",
    event: {
      type: "configuration.invalid",
      scope: "global",
      reason: "commands-required",
    },
    expected: "configuration.invalid scope=global reason=commands-required",
  },
  {
    label: "project missing commands configuration",
    event: {
      type: "configuration.invalid",
      scope: "project",
      reason: "commands-required",
    },
    expected: "configuration.invalid scope=project reason=commands-required",
  },
  {
    label: "global invalid document configuration",
    event: {
      type: "configuration.invalid",
      scope: "global",
      reason: "invalid-document",
    },
    expected: "configuration.invalid scope=global reason=invalid-document",
  },
  {
    label: "project invalid document configuration",
    event: {
      type: "configuration.invalid",
      scope: "project",
      reason: "invalid-document",
    },
    expected: "configuration.invalid scope=project reason=invalid-document",
  },
  {
    label: "global invalid command",
    event: {
      type: "command.invalid",
      scope: "global",
      index: 4,
    },
    expected: "command.invalid scope=global index=4",
  },
  {
    label: "project already-started command",
    event: {
      type: "command.skipped",
      scope: "project",
      index: 5,
      name: "Project helper",
      reason: "already-started",
    },
    expected:
      'command.skipped scope=project index=5 name="Project helper" reason=already-started',
  },
  {
    label: "global duplicate command",
    event: {
      type: "command.skipped",
      scope: "global",
      index: 6,
      name: "Global helper",
      reason: "duplicate",
    },
    expected:
      'command.skipped scope=global index=6 name="Global helper" reason=duplicate',
  },
] satisfies Array<{ label: string; event: LogEvent; expected: string }>;

describe("Logger console output", () => {
  test("writes concise safe lifecycle events", () => {
    const output = createConsole();
    const directory = createTempDirectory();
    const logger = createLogger({
      console: output,
      filePath: join(directory, "plugin.log"),
    });

    logger.write({
      type: "command.spawned",
      scope: "global",
      index: 0,
      name: "Lemonade Whisper",
      pid: 123,
    });

    expect(output.lines).toEqual([
      'startup-commands: spawned scope=global index=0 name="Lemonade Whisper" pid=123',
    ]);
  });

  test("writes fixed scope-aware configuration diagnostics", () => {
    const output = createConsole();
    const directory = createTempDirectory();
    const logger = createLogger({
      console: output,
      filePath: join(directory, "plugin.log"),
    });

    logger.write({
      type: "configuration.invalid",
      scope: "global",
      reason: "file-unavailable",
    });
    logger.write({
      type: "configuration.invalid",
      scope: "project",
      reason: "invalid-json",
    });
    logger.write({
      type: "configuration.invalid",
      scope: "global",
      reason: "invalid-document",
    });
    logger.write({
      type: "configuration.invalid",
      scope: "project",
      reason: "commands-required",
    });
    logger.write({
      type: "command.invalid",
      scope: "project",
      index: 7,
      name: "Project helper",
    });

    expect(output.lines).toEqual([
      "startup-commands: invalid configuration scope=global reason=file-unavailable",
      "startup-commands: invalid configuration scope=project reason=invalid-json",
      "startup-commands: invalid configuration scope=global reason=invalid-document",
      "startup-commands: invalid configuration scope=project reason=commands-required",
      'startup-commands: invalid command scope=project index=7 name="Project helper"',
    ]);
  });

  test("writes fixed scope-aware command skip reasons", () => {
    const output = createConsole();
    const directory = createTempDirectory();
    const logger = createLogger({
      console: output,
      filePath: join(directory, "plugin.log"),
    });

    logger.write({
      type: "command.skipped",
      scope: "global",
      index: 2,
      name: "Repeated helper",
      reason: "duplicate",
    });
    logger.write({
      type: "command.skipped",
      scope: "project",
      index: 3,
      name: "Started helper",
      reason: "already-started",
    });

    expect(output.lines).toEqual([
      'startup-commands: command skipped scope=global index=2 name="Repeated helper" reason=duplicate',
      'startup-commands: command skipped scope=project index=3 name="Started helper" reason=already-started',
    ]);
  });

  test("removes control characters and caps command labels", () => {
    const output = createConsole();
    const directory = createTempDirectory();
    const logger = createLogger({
      console: output,
      filePath: join(directory, "plugin.log"),
    });
    const unsafeName = `line one\r\nline two\u0000${"x".repeat(200)}`;

    logger.write({
      type: "command.spawned",
      scope: "global",
      index: 4,
      name: unsafeName,
    });

    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).not.toMatch(/[\r\n\u0000]/);
    expect(output.lines[0]).toContain(`name="${"line one  line two ".concat("x".repeat(101))}"`);
    expect(output.lines[0]).not.toContain("x".repeat(102));
  });

  test("removes Unicode line separators and C1 controls", () => {
    const output = createConsole();
    const directory = createTempDirectory();
    const logger = createLogger({
      console: output,
      filePath: join(directory, "plugin.log"),
    });

    logger.write({
      type: "command.spawned",
      scope: "project",
      index: 0,
      name: "safe\u0085forged\u2028second\u2029third",
    });

    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]).not.toMatch(/[\u0080-\u009f\u2028\u2029]/);
  });
});

describe("Logger file output", () => {
  test("appends timestamped safe events", () => {
    const directory = createTempDirectory();
    const filePath = join(directory, "plugin.log");
    const logger = createLogger({
      console: createConsole(),
      filePath,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    logger.write({
      type: "command.spawned",
      scope: "project",
      index: 0,
      name: "Helper",
      pid: 123,
    });

    expect(readFileSync(filePath, "utf8")).toBe(
      '2026-08-30T12:00:00.000Z command.spawned scope=project index=0 name="Helper" pid=123\n',
    );
  });

  test.each(FILE_EVENT_CASES)("appends $label", ({ event, expected }) => {
    const directory = createTempDirectory();
    const filePath = join(directory, "plugin.log");
    const logger = createLogger({
      console: createConsole(),
      filePath,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    logger.write(event);

    expect(readFileSync(filePath, "utf8")).toBe(
      `2026-08-30T12:00:00.000Z ${expected}\n`,
    );
  });

  test("rotates at one MiB and retains one archive", () => {
    const directory = createTempDirectory();
    const filePath = join(directory, "plugin.log");
    const archivePath = `${filePath}.1`;
    const previous = "a".repeat(1024 * 1024);
    writeFileSync(filePath, previous, "utf8");
    writeFileSync(archivePath, "older archive", "utf8");
    const logger = createLogger({
      console: createConsole(),
      filePath,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    logger.write({ type: "plugin.initialized", commandCount: 2 });

    expect(readFileSync(archivePath, "utf8")).toBe(previous);
    expect(readFileSync(filePath, "utf8")).toBe(
      "2026-08-30T12:00:00.000Z plugin.initialized commandCount=2\n",
    );
  });

  test("reports an unavailable file without exposing its path", () => {
    const directory = createTempDirectory();
    const blockingFile = join(directory, "not-a-directory");
    const secret = "SECRET_LOG_PATH";
    writeFileSync(blockingFile, "block", "utf8");
    const output = createConsole();
    const logger = createLogger({
      console: output,
      filePath: join(blockingFile, secret, "plugin.log"),
    });

    expect(() =>
      logger.write({ type: "plugin.initialized", commandCount: 1 }),
    ).not.toThrow();
    expect(output.lines).toEqual([
      "startup-commands: initialized commandCount=1",
      "startup-commands: log file unavailable",
    ]);
    expect(output.lines.join(" ")).not.toContain(secret);
  });

  test("uses the automatic Windows log location", () => {
    const directory = createTempDirectory();
    const output = createConsole();
    const expectedPath = join(
      directory,
      "opencode",
      "logs",
      "opencode-startup-commands.log",
    );
    const logger = createLogger({
      console: output,
      platform: "win32",
      env: { LOCALAPPDATA: directory },
      home: join(directory, "home"),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    logger.write({ type: "plugin.initialized", commandCount: 1 });

    expect(existsSync(expectedPath)).toBe(true);
  });

  test("falls back when Windows local app data is empty", () => {
    const directory = createTempDirectory();
    const home = join(directory, "home");
    const expectedPath = join(
      home,
      "AppData",
      "Local",
      "opencode",
      "logs",
      "opencode-startup-commands.log",
    );
    const logger = createLogger({
      console: createConsole(),
      platform: "win32",
      env: { LOCALAPPDATA: "" },
      home,
    });

    logger.write({ type: "plugin.initialized", commandCount: 1 });

    expect(existsSync(expectedPath)).toBe(true);
  });

  test("falls back when the Linux state directory is relative", () => {
    const directory = createTempDirectory();
    const home = join(directory, "home");
    const expectedPath = join(
      home,
      ".local",
      "state",
      "opencode",
      "log",
      "opencode-startup-commands.log",
    );
    const logger = createLogger({
      console: createConsole(),
      platform: "linux",
      env: { XDG_STATE_HOME: "." },
      home,
    });

    logger.write({ type: "plugin.initialized", commandCount: 1 });

    expect(existsSync(expectedPath)).toBe(true);
  });
});
