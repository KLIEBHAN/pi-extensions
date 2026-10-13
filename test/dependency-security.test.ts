import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface LockPackage {
  version?: string;
}

const projectRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8")) as {
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
};
const ciWorkflowSource = readFileSync(resolve(projectRoot, ".github", "workflows", "ci.yml"), "utf8");
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
    .map(([path, entry]) => {
      assert.match(entry.version!, /^\d+\.\d+\.\d+$/, `${path} must use a three-part numeric version`);
      return [path, entry.version!];
    });
}

/**
 * The full-tree audit command. `--include` outranks `--omit`, so an ambient
 * `NODE_ENV=production` or `npm_config_omit` cannot shrink the audited tree.
 */
const FULL_AUDIT_COMMAND = "npm audit --include=prod --include=dev --include=optional --include=peer";

test("CI audits the complete development and production dependency tree", () => {
  const workflow = parse(ciWorkflowSource) as {
    jobs?: Record<string, { steps?: Array<{ run?: unknown }> }>;
  };
  const releaseAudit = workflow.jobs?.["release-audit"];
  assert.ok(releaseAudit, "CI must define the release-audit job");
  assert.ok(Array.isArray(releaseAudit.steps), "release-audit must define steps");

  const commands = releaseAudit.steps
    .map((step) => step.run)
    .filter((command): command is string => typeof command === "string");
  const auditCommands = commands.filter(
    (command) => command.startsWith("npm audit") || command.includes("audit:dependencies"),
  );
  assert.deepEqual(auditCommands, ["npm run audit:dependencies"], "release-audit must run the full audit");
});

test("the audit script runs a full npm audit that cannot be narrowed", () => {
  const scripts = (JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }).scripts;

  // Without this the workflow assertion above could be satisfied by an npm
  // script that no longer audits the complete tree.
  assert.equal(scripts["audit:dependencies"], FULL_AUDIT_COMMAND);
  for (const weakening of ["--audit-level", "--omit", "--production", "--only=", "|| true", ";"]) {
    assert.ok(!scripts["audit:dependencies"]!.includes(weakening), `the audit must not be weakened with ${weakening}`);
  }
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
  assert.equal(lock.lockfileVersion, 3, "dependency path checks require npm lockfileVersion 3");
  assert.ok(
    lockedVersions("protobufjs").some(([path]) => path === "node_modules/protobufjs"),
    "root-level dependency entries must be included in advisory checks",
  );

  const vulnerableBraceExpansion = lockedVersions("brace-expansion").filter(([, version]) =>
    compareVersions(version, "3.0.0") >= 0 && compareVersions(version, "5.0.7") < 0
  );
  assert.deepEqual(
    vulnerableBraceExpansion,
    [],
    "package-lock.json must not contain versions affected by GHSA-3jxr-9vmj-r5cp",
  );

  const vulnerableProtobufjs = lockedVersions("protobufjs").filter(([, version]) =>
    compareVersions(version, "7.5.0") >= 0 && compareVersions(version, "7.6.4") <= 0
  );
  assert.deepEqual(
    vulnerableProtobufjs,
    [],
    "package-lock.json must not contain versions affected by GHSA-j3f2-48v5-ccww",
  );
});
