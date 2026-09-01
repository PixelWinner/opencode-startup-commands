import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runChecked } from "./process.mjs";

const PACKAGE_NAME = "opencode-startup-commands";
const PACKAGE_VERSION = "1.0.0";
const PACKAGE_FILENAME = `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`;
const MAX_COMPRESSED_SIZE = 2 * 1024 * 1024;
const MAX_UNPACKED_SIZE = 5 * 1024 * 1024;
const REQUIRED_METADATA_PATHS = ["LICENSE", "README.md", "package.json"];
const REQUIRED_PACKAGE_PATHS = [
  ...REQUIRED_METADATA_PATHS,
  "dist/config.js",
  "dist/config.d.ts",
  "dist/core.js",
  "dist/core.d.ts",
  "dist/logger.js",
  "dist/logger.d.ts",
  "dist/process-tree.d.ts",
  "dist/process-tree.js",
  "dist/server.js",
  "dist/server.d.ts",
  "dist/server-internal.js",
  "dist/server-internal.d.ts",
];
const EXPECTED_EXPORTS = {
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
};
const EXPECTED_SCRIPTS = {
  test: "bun test",
  typecheck: "tsc --noEmit && tsc -p tsconfig.type-tests.json",
  compile: "tsc -p tsconfig.json",
  "package:check": "node ./scripts/release-package.mjs",
  "verify:dist": "node ./scripts/verify-dist.mjs",
  "release:check": "node ./scripts/release-check.mjs",
};
const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_IMPORT_SCRIPT = `
import rootPlugin from "opencode-startup-commands";
import serverPlugin from "opencode-startup-commands/server";
if (rootPlugin !== serverPlugin) throw new Error("Package exports differ");
if (rootPlugin?.id !== "opencode-startup-commands") throw new Error("Unexpected plugin id");
`;

export function validatePackageFilePaths(paths) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("Package paths must be an array of strings");
  }

  for (const requiredPath of REQUIRED_PACKAGE_PATHS) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`Package is missing ${requiredPath}`);
    }
  }

  const seen = new Set();
  for (const packagePath of paths) {
    if (seen.has(packagePath)) {
      throw new Error(`Package contains duplicate path ${packagePath}`);
    }
    seen.add(packagePath);

    if (!REQUIRED_PACKAGE_PATHS.includes(packagePath)) {
      throw new Error(`Package contains forbidden path ${packagePath}`);
    }
  }

  return paths;
}

export function validatePackageSizes(compressedSize, unpackedSize) {
  if (!Number.isSafeInteger(compressedSize) || compressedSize < 0) {
    throw new Error("Invalid compressed package size");
  }
  if (!Number.isSafeInteger(unpackedSize) || unpackedSize < 0) {
    throw new Error("Invalid unpacked package size");
  }
  if (compressedSize > MAX_COMPRESSED_SIZE) {
    throw new Error("Package compressed size exceeds 2 MiB");
  }
  if (unpackedSize > MAX_UNPACKED_SIZE) {
    throw new Error("Package unpacked size exceeds 5 MiB");
  }

  return { compressedSize, unpackedSize };
}

export function validatePackageIdentity(result) {
  if (result?.name !== PACKAGE_NAME) {
    throw new Error(`Unexpected package name ${String(result?.name)}`);
  }
  if (result.version !== PACKAGE_VERSION) {
    throw new Error(`Unexpected package version ${String(result.version)}`);
  }
  if (result.filename !== PACKAGE_FILENAME) {
    throw new Error(`Unexpected package filename ${String(result.filename)}`);
  }

  return {
    name: result.name,
    version: result.version,
    filename: result.filename,
  };
}

export function validateRuntimeManifest(manifest, packagePaths) {
  if (manifest?.main !== "./dist/server.js") {
    throw new Error("Unexpected main runtime export");
  }
  if (manifest.types !== "./dist/server.d.ts") {
    throw new Error("Unexpected types runtime export");
  }

  for (const [exportName, expectedExport] of Object.entries(EXPECTED_EXPORTS)) {
    if (
      JSON.stringify(manifest.exports?.[exportName]) !==
      JSON.stringify(expectedExport)
    ) {
      throw new Error(`Unexpected ${exportName} runtime export`);
    }
  }

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(`Package must not contain ${field}`);
    }
  }

  const scriptNames = Object.keys(manifest.scripts ?? {}).sort();
  const expectedScriptNames = Object.keys(EXPECTED_SCRIPTS).sort();
  if (
    JSON.stringify(scriptNames) !== JSON.stringify(expectedScriptNames) ||
    expectedScriptNames.some(
      (scriptName) => manifest.scripts[scriptName] !== EXPECTED_SCRIPTS[scriptName],
    )
  ) {
    throw new Error("Package scripts do not match the exact release contract");
  }

  for (const entryPath of [manifest.main, manifest.types]) {
    if (!packagePaths.includes(entryPath.slice(2))) {
      throw new Error(`Package is missing runtime entry ${entryPath}`);
    }
  }

  return manifest;
}

export function validatePackResult(result, manifest) {
  if (!result || !Array.isArray(result.files)) {
    throw new Error("npm pack returned an invalid result");
  }

  validatePackageIdentity(result);
  validatePackageSizes(result.size, result.unpackedSize);
  const packagePaths = result.files.map((file) => file?.path);
  validatePackageFilePaths(packagePaths);
  validateRuntimeManifest(manifest, packagePaths);

  return result;
}

function parseSinglePackResult(stdout) {
  const packResults = JSON.parse(stdout);
  if (!Array.isArray(packResults) || packResults.length !== 1) {
    throw new Error("npm pack must return exactly one result");
  }

  return packResults[0];
}

function packResultContract(result) {
  return {
    id: result.id,
    name: result.name,
    version: result.version,
    filename: result.filename,
    size: result.size,
    unpackedSize: result.unpackedSize,
    shasum: result.shasum,
    integrity: result.integrity,
    entryCount: result.entryCount,
    bundled: result.bundled,
    files: result.files
      .map((file) => ({ path: file.path, size: file.size, mode: file.mode }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function snapshotDefaultDryRunState(cwd, outputDirectory) {
  const outputEntries = await readdir(outputDirectory);
  let rootTarball;

  try {
    rootTarball = {
      exists: true,
      bytes: await readFile(join(cwd, PACKAGE_FILENAME)),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    rootTarball = { exists: false };
  }

  return { outputEntries, rootTarball };
}

function rootTarballChanged(before, after) {
  if (before.exists !== after.exists) {
    return true;
  }
  if (!before.exists) {
    return false;
  }

  return Buffer.compare(Buffer.from(before.bytes), Buffer.from(after.bytes)) !== 0;
}

export async function runValidatedPackSequence(options) {
  const run = options.run ?? runChecked;
  const snapshotDryRunState =
    options.snapshotDryRunState ??
    function () {
      return snapshotDefaultDryRunState(
        options.cwd,
        options.outputDirectory,
      );
    };
  const processOptions = { captureOutput: true, cwd: options.cwd };
  const stateBeforeDryRun = await snapshotDryRunState();
  if (stateBeforeDryRun.outputEntries.length !== 0) {
    throw new Error("output directory must be empty before npm dry-run");
  }

  const dryRun = await run(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    processOptions,
  );
  const stateAfterDryRun = await snapshotDryRunState();
  if (stateAfterDryRun.outputEntries.length !== 0) {
    throw new Error("npm dry-run changed the output directory");
  }
  if (
    rootTarballChanged(
      stateBeforeDryRun.rootTarball,
      stateAfterDryRun.rootTarball,
    )
  ) {
    throw new Error("npm dry-run changed the project-root tarball");
  }

  const dryRunResult = parseSinglePackResult(dryRun.stdout);
  validatePackResult(dryRunResult, options.manifest);

  const realPack = await run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      options.outputDirectory,
    ],
    processOptions,
  );
  const realPackResult = parseSinglePackResult(realPack.stdout);
  validatePackResult(realPackResult, options.manifest);

  if (
    JSON.stringify(packResultContract(dryRunResult)) !==
    JSON.stringify(packResultContract(realPackResult))
  ) {
    throw new Error("npm pack dry-run and real results differ");
  }

  return realPackResult;
}

export function validateReleaseToolVersions(versions) {
  if (versions?.node !== "24.20.0") {
    throw new Error(
      `Node 24.20.0 required; received ${String(versions?.node)}`,
    );
  }
  if (versions.npm !== "11.19.0") {
    throw new Error(`npm 11.19.0 required; received ${String(versions.npm)}`);
  }

  return versions;
}

export async function runReleaseToolPreflight(options = {}) {
  const run = options.run ?? runChecked;
  const processOptions = { captureOutput: true };
  if (options.cwd !== undefined) {
    processOptions.cwd = options.cwd;
  }
  const npmVersionResult = await run("npm", ["--version"], processOptions);

  return validateReleaseToolVersions({
    node: options.nodeVersion ?? process.versions.node,
    npm: npmVersionResult.stdout.trim(),
  });
}

export function formatChecksumLine(digest, filename) {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid SHA-256 digest");
  }
  if (filename !== PACKAGE_FILENAME) {
    throw new Error(`Unexpected checksum filename ${filename}`);
  }

  return `${digest}  ${filename}\n`;
}

function parseCliArguments(args) {
  if (args.length === 0) {
    return { outputDirectory: undefined };
  }
  if (
    args.length !== 2 ||
    args[0] !== "--output-dir" ||
    !isAbsolute(args[1])
  ) {
    throw new Error(
      "Usage: node ./scripts/release-package.mjs [--output-dir <absolute-empty-directory>]",
    );
  }

  return { outputDirectory: args[1] };
}

async function prepareOutputDirectory(requestedDirectory) {
  if (requestedDirectory === undefined) {
    return {
      directory: await mkdtemp(join(tmpdir(), "opencode-startup-package-")),
      temporary: true,
    };
  }

  await mkdir(requestedDirectory, { recursive: true });
  const entries = await readdir(requestedDirectory);
  if (entries.length !== 0) {
    throw new Error("Requested output directory must be empty");
  }

  return { directory: requestedDirectory, temporary: false };
}

export async function withPackageDirectories(
  requestedDirectory,
  operation,
  dependencies = {},
) {
  const prepareOutput =
    dependencies.prepareOutputDirectory ?? prepareOutputDirectory;
  const createConsumerDirectory =
    dependencies.createConsumerDirectory ??
    function () {
      return mkdtemp(join(tmpdir(), "opencode-startup-consumer-"));
    };
  const remove = dependencies.remove ?? rm;
  let output;
  let consumerDirectory;

  try {
    output = await prepareOutput(requestedDirectory);
    consumerDirectory = await createConsumerDirectory();
    return await operation({ output, consumerDirectory });
  } finally {
    const cleanup = [];
    if (consumerDirectory !== undefined) {
      cleanup.push(
        remove(consumerDirectory, { recursive: true, force: true }),
      );
    }
    if (output?.temporary) {
      cleanup.push(remove(output.directory, { recursive: true, force: true }));
    }
    await Promise.all(cleanup);
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function main() {
  const { outputDirectory: requestedDirectory } = parseCliArguments(
    process.argv.slice(2),
  );

  await runReleaseToolPreflight({ cwd: PROJECT_ROOT });
  await withPackageDirectories(
    requestedDirectory,
    async function ({ output, consumerDirectory }) {
      const manifest = JSON.parse(
        await readFile(join(PROJECT_ROOT, "package.json"), "utf8"),
      );
      const result = await runValidatedPackSequence({
        cwd: PROJECT_ROOT,
        manifest,
        outputDirectory: output.directory,
      });
      const tarballPath = join(output.directory, result.filename);
      const digest = await sha256File(tarballPath);
      const checksumLine = formatChecksumLine(digest, result.filename);
      const checksumPath = join(output.directory, "SHA256SUMS");
      await writeFile(checksumPath, checksumLine, "utf8");

      const writtenChecksum = await readFile(checksumPath, "utf8");
      const verifiedDigest = await sha256File(tarballPath);
      if (writtenChecksum !== checksumLine || verifiedDigest !== digest) {
        throw new Error("Package checksum verification failed");
      }

      await writeFile(
        join(consumerDirectory, "package.json"),
        `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
        "utf8",
      );
      await runChecked(
        "npm",
        [
          "install",
          tarballPath,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: consumerDirectory },
      );
      await runChecked(
        "node",
        ["--input-type=module", "--eval", SMOKE_IMPORT_SCRIPT],
        { cwd: consumerDirectory },
      );

      console.log(
        `${result.filename} verified (${result.size} compressed bytes, ${result.unpackedSize} unpacked bytes)`,
      );
      console.log(checksumLine.trimEnd());
    },
  );
}

const isEntryScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Package check failed");
    process.exitCode = 1;
  });
}
