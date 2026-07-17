import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(root, "extensions", "prompt-autocomplete");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const packageSpec = `${manifest.name}@${manifest.version}`;

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function failCommand(label, result) {
  const output = commandOutput(result);
  throw new Error(`${label} failed${output ? `:\n${output}` : ""}`);
}

const registryResult = runNpm(["view", packageSpec, "dist.integrity", "--json"]);

if (registryResult.status === 0) {
  const registryIntegrity = JSON.parse(registryResult.stdout);
  assert.equal(typeof registryIntegrity, "string", `npm returned no integrity for ${packageSpec}`);

  const packDir = mkdtempSync(join(tmpdir(), "pi-prompt-autocomplete-release-check-"));
  try {
    const packResult = runNpm([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDir,
      packageRoot,
    ]);
    if (packResult.status !== 0) failCommand("npm pack", packResult);

    const packed = JSON.parse(packResult.stdout);
    assert.equal(packed.length, 1, "npm pack must produce exactly one artifact");
    const item = packed[0];
    assert.equal(item.name, manifest.name);
    assert.equal(item.version, manifest.version);

    const tarball = readFileSync(resolve(packDir, item.filename));
    const computedIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    assert.equal(item.integrity, computedIntegrity, "npm pack integrity does not match the tarball bytes");
    assert.equal(
      item.integrity,
      registryIntegrity,
      `${packageSpec} already exists with different bytes`,
    );

    console.log(`${packageSpec} already exists with the exact local integrity; publish dry-run skipped.`);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
} else {
  const viewOutput = commandOutput(registryResult);
  if (!/npm error code E404|"code"\s*:\s*"E404"/.test(viewOutput)) {
    failCommand(`npm view ${packageSpec}`, registryResult);
  }

  const dryRunResult = runNpm([
    "publish",
    "--dry-run",
    "--ignore-scripts",
    "--access",
    "public",
    "--provenance=false",
    packageRoot,
  ], { stdio: "inherit" });
  if (dryRunResult.status !== 0) failCommand("npm publish --dry-run", dryRunResult);
}
