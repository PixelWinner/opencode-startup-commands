import { expect, test } from "bun:test";
import packageManifest from "../package.json";

const manifest: Record<string, unknown> = packageManifest;

test("manifest exposes the exact public release metadata", () => {
  expect(manifest.name).toBe("opencode-startup-commands");
  expect(manifest.version).toBe("1.1.0");
  expect(manifest).not.toHaveProperty("private");
  expect(manifest.description).toBe(
    "Launch trusted background commands when OpenCode initializes a project or directory.",
  );
  expect(manifest.license).toBe("MIT");
  expect(manifest.author).toEqual({
    name: "Oleksandr Khoroshykh (PixelWinner)",
    url: "https://github.com/PixelWinner",
  });
  expect(manifest.repository).toBe(
    "git+https://github.com/PixelWinner/opencode-startup-commands.git",
  );
  expect(manifest.homepage).toBe(
    "https://github.com/PixelWinner/opencode-startup-commands#readme",
  );
  expect(manifest.bugs).toEqual({
    url: "https://github.com/PixelWinner/opencode-startup-commands/issues",
  });
  expect(manifest.keywords).toEqual([
    "opencode",
    "opencode-plugin",
    "startup",
    "automation",
    "background-process",
    "typescript",
  ]);
  expect(manifest.files).toEqual(["dist/**/*.js", "dist/**/*.d.ts"]);
  expect(manifest.publishConfig).toEqual({
    access: "public",
    registry: "https://registry.npmjs.org/",
  });
});

test("manifest preserves the public runtime entry points", () => {
  expect(manifest.main).toBe("./dist/server.js");
  expect(manifest.types).toBe("./dist/server.d.ts");
  expect(manifest.exports).toEqual({
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
  });
});

test("manifest keeps runtime installation side-effect free", () => {
  expect(manifest.scripts).toEqual({
    test: "bun test",
    typecheck: "tsc --noEmit && tsc -p tsconfig.type-tests.json",
    compile: "tsc -p tsconfig.json",
    "package:check": "node ./scripts/release-package.mjs",
    "verify:dist": "node ./scripts/verify-dist.mjs",
    "release:check": "node ./scripts/release-check.mjs",
  });
  expect(manifest).not.toHaveProperty("dependencies");
  expect(manifest).not.toHaveProperty("optionalDependencies");
  expect(manifest).not.toHaveProperty("peerDependencies");
  expect(manifest).not.toHaveProperty("bundledDependencies");
  expect(manifest).not.toHaveProperty("bundleDependencies");
  expect(manifest.engines).toEqual({ opencode: "1.18.x" });
  expect(packageManifest.devDependencies["@opencode-ai/plugin"]).toBe(
    "1.18.25",
  );
});
