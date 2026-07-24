import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

interface LockPackage {
  version?: string;
}

const projectRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, LockPackage>;
};
const ciWorkflow = readFileSync(resolve(projectRoot, ".github", "workflows", "ci.yml"), "utf8");

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function lockedVersions(packageName: string): Array<[path: string, version: string]> {
  const rootPath = `node_modules/${packageName}`;
  return Object.entries(lock.packages)
    .filter(([path, entry]) =>
      (path === rootPath || path.endsWith(`/${rootPath}`)) && typeof entry.version === "string"
    )
    .map(([path, entry]) => [path, entry.version!]);
}

test("CI audits the complete development and production dependency tree", () => {
  assert.match(ciWorkflow, /\n\s+- run: npm audit\s*(?:\n|$)/);
  assert.doesNotMatch(ciWorkflow, /npm audit[^\n]*--omit(?:=|\s+)dev/);
});

test("Pi development packages stay on one exact version", () => {
  const packageNames = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  const versions = packageNames.map((packageName) => manifest.devDependencies[packageName]);
  assert.ok(versions.every((version) => /^\d+\.\d+\.\d+$/.test(version)), "Pi packages must use exact versions");
  assert.equal(new Set(versions).size, 1, "Pi packages must be upgraded together");

  for (const [index, packageName] of packageNames.entries()) {
    assert.equal(lock.packages[`node_modules/${packageName}`]?.version, versions[index]);
  }
});

test("lockfile excludes the resolved brace-expansion and protobufjs advisory ranges", () => {
  assert.ok(
    lockedVersions("protobufjs").some(([path]) => path === "node_modules/protobufjs"),
    "root-level dependency entries must be included in advisory checks",
  );

  const vulnerableBraceExpansion = lockedVersions("brace-expansion").filter(([, version]) =>
    compareVersions(version, "3.0.0") >= 0 && compareVersions(version, "5.0.7") < 0
  );
  assert.deepEqual(vulnerableBraceExpansion, [], "GHSA-3jxr-9vmj-r5cp remains in package-lock.json");

  const vulnerableProtobufjs = lockedVersions("protobufjs").filter(([, version]) =>
    compareVersions(version, "7.5.0") >= 0 && compareVersions(version, "7.6.4") <= 0
  );
  assert.deepEqual(vulnerableProtobufjs, [], "GHSA-j3f2-48v5-ccww remains in package-lock.json");
});
