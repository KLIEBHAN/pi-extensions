import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("the audit script is the command CI actually runs", () => {
  const scripts = (JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }).scripts;

  // Without this the workflow assertion above could be satisfied by an npm
  // script that no longer audits anything.
  assert.equal(scripts["audit:dependencies"], "node scripts/audit-dependencies.mjs");
});

test("the audit gate runs a full audit and cannot be narrowed", () => {
  assert.match(auditGateSource, /"audit",\s*"--json"/, "the gate must run npm audit as JSON");
  for (const dependencyClass of ["prod", "dev", "optional", "peer"]) {
    assert.ok(
      auditGateSource.includes(`"--include=${dependencyClass}"`),
      `the gate must audit ${dependencyClass} dependencies explicitly`,
    );
  }

  for (const weakening of ["--audit-level", "--omit", "--production", "--only=prod"]) {
    assert.ok(
      !auditGateSource.includes(weakening),
      `the gate must not narrow npm audit with ${weakening}`,
    );
  }

  // Ambient npm configuration must not be able to shrink the audited tree.
  assert.match(auditGateSource, /npm_config_omit/i);

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
  upstreamFix: "Requires the upstream package to raise its shrinkwrapped version.",
  acceptedOn: "2026-07-25",
  reviewBy: "2026-09-05",
};

// Fixed so the suite does not start failing as real time passes the dates above.
const TODAY = "2026-07-26";

function declared(overrides: Record<string, unknown> = {}) {
  return parseExceptions({ exceptions: [{ ...ACCEPTED, ...overrides }] }, "test", TODAY);
}

function vulnerability(overrides: Record<string, unknown> = {}) {
  return {
    name: "brace-expansion",
    severity: "high",
    via: [
      {
        url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
        title: "DoS via unbounded expansion",
        name: "brace-expansion",
        dependency: "brace-expansion",
        severity: "high",
        range: "<=5.0.7",
      },
    ],
    nodes: [...ACCEPTED.paths],
    ...overrides,
  };
}

function reconcile(
  vulnerabilities: Record<string, unknown>,
  exceptions = declared(),
  today = TODAY,
  total?: number,
  severities: { high?: number; critical?: number } = {},
) {
  return reconcileAudit(
    {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: severities.high ?? Object.keys(vulnerabilities).length,
          critical: severities.critical ?? 0,
          total: total ?? Object.keys(vulnerabilities).length,
        },
      },
    },
    exceptions,
    today,
  );
}

test("the audit gate accepts exactly the documented advisory", () => {
  const { failures, matched } = reconcile({ "brace-expansion": vulnerability() });

  assert.deepEqual(failures, []);
  assert.deepEqual([...matched], ["GHSA-mh99-v99m-4gvg"]);
});

test("the audit gate rejects an advisory that was never declared", () => {
  const { failures } = reconcile({
    "brace-expansion": vulnerability({
      via: [
        {
          url: "https://github.com/advisories/GHSA-2222-3333-4444",
          severity: "critical",
          range: "<=9.9.9",
        },
      ],
    }),
  });

  assert.match(failures.join("\n"), /undeclared advisory GHSA-2222-3333-4444/);
  assert.match(failures.join("\n"), /no longer matches any reported advisory/);
});

test("the audit gate rejects a vulnerability that identifies no advisory", () => {
  // The shape an undeclared vulnerability takes if a gate only iterates the
  // advisories it can read: an entry with no via at all.
  for (const shape of [{ via: undefined }, { via: [] }]) {
    const { failures } = reconcile({
      "brace-expansion": vulnerability(),
      evil: { name: "evil", severity: "critical", nodes: ["node_modules/evil"], ...shape },
    });

    assert.match(failures.join("\n"), /evil \(critical\) is reported as vulnerable but identifies no advisory/);
  }
});

test("the audit gate rejects a vulnerability chain no exception covers", () => {
  const { failures } = reconcile({
    "brace-expansion": vulnerability(),
    dependent: { name: "dependent", severity: "high", via: ["brace-expansion"], nodes: ["node_modules/dependent"] },
  });

  assert.match(failures.join("\n"), /dependent is vulnerable through brace-expansion, which no exception covers/);
});

test("the audit gate accepts a chain only when the exception names the dependent", () => {
  const { failures } = reconcile(
    {
      "brace-expansion": vulnerability(),
      dependent: { name: "dependent", severity: "high", via: ["brace-expansion"], nodes: ["node_modules/dependent"] },
    },
    declared({ effects: ["dependent"] }),
  );

  assert.deepEqual(failures, []);
});

test("the audit gate rejects a report whose own count disagrees with its entries", () => {
  const { failures } = reconcile({ "brace-expansion": vulnerability() }, declared(), "2026-07-26", 5);

  assert.match(failures.join("\n"), /npm reported 5 vulnerabilities but described 1/);
});

test("the audit gate rejects an advisory reported without reconcilable evidence", () => {
  const noRange = reconcile({
    "brace-expansion": vulnerability({
      via: [{ url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg", severity: "high" }],
    }),
  });
  assert.match(noRange.failures.join("\n"), /without an affected range/);

  const noPaths = reconcile({ "brace-expansion": vulnerability({ nodes: [] }) });
  assert.match(noPaths.failures.join("\n"), /without any dependency path/);
});

test("the audit gate rejects an advisory URL that only looks like GitHub's", () => {
  const { failures } = reconcile({
    "brace-expansion": vulnerability({
      via: [
        {
          url: "https://evil.example/advisories/GHSA-mh99-v99m-4gvg",
          severity: "high",
          range: "<=5.0.7",
        },
      ],
    }),
  });

  assert.match(failures.join("\n"), /no usable GitHub advisory URL/);
});

test("the audit gate rejects a declaration that no longer matches any advisory", () => {
  const { failures } = reconcile({});

  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /GHSA-mh99-v99m-4gvg no longer matches any reported advisory/);
});

test("the audit gate rejects an expired declaration", () => {
  const { failures } = reconcile({ "brace-expansion": vulnerability() }, declared(), "2026-09-06");

  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /expired on 2026-09-05/);
});

test("the audit gate requires the declared paths to match the reported paths exactly", () => {
  const added = reconcile({
    "brace-expansion": vulnerability({ nodes: [...ACCEPTED.paths, "node_modules/brace-expansion"] }),
  });
  assert.match(added.failures.join("\n"), /undeclared paths: node_modules\/brace-expansion/);

  // A path that is declared but no longer reported would pre-authorise a future
  // move back into it without review.
  const surplus = reconcile(
    { "brace-expansion": vulnerability() },
    declared({ paths: [...ACCEPTED.paths, "node_modules/brace-expansion"] }),
  );
  assert.match(surplus.failures.join("\n"), /declares paths that are no longer reported/);
});

test("the audit gate rejects an advisory that grew in severity or range", () => {
  const escalated = reconcile({ "brace-expansion": vulnerability() }, declared({ severity: "moderate" }));
  assert.match(escalated.failures.join("\n"), /now high, but the exception was accepted as moderate/);

  const widened = reconcile({ "brace-expansion": vulnerability() }, declared({ range: "<=5.0.6" }));
  assert.match(widened.failures.join("\n"), /now covers <=5\.0\.7, but the exception was accepted for <=5\.0\.6/);
});

test("an exception cannot be declared broadly, vaguely, or indefinitely", () => {
  assert.throws(() => declared({ reason: undefined }), /must set "reason"/);
  assert.throws(() => declared({ reason: "" }), /must set "reason"/);
  assert.throws(() => declared({ module: "  " }), /must set "module"/);
  assert.throws(() => declared({ paths: [] }), /must list the dependency paths/);
  assert.throws(() => declared({ paths: ["node_modules/*"] }), /must not use wildcard paths/);
  assert.throws(() => declared({ paths: ["../etc"] }), /must use lockfile dependency paths/);
  assert.throws(() => declared({ advisory: "CVE-2026-1" }), /canonical GHSA identifier/);
  assert.throws(() => declared({ advisory: "GHSA-new-advisory" }), /canonical GHSA identifier/);
  assert.throws(() => declared({ reviewBy: "soon" }), /real YYYY-MM-DD date/);
  // A shape-valid but impossible date would otherwise defer review forever.
  assert.throws(() => declared({ reviewBy: "9999-99-99" }), /real YYYY-MM-DD date/);
  assert.throws(() => declared({ reviewBy: "2026-07-24" }), /must be reviewed after it was accepted/);
  assert.throws(() => declared({ reviewBy: "3026-07-25" }), /the maximum is 120/);
});

// Executing the gate as CI does, with npm stubbed, proves the command really
// audits and really fails. A gate whose CLI entry point were removed would
// exit 0 here while every offline reconciliation test still passed.
function runGateWithStubbedNpm(report: unknown): { status: number | null; output: string } {
  const stubDir = mkdtempSync(join(tmpdir(), "audit-gate-stub-"));
  try {
    const reportPath = join(stubDir, "report.json");
    writeFileSync(reportPath, JSON.stringify(report));
    const npmStub = join(stubDir, "npm");
    // Exit 1 like npm does when advisories exist.
    writeFileSync(npmStub, `#!/bin/sh\ncat ${JSON.stringify(reportPath)}\nexit 1\n`);
    chmodSync(npmStub, 0o755);

    const result = spawnSync(process.execPath, [resolve(projectRoot, "scripts", "audit-dependencies.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

// The stub is a POSIX shell script, so these run only where the release-audit
// job itself runs. CI executes the full suite on Windows too.
const posixOnly = { skip: process.platform === "win32" ? "requires a POSIX shell stub" : false };

test("the audit gate command fails on an undeclared advisory", posixOnly, () => {
  const { status, output } = runGateWithStubbedNpm({
    auditReportVersion: 2,
    vulnerabilities: {
      "totally-undeclared": {
        name: "totally-undeclared",
        severity: "critical",
        via: [
          {
            url: "https://github.com/advisories/GHSA-2222-3333-4444",
            title: "synthetic advisory",
            severity: "critical",
            range: "<=1.0.0",
          },
        ],
        nodes: ["node_modules/totally-undeclared"],
      },
    },
    metadata: { vulnerabilities: { total: 1 } },
  });

  assert.equal(status, 1, "an undeclared advisory must fail the gate command");
  assert.match(output, /undeclared advisory GHSA-2222-3333-4444/);
});

test("the audit gate command fails when npm reports a failure it cannot describe", posixOnly, () => {
  const { status, output } = runGateWithStubbedNpm({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { total: 0 } },
  });

  // npm exited non-zero, so an empty report is a broken audit, not a clean tree.
  assert.equal(status, 1);
  assert.match(output, /without reporting any vulnerability/);
});

test("an effect never validates a declaration on its own", () => {
  // The source package is reported but carries no reconcilable advisory, so the
  // declaration has no evidence behind it and the effect must not supply it.
  const { failures } = reconcile(
    {
      "brace-expansion": { name: "brace-expansion", severity: "high", via: [], nodes: [...ACCEPTED.paths] },
      dependent: { name: "dependent", severity: "critical", via: ["brace-expansion"], nodes: ["node_modules/dependent"] },
    },
    declared({ effects: ["dependent"] }),
  );

  assert.match(failures.join("\n"), /claims cover from GHSA-mh99-v99m-4gvg, but that advisory was not reconciled/);
});

test("a self-referential effect cannot stand in for an advisory", () => {
  const { failures } = reconcile(
    {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "critical",
        via: ["brace-expansion"],
        nodes: ["node_modules/anywhere"],
      },
    },
    declared({ effects: ["brace-expansion"] }),
    "2027-12-31",
  );

  assert.match(failures.join("\n"), /affected via itself/);
});

test("an inherited property cannot pose as a reported package", () => {
  const { failures } = reconcile(
    { victim: { name: "victim", severity: "critical", via: ["constructor"], nodes: ["node_modules/victim"] } },
    declared({ module: "constructor", effects: ["victim"] }),
  );

  assert.match(failures.join("\n"), /via constructor, which npm did not report separately/);
});

test("the audit gate rejects a report whose key disagrees with the package name", () => {
  const { failures } = reconcile({ innocent: vulnerability() });

  assert.match(failures.join("\n"), /reported "brace-expansion" under the key "innocent"/);
});

test("the audit gate rejects a report that states no vulnerability count", () => {
  const { failures } = reconcileAudit(
    { auditReportVersion: 2, vulnerabilities: { "brace-expansion": vulnerability() }, metadata: {} },
    declared(),
    TODAY,
  );

  assert.match(failures.join("\n"), /does not state how many vulnerabilities it found/);
});

test("an exception cannot be future-dated to escape the review deadline", () => {
  // Moving both dates forward would otherwise satisfy the 120-day cap while
  // deferring the actual review indefinitely.
  assert.throws(
    () => declared({ acceptedOn: "3026-01-01", reviewBy: "3026-04-01" }),
    /accepted on 3026-01-01, which is in the future/,
  );
});

test("an exception must record what would retire it", () => {
  assert.throws(() => declared({ upstreamFix: undefined }), /must set "upstreamFix"/);
});

test("the audit gate rejects a package severity its advisories do not account for", () => {
  // A truncated report could otherwise signal a critical finding in the
  // aggregate while describing only the accepted high advisory.
  const { failures } = reconcile(
    { "brace-expansion": vulnerability({ severity: "critical" }) },
    declared(),
    TODAY,
    1,
    { high: 0, critical: 1 },
  );

  assert.match(failures.join("\n"), /reported as critical but its advisories account for at most high/);
});

test("the audit gate rejects severity buckets that disagree with the total", () => {
  const { failures } = reconcile({ "brace-expansion": vulnerability() }, declared(), TODAY, 1, {
    high: 1,
    critical: 1,
  });

  assert.match(failures.join("\n"), /1 vulnerabilities but 2 across its severity buckets/);
});

test("the audit gate rejects an advisory naming a package other than its own", () => {
  const { failures } = reconcile({
    "brace-expansion": vulnerability({
      via: [
        {
          url: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
          name: "some-other-package",
          severity: "high",
          range: "<=5.0.7",
        },
      ],
    }),
  });

  assert.match(failures.join("\n"), /reports name "some-other-package" under brace-expansion/);
});
