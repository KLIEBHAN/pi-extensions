#!/usr/bin/env node
// Full dependency audit gate.
//
// Runs the same complete `npm audit` as before, including development
// dependencies, and then reconciles the report against an explicit exception
// list. The gate fails closed: every reported advisory must be declared, every
// declaration must still match what npm reports, and every declaration expires.
//
// It deliberately cannot express "ignore everything" or "ignore this severity".
// The only expressible statement is "this exact advisory, in this exact module,
// at these exact dependency paths, is accepted until this date".
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");
const exceptionsPath = resolve(projectRoot, ".github", "audit-exceptions.json");
const ADVISORY_URL_PREFIX = "https://github.com/advisories/";

function runAudit() {
  const result = spawnSync("npm", ["audit", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  // npm exits non-zero when advisories exist, which is the normal path here.
  // An unparsable report is not, and must never be treated as "no advisories".
  if (!result.stdout.trim()) {
    throw new Error(`npm audit produced no JSON report (exit ${result.status}): ${result.stderr.trim()}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm audit produced an unparsable JSON report: ${error.message}`);
  }

  if (report.auditReportVersion !== 2) {
    throw new Error(`unsupported npm audit report version ${report.auditReportVersion}; review this gate before upgrading npm`);
  }
  if (typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
    throw new Error("npm audit report contains no vulnerabilities section");
  }

  return report;
}

export function parseExceptions(parsed, source = exceptionsPath) {
  if (!Array.isArray(parsed.exceptions)) {
    throw new Error(`${source} must contain an "exceptions" array`);
  }

  const required = ["advisory", "module", "severity", "range", "paths", "reason", "acceptedOn", "reviewBy"];
  for (const entry of parsed.exceptions) {
    for (const field of required) {
      if (entry[field] === undefined) {
        throw new Error(`audit exception for ${entry.advisory ?? "(unknown advisory)"} is missing "${field}"`);
      }
    }
    if (!/^GHSA-[0-9a-z-]+$/.test(entry.advisory)) {
      throw new Error(`audit exception "${entry.advisory}" must reference a GHSA identifier`);
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new Error(`audit exception ${entry.advisory} must list the dependency paths it covers`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy)) {
      throw new Error(`audit exception ${entry.advisory} must set reviewBy as YYYY-MM-DD`);
    }
  }

  const byAdvisory = new Map();
  for (const entry of parsed.exceptions) {
    if (byAdvisory.has(entry.advisory)) {
      throw new Error(`audit exception ${entry.advisory} is declared more than once`);
    }
    byAdvisory.set(entry.advisory, entry);
  }
  return byAdvisory;
}

function advisoryIdFrom(via) {
  if (typeof via.url === "string" && via.url.startsWith(ADVISORY_URL_PREFIX)) {
    return via.url.slice(ADVISORY_URL_PREFIX.length);
  }
  return undefined;
}

/** Reconcile one reported advisory against its declaration. */
function checkAdvisory({ advisory, vulnerability, via, exceptions, matched, today, fail }) {
  const exception = exceptions.get(advisory);
  if (!exception) {
    fail(
      `undeclared advisory ${advisory} (${via.severity}) in ${vulnerability.name}: ${via.title ?? "no title"}\n` +
        `    paths: ${(vulnerability.nodes ?? []).join(", ") || "(none reported)"}\n` +
        "    Fix the dependency, or document an explicit exception in .github/audit-exceptions.json.",
    );
    return;
  }

  matched.add(advisory);

  if (exception.module !== vulnerability.name) {
    fail(`advisory ${advisory} now affects ${vulnerability.name}, but the exception covers ${exception.module}`);
  }
  if (exception.severity !== via.severity) {
    fail(`advisory ${advisory} is now ${via.severity}, but the exception was accepted as ${exception.severity}`);
  }
  if (via.range !== undefined && exception.range !== via.range) {
    fail(`advisory ${advisory} now covers ${via.range}, but the exception was accepted for ${exception.range}`);
  }

  // A new dependency path means the vulnerable code reached a place the
  // exception never assessed, so the exception no longer applies to it.
  const declared = new Set(exception.paths);
  const undeclared = (vulnerability.nodes ?? []).filter((node) => !declared.has(node));
  if (undeclared.length > 0) {
    fail(`advisory ${advisory} appears at undeclared paths: ${undeclared.join(", ")}`);
  }

  if (exception.reviewBy < today) {
    fail(
      `audit exception ${advisory} expired on ${exception.reviewBy}. Re-check the upstream fix ` +
        `(${exception.upstreamFix ?? "no upstream reference recorded"}) and either remove or renew it.`,
    );
  }
}

/**
 * Compare a parsed audit report against the declared exceptions.
 *
 * Pure so the fail-closed behaviour can be proven offline against synthetic
 * reports instead of only against whatever the registry reports today.
 * Returns the matched advisories and every reason the gate should fail.
 */
export function reconcileAudit(report, exceptions, today) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const vulnerabilities = Object.values(report.vulnerabilities ?? {});
  const matched = new Set();

  for (const vulnerability of vulnerabilities) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === "string") {
        // An effect of another vulnerable package. It is only covered because
        // that package is itself reported and checked in this same loop.
        if (!report.vulnerabilities[via]) {
          fail(`${vulnerability.name} is reported as affected via ${via}, which npm did not report separately`);
        }
        continue;
      }

      const advisory = advisoryIdFrom(via);
      if (!advisory) {
        fail(`advisory for ${vulnerability.name} has no GitHub advisory URL and cannot be reconciled: ${JSON.stringify(via)}`);
        continue;
      }

      checkAdvisory({ advisory, vulnerability, via, exceptions, matched, today, fail });
    }
  }

  // A declaration that matches nothing is stale: it either was fixed upstream
  // or no longer describes reality, and must not keep silently granting cover.
  for (const advisory of exceptions.keys()) {
    if (!matched.has(advisory)) {
      fail(`audit exception ${advisory} no longer matches any reported advisory and must be removed`);
    }
  }

  return { failures, matched };
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = parseExceptions(JSON.parse(readFileSync(exceptionsPath, "utf8")));
  const report = runAudit();
  const { failures, matched } = reconcileAudit(report, exceptions, today);

  const totals = report.metadata?.vulnerabilities ?? {};
  if (failures.length > 0) {
    console.error("Dependency audit failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(`\nReported advisories: ${totals.total ?? "unknown"}. See docs/dependency-audit.md.`);
    process.exit(1);
  }

  if (matched.size === 0) {
    console.log("Dependency audit passed with no advisories.");
    return;
  }

  console.log(`Dependency audit passed with ${matched.size} documented exception(s):`);
  for (const advisory of matched) {
    const exception = exceptions.get(advisory);
    console.log(`  - ${advisory} (${exception.severity}) in ${exception.module}, pinned by ${exception.pinnedBy ?? "an upstream package"}, review by ${exception.reviewBy}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
