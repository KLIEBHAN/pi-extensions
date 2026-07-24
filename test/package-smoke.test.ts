import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const standalonePackageRoot = join(projectRoot, "extensions", "prompt-autocomplete");
const standaloneManifest = JSON.parse(readFileSync(join(standalonePackageRoot, "package.json"), "utf8")) as {
  version: string;
};
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piCommand = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");

function run(command: string, args: string[], cwd = projectRoot): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PI_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    shell: process.platform === "win32",
  });
}

test("packed collection installs cleanly and is discovered by the supported Pi version", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-extensions-package-smoke-"));
  const packDir = join(tempRoot, "pack");
  const appDir = join(tempRoot, "app");
  const agentDir = join(tempRoot, "agent");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  try {
    const packOutput = run(npmCommand, ["pack", "--json", "--pack-destination", packDir]);
    const packResults = JSON.parse(packOutput) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    assert.equal(packResults.length, 1);

    const packed = packResults[0]!;
    const tarball = join(packDir, packed.filename);
    const packedPaths = packed.files.map((file) => file.path).sort();
    const requiredPaths = [
      "LICENSE",
      "README.md",
      "extensions/auto-mode/system-prompt.template.md",
      "extensions/prompt-autocomplete/system-prompt.template.md",
      "extensions/terminal-bench.system-prompt.template.md",
      "package.json",
      "themes/hermes-dark.json",
    ];
    for (const requiredPath of requiredPaths) {
      assert.ok(packedPaths.includes(requiredPath), `tarball is missing ${requiredPath}`);
    }
    for (const packedPath of packedPaths) {
      assert.ok(
        packedPath === "LICENSE"
          || packedPath === "README.md"
          || packedPath === "package.json"
          || packedPath.startsWith("extensions/")
          || packedPath.startsWith("themes/"),
        `unexpected package entry: ${packedPath}`,
      );
    }
    assert.equal(
      packedPaths.some((path) => /^(?:test|docs|examples|benchmark-runs|\.pi|\.pi-subagents)(?:\/|$)/.test(path)),
      false,
    );

    run(npmCommand, [
      "install",
      "--ignore-scripts",
      "--offline",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ], appDir);

    const installedPackage = join(appDir, "node_modules", "pi-extensions");
    const installedManifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    assert.equal(installedManifest.name, "pi-extensions");
    assert.equal(installedManifest.version, "0.1.0");
    for (const templatePath of requiredPaths.filter((path) => path.endsWith(".template.md"))) {
      assert.ok(readFileSync(join(installedPackage, templatePath), "utf8").trim().length > 0);
    }

    const settingsManager = SettingsManager.inMemory({
      packages: [installedPackage],
      defaultProjectTrust: "never",
    });
    const loader = new DefaultResourceLoader({
      cwd: appDir,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const extensionResult = loader.getExtensions();
    assert.deepEqual(extensionResult.errors, []);

    const loadedPaths = extensionResult.extensions
      .map((extension) => relative(installedPackage, extension.resolvedPath).replaceAll("\\", "/"))
      .sort();
    assert.deepEqual(loadedPaths, [
      "extensions/auto-mode/index.ts",
      "extensions/copy-prompt.ts",
      "extensions/hello.ts",
      "extensions/notify.ts",
      "extensions/permission-gate.ts",
      "extensions/prompt-autocomplete/index.ts",
      "extensions/ralphy-loop/index.ts",
      "extensions/review-cycle/index.ts",
      "extensions/session-name.ts",
      "extensions/terminal-bench.ts",
    ].sort());
    assert.equal(loadedPaths.some((path) => path.endsWith("/core.ts")), false);

    const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    assert.equal(run(piCommand, ["--version"]).trim(), manifest.devDependencies["@earendil-works/pi-coding-agent"]);

    const help = spawnSync(
      piCommand,
      ["--no-extensions", "-e", join(installedPackage, "extensions", "prompt-autocomplete"), "--help"],
      {
        cwd: appDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: agentDir,
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          GEMINI_API_KEY: "",
        },
        timeout: 120_000,
        shell: process.platform === "win32",
      },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--prompt-autocomplete\b/);
    assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /Failed to load extension|ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("standalone Prompt Autocomplete package is release-ready and discovers only its entrypoint", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-prompt-autocomplete-package-smoke-"));
  const packDir = join(tempRoot, "pack");
  const appDir = join(tempRoot, "app");
  const agentDir = join(tempRoot, "agent");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  try {
    const packOutput = run(
      npmCommand,
      ["pack", "--json", "--pack-destination", packDir],
      standalonePackageRoot,
    );
    const packResults = JSON.parse(packOutput) as Array<{
      filename: string;
      files: Array<{ path: string; size: number }>;
    }>;
    assert.equal(packResults.length, 1);

    const packed = packResults[0]!;
    const tarball = join(packDir, packed.filename);
    const packedPaths = packed.files.map((file) => file.path).sort();
    assert.deepEqual(packedPaths, [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "core.ts",
      "index.ts",
      "media/prompt-autocomplete-demo.mp4",
      "package.json",
      "system-prompt.template.md",
    ].sort());
    for (const requiredPath of [
      "README.md",
      "CHANGELOG.md",
      "core.ts",
      "index.ts",
      "media/prompt-autocomplete-demo.mp4",
      "system-prompt.template.md",
    ]) {
      const entry = packed.files.find((file) => file.path === requiredPath);
      assert.ok(entry && entry.size > 0, `${requiredPath} must be non-empty`);
    }

    run(npmCommand, [
      "install",
      "--ignore-scripts",
      "--offline",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ], appDir);

    const installedPackage = join(appDir, "node_modules", "@kliebhan", "pi-prompt-autocomplete");
    const installedManifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")) as {
      name: string;
      version: string;
      description: string;
      keywords: string[];
      scripts?: Record<string, string>;
      pi: { extensions: string[]; video: string };
      peerDependencies: Record<string, string>;
      publishConfig: { access: string; provenance: boolean };
      repository: { directory: string; url: string };
    };
    assert.equal(installedManifest.name, "@kliebhan/pi-prompt-autocomplete");
    assert.equal(installedManifest.version, standaloneManifest.version);
    assert.ok(installedManifest.description.length > 0);
    assert.ok(installedManifest.keywords.includes("pi-package"));
    assert.deepEqual(
      ["extension", "skill", "prompt", "theme"].filter((keyword) => installedManifest.keywords.includes(keyword)),
      ["extension"],
      "Gallery type keywords must match the extension-only manifest",
    );
    assert.deepEqual(installedManifest.pi.extensions, ["./index.ts"]);
    assert.match(installedManifest.pi.video, /^https:\/\//);
    assert.deepEqual(installedManifest.peerDependencies, {
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
    });
    assert.deepEqual(installedManifest.publishConfig, { access: "public", provenance: true });
    assert.equal(installedManifest.repository.directory, "extensions/prompt-autocomplete");
    assert.match(installedManifest.repository.url, /github\.com\/KLIEBHAN\/pi-extensions/);
    assert.equal(installedManifest.scripts, undefined, "published package must not run lifecycle scripts");
    assert.ok(readFileSync(join(installedPackage, "system-prompt.template.md"), "utf8").trim().length > 0);
    assert.ok(readFileSync(join(installedPackage, "media", "prompt-autocomplete-demo.mp4")).length > 0);

    const settingsManager = SettingsManager.inMemory({
      packages: [installedPackage],
      defaultProjectTrust: "never",
    });
    const loader = new DefaultResourceLoader({
      cwd: appDir,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const extensionResult = loader.getExtensions();
    assert.deepEqual(extensionResult.errors, []);
    assert.deepEqual(
      extensionResult.extensions.map((extension) =>
        relative(installedPackage, extension.resolvedPath).replaceAll("\\", "/")
      ),
      ["index.ts"],
    );

    const help = spawnSync(
      piCommand,
      ["--no-extensions", "-e", installedPackage, "--help"],
      {
        cwd: appDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: agentDir,
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          GEMINI_API_KEY: "",
        },
        timeout: 120_000,
        shell: process.platform === "win32",
      },
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--prompt-autocomplete\b/);
    assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /Failed to load extension|ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
