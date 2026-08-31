import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepositoryFile(path: string): string {
  try {
    return readFileSync(`${repositoryRoot}/${path}`, "utf8").replaceAll(
      "\r\n",
      "\n",
    );
  } catch {
    return "";
  }
}

function getJob(workflow: string, jobId: string): string {
  const match = workflow.match(
    new RegExp(
      `^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|(?![\\s\\S]))`,
      "m",
    ),
  );

  return match?.[0] ?? "";
}

function getRunScripts(workflow: string): string[] {
  const lines = workflow.split("\n");
  const scripts: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(/^\s*-?\s*run:\s*(?![>|]\s*$)(.+)$/);
    if (inline) {
      scripts.push(inline[1]);
      continue;
    }

    const block = line.match(/^(\s*)-?\s*run:\s*[>|]\s*$/);
    if (!block) {
      continue;
    }

    const indentation = block[1].length;
    const body: string[] = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      const nextIndentation = nextLine.match(/^\s*/)?.[0].length ?? 0;
      if (nextLine.trim() && nextIndentation <= indentation) {
        break;
      }
      body.push(nextLine);
      index += 1;
    }
    scripts.push(body.join("\n"));
  }

  return scripts;
}

function getUploadPaths(job: string): string[] {
  const match = job.match(
    /actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n[\s\S]*?^\s+path:\s*\|\n((?:^\s{12}.+\n)+)/m,
  );

  return (match?.[1] ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim());
}

const ci = readRepositoryFile(".github/workflows/ci.yml");
const release = readRepositoryFile(".github/workflows/release.yml");
const workflows = [ci, release];

describe("immutable workflow inputs", () => {
  test("pins every action to the reviewed commit with an adjacent tag comment", () => {
    const expectedUses = new Set([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
    ]);

    for (const workflow of workflows) {
      const usesLines = workflow.match(/^\s*- uses: .+$/gm) ?? [];
      expect(usesLines.length).toBeGreaterThan(0);
      for (const line of usesLines) {
        const value = line.replace(/^\s*- uses:\s*/, "");
        expect(value).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
        expect(expectedUses.has(value)).toBe(true);
      }
    }
  });

  test("keeps every checkout credential-free", () => {
    for (const workflow of workflows) {
      const checkoutCount = (workflow.match(/actions\/checkout@/g) ?? []).length;
      const disabledCredentialCount = (
        workflow.match(/persist-credentials:\s*false/g) ?? []
      ).length;
      expect(checkoutCount).toBeGreaterThan(0);
      expect(disabledCredentialCount).toBe(checkoutCount);
    }
  });
});

describe("normal CI contract", () => {
  test("retains main push, main pull request, and manual triggers", () => {
    expect(ci).toMatch(/^on:\n  push:\n    branches:\n      - main/m);
    expect(ci).toMatch(/  pull_request:\n    branches:\n      - main/);
    expect(ci).toContain("  workflow_dispatch:");
  });

  test("retains read-only permissions, concurrency, and the Bun matrix", () => {
    expect(ci).toMatch(/^permissions:\n  contents: read$/m);
    expect(ci).toContain("group: ci-${{ github.workflow }}-${{ github.ref }}");
    expect(ci).toContain("cancel-in-progress: true");
    for (const operatingSystem of [
      "ubuntu-latest",
      "windows-latest",
      "macos-latest",
    ]) {
      expect(ci).toContain(`- ${operatingSystem}`);
    }
    expect(ci).toContain("bun-version: 1.3.14");
  });

  test("retains typecheck and exact clean tracked-dist verification", () => {
    const verifyBuild = getJob(ci, "verify-build");
    expect(verifyBuild).toContain("run: bun run typecheck");
    expect(verifyBuild).toContain("run: rm -rf dist");
    expect(verifyBuild).toContain("run: bun run compile");
    expect(verifyBuild).toContain("run: git diff --exit-code -- dist");
    expect(verifyBuild).toContain(
      'run: test -z "$(git status --porcelain --untracked-files=all -- dist)"',
    );
  });
});

describe("release workflow modes and permissions", () => {
  test("allows only manual dry-run and v-prefixed tag-push triggers", () => {
    expect(release).toMatch(
      /^on:\n  workflow_dispatch:\n  push:\n    tags:\n      - "v\*"$/m,
    );
    expect(release).not.toMatch(/^\s+branches:/m);
    expect(release).not.toContain("pull_request:");
  });

  test("uses one non-cancelling run per ref and event-name mode gates", () => {
    expect(release).toMatch(/^permissions:\n  contents: read$/m);
    expect(release).toContain(
      "group: release-${{ github.workflow }}-${{ github.ref }}",
    );
    expect(release).toContain("cancel-in-progress: false");
    expect(release).toContain("github.event_name == 'workflow_dispatch'");
    expect(release).toContain("github.event_name == 'push'");
    expect(release).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  test("repeats the complete CI matrix and build verification on the tagged commit", () => {
    for (const workflow of [ci, release]) {
      const testJob = getJob(workflow, "test");
      const verifyBuild = getJob(workflow, "verify-build");
      for (const operatingSystem of [
        "ubuntu-latest",
        "windows-latest",
        "macos-latest",
      ]) {
        expect(testJob).toContain(`- ${operatingSystem}`);
      }
      expect(testJob).toContain("bun-version: 1.3.14");
      expect(testJob).toContain("run: bun install --frozen-lockfile");
      expect(testJob).toContain("run: bun test");
      expect(verifyBuild).toContain("bun-version: 1.3.14");
      expect(verifyBuild).toContain("run: bun install --frozen-lockfile");
      expect(verifyBuild).toContain("run: bun run typecheck");
      expect(verifyBuild).toContain("run: rm -rf dist");
      expect(verifyBuild).toContain("run: bun run compile");
      expect(verifyBuild).toContain("run: git diff --exit-code -- dist");
      expect(verifyBuild).toContain(
        'run: test -z "$(git status --porcelain --untracked-files=all -- dist)"',
      );
    }
  });

  test("uses the complete push-and-tag gate on every tag-only job", () => {
    const exactGate =
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
    for (const jobId of ["package-tag", "release"]) {
      expect(getJob(release, jobId)).toContain(exactGate);
    }
  });

  test("keeps manual packaging read-only and incapable of artifact or release writes", () => {
    const manualPackage = getJob(release, "package-dry-run");
    expect(manualPackage).toContain("contents: read");
    expect(manualPackage).toContain("github.event_name == 'workflow_dispatch'");
    expect(manualPackage).toContain("node ./scripts/release-package.mjs");
    expect(manualPackage).not.toContain("upload-artifact");
    expect(manualPackage).not.toContain("release-draft.mjs");
    expect(manualPackage).not.toContain("contents: write");
  });

  test("keeps tag packaging read-only with exact tools, verification, and handoff", () => {
    const tagPackage = getJob(release, "package-tag");
    expect(tagPackage).toContain("contents: read");
    expect(tagPackage).toContain("github.event_name == 'push'");
    expect(tagPackage).toContain("node-version: 24.20.0");
    expect(tagPackage).toContain("npm install --global npm@11.19.0");
    expect(tagPackage).toContain("node ./scripts/release-package.mjs --output-dir");
    expect(tagPackage).toContain("id: package-identity");
    expect(tagPackage).toContain("process.env.RELEASE_TAG");
    expect(tagPackage).toContain("process.env.GITHUB_OUTPUT");
    expect(tagPackage).toContain("tarball_name=");
    expect(tagPackage).not.toContain("opencode-startup-commands-1.0.0.tgz");
    expect(tagPackage).not.toContain("contents: write");
  });

  test("gives only the dedicated release job write permission and a step-scoped token", () => {
    const releaseJob = getJob(release, "release");
    expect((release.match(/contents: write/g) ?? [])).toHaveLength(1);
    expect(releaseJob).toContain("contents: write");
    expect(releaseJob).toContain("actions/download-artifact@");
    expect(releaseJob).toContain("sha256sum --check SHA256SUMS");
    expect(releaseJob).toContain("node ./scripts/release-draft.mjs");
    expect(releaseJob).toMatch(
      /run: node \.\/scripts\/release-draft\.mjs\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}/,
    );
    expect((release.match(/GH_TOKEN:/g) ?? [])).toHaveLength(1);
    expect((release.match(/\$\{\{ github\.token \}\}/g) ?? [])).toHaveLength(1);
    expect(release).not.toMatch(/^env:\n\s+GH_TOKEN:/m);
    expect(releaseJob).not.toContain("npm install");
    expect(releaseJob).not.toContain("npm --version");
    expect(releaseJob).toContain("node --version");
    expect(releaseJob).toContain("gh --version");
  });

  test("runs tag-version equality only in tag-push packaging", () => {
    const manualPackage = getJob(release, "package-dry-run");
    const tagPackage = getJob(release, "package-tag");
    expect(tagPackage).toContain("const expectedTag = `v${manifest.version}`");
    expect(tagPackage).toContain("releaseTag !== expectedTag");
    expect(manualPackage).not.toContain("package-identity");
    expect(manualPackage).not.toContain("RELEASE_TAG");
  });

  test("downloads and uploads exactly the tarball and checksum without wildcards", () => {
    const tagPackage = getJob(release, "package-tag");
    const releaseJob = getJob(release, "release");
    const artifactJobs = `${tagPackage}\n${releaseJob}`;
    expect(artifactJobs).not.toMatch(/path:\s*[^\n]*[*?]/);
    expect(artifactJobs).not.toContain("--clobber");
    expect(getUploadPaths(tagPackage)).toEqual([
      "${{ runner.temp }}/release-candidate/${{ steps.package-identity.outputs.tarball_name }}",
      "${{ runner.temp }}/release-candidate/SHA256SUMS",
    ]);
    expect(tagPackage).toContain("name: release-candidate");
    expect(releaseJob).toContain("name: release-candidate");
    expect(releaseJob).toContain("node ./scripts/release-draft.mjs");
  });

  test("prints release tool versions including gh", () => {
    expect(release).toContain("bun --version");
    expect(release).toContain("node --version");
    expect(release).toContain("npm --version");
    expect(release).toContain("gh --version");
  });
});

describe("release workflow mutation and injection boundaries", () => {
  test("contains no publishing credentials or repository-history mutations", () => {
    expect(release).not.toMatch(/id-token:\s*write/);
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm publish/);
    expect(release).not.toMatch(
      /git\s+(?:tag|push|commit|config)|force-push|gh\s+release\s+upload|--clobber/,
    );
    expect(release).not.toMatch(
      /opencode\s+(?:config|plugin)|\.config[\\/]opencode|opencode\.json|global OpenCode|plugin registration/i,
    );
  });

  test("passes GitHub context through env rather than interpolating it in scripts", () => {
    const runScripts = getRunScripts(release);
    expect(runScripts.length).toBeGreaterThan(0);
    for (const script of runScripts) {
      expect(script).not.toMatch(/\$\{\{\s*github\./);
    }
    expect(release).toContain("RELEASE_REPOSITORY: ${{ github.repository }}");
    expect(release).toContain("RELEASE_TAG: ${{ github.ref_name }}");
    expect(release).toContain("RELEASE_COMMIT_SHA: ${{ github.sha }}");
  });
});
