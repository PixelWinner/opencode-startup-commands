import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGhRemoteAdapter,
  reconcileDraftRelease,
  validateReleaseEnvironment,
} from "../scripts/release-draft.mjs";

const repository = "PixelWinner/opencode-startup-commands";
const tag = "v1.0.0";
const commitSha = "a".repeat(40);
const tarballName = "opencode-startup-commands-1.0.0.tgz";
const checksumName = "SHA256SUMS";
const temporaryPaths: string[] = [];

type Release = {
  repository: string;
  tagName: string;
  isDraft: boolean;
  targetCommitish: string;
  assets: Array<{ name: string }>;
};

type Candidate = {
  directory: string;
  tarball: Buffer;
  checksum: Buffer;
  digest: string;
};

type RemoteOptions = {
  release?: Release | null;
  downloadedTarball?: Buffer;
  downloadedChecksum?: Buffer;
  lookupError?: Error;
  resolvedTags?: string[];
  resolveError?: Error;
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function makeCandidate(
  tarball = Buffer.from("verified release candidate"),
): Promise<Candidate> {
  const directory = await makeTemporaryDirectory("release-candidate-");
  const digest = createHash("sha256").update(tarball).digest("hex");
  const checksum = Buffer.from(`${digest}  ${tarballName}\n`);
  await writeFile(join(directory, tarballName), tarball);
  await writeFile(join(directory, checksumName), checksum);

  return { directory, tarball, checksum, digest };
}

function validEnvironment(candidateDirectory: string): NodeJS.ProcessEnv {
  return {
    RELEASE_REPOSITORY: repository,
    RELEASE_TAG: tag,
    RELEASE_COMMIT_SHA: commitSha,
    RELEASE_CANDIDATE_DIR: candidateDirectory,
  };
}

function matchingRelease(overrides: Partial<Release> = {}): Release {
  return {
    repository,
    tagName: tag,
    isDraft: true,
    targetCommitish: commitSha,
    assets: [{ name: tarballName }, { name: checksumName }],
    ...overrides,
  };
}

function createFakeRemote(options: RemoteOptions = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const release = options.release === undefined ? null : options.release;
  const resolvedTags = options.resolvedTags ?? [commitSha];
  let resolveIndex = 0;

  return {
    calls,
    adapter: {
      async getRelease(request: Record<string, unknown>) {
        calls.push({ operation: "getRelease", ...request });
        if (options.lookupError) {
          throw options.lookupError;
        }
        return release;
      },
      async resolveTag(request: Record<string, unknown>) {
        calls.push({ operation: "resolveTag", ...request });
        if (options.resolveError) {
          throw options.resolveError;
        }
        const resolved =
          resolvedTags[Math.min(resolveIndex, resolvedTags.length - 1)];
        resolveIndex += 1;
        return resolved;
      },
      async downloadAssets(request: {
        repository: string;
        tag: string;
        assetNames: string[];
        destination: string;
        clobber: boolean;
      }) {
        calls.push({ operation: "downloadAssets", ...request });
        await writeFile(
          join(request.destination, tarballName),
          options.downloadedTarball ?? Buffer.from("verified release candidate"),
          { flag: "wx" },
        );
        await writeFile(
          join(request.destination, checksumName),
          options.downloadedChecksum ?? Buffer.alloc(0),
          { flag: "wx" },
        );
      },
      async createDraft(request: Record<string, unknown>) {
        calls.push({ operation: "createDraft", ...request });
      },
    },
  };
}

async function expectManualRecovery(failure: Promise<unknown>): Promise<void> {
  let message = "";
  try {
    await failure;
  } catch (error) {
    message = String(error);
  }

  expect(message).toContain("Inspect the GitHub Release manually");
  expect(message).toContain("Do not publish npm");
  expect(message).toContain(
    "deliberately delete and recreate only the broken draft",
  );
  expect(message).toContain("never deletes or overwrites release assets");
}

function reconciliationDependencies(
  calls: string[],
  downloadDirectory?: string,
) {
  return {
    async createDownloadDirectory() {
      calls.push("createDownloadDirectory");
      return downloadDirectory ?? makeTemporaryDirectory("release-download-");
    },
    async peelLocalTag(receivedTag: string) {
      calls.push(`peelLocalTag:${receivedTag}`);
      return commitSha;
    },
  };
}

describe("release environment validation", () => {
  test("accepts only an explicit repository, semver tag, commit, and absolute candidate directory", async () => {
    const candidate = await makeCandidate();
    expect(validateReleaseEnvironment(validEnvironment(candidate.directory))).toEqual({
      repository,
      tag,
      commitSha,
      candidateDirectory: candidate.directory,
      tarballName,
      tarballPath: join(candidate.directory, tarballName),
      checksumPath: join(candidate.directory, checksumName),
      title: "v1.0.0 — Initial release",
    });

    for (const changed of [
      { RELEASE_REPOSITORY: "owner/repo/extra" },
      { RELEASE_REPOSITORY: "${{ github.repository }}" },
      { RELEASE_TAG: "main" },
      { RELEASE_TAG: "v1.0.0; echo unsafe" },
      { RELEASE_COMMIT_SHA: "abc123" },
      { RELEASE_CANDIDATE_DIR: "relative/path" },
      { RELEASE_CANDIDATE_DIR: "" },
    ]) {
      expect(() =>
        validateReleaseEnvironment({
          ...validEnvironment(candidate.directory),
          ...changed,
        }),
      ).toThrow();
    }
  });

  test("derives a safe future-version tarball name and title from the validated tag", async () => {
    const candidate = await makeCandidate();
    const environment = {
      ...validEnvironment(candidate.directory),
      RELEASE_TAG: "v1.1.0",
    };

    expect(validateReleaseEnvironment(environment)).toEqual({
      repository,
      tag: "v1.1.0",
      commitSha,
      candidateDirectory: candidate.directory,
      tarballName: "opencode-startup-commands-1.1.0.tgz",
      tarballPath: join(
        candidate.directory,
        "opencode-startup-commands-1.1.0.tgz",
      ),
      checksumPath: join(candidate.directory, checksumName),
      title: "v1.1.0",
    });
  });
});

describe("draft reconciliation", () => {
  test("creates a targeted draft only after local and remote tags resolve to the workflow commit", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote();
    const sequence: string[] = [];

    const result = await reconcileDraftRelease(
      validateReleaseEnvironment(validEnvironment(candidate.directory)),
      remote.adapter,
      reconciliationDependencies(sequence),
    );

    expect(result).toEqual({ action: "created" });
    expect(sequence[0]).toBe(`peelLocalTag:${tag}`);
    expect(remote.calls).toEqual([
      { operation: "getRelease", repository, tag },
      { operation: "resolveTag", repository, tag },
      {
        operation: "createDraft",
        repository,
        tag,
        commitSha,
        title: "v1.0.0 — Initial release",
        assetPaths: [
          join(candidate.directory, tarballName),
          join(candidate.directory, checksumName),
        ],
      },
      { operation: "resolveTag", repository, tag },
    ]);
  });

  test("refuses draft creation when the remote tag does not resolve to the workflow commit", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote({ resolvedTags: ["b".repeat(40)] });

    await expect(
      reconcileDraftRelease(
        validateReleaseEnvironment(validEnvironment(candidate.directory)),
        remote.adapter,
        reconciliationDependencies([]),
      ),
    ).rejects.toThrow("Remote tag does not match release commit");
    expect(remote.calls).toEqual([
      { operation: "getRelease", repository, tag },
      { operation: "resolveTag", repository, tag },
    ]);
  });

  test("fails with manual recovery instructions if the remote tag moves during draft creation", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote({
      resolvedTags: [commitSha, "b".repeat(40)],
    });

    await expectManualRecovery(
      reconcileDraftRelease(
        validateReleaseEnvironment(validEnvironment(candidate.directory)),
        remote.adapter,
        reconciliationDependencies([]),
      ),
    );
    expect(remote.calls.map((call) => call.operation)).toEqual([
      "getRelease",
      "resolveTag",
      "createDraft",
      "resolveTag",
    ]);
  });

  test("refuses a local tag that does not peel to the workflow commit before remote access", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote();

    await expect(
      reconcileDraftRelease(
        validateReleaseEnvironment(validEnvironment(candidate.directory)),
        remote.adapter,
        {
          async peelLocalTag() {
            return "b".repeat(40);
          },
        },
      ),
    ).rejects.toThrow("Local tag does not match release commit");
    expect(remote.calls).toEqual([]);
  });

  test("accepts an exact existing draft only after byte and digest verification", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote({
      release: matchingRelease(),
      downloadedTarball: candidate.tarball,
      downloadedChecksum: candidate.checksum,
    });
    const sequence: string[] = [];

    const result = await reconcileDraftRelease(
      validateReleaseEnvironment(validEnvironment(candidate.directory)),
      remote.adapter,
      reconciliationDependencies(sequence),
    );

    expect(result).toEqual({ action: "no-op" });
    expect(remote.calls).toHaveLength(3);
    expect(remote.calls[1]).toEqual({
      operation: "resolveTag",
      repository,
      tag,
    });
    expect(remote.calls[2]).toEqual({
      operation: "downloadAssets",
      repository,
      tag,
      assetNames: [tarballName, checksumName],
      destination: expect.any(String),
      clobber: false,
    });
    expect(sequence).toEqual([
      `peelLocalTag:${tag}`,
      "createDownloadDirectory",
    ]);
  });

  test("hard-fails every invalid existing release without creating or overwriting assets", async () => {
    const candidate = await makeCandidate();
    const invalidReleases: Array<[string, Release]> = [
      ["published", matchingRelease({ isDraft: false })],
      ["repository", matchingRelease({ repository: "other/repository" })],
      ["tag", matchingRelease({ tagName: "v1.0.1" })],
      ["target", matchingRelease({ targetCommitish: "b".repeat(40) })],
      ["missing", matchingRelease({ assets: [{ name: tarballName }] })],
      [
        "extra",
        matchingRelease({
          assets: [
            { name: tarballName },
            { name: checksumName },
            { name: "extra.txt" },
          ],
        }),
      ],
      [
        "duplicate",
        matchingRelease({
          assets: [
            { name: tarballName },
            { name: tarballName },
            { name: checksumName },
          ],
        }),
      ],
    ];

    for (const [name, release] of invalidReleases) {
      const remote = createFakeRemote({ release });
      await expectManualRecovery(
        reconcileDraftRelease(
          validateReleaseEnvironment(validEnvironment(candidate.directory)),
          remote.adapter,
          reconciliationDependencies([]),
        ),
      );
      expect(remote.calls, name).toHaveLength(1);
      expect(remote.calls[0].operation).toBe("getRelease");
    }
  });

  test("refuses an existing draft when its remote tag no longer resolves to the expected commit", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote({
      release: matchingRelease(),
      resolvedTags: ["b".repeat(40)],
    });

    await expectManualRecovery(
      reconcileDraftRelease(
        validateReleaseEnvironment(validEnvironment(candidate.directory)),
        remote.adapter,
        reconciliationDependencies([]),
      ),
    );
    expect(remote.calls).toEqual([
      { operation: "getRelease", repository, tag },
      { operation: "resolveTag", repository, tag },
    ]);
  });

  test("hard-fails changed checksum bytes or a changed downloaded tarball", async () => {
    const candidate = await makeCandidate();
    const changedChecksum = Buffer.from(
      `${"b".repeat(64)}  ${tarballName}\n`,
    );

    for (const options of [
      {
        release: matchingRelease(),
        downloadedTarball: candidate.tarball,
        downloadedChecksum: changedChecksum,
      },
      {
        release: matchingRelease(),
        downloadedTarball: Buffer.from("changed tarball"),
        downloadedChecksum: candidate.checksum,
      },
    ]) {
      const remote = createFakeRemote(options);
      await expectManualRecovery(
        reconcileDraftRelease(
          validateReleaseEnvironment(validEnvironment(candidate.directory)),
          remote.adapter,
          reconciliationDependencies([]),
        ),
      );
      expect(remote.calls.some((call) => call.operation === "createDraft")).toBe(
        false,
      );
    }
  });

  test("refuses a non-empty download directory before requesting assets", async () => {
    const candidate = await makeCandidate();
    const downloadDirectory = await makeTemporaryDirectory("release-nonempty-");
    await writeFile(join(downloadDirectory, "existing.txt"), "must survive");
    const remote = createFakeRemote({ release: matchingRelease() });

    await expect(
      reconcileDraftRelease(
        validateReleaseEnvironment(validEnvironment(candidate.directory)),
        remote.adapter,
        reconciliationDependencies([], downloadDirectory),
      ),
    ).rejects.toThrow("Download directory must be empty");
    expect(remote.calls.map((call) => call.operation)).toEqual([
      "getRelease",
      "resolveTag",
    ]);
    expect(await readFile(join(downloadDirectory, "existing.txt"), "utf8")).toBe(
      "must survive",
    );
  });

  test("propagates authentication and network lookup errors instead of treating them as no release", async () => {
    const candidate = await makeCandidate();
    const remote = createFakeRemote({
      lookupError: new Error("GitHub authentication failed"),
    });

    await expect(
      reconcileDraftRelease(
        validateReleaseEnvironment(validEnvironment(candidate.directory)),
        remote.adapter,
        reconciliationDependencies([]),
      ),
    ).rejects.toThrow("GitHub authentication failed");
    expect(remote.calls).toHaveLength(1);
  });
});

describe("gh adapter", () => {
  test("distinguishes a no-release 404 from authentication and network failures", async () => {
    for (const result of [
      { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" },
      { code: 1, stdout: "", stderr: "HTTP 404: release not found\n" },
    ]) {
      const remote = createGhRemoteAdapter({ execute: async () => result });
      expect(await remote.getRelease({ repository, tag })).toBeNull();
    }

    for (const result of [
      { code: 1, stdout: "", stderr: "HTTP 401: Bad credentials\n" },
      { code: 1, stdout: "", stderr: "network unavailable\n" },
    ]) {
      const remote = createGhRemoteAdapter({ execute: async () => result });
      await expect(remote.getRelease({ repository, tag })).rejects.toThrow(
        "gh release lookup failed",
      );
    }
  });

  test("queries the explicit release endpoint and maps exact release metadata", async () => {
    const invocations: unknown[][] = [];
    const remote = createGhRemoteAdapter({
      execute: async (...args: unknown[]) => {
        invocations.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({
            tag_name: tag,
            draft: true,
            target_commitish: commitSha,
            assets: [{ name: tarballName }, { name: checksumName }],
          }),
          stderr: "",
        };
      },
    });

    expect(await remote.getRelease({ repository, tag })).toEqual(
      matchingRelease(),
    );
    expect(invocations).toEqual([
      [
        "gh",
        ["api", `repos/${repository}/releases/tags/${tag}`],
        { shell: false },
      ],
    ]);
  });

  test("resolves a lightweight remote tag through the explicit Git refs endpoint", async () => {
    const invocations: unknown[][] = [];
    const remote = createGhRemoteAdapter({
      execute: async (...args: unknown[]) => {
        invocations.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({
            ref: `refs/tags/${tag}`,
            object: { type: "commit", sha: commitSha },
          }),
          stderr: "",
        };
      },
    });

    expect(await remote.resolveTag({ repository, tag })).toBe(commitSha);
    expect(invocations).toEqual([
      [
        "gh",
        ["api", `repos/${repository}/git/ref/tags/${tag}`],
        { shell: false },
      ],
    ]);
  });

  test("recursively peels annotated remote tag objects to a validated commit", async () => {
    const firstTagObject = "b".repeat(40);
    const secondTagObject = "c".repeat(40);
    const results = [
      {
        ref: `refs/tags/${tag}`,
        object: { type: "tag", sha: firstTagObject },
      },
      { object: { type: "tag", sha: secondTagObject } },
      { object: { type: "commit", sha: commitSha } },
    ];
    const invocations: unknown[][] = [];
    const remote = createGhRemoteAdapter({
      execute: async (...args: unknown[]) => {
        invocations.push(args);
        return {
          code: 0,
          stdout: JSON.stringify(results.shift()),
          stderr: "",
        };
      },
    });

    expect(await remote.resolveTag({ repository, tag })).toBe(commitSha);
    expect(invocations).toEqual([
      [
        "gh",
        ["api", `repos/${repository}/git/ref/tags/${tag}`],
        { shell: false },
      ],
      [
        "gh",
        ["api", `repos/${repository}/git/tags/${firstTagObject}`],
        { shell: false },
      ],
      [
        "gh",
        ["api", `repos/${repository}/git/tags/${secondTagObject}`],
        { shell: false },
      ],
    ]);
  });

  test("hard-fails tag 404s, invalid tag objects, and excessive annotated depth", async () => {
    const tag404 = createGhRemoteAdapter({
      execute: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)\n",
      }),
    });
    await expect(tag404.resolveTag({ repository, tag })).rejects.toThrow(
      "gh remote tag lookup failed",
    );

    for (const object of [
      { type: "tree", sha: commitSha },
      { type: "commit", sha: "not-a-sha" },
      { type: "tag", sha: "A".repeat(40) },
    ]) {
      const invalid = createGhRemoteAdapter({
        execute: async () => ({
          code: 0,
          stdout: JSON.stringify({ ref: `refs/tags/${tag}`, object }),
          stderr: "",
        }),
      });
      await expect(invalid.resolveTag({ repository, tag })).rejects.toThrow(
        "invalid remote tag object",
      );
    }

    let depthCalls = 0;
    const tooDeep = createGhRemoteAdapter({
      execute: async () => {
        depthCalls += 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            ref: `refs/tags/${tag}`,
            object: { type: "tag", sha: "b".repeat(40) },
          }),
          stderr: "",
        };
      },
    });
    await expect(tooDeep.resolveTag({ repository, tag })).rejects.toThrow(
      "annotated tag depth exceeds 5",
    );
    expect(depthCalls).toBe(6);
  });

  test("creates a verified-tag targeted draft with exact paths and shell disabled", async () => {
    const candidate = await makeCandidate();
    const invocations: unknown[][] = [];
    const remote = createGhRemoteAdapter({
      execute: async (...args: unknown[]) => {
        invocations.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await remote.createDraft({
      repository,
      tag,
      commitSha,
      title: "v1.0.0 — Initial release",
      assetPaths: [
        join(candidate.directory, tarballName),
        join(candidate.directory, checksumName),
      ],
    });

    expect(invocations).toEqual([
      [
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
          "v1.0.0 — Initial release",
          join(candidate.directory, tarballName),
          join(candidate.directory, checksumName),
        ],
        { shell: false },
      ],
    ]);
  });

  test("downloads the two exact assets without wildcard or clobber arguments", async () => {
    const destination = await makeTemporaryDirectory("release-download-");
    const invocations: unknown[][] = [];
    const remote = createGhRemoteAdapter({
      execute: async (...args: unknown[]) => {
        invocations.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await remote.downloadAssets({
      repository,
      tag,
      assetNames: [tarballName, checksumName],
      destination,
      clobber: false,
    });

    expect(invocations).toEqual([
      [
        "gh",
        [
          "release",
          "download",
          tag,
          "--repo",
          repository,
          "--dir",
          destination,
          "--pattern",
          tarballName,
          "--pattern",
          checksumName,
        ],
        { shell: false },
      ],
    ]);
  });
});
