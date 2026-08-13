import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BELOW_BASELINE_PI_PROBE,
  MINIMUM_SUPPORTED_PI,
  SUPPORTED_PI_MATRIX,
} from "../scripts/prompt-autocomplete-support.mjs";

/**
 * Executable Pi host compatibility matrix.
 *
 * Pi's package model keeps core peers at `"*"` and installs without peer
 * solving, so support cannot be encoded in metadata. Instead, every supported
 * host version is installed here as a matched pi-ai/pi-coding-agent/pi-tui
 * triplet from the registry and must pass:
 *
 *  1. a discovery/load smoke through the real `pi` CLI, which exercises the
 *     jiti alias table including the pi-ai root-specifier mapping, and
 *  2. an editor/request lifecycle smoke that runs the packaged extension
 *     against that triplet's actual CustomEditor and pi-tui runtime.
 *
 * Requires registry access. Set PI_COMPAT_MATRIX=0 to skip locally when
 * offline; CI never sets it, so the matrix stays enforced there.
 */

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const standalonePackageRoot = join(projectRoot, "extensions", "prompt-autocomplete");
const fixturePath = join(projectRoot, "test", "fixtures", "pi-triplet-editor-smoke.ts");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const skipMatrix = process.env.PI_COMPAT_MATRIX === "0";
const npmInstallTimeoutMs = process.platform === "win32" ? 600_000 : 300_000;

const CORE_PACKAGES = ["pi-coding-agent", "pi-ai", "pi-tui"] as const;

/**
 * Windows CI timed out when the matrix and the below-baseline probe installed
 * triplets in parallel against one shared npm cache. Keep one install at a
 * time, and give each consumer its own cache directory.
 */
let npmInstallQueue = Promise.resolve();

function enqueueNpmInstall<T>(fn: () => T): Promise<T> {
  const run = npmInstallQueue.then(fn);
  npmInstallQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function removeTempTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

function packStandalone(packDir: string): string {
  mkdirSync(packDir, { recursive: true });
  const output = execFileSync(npmCommand, ["pack", "--json", "--pack-destination", packDir], {
    cwd: standalonePackageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    shell: process.platform === "win32",
  });
  const packed = JSON.parse(output) as Array<{ filename: string }>;
  assert.equal(packed.length, 1);
  return join(packDir, packed[0]!.filename);
}

function createConsumer(consumerDir: string, tarball: string, piVersion: string): string {
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "pi-compat-consumer", version: "0.0.0", private: true, type: "module" }),
    "utf8",
  );
  const npmCache = join(consumerDir, ".npm-cache");
  mkdirSync(npmCache, { recursive: true });

  const install = spawnSync(
    npmCommand,
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--loglevel=error",
      tarball,
      ...CORE_PACKAGES.map((name) => `@earendil-works/${name}@${piVersion}`),
    ],
    {
      cwd: consumerDir,
      encoding: "utf8",
      timeout: npmInstallTimeoutMs,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        npm_config_update_notifier: "false",
      },
    },
  );
  assert.equal(
    install.status,
    0,
    `installing the ${piVersion} triplet failed: status=${String(install.status)} signal=${String(install.signal)} error=${install.error?.message ?? ""} stderr=${install.stderr}`,
  );

  for (const name of CORE_PACKAGES) {
    const manifest = JSON.parse(
      readFileSync(join(consumerDir, "node_modules", "@earendil-works", name, "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(manifest.version, piVersion, `@earendil-works/${name} must be the requested ${piVersion}`);
  }

  return join(consumerDir, "node_modules", "@kliebhan", "pi-prompt-autocomplete");
}

function runDiscoverySmoke(consumerDir: string, installedPackage: string, agentDir: string): void {
  const piCommand = join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const help = spawnSync(piCommand, ["--no-extensions", "-e", installedPackage, "--help"], {
    cwd: consumerDir,
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
  });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--prompt-autocomplete\b/);
  assert.match(help.stdout, /--prompt-autocomplete-stream\s+<value>/);
  assert.doesNotMatch(`${help.stdout}\n${help.stderr}`, /Failed to load extension|ERR_MODULE_NOT_FOUND/);
}

function runEditorSmoke(consumerDir: string, installedPackage: string): void {
  const pkgDir = join(consumerDir, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  // Node refuses to strip types inside node_modules, so the shipped sources are
  // copied next to the harness; their pi imports still resolve against the
  // consumer's node_modules and therefore against the triplet under test.
  for (const file of ["index.ts", "core.ts", "system-prompt.template.md"]) {
    copyFileSync(join(installedPackage, file), join(pkgDir, file));
  }
  copyFileSync(fixturePath, join(consumerDir, "smoke.ts"));

  const smoke = spawnSync(process.execPath, ["--experimental-strip-types", "smoke.ts"], {
    cwd: consumerDir,
    encoding: "utf8",
    timeout: 120_000,
  });

  assert.equal(smoke.status, 0, `editor smoke failed:\n${smoke.stdout}\n${smoke.stderr}`);
  assert.match(smoke.stdout, /editor-smoke-ok/);
}

test("the support constants and the repository baseline agree", () => {
  assert.equal(SUPPORTED_PI_MATRIX[0], MINIMUM_SUPPORTED_PI, "the matrix must start at the documented minimum");
  assert.ok(
    [...SUPPORTED_PI_MATRIX].every((version, index, sorted) =>
      index === 0 ? true : sorted[index - 1]!.localeCompare(version, "en", { numeric: true }) < 0,
    ),
    "the matrix must be ascending",
  );

  const rootManifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  const devVersions = CORE_PACKAGES.map((name) => rootManifest.devDependencies[`@earendil-works/${name}`]);
  assert.equal(new Set(devVersions).size, 1, "the development triplet must be in lockstep");
  assert.ok(
    SUPPORTED_PI_MATRIX.includes(devVersions[0]!),
    `the development Pi version ${devVersions[0]} must be part of the supported matrix`,
  );

  const readme = readFileSync(join(standalonePackageRoot, "README.md"), "utf8");
  assert.ok(
    readme.includes(`Supported baseline: Pi \`${MINIMUM_SUPPORTED_PI}\``),
    "the README baseline must match the tested minimum",
  );
});

test("supported Pi host triplets pass discovery and editor lifecycle smokes", { skip: skipMatrix }, async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-compat-matrix-"));

  try {
    const tarball = packStandalone(join(tempRoot, "pack"));

    for (const piVersion of SUPPORTED_PI_MATRIX) {
      await t.test(`Pi ${piVersion}`, async () => {
        const consumerDir = join(tempRoot, `pi-${piVersion.replaceAll(".", "-")}`);
        const agentDir = join(consumerDir, "agent");
        mkdirSync(agentDir, { recursive: true });

        const installedPackage = await enqueueNpmInstall(() => createConsumer(consumerDir, tarball, piVersion));
        runDiscoverySmoke(consumerDir, installedPackage, agentDir);
        runEditorSmoke(consumerDir, installedPackage);
      });
    }
  } finally {
    removeTempTree(tempRoot);
  }
});

test("the below-baseline probe documents the current technical floor", { skip: skipMatrix }, async () => {
  // Pi 0.79 is below the supported baseline and carries no promise. It happens
  // to work today because the pre-split pi-ai root exported the simple
  // completion API directly. When this test starts failing, the documented
  // baseline has become the technical floor: convert both smokes into
  // expected-failure assertions that pin the failure mode; do not delete them.
  assert.ok(
    BELOW_BASELINE_PI_PROBE.localeCompare(MINIMUM_SUPPORTED_PI, "en", { numeric: true }) < 0,
    `the below-baseline probe ${BELOW_BASELINE_PI_PROBE} must be strictly lower than ${MINIMUM_SUPPORTED_PI}`,
  );
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-compat-probe-"));

  try {
    const tarball = packStandalone(join(tempRoot, "pack"));
    const consumerDir = join(tempRoot, "below-baseline");
    const agentDir = join(consumerDir, "agent");
    mkdirSync(agentDir, { recursive: true });

    const installedPackage = await enqueueNpmInstall(() =>
      createConsumer(consumerDir, tarball, BELOW_BASELINE_PI_PROBE),
    );
    runDiscoverySmoke(consumerDir, installedPackage, agentDir);
    runEditorSmoke(consumerDir, installedPackage);
  } finally {
    removeTempTree(tempRoot);
  }
});
