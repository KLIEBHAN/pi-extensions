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
const auditGateSource = readFileSync(resolve(projectRoot, "scripts", "audit-dependencies.mjs"), "utf8");
const auditExceptions = JSON.parse(
  readFileSync(resolve(projectRoot, ".github", "audit-exceptions.json"), "utf8"),
) as {
  exceptions: Array<{
    advisory: string;
    module: string;
    severity: string;
    range: string;
    paths: string[];
    reason: string;
    acceptedOn: string;
    reviewBy: string;
  }>;
};

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
  assert.deepEqual(
    auditCommands,
    ["npm run audit:dependencies"],
    "release-audit must run exactly the reconciling audit gate",
  );
});

test("the audit gate runs a full audit and cannot be narrowed", () => {
  assert.match(
    auditGateSource,
    /"npm",\s*\["audit",\s*"--json"\]/,
    "the gate must run a complete npm audit",
  );

  for (const weakening of ["--audit-level", "--omit", "--production", "--only=prod"]) {
    assert.ok(
      !auditGateSource.includes(weakening),
      `the gate must not narrow npm audit with ${weakening}`,
    );
  }

  // An unreadable or unexpected report must fail rather than be read as "clean".
  assert.match(auditGateSource, /auditReportVersion !== 2/);
  assert.match(auditGateSource, /unparsable JSON report/);
  assert.match(auditGateSource, /undeclared advisory/);
  assert.match(auditGateSource, /no longer matches any reported advisory/);
});

test("every audit exception is narrow, justified, and time-boxed", () => {
  assert.ok(Array.isArray(auditExceptions.exceptions), "the exception file must declare an array");

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();

  for (const exception of auditExceptions.exceptions) {
    assert.match(exception.advisory, /^GHSA-[0-9a-z-]+$/, "an exception must name one GHSA advisory");
    assert.ok(!seen.has(exception.advisory), `${exception.advisory} is declared more than once`);
    seen.add(exception.advisory);

    assert.ok(exception.module.length > 0, `${exception.advisory} must name the affected module`);
    assert.ok(exception.range.length > 0, `${exception.advisory} must record the accepted range`);
    assert.ok(
      Array.isArray(exception.paths) && exception.paths.length > 0,
      `${exception.advisory} must list the dependency paths it covers`,
    );
    for (const path of exception.paths) {
      assert.match(path, /^node_modules\//, `${exception.advisory} must use lockfile dependency paths`);
      assert.ok(!path.includes("*"), `${exception.advisory} must not use wildcard paths`);
    }

    // The justification is the whole point of the exception, so it must be substantive.
    assert.ok(
      exception.reason.length >= 80,
      `${exception.advisory} must explain why the vulnerable version cannot be raised here`,
    );

    assert.match(exception.acceptedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(exception.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(
      exception.reviewBy > exception.acceptedOn,
      `${exception.advisory} must be reviewed after it was accepted`,
    );
    assert.ok(
      exception.reviewBy >= today,
      `${exception.advisory} expired on ${exception.reviewBy} and must be renewed or removed`,
    );
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

// The reconciliation is exercised directly so fail-closed behaviour is proven
// against synthetic reports rather than against whatever the registry happens
// to report on the day CI runs.
const { parseExceptions, reconcileAudit } = await import("../scripts/audit-dependencies.mjs");

const ACCEPTED = {
  advisory: "GHSA-mh99-v99m-4gvg",
  module: "brace-expansion",
  severity: "high",
  range: "<=5.0.7",
  paths: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
  reason: "x".repeat(80),
  acceptedOn: "2026-07-25",
  reviewBy: "2026-09-05",
};

function declared(overrides: Record<string, unknown> = {}) {
  return parseExceptions({ exceptions: [{ ...ACCEPTED, ...overrides }] }, "test");
}

function reportFor(overrides: Record<string, unknown> = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "high",
        via: [
          {
            url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
            title: "DoS via unbounded expansion",
            severity: "high",
            range: "<=5.0.7",
          },
        ],
        range: "<=5.0.7",
        nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"],
        ...overrides,
      },
    },
    metadata: { vulnerabilities: { total: 1 } },
  };
}

test("the audit gate accepts exactly the documented advisory", () => {
  const { failures, matched } = reconcileAudit(reportFor(), declared(), "2026-07-26");

  assert.deepEqual(failures, []);
  assert.deepEqual([...matched], ["GHSA-mh99-v99m-4gvg"]);
});

test("the audit gate rejects an advisory that was never declared", () => {
  const report = reportFor();
  report.vulnerabilities["brace-expansion"].via[0].url = "https://github.com/advisories/GHSA-new-advisory";

  const { failures } = reconcileAudit(report, declared(), "2026-07-26");

  assert.equal(failures.length, 2, "the new advisory is undeclared and the declaration is now stale");
  assert.match(failures[0] ?? "", /undeclared advisory GHSA-new-advisory/);
  assert.match(failures[1] ?? "", /no longer matches any reported advisory/);
});

test("the audit gate rejects a declaration that no longer matches any advisory", () => {
  const { failures } = reconcileAudit(
    { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } },
    declared(),
    "2026-07-26",
  );

  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /GHSA-mh99-v99m-4gvg no longer matches any reported advisory/);
});

test("the audit gate rejects an expired declaration", () => {
  const { failures } = reconcileAudit(reportFor(), declared(), "2026-09-06");

  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /expired on 2026-09-05/);
});

test("the audit gate rejects the same advisory reaching a new dependency path", () => {
  const { failures } = reconcileAudit(
    reportFor({ nodes: [...ACCEPTED.paths, "node_modules/brace-expansion"] }),
    declared(),
    "2026-07-26",
  );

  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /undeclared paths: node_modules\/brace-expansion/);
});

test("the audit gate rejects an advisory that grew in severity or range", () => {
  const escalated = reconcileAudit(reportFor(), declared({ severity: "moderate" }), "2026-07-26");
  assert.match(escalated.failures[0] ?? "", /now high, but the exception was accepted as moderate/);

  const widened = reconcileAudit(reportFor(), declared({ range: "<=5.0.6" }), "2026-07-26");
  assert.match(widened.failures[0] ?? "", /now covers <=5\.0\.7, but the exception was accepted for <=5\.0\.6/);
});

test("the audit gate rejects an advisory it cannot identify", () => {
  const report = reportFor();
  report.vulnerabilities["brace-expansion"].via = [{ title: "no advisory url", severity: "high" }];

  const { failures } = reconcileAudit(report, declared(), "2026-07-26");

  assert.match(failures[0] ?? "", /has no GitHub advisory URL and cannot be reconciled/);
});

test("an exception cannot be declared without a justification or a review date", () => {
  assert.throws(() => declared({ reason: undefined }), /missing "reason"/);
  assert.throws(() => declared({ reviewBy: undefined }), /missing "reviewBy"/);
  assert.throws(() => declared({ paths: [] }), /must list the dependency paths/);
  assert.throws(() => declared({ advisory: "CVE-2026-1" }), /must reference a GHSA identifier/);
  assert.throws(() => declared({ reviewBy: "soon" }), /must set reviewBy as YYYY-MM-DD/);
});
