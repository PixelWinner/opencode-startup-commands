import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "opencode-startup-commands";
const CHECKSUM_NAME = "SHA256SUMS";
const REPOSITORY_PATTERN =
  /^(?!.*\.\.)(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))\/(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99}))$/;
const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_ANNOTATED_TAG_DEPTH = 5;

function executeProcess(tool, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(tool, args, {
        ...options,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error(`${tool} execution failed`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error(`${tool} execution failed`));
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

function requireString(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function releaseTitle(tag) {
  return tag === "v1.0.0" ? "v1.0.0 — Initial release" : tag;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectedAssetNames(context) {
  return [context.tarballName, CHECKSUM_NAME];
}

function manualRecoveryError(reason) {
  return new Error(
    `${reason}. Inspect the GitHub Release manually. Do not publish npm. ` +
      "If the draft is broken, deliberately delete and recreate only the broken draft " +
      "after inspection; automation never deletes or overwrites release assets.",
  );
}

function assertExactFiles(entries, expectedNames, description) {
  const names = entries.map((entry) => entry.name);
  const uniqueNames = new Set(names);
  if (
    names.length !== expectedNames.length ||
    uniqueNames.size !== expectedNames.length ||
    expectedNames.some((name) => !uniqueNames.has(name)) ||
    entries.some((entry) => !entry.isFile())
  ) {
    throw new Error(`${description} must contain exactly ${expectedNames.join(", ")}`);
  }
}

async function readAndVerifyCandidate(context) {
  const entries = await readdir(context.candidateDirectory, {
    withFileTypes: true,
  });
  assertExactFiles(entries, expectedAssetNames(context), "Candidate directory");

  const [tarball, checksum] = await Promise.all([
    readFile(context.tarballPath),
    readFile(context.checksumPath),
  ]);
  const digest = sha256(tarball);
  const expectedChecksum = Buffer.from(`${digest}  ${context.tarballName}\n`);
  if (!checksum.equals(expectedChecksum)) {
    throw new Error("Candidate checksum does not match candidate tarball");
  }

  return { digest, checksum };
}

function validateExistingRelease(release, context) {
  if (!release || typeof release !== "object") {
    throw manualRecoveryError("Existing release metadata is invalid");
  }
  if (release.repository !== context.repository) {
    throw manualRecoveryError("Existing release repository does not match");
  }
  if (release.tagName !== context.tag) {
    throw manualRecoveryError("Existing release tag does not match");
  }
  if (release.isDraft !== true) {
    throw manualRecoveryError("Existing release is not a draft");
  }
  if (release.targetCommitish !== context.commitSha) {
    throw manualRecoveryError("Existing release target commit does not match");
  }
  if (!Array.isArray(release.assets)) {
    throw manualRecoveryError("Existing release assets are invalid");
  }

  const names = release.assets.map((asset) => asset?.name);
  const expectedNames = expectedAssetNames(context);
  const uniqueNames = new Set(names);
  if (
    names.some((name) => typeof name !== "string") ||
    names.length !== expectedNames.length ||
    uniqueNames.size !== expectedNames.length ||
    expectedNames.some((name) => !uniqueNames.has(name))
  ) {
    throw manualRecoveryError(
      "Existing draft must contain exactly the expected assets",
    );
  }
}

async function verifyDownloadedAssets(directory, context, candidate) {
  const entries = await readdir(directory, { withFileTypes: true });
  assertExactFiles(entries, expectedAssetNames(context), "Downloaded assets");

  const [tarball, checksum] = await Promise.all([
    readFile(join(directory, context.tarballName)),
    readFile(join(directory, CHECKSUM_NAME)),
  ]);
  if (!checksum.equals(candidate.checksum)) {
    throw new Error("Downloaded checksum bytes do not match candidate checksum");
  }
  if (sha256(tarball) !== candidate.digest) {
    throw new Error("Downloaded tarball digest does not match candidate tarball");
  }
}

async function peelLocalTagWithGit(tag, execute = executeProcess) {
  const result = await execute("git", ["rev-parse", `${tag}^{commit}`], {
    shell: false,
  });
  if (result.code !== 0) {
    throw new Error("git tag verification failed");
  }

  const commit = result.stdout.trim();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("git returned an invalid tag commit");
  }
  return commit;
}

export function validateReleaseEnvironment(environment) {
  const repository = requireString(environment, "RELEASE_REPOSITORY");
  const tag = requireString(environment, "RELEASE_TAG");
  const commitSha = requireString(environment, "RELEASE_COMMIT_SHA");
  const candidateDirectory = requireString(
    environment,
    "RELEASE_CANDIDATE_DIR",
  );

  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("RELEASE_REPOSITORY must be an explicit owner/repository");
  }
  const tagMatch = tag.match(TAG_PATTERN);
  if (!tagMatch) {
    throw new Error("RELEASE_TAG must be a v-prefixed semantic version");
  }
  if (!COMMIT_PATTERN.test(commitSha)) {
    throw new Error("RELEASE_COMMIT_SHA must be a lowercase 40-character SHA");
  }
  if (!isAbsolute(candidateDirectory)) {
    throw new Error("RELEASE_CANDIDATE_DIR must be absolute");
  }

  const version = tag.slice(1);
  const tarballName = `${PACKAGE_NAME}-${version}.tgz`;
  return {
    repository,
    tag,
    commitSha,
    candidateDirectory,
    tarballName,
    tarballPath: join(candidateDirectory, tarballName),
    checksumPath: join(candidateDirectory, CHECKSUM_NAME),
    title: releaseTitle(tag),
  };
}

export function createGhRemoteAdapter(dependencies = {}) {
  const execute = dependencies.execute ?? executeProcess;

  async function executeJson(endpoint, failureMessage) {
    const result = await execute("gh", ["api", endpoint], { shell: false });
    if (result.code !== 0) {
      throw new Error(failureMessage);
    }

    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("gh returned invalid JSON metadata");
    }
  }

  function validateTagObject(value) {
    const object = value?.object;
    if (
      !object ||
      (object.type !== "commit" && object.type !== "tag") ||
      !COMMIT_PATTERN.test(object.sha)
    ) {
      throw new Error("gh returned an invalid remote tag object");
    }
    return object;
  }

  return {
    async getRelease({ repository, tag }) {
      const endpoint = `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
      const result = await execute("gh", ["api", endpoint], { shell: false });
      if (result.code !== 0) {
        if (/\bHTTP 404\b/i.test(result.stderr)) {
          return null;
        }
        throw new Error("gh release lookup failed");
      }

      let release;
      try {
        release = JSON.parse(result.stdout);
      } catch {
        throw new Error("gh returned invalid release metadata");
      }

      return {
        repository,
        tagName: release.tag_name,
        isDraft: release.draft,
        targetCommitish: release.target_commitish,
        assets: Array.isArray(release.assets)
          ? release.assets.map((asset) => ({ name: asset?.name }))
          : release.assets,
      };
    },

    async resolveTag({ repository, tag }) {
      const refEndpoint =
        `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
      const ref = await executeJson(refEndpoint, "gh remote tag lookup failed");
      if (ref?.ref !== `refs/tags/${tag}`) {
        throw new Error("gh returned invalid remote tag metadata");
      }

      let object = validateTagObject(ref);
      let depth = 0;
      while (object.type === "tag") {
        if (depth >= MAX_ANNOTATED_TAG_DEPTH) {
          throw new Error(
            `annotated tag depth exceeds ${MAX_ANNOTATED_TAG_DEPTH}`,
          );
        }
        const tagObject = await executeJson(
          `repos/${repository}/git/tags/${object.sha}`,
          "gh remote tag lookup failed",
        );
        object = validateTagObject(tagObject);
        depth += 1;
      }

      return object.sha;
    },

    async downloadAssets({
      repository,
      tag,
      assetNames,
      destination,
      clobber,
    }) {
      if (clobber !== false) {
        throw new Error("Release asset downloads must not clobber files");
      }
      const args = [
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        destination,
      ];
      for (const assetName of assetNames) {
        args.push("--pattern", assetName);
      }

      const result = await execute("gh", args, { shell: false });
      if (result.code !== 0) {
        throw new Error("gh release asset download failed");
      }
    },

    async createDraft({ repository, tag, commitSha, title, assetPaths }) {
      const result = await execute(
        "gh",
        [
          "release",
          "create",
          tag,
          "--verify-tag",
          "--target",
          commitSha,
          "--repo",
          repository,
          "--draft",
          "--generate-notes",
          "--title",
          title,
          ...assetPaths,
        ],
        { shell: false },
      );
      if (result.code !== 0) {
        throw new Error("gh draft release creation failed");
      }
    },
  };
}

export async function reconcileDraftRelease(context, remote, dependencies = {}) {
  const candidate = await readAndVerifyCandidate(context);
  const peelLocalTag = dependencies.peelLocalTag ?? peelLocalTagWithGit;
  const localCommit = await peelLocalTag(context.tag);
  if (localCommit !== context.commitSha) {
    throw new Error("Local tag does not match release commit");
  }

  const release = await remote.getRelease({
    repository: context.repository,
    tag: context.tag,
  });
  if (release === null) {
    const remoteCommit = await remote.resolveTag({
      repository: context.repository,
      tag: context.tag,
    });
    if (remoteCommit !== context.commitSha) {
      throw new Error("Remote tag does not match release commit");
    }
    await remote.createDraft({
      repository: context.repository,
      tag: context.tag,
      commitSha: context.commitSha,
      title: context.title,
      assetPaths: [context.tarballPath, context.checksumPath],
    });
    const verifiedRemoteCommit = await remote.resolveTag({
      repository: context.repository,
      tag: context.tag,
    });
    if (verifiedRemoteCommit !== context.commitSha) {
      throw manualRecoveryError(
        "Remote tag moved while the draft release was being created",
      );
    }
    return { action: "created" };
  }

  validateExistingRelease(release, context);
  const remoteCommit = await remote.resolveTag({
    repository: context.repository,
    tag: context.tag,
  });
  if (remoteCommit !== context.commitSha) {
    throw manualRecoveryError(
      "Existing release remote tag does not match the expected commit",
    );
  }
  const createDownloadDirectory =
    dependencies.createDownloadDirectory ??
    (() => mkdtemp(join(tmpdir(), "release-draft-download-")));
  const removeDownloadDirectory = !dependencies.createDownloadDirectory;
  const downloadDirectory = await createDownloadDirectory();

  try {
    if ((await readdir(downloadDirectory)).length !== 0) {
      throw new Error("Download directory must be empty");
    }
    await remote.downloadAssets({
      repository: context.repository,
      tag: context.tag,
      assetNames: expectedAssetNames(context),
      destination: downloadDirectory,
      clobber: false,
    });
    try {
      await verifyDownloadedAssets(downloadDirectory, context, candidate);
    } catch (error) {
      throw manualRecoveryError(error.message);
    }
    return { action: "no-op" };
  } finally {
    if (removeDownloadDirectory) {
      await rm(downloadDirectory, { recursive: true, force: true });
    }
  }
}

export async function runReleaseDraft(environment = process.env, dependencies = {}) {
  const context = validateReleaseEnvironment(environment);
  const remote =
    dependencies.remote ?? createGhRemoteAdapter(dependencies.remoteDependencies);
  return reconcileDraftRelease(context, remote, dependencies);
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("release-draft.mjs accepts no command-line arguments");
  }
  const result = await runReleaseDraft();
  process.stdout.write(
    result.action === "created"
      ? "Draft release created.\n"
      : "Existing draft matches the verified candidate; no changes made.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
