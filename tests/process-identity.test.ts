import { describe, expect, test } from "bun:test";
import {
  createProcessIdentityController,
  type ProcessIdentityController,
  type ProcessQueryChild,
  type ProcessQuerySpawn,
  type ProcessQuerySpawnOptions,
} from "../src/process-identity.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

function linuxController(
  files: Record<string, string | Error>,
): ProcessIdentityController {
  return createProcessIdentityController({
    platform: "linux",
    readTextFile(path: string): string {
      const value = files[path];
      if (value === undefined) {
        throw Object.assign(new Error("Missing test file"), {
          code: "ENOENT",
        });
      }
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
  });
}

function statLine(starttime: number): string {
  const fields = Array.from({ length: 50 }, (_unused, index) =>
    String(index + 1),
  );
  fields[18] = String(starttime);
  return `4242 (my (weird) proc) S ${fields.join(" ")}\n`;
}

describe("linux process identity", () => {
  test("describes a live process as boot id paired with start ticks", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "6f9619ff-8b86-d011-b42d-00c04fc964ff\n",
      "/proc/4242/stat": statLine(998877),
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "described",
      token: "linux1:6f9619ff-8b86-d011-b42d-00c04fc964ff:998877",
    });
  });

  test("reports a missing process as gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "b001dead\n",
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "gone",
    });
  });

  test("reports a malformed boot id as unknown, never gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "6F9619FF-8B86-D011-B42D-00C04FC964FF\n",
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "malformed-output",
    });
  });

  test("reports a non-hex boot id as unknown, never gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "notarealboot\n",
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "malformed-output",
    });
  });

  test("rejects an unsafe process identifier without reading anything", async () => {
    let reads = 0;
    const controller = createProcessIdentityController({
      platform: "linux",
      readTextFile(): string {
        reads += 1;
        return "";
      },
    });

    await expect(controller.describe(0)).resolves.toEqual({
      status: "gone",
    });
    expect(reads).toBe(0);
  });
});

describe("probe comparison", () => {
  test("matching token is alive", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "b001dead\n",
      "/proc/7/stat": statLine(11),
    });

    await expect(controller.probe(7, "linux1:b001dead:11")).resolves.toEqual({
      status: "alive",
    });
  });

  test("same pid with a different start tick is gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "b001dead\n",
      "/proc/7/stat": statLine(12),
    });

    await expect(controller.probe(7, "linux1:b001dead:11")).resolves.toEqual({
      status: "gone",
    });
  });

  test("same pid and tick after a reboot is gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "b002dead\n",
      "/proc/7/stat": statLine(11),
    });

    await expect(controller.probe(7, "linux1:b001dead:11")).resolves.toEqual({
      status: "gone",
    });
  });

  test("a token tagged for another platform is gone without probing", async () => {
    let reads = 0;
    const controller = createProcessIdentityController({
      platform: "linux",
      readTextFile(): string {
        reads += 1;
        return "";
      },
    });

    await expect(
      controller.probe(7, "win1:638912345678901234"),
    ).resolves.toEqual({ status: "gone" });
    expect(reads).toBe(0);
  });

  test("permission failure is unknown, never gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: Object.assign(new Error("denied"), { code: "EACCES" }),
    });

    await expect(controller.probe(7, "linux1:b001dead:11")).resolves.toEqual({
      status: "unknown",
      reason: "permission-denied",
    });
  });

  test("malformed stat content is unknown, never gone", async () => {
    const controller = linuxController({
      [BOOT_ID_PATH]: "b001dead\n",
      "/proc/7/stat": "no closing paren here\n",
    });

    await expect(controller.probe(7, "linux1:b001dead:11")).resolves.toEqual({
      status: "unknown",
      reason: "malformed-output",
    });
  });
});

class FakeQueryChild implements ProcessQueryChild {
  public readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  public unrefCalls = 0;
  private dataListener?: (chunk: Buffer | string) => void;
  private errorListener?: (error: Error) => void;
  private closeListener?: (code: number | null) => void;

  public readonly stdout = {
    on: (
      _event: "data",
      listener: (chunk: Buffer | string) => void,
    ): unknown => {
      this.dataListener = listener;
      return this.stdout;
    },
  };

  public once(
    event: "error",
    listener: (error: Error) => void,
  ): ProcessQueryChild;
  public once(
    event: "close",
    listener: (code: number | null) => void,
  ): ProcessQueryChild;
  public once(
    event: "error" | "close",
    listener: ((error: Error) => void) | ((code: number | null) => void),
  ): ProcessQueryChild {
    if (event === "error") {
      this.errorListener = listener as (error: Error) => void;
    } else {
      this.closeListener = listener as (code: number | null) => void;
    }
    return this;
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }

  public unref(): void {
    this.unrefCalls += 1;
  }

  public emitData(chunk: string): void {
    this.dataListener?.(chunk);
  }

  public emitClose(exitCode: number | null): void {
    this.closeListener?.(exitCode);
  }

  public emit(output: string, exitCode: number | null): void {
    this.emitData(output);
    this.emitClose(exitCode);
  }
}

interface RecordedSpawn {
  executable: string;
  args: string[];
  options: ProcessQuerySpawnOptions;
}

function queryController(
  platform: NodeJS.Platform,
  respond: (child: FakeQueryChild, call: RecordedSpawn) => void,
  env: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" },
): { controller: ProcessIdentityController; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const spawn: ProcessQuerySpawn = (executable, args, options) => {
    const call = { executable, args, options };
    calls.push(call);
    const child = new FakeQueryChild();
    queueMicrotask(() => respond(child, call));
    return child;
  };

  return {
    calls,
    controller: createProcessIdentityController({
      platform,
      env,
      spawn,
      timeoutMs: 50,
    }),
  };
}

describe("windows process identity", () => {
  test("describes a live process from utc ticks", async () => {
    const { controller, calls } = queryController("win32", (child) => {
      child.emit("638912345678901234\r\n", 0);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "described",
      token: "win1:638912345678901234",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(calls[0]?.args).toContain("-NoProfile");
    expect(calls[0]?.args).toContain("-NonInteractive");
    expect(calls[0]?.options).toEqual({
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  });

  test("the absent sentinel means the process is gone", async () => {
    const { controller } = queryController("win32", (child) => {
      child.emit("absent\r\n", 0);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "gone",
    });
  });

  test("the denied sentinel is a permission failure, not gone", async () => {
    const { controller } = queryController("win32", (child) => {
      child.emit("denied\r\n", 0);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "permission-denied",
    });
  });

  test("empty output is malformed, not gone", async () => {
    const { controller } = queryController("win32", (child) => {
      child.emit("", 0);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "malformed-output",
    });
  });

  test("non-numeric output is malformed, not gone", async () => {
    const { controller } = queryController("win32", (child) => {
      child.emit("Get-Process : Cannot find a process\r\n", 1);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "malformed-output",
    });
  });

  test("a missing SystemRoot makes the facility unavailable", async () => {
    const { controller, calls } = queryController(
      "win32",
      (child) => {
        child.emit("1\r\n", 0);
      },
      {},
    );

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "facility-unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  test("a hung utility times out and is killed", async () => {
    let spawned: FakeQueryChild | undefined;
    const { controller } = queryController("win32", (child) => {
      spawned = child;
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "unknown",
      reason: "timeout",
    });
    expect(spawned?.killCalls).toEqual(["SIGKILL"]);
    expect(spawned?.unrefCalls).toBe(1);
  });
});

describe("macos process identity", () => {
  test("normalizes lstart whitespace into a token", async () => {
    const { controller, calls } = queryController("darwin", (child) => {
      child.emit("Wed Sep  3 01:46:57 2026\n", 0);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "described",
      token: "mac1:Wed Sep 3 01:46:57 2026",
    });
    expect(calls[0]?.executable).toBe("/bin/ps");
    expect(calls[0]?.args).toEqual(["-p", "4242", "-o", "lstart="]);
  });

  test("pins the ps time zone and locale so a host time-zone change cannot invalidate a token", async () => {
    const { controller, calls } = queryController(
      "darwin",
      (child) => {
        child.emit("Wed Sep  3 01:46:57 2026\n", 0);
      },
      { PATH: "/usr/bin", HOME: "/Users/dev", TZ: "Europe/Kyiv" },
    );

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "described",
      token: "mac1:Wed Sep 3 01:46:57 2026",
    });
    expect(calls[0]?.options.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      TZ: "UTC",
      LC_ALL: "C",
    });
  });

  test("empty ps output means the process is gone", async () => {
    const { controller } = queryController("darwin", (child) => {
      child.emit("\n", 1);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "gone",
    });
  });
});

describe("query output cap", () => {
  const CAP = 4096;

  test("caps accumulated stdout instead of letting one chunk overshoot the limit", async () => {
    const upToBoundary = "9".repeat(CAP - 6);
    const overflowChunk = "9".repeat(50);
    const { controller } = queryController("win32", (child) => {
      child.emitData(upToBoundary);
      child.emitData(overflowChunk);
      child.emitClose(0);
    });

    await expect(controller.describe(4242)).resolves.toEqual({
      status: "described",
      token: `win1:${"9".repeat(CAP)}`,
    });
  });
});

describe("identity privacy", () => {
  test("malformed output never appears in the result", async () => {
    const secret = "C:\\Users\\someone\\secret-helper.exe";
    const { controller } = queryController("win32", (child) => {
      child.emit(`error near ${secret}\r\n`, 1);
    });

    const result = await controller.describe(4242);
    expect(JSON.stringify(result)).not.toContain("secret-helper");
    expect(result).toEqual({
      status: "unknown",
      reason: "malformed-output",
    });
  });
});
