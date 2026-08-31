import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatChecksumLine,
  runValidatedPackSequence,
  withPackageDirectories,
  validatePackResult,
  validatePackageFilePaths,
  validatePackageIdentity,
  validatePackageSizes,
  validateReleaseToolVersions,
  validateRuntimeManifest,
  runReleaseToolPreflight,
} from "../scripts/release-package.mjs";
import {
  createProcessInvocation,
  resolveNpmCliPath,
  runChecked,
  selectExecutable,
} from "../scripts/process.mjs";
import {
  getReleaseCheckCommands,
  runReleaseCheck,
} from "../scripts/release-check.mjs";
import {
  getVerifyDistCommands,
  runVerifyDist,
} from "../scripts/verify-dist.mjs";
import tsconfig from "../tsconfig.json";

const allowedPaths = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/config.js",
  "dist/config.d.ts",
  "dist/core.js",
  "dist/core.d.ts",
  "dist/logger.js",
  "dist/logger.d.ts",
  "dist/server.js",
  "dist/server.d.ts",
  "dist/server-internal.js",
  "dist/server-internal.d.ts",
];

const releaseManifest = {
  name: "opencode-startup-commands",
  version: "1.0.0",
  main: "./dist/server.js",
  types: "./dist/server.d.ts",
  exports: {
    ".": {
      types: "./dist/server.d.ts",
      import: "./dist/server.js",
      default: "./dist/server.js",
    },
    "./server": {
      types: "./dist/server.d.ts",
      import: "./dist/server.js",
      default: "./dist/server.js",
    },
  },
  scripts: {
    test: "bun test",
    typecheck: "tsc --noEmit && tsc -p tsconfig.type-tests.json",
    compile: "tsc -p tsconfig.json",
    "package:check": "node ./scripts/release-package.mjs",
    "verify:dist": "node ./scripts/verify-dist.mjs",
    "release:check": "node ./scripts/release-check.mjs",
  },
};

const packResult = {
  id: "opencode-startup-commands@1.0.0",
  name: "opencode-startup-commands",
  version: "1.0.0",
  filename: "opencode-startup-commands-1.0.0.tgz",
  size: 1024,
  unpackedSize: 4096,
  shasum: "0123456789abcdef0123456789abcdef01234567",
  integrity: "sha512-release-package",
  entryCount: allowedPaths.length,
  bundled: [],
  files: allowedPaths.map((path, index) => ({
    path,
    size: index + 1,
    mode: 420,
  })),
};

function unchangedAbsentTarballState() {
  return {
    outputEntries: [],
    rootTarball: { exists: false },
  };
}

async function createPackTestDirectories() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "release-package-test-"),
  );
  const cwd = join(temporaryDirectory, "repository");
  const outputDirectory = join(temporaryDirectory, "output");
  await Promise.all([mkdir(cwd), mkdir(outputDirectory)]);

  return { temporaryDirectory, cwd, outputDirectory };
}

describe("package file contract", () => {
  test("accepts only release metadata and compiled JavaScript declarations", () => {
    expect(validatePackageFilePaths(allowedPaths)).toEqual(allowedPaths);
  });

  test("requires every top-level release metadata file", () => {
    for (const requiredPath of ["LICENSE", "README.md", "package.json"]) {
      expect(() =>
        validatePackageFilePaths(
          allowedPaths.filter((path) => path !== requiredPath),
        ),
      ).toThrow(requiredPath);
    }
  });

  test("requires every path in the exact 13-file package", () => {
    for (const requiredPath of allowedPaths) {
      expect(() =>
        validatePackageFilePaths(
          allowedPaths.filter((path) => path !== requiredPath),
        ),
      ).toThrow(requiredPath);
    }
  });

  test("rejects an otherwise valid compiled debug module", () => {
    expect(() =>
      validatePackageFilePaths([...allowedPaths, "dist/debug.js"]),
    ).toThrow("dist/debug.js");
  });

  test("rejects private, generated, and arbitrary package paths", () => {
    const forbiddenPaths = [
      "src/server.ts",
      "tests/server.test.ts",
      ".github/workflows/ci.yml",
      "docs/release-notes.md",
      "debug.log",
      "dist/server.js.map",
      "dist/server.d.ts.map",
      "bun.lock",
      "package-lock.json",
      "CHANGELOG.md",
      "dist/metadata.json",
      "dist/../outside.js",
      "dist//server.js",
      "../outside.js",
      "dist\\server.js",
    ];

    for (const forbiddenPath of forbiddenPaths) {
      expect(() =>
        validatePackageFilePaths([...allowedPaths, forbiddenPath]),
      ).toThrow(forbiddenPath);
    }
  });
});

describe("package limits and identity", () => {
  test("accepts package sizes at the configured boundaries", () => {
    expect(validatePackageSizes(2 * 1024 * 1024, 5 * 1024 * 1024)).toEqual({
      compressedSize: 2 * 1024 * 1024,
      unpackedSize: 5 * 1024 * 1024,
    });
  });

  test("rejects a package over either configured size boundary", () => {
    expect(() => validatePackageSizes(2 * 1024 * 1024 + 1, 1)).toThrow(
      "compressed",
    );
    expect(() => validatePackageSizes(1, 5 * 1024 * 1024 + 1)).toThrow(
      "unpacked",
    );
  });

  test("requires the exact package identity and tarball filename", () => {
    expect(validatePackageIdentity(packResult)).toEqual({
      name: "opencode-startup-commands",
      version: "1.0.0",
      filename: "opencode-startup-commands-1.0.0.tgz",
    });

    for (const changed of [
      { name: "other-package" },
      { version: "1.0.1" },
      { filename: "other-package-1.0.0.tgz" },
    ]) {
      expect(() =>
        validatePackageIdentity({ ...packResult, ...changed }),
      ).toThrow();
    }
  });

  test("requires the exact release Node and npm versions", () => {
    expect(
      validateReleaseToolVersions({ node: "24.20.0", npm: "11.19.0" }),
    ).toEqual({ node: "24.20.0", npm: "11.19.0" });
    expect(() =>
      validateReleaseToolVersions({ node: "26.4.0", npm: "10.8.3" }),
    ).toThrow("Node 24.20.0 required; received 26.4.0");
    expect(() =>
      validateReleaseToolVersions({ node: "24.20.0", npm: "10.8.3" }),
    ).toThrow("npm 11.19.0 required; received 10.8.3");
  });

  test("preflight reads npm through the checked launcher", async () => {
    const calls: unknown[][] = [];
    const versions = await runReleaseToolPreflight({
      nodeVersion: "24.20.0",
      run: async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: "11.19.0\n", stderr: "" };
      },
    });

    expect(versions).toEqual({ node: "24.20.0", npm: "11.19.0" });
    expect(calls).toEqual([
      ["npm", ["--version"], { captureOutput: true }],
    ]);
  });
});

describe("package workspace cleanup", () => {
  test("removes default output when consumer setup fails", async () => {
    const removedPaths: string[] = [];
    let failure: unknown;

    try {
      await withPackageDirectories(undefined, async () => {}, {
        createConsumerDirectory: async () => {
          throw new Error("consumer setup failed");
        },
        prepareOutputDirectory: async () => ({
          directory: "temporary-output",
          temporary: true,
        }),
        remove: async (path: string) => {
          removedPaths.push(path);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: consumer setup failed");
    expect(removedPaths).toEqual(["temporary-output"]);
  });

  test("preserves requested output when consumer setup fails", async () => {
    const removedPaths: string[] = [];

    try {
      await withPackageDirectories("requested-output", async () => {}, {
        createConsumerDirectory: async () => {
          throw new Error("consumer setup failed");
        },
        prepareOutputDirectory: async () => ({
          directory: "requested-output",
          temporary: false,
        }),
        remove: async (path: string) => {
          removedPaths.push(path);
        },
      });
    } catch {}

    expect(removedPaths).toEqual([]);
  });
});

describe("npm pack sequence", () => {
  test("validates a dry run before creating and validating the real package", async () => {
    const calls: unknown[][] = [];
    let snapshotCount = 0;
    const result = await runValidatedPackSequence({
      cwd: "repository",
      manifest: releaseManifest,
      outputDirectory: "package-output",
      snapshotDryRunState: async () => {
        snapshotCount += 1;
        calls.push(["snapshot-dry-run-state", snapshotCount]);
        return unchangedAbsentTarballState();
      },
      run: async (...args: unknown[]) => {
        calls.push(args);
        const commandArgs = args[1] as string[];
        if (commandArgs.includes("--dry-run")) {
          return { stdout: JSON.stringify([packResult]), stderr: "" };
        }
        expect(snapshotCount).toBe(2);
        return { stdout: JSON.stringify([packResult]), stderr: "" };
      },
    });

    expect(result).toEqual(packResult);
    expect(calls).toEqual([
      ["snapshot-dry-run-state", 1],
      [
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        { captureOutput: true, cwd: "repository" },
      ],
      ["snapshot-dry-run-state", 2],
      [
        "npm",
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          "package-output",
        ],
        { captureOutput: true, cwd: "repository" },
      ],
    ]);
  });

  test("rejects a non-empty output directory before dry run without deleting it", async () => {
    const commands: string[][] = [];
    const snapshot = {
      outputEntries: ["existing-package.tgz"],
      rootTarball: { exists: false },
    };

    await expect(
      runValidatedPackSequence({
        cwd: "repository",
        manifest: releaseManifest,
        outputDirectory: "package-output",
        snapshotDryRunState: async () => snapshot,
        run: async (_tool: string, args: string[]) => {
          commands.push(args);
          return { stdout: JSON.stringify([packResult]), stderr: "" };
        },
      }),
    ).rejects.toThrow("output directory must be empty before npm dry-run");

    expect(commands).toEqual([]);
    expect(snapshot.outputEntries).toEqual(["existing-package.tgz"]);
  });

  test("preserves an unchanged pre-existing root tarball and proceeds to real pack", async () => {
    const { temporaryDirectory, cwd, outputDirectory } =
      await createPackTestDirectories();
    const rootTarball = join(cwd, packResult.filename);
    const originalBytes = Buffer.from("pre-existing tarball bytes\n");
    let packCalls = 0;

    try {
      await writeFile(rootTarball, originalBytes);
      await runValidatedPackSequence({
        cwd,
        manifest: releaseManifest,
        outputDirectory,
        run: async () => {
          packCalls += 1;
          return { stdout: JSON.stringify([packResult]), stderr: "" };
        },
      });

      expect(packCalls).toBe(2);
      expect(await readFile(rootTarball)).toEqual(originalBytes);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("fails without deleting a new dry-run output entry", async () => {
    const { temporaryDirectory, cwd, outputDirectory } =
      await createPackTestDirectories();
    const unexpectedOutput = join(outputDirectory, "unexpected.tgz");
    const unexpectedBytes = Buffer.from("unexpected dry-run output\n");
    let packCalls = 0;

    try {
      await expect(
        runValidatedPackSequence({
          cwd,
          manifest: releaseManifest,
          outputDirectory,
          run: async () => {
            packCalls += 1;
            await writeFile(unexpectedOutput, unexpectedBytes);
            return { stdout: JSON.stringify([packResult]), stderr: "" };
          },
        }),
      ).rejects.toThrow("npm dry-run changed the output directory");

      expect(packCalls).toBe(1);
      expect(await readFile(unexpectedOutput)).toEqual(unexpectedBytes);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("fails without deleting a root tarball created by dry run", async () => {
    const { temporaryDirectory, cwd, outputDirectory } =
      await createPackTestDirectories();
    const rootTarball = join(cwd, packResult.filename);
    const unexpectedBytes = Buffer.from("unexpected root tarball\n");
    let packCalls = 0;

    try {
      await expect(
        runValidatedPackSequence({
          cwd,
          manifest: releaseManifest,
          outputDirectory,
          run: async () => {
            packCalls += 1;
            await writeFile(rootTarball, unexpectedBytes);
            return { stdout: JSON.stringify([packResult]), stderr: "" };
          },
        }),
      ).rejects.toThrow("npm dry-run changed the project-root tarball");

      expect(packCalls).toBe(1);
      expect(await readFile(rootTarball)).toEqual(unexpectedBytes);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("checks filesystem state before parsing an invalid dry-run result", async () => {
    let snapshotCount = 0;

    await expect(
      runValidatedPackSequence({
        cwd: "repository",
        manifest: releaseManifest,
        outputDirectory: "package-output",
        snapshotDryRunState: async () => {
          snapshotCount += 1;
          return snapshotCount === 1
            ? unchangedAbsentTarballState()
            : {
                outputEntries: [],
                rootTarball: {
                  exists: true,
                  bytes: Buffer.from("unexpected root tarball\n"),
                },
              };
        },
        run: async () => ({ stdout: "invalid JSON", stderr: "" }),
      }),
    ).rejects.toThrow("npm dry-run changed the project-root tarball");

    expect(snapshotCount).toBe(2);
  });

  test("fails without cleanup when dry run modifies or deletes a root tarball", async () => {
    for (const mutation of ["modify", "delete"]) {
      const { temporaryDirectory, cwd, outputDirectory } =
        await createPackTestDirectories();
      const rootTarball = join(cwd, packResult.filename);
      const originalBytes = Buffer.from("original root tarball\n");
      const modifiedBytes = Buffer.from("modified root tarball\n");
      let packCalls = 0;

      try {
        await writeFile(rootTarball, originalBytes);
        await expect(
          runValidatedPackSequence({
            cwd,
            manifest: releaseManifest,
            outputDirectory,
            run: async () => {
              packCalls += 1;
              if (mutation === "modify") {
                await writeFile(rootTarball, modifiedBytes);
              } else {
                await rm(rootTarball);
              }
              return { stdout: JSON.stringify([packResult]), stderr: "" };
            },
          }),
        ).rejects.toThrow("npm dry-run changed the project-root tarball");

        expect(packCalls).toBe(1);
        if (mutation === "modify") {
          expect(await readFile(rootTarball)).toEqual(modifiedBytes);
        } else {
          await expect(readFile(rootTarball)).rejects.toThrow();
        }
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  test("validates the dry-run result before real pack", async () => {
    const commands: string[][] = [];
    const invalidDryRun = {
      ...packResult,
      files: [...packResult.files, { path: "dist/debug.js", size: 1, mode: 420 }],
    };

    await expect(
      runValidatedPackSequence({
        cwd: "repository",
        manifest: releaseManifest,
        outputDirectory: "package-output",
        snapshotDryRunState: async () => unchangedAbsentTarballState(),
        run: async (_tool: string, args: string[]) => {
          commands.push(args);
          return { stdout: JSON.stringify([invalidDryRun]), stderr: "" };
        },
      }),
    ).rejects.toThrow("dist/debug.js");

    expect(commands).toEqual([
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
    ]);
  });

  test("rejects critical metadata or file inventory differences", async () => {
    const mismatchedRealPacks = [
      { ...packResult, integrity: "sha512-different-package" },
      {
        ...packResult,
        files: packResult.files.map((file, index) =>
          index === 0 ? { ...file, size: file.size + 1 } : file,
        ),
      },
    ];

    for (const mismatchedRealPack of mismatchedRealPacks) {
      let packCall = 0;
      await expect(
        runValidatedPackSequence({
          cwd: "repository",
          manifest: releaseManifest,
          outputDirectory: "package-output",
          snapshotDryRunState: async () => unchangedAbsentTarballState(),
          run: async () => {
            packCall += 1;
            return {
              stdout: JSON.stringify([
                packCall === 1 ? packResult : mismatchedRealPack,
              ]),
              stderr: "",
            };
          },
        }),
      ).rejects.toThrow("npm pack dry-run and real results differ");
    }
  });
});

describe("runtime manifest contract", () => {
  test("accepts both required exports without runtime dependencies", () => {
    expect(validateRuntimeManifest(releaseManifest, allowedPaths)).toEqual(
      releaseManifest,
    );
  });

  test("rejects missing or changed runtime exports", () => {
    expect(() =>
      validateRuntimeManifest(
        { ...releaseManifest, exports: { ".": releaseManifest.exports["."] } },
        allowedPaths,
      ),
    ).toThrow("./server");
    expect(() =>
      validateRuntimeManifest(
        { ...releaseManifest, main: "./dist/missing.js" },
        allowedPaths,
      ),
    ).toThrow("main");
  });

  test("rejects every runtime dependency channel", () => {
    const runtimeDependencyFields = [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ];

    for (const field of runtimeDependencyFields) {
      const value = field.includes("bundl") ? ["example"] : { example: "1.0.0" };
      expect(() =>
        validateRuntimeManifest(
          { ...releaseManifest, [field]: value },
          allowedPaths,
        ),
      ).toThrow(field);
    }
  });

  test("rejects runtime dependency fields even when empty", () => {
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(() =>
        validateRuntimeManifest(
          { ...releaseManifest, [field]: {} },
          allowedPaths,
        ),
      ).toThrow(field);
    }
    for (const field of ["bundledDependencies", "bundleDependencies"]) {
      expect(() =>
        validateRuntimeManifest(
          { ...releaseManifest, [field]: [] },
          allowedPaths,
        ),
      ).toThrow(field);
    }
  });

  test("rejects scripts outside the exact release command set", () => {
    for (const lifecycleScript of ["preprepare", "postprepare", "postpack"]) {
      expect(() =>
        validateRuntimeManifest(
          {
            ...releaseManifest,
            scripts: {
              ...releaseManifest.scripts,
              [lifecycleScript]: "node unsafe.mjs",
            },
          },
          allowedPaths,
        ),
      ).toThrow("scripts");
    }
  });

  test("validates a complete npm pack result", () => {
    expect(validatePackResult(packResult, releaseManifest)).toEqual(packResult);
  });
});

test("formats a deterministic SHA-256 checksum line", () => {
  const digest = "a".repeat(64);

  expect(
    formatChecksumLine(
      digest,
      "opencode-startup-commands-1.0.0.tgz",
    ),
  ).toBe(
    `${digest}  opencode-startup-commands-1.0.0.tgz\n`,
  );
});

describe("shell-free process contract", () => {
  test("selects platform-specific executable names", () => {
    expect(selectExecutable("npm", "linux")).toBe("npm");
    expect(selectExecutable("bun", "win32")).toBe("bun.exe");
    expect(selectExecutable("bun", "darwin")).toBe("bun");
    expect(selectExecutable("git", "win32")).toBe("git.exe");
    expect(selectExecutable("git", "linux")).toBe("git");
  });

  test("keeps user-controlled values as arguments and always disables shell", () => {
    const destination = "C:\\release & echo unsafe";
    const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
    const npmCliPath =
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const invocation = createProcessInvocation(
      "npm",
      ["pack", "--pack-destination", destination],
      { cwd: "C:\\repository", shell: true },
      "win32",
      {
        env: {},
        execPath: nodeExecutable,
        existsSync: () => true,
        realpathSync: (path: string) => path,
      },
    );

    expect(invocation).toEqual({
      executable: nodeExecutable,
      args: [npmCliPath, "pack", "--pack-destination", destination],
      options: { cwd: "C:\\repository", shell: false },
    });
  });

  test("canonicalizes node.exe before launching the trusted npm CLI", () => {
    const linkedNode = "C:\\node-link\\node.exe";
    const trustedNode = "C:\\trusted-node\\node.exe";
    const trustedCli =
      "C:\\trusted-node\\node_modules\\npm\\bin\\npm-cli.js";
    const invocation = createProcessInvocation(
      "npm",
      ["--version"],
      {},
      "win32",
      {
        env: {},
        execPath: linkedNode,
        existsSync: () => true,
        realpathSync: (path: string) => {
          if (path === linkedNode) {
            return trustedNode;
          }
          return path;
        },
      },
    );

    expect(invocation.executable).toBe(trustedNode);
    expect(invocation.args).toEqual([trustedCli, "--version"]);
  });

  test("prefers the canonical sibling npm CLI over npm_execpath", () => {
    const trustedNode = "C:\\trusted-node\\node.exe";
    const siblingCli =
      "C:\\trusted-node\\node_modules\\npm\\bin\\npm-cli.js";
    const environmentCli = "C:\\trusted-node\\alternate\\npm-cli.js";

    expect(
      resolveNpmCliPath("win32", {
        env: { npm_execpath: environmentCli },
        execPath: "C:\\node-link\\node.exe",
        existsSync: () => true,
        realpathSync: (path: string) => {
          if (path === "C:\\node-link\\node.exe") {
            return trustedNode;
          }
          return path;
        },
      }),
    ).toBe(siblingCli);
  });

  test("accepts npm_execpath only inside the canonical Node root", () => {
    const trustedNode = "C:\\trusted-node\\node.exe";
    const siblingCli =
      "C:\\trusted-node\\node_modules\\npm\\bin\\npm-cli.js";
    const environmentCli = "C:\\trusted-node\\alternate\\npm-cli.js";

    expect(
      resolveNpmCliPath("win32", {
        env: { npm_execpath: environmentCli },
        execPath: trustedNode,
        existsSync: () => true,
        realpathSync: (path: string) => {
          if (path === siblingCli) {
            throw new Error("missing sibling");
          }
          return path;
        },
      }),
    ).toBe(environmentCli);

    expect(() =>
      resolveNpmCliPath("win32", {
        env: { npm_execpath: "C:\\untrusted\\npm-cli.js" },
        execPath: trustedNode,
        existsSync: () => true,
        realpathSync: (path: string) => {
          if (path === siblingCli) {
            throw new Error("missing sibling");
          }
          return path;
        },
      }),
    ).toThrow("npm exited with code unknown");
  });

  test("rejects an npm CLI symlink that escapes the canonical Node root", () => {
    const trustedNode = "C:\\trusted-node\\node.exe";
    const siblingCli =
      "C:\\trusted-node\\node_modules\\npm\\bin\\npm-cli.js";
    const environmentCli = "C:\\trusted-node\\alternate\\npm-cli.js";

    expect(() =>
      resolveNpmCliPath("win32", {
        env: { npm_execpath: environmentCli },
        execPath: trustedNode,
        existsSync: () => true,
        realpathSync: (path: string) => {
          if (path === siblingCli) {
            throw new Error("missing sibling");
          }
          if (path === environmentCli) {
            return "C:\\untrusted\\npm-cli.js";
          }
          return path;
        },
      }),
    ).toThrow("npm exited with code unknown");
  });

  if (process.platform === "win32") {
    test("executes the installed npm CLI without a command shell", async () => {
      const processModuleUrl = new URL(
        "../scripts/process.mjs",
        import.meta.url,
      ).href;
      const result = await runChecked("node", [
        "--input-type=module",
        "--eval",
        `const { runChecked } = await import(process.argv[1]); const result = await runChecked("npm", ["--version"], { captureOutput: true }); process.stdout.write(result.stdout);`,
        processModuleUrl,
      ], {
        captureOutput: true,
      });

      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  } else {
    test.skip("executes the installed npm CLI without a command shell", () => {});
  }

  test("captures checked process output without a shell", async () => {
    const result = await runChecked(
      "node",
      ["--eval", "process.stdout.write('captured')"],
      { captureOutput: true },
    );

    expect(result).toEqual({ stdout: "captured", stderr: "" });
  });

  test("reports only the tool and exit code when a process fails", async () => {
    let failure: unknown;

    try {
      await runChecked(
        "node",
        [
          "--eval",
          "process.stderr.write('sensitive value'); process.exit(7)",
        ],
        { captureOutput: true },
      );
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: node exited with code 7");
  });

  test("sanitizes process start failures without exposing system details", async () => {
    let failure: unknown;

    try {
      await runChecked("definitely-missing-release-tool", []);
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe(
      "Error: definitely-missing-release-tool exited with code unknown",
    );
  });

  test("sanitizes synchronous spawn failures", async () => {
    let failure: unknown;

    try {
      await runChecked("node", ["--version"], {
        cwd: { secret: "must not escape" },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: node exited with code unknown");
  });

  test("defines dist verification and release checks as ordered arguments", () => {
    expect(getVerifyDistCommands("linux")).toEqual([
      {
        tool: "git",
        args: ["diff", "--no-ext-diff", "--exit-code", "--", "dist"],
      },
      {
        tool: "git",
        args: ["status", "--porcelain", "--untracked-files=all", "--", "dist"],
        captureOutput: true,
      },
      { tool: "bun", args: ["run", "compile"] },
      {
        tool: "git",
        args: ["diff", "--no-ext-diff", "--exit-code", "--", "dist"],
      },
      {
        tool: "git",
        args: ["status", "--porcelain", "--untracked-files=all", "--", "dist"],
        captureOutput: true,
      },
    ]);
    expect(getVerifyDistCommands("win32")).toEqual(
      getVerifyDistCommands("linux"),
    );
    expect(getVerifyDistCommands("win32")[2]).toEqual({
      tool: "bun",
      args: ["run", "compile"],
    });
    expect(getReleaseCheckCommands()).toEqual([
      { tool: "bun", args: ["test"] },
      { tool: "bun", args: ["run", "typecheck"] },
      { tool: "bun", args: ["run", "verify:dist"] },
      { tool: "bun", args: ["run", "package:check"] },
    ]);
  });

  test("pins tracked dist output to LF in TypeScript configuration", () => {
    expect(tsconfig.compilerOptions.newLine).toBe("lf");
  });

  test("refuses untracked dist content before removing dist", async () => {
    const calls: string[] = [];
    let failure: unknown;

    try {
      await runVerifyDist({
        remove: async () => {
          calls.push("remove");
        },
        run: async (tool: string, args: string[]) => {
          calls.push(`${tool} ${args[0]}`);
          if (args[0] === "status") {
            return { stdout: "?? dist/debug.js\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe(
      "Error: dist must be clean before verification",
    );
    expect(calls).toEqual(["git diff", "git status"]);
  });

  test("restores original dist bytes when compilation fails", async () => {
    const originalBytes = Buffer.from([0, 13, 10, 255, 42]);
    let distBytes: Buffer | undefined = Buffer.from(originalBytes);
    let backupBytes: Buffer | undefined;
    let copyCount = 0;
    const removedPaths: string[] = [];
    let failure: unknown;

    try {
      await runVerifyDist({
        copy: async () => {
          copyCount += 1;
          if (copyCount === 1) {
            backupBytes = Buffer.from(distBytes!);
          } else {
            distBytes = Buffer.from(backupBytes!);
          }
        },
        makeTempDirectory: async () => "backup-root",
        projectRoot: "project-root",
        remove: async (path: string) => {
          removedPaths.push(path);
          if (/[\\/]dist$/.test(path)) {
            distBytes = undefined;
          }
        },
        run: async (tool: string, args: string[]) => {
          if (tool === "bun") {
            distBytes = Buffer.from("partial compile output");
            throw new Error("compile failed");
          }
          if (args[0] === "status") {
            return { stdout: "", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: compile failed");
    expect(distBytes).toEqual(originalBytes);
    expect(copyCount).toBe(2);
    expect(removedPaths.at(-1)).toBe("backup-root");
  });

  test("restores checkout bytes after a successful LF verification", async () => {
    const originalBytes = Buffer.from("checkout CRLF bytes\r\n");
    let distBytes: Buffer | undefined = Buffer.from(originalBytes);
    let backupBytes: Buffer | undefined;
    let copyCount = 0;
    const removedPaths: string[] = [];

    await runVerifyDist({
      copy: async () => {
        copyCount += 1;
        if (copyCount === 1) {
          backupBytes = Buffer.from(distBytes!);
        } else {
          distBytes = Buffer.from(backupBytes!);
        }
      },
      makeTempDirectory: async () => "backup-root",
      projectRoot: "project-root",
      remove: async (path: string) => {
        removedPaths.push(path);
        if (/[\\/]dist$/.test(path)) {
          distBytes = undefined;
        }
      },
      run: async (tool: string, args: string[]) => {
        if (tool === "bun") {
          distBytes = Buffer.from("deterministic LF bytes\n");
        }
        if (args[0] === "status") {
          return { stdout: " M dist/server.js\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(distBytes).toEqual(originalBytes);
    expect(copyCount).toBe(2);
    expect(removedPaths.at(-1)).toBe("backup-root");
  });

  test("runs release version preflight before every release command", async () => {
    const calls: string[] = [];

    await runReleaseCheck({
      preflight: async () => {
        calls.push("preflight");
      },
      run: async (tool: string, args: string[]) => {
        calls.push(`${tool} ${args.join(" ")}`);
      },
    });

    expect(calls).toEqual([
      "preflight",
      "bun test",
      "bun run typecheck",
      "bun run verify:dist",
      "bun run package:check",
    ]);
  });

  test("does not run release commands when version preflight fails", async () => {
    const calls: string[] = [];
    let failure: unknown;

    try {
      await runReleaseCheck({
        preflight: async () => {
          calls.push("preflight");
          throw new Error("version mismatch");
        },
        run: async () => {
          calls.push("command");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).toBe("Error: version mismatch");
    expect(calls).toEqual(["preflight"]);
  });
});
