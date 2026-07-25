#!/usr/bin/env node
// Full dependency audit gate.
//
// Runs a complete `npm audit`, development dependencies included, and
// reconciles the report against an explicit exception list. The gate fails
// closed: every reported vulnerability must be accounted for, every
// declaration must still match what npm reports, and every declaration
// expires.
//
// It deliberately cannot express "ignore everything" or "ignore this
// severity". The only expressible statement is "this exact advisory, in this
// exact module, at exactly these dependency paths, is accepted until this
// date".
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "..");
const exceptionsPath = resolve(projectRoot, ".github", "audit-exceptions.json");
const ADVISORY_URL_PREFIX = "https://github.com/advisories/";
// GitHub advisory identifiers use a fixed three-block base32 alphabet.
const ADVISORY_ID_PATTERN = /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/;
// An exception is a deferral, not a decision to live with the risk.
const MAX_EXCEPTION_DAYS = 120;

function runAudit() {
  // npm reads omit/include settings from the environment and from .npmrc, so a
  // stray NPM_CONFIG_OMIT would silently shrink the audited tree. The classes
  // are requested explicitly and the ambient override is removed.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_omit$/i.test(key)) delete env[key];
  }

  const result = spawnSync(
    "npm",
    ["audit", "--json", "--include=prod", "--include=dev", "--include=optional", "--include=peer"],
    { cwd: projectRoot, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.error) throw result.error;
  // npm exits non-zero when advisories exist, which is the normal path here.
  // An unparsable report is not, and must never be read as "no advisories".
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
  // A non-zero audit that reports nothing means the report does not describe
  // the failure, so the gate must not conclude the tree is clean.
  if (result.status !== 0 && Object.keys(report.vulnerabilities).length === 0) {
    throw new Error(`npm audit failed (exit ${result.status}) without reporting any vulnerability: ${result.stderr.trim()}`);
  }

  return report;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // Rejects impossible calendar dates such as 9999-99-99, which pass the shape
  // check but would otherwise defer the deadline indefinitely.
  return parsed.toISOString().slice(0, 10) === value ? parsed : undefined;
}

export function parseExceptions(parsed, source = exceptionsPath) {
  if (!Array.isArray(parsed.exceptions)) {
    throw new Error(`${source} must contain an "exceptions" array`);
  }

  const byAdvisory = new Map();
  for (const entry of parsed.exceptions) {
    const id = typeof entry?.advisory === "string" ? entry.advisory : "(unknown advisory)";

    if (!ADVISORY_ID_PATTERN.test(id)) {
      throw new Error(`audit exception "${id}" must reference a canonical GHSA identifier`);
    }
    for (const field of ["module", "severity", "range", "reason", "acceptedOn", "reviewBy"]) {
      if (!isNonEmptyString(entry[field])) {
        throw new Error(`audit exception ${id} must set "${field}" to a non-empty string`);
      }
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
      throw new Error(`audit exception ${id} must list the dependency paths it covers`);
    }
    for (const path of entry.paths) {
      if (!isNonEmptyString(path) || !path.startsWith("node_modules/")) {
        throw new Error(`audit exception ${id} must use lockfile dependency paths, got ${JSON.stringify(path)}`);
      }
      if (path.includes("*")) {
        throw new Error(`audit exception ${id} must not use wildcard paths`);
      }
    }
    if (entry.effects !== undefined) {
      if (!Array.isArray(entry.effects) || !entry.effects.every(isNonEmptyString)) {
        throw new Error(`audit exception ${id} must declare "effects" as package names`);
      }
    }

    const acceptedOn = parseIsoDate(entry.acceptedOn);
    const reviewBy = parseIsoDate(entry.reviewBy);
    if (!acceptedOn) throw new Error(`audit exception ${id} must set acceptedOn to a real YYYY-MM-DD date`);
    if (!reviewBy) throw new Error(`audit exception ${id} must set reviewBy to a real YYYY-MM-DD date`);
    if (reviewBy <= acceptedOn) {
      throw new Error(`audit exception ${id} must be reviewed after it was accepted`);
    }

    const lifetimeDays = Math.round((reviewBy - acceptedOn) / 86_400_000);
    if (lifetimeDays > MAX_EXCEPTION_DAYS) {
      throw new Error(
        `audit exception ${id} defers review by ${lifetimeDays} days; the maximum is ${MAX_EXCEPTION_DAYS}`,
      );
    }

    if (byAdvisory.has(id)) throw new Error(`audit exception ${id} is declared more than once`);
    byAdvisory.set(id, entry);
  }

  return byAdvisory;
}

function advisoryIdFrom(via) {
  if (typeof via.url !== "string" || !via.url.startsWith(ADVISORY_URL_PREFIX)) return undefined;
  const id = via.url.slice(ADVISORY_URL_PREFIX.length);
  return ADVISORY_ID_PATTERN.test(id) ? id : undefined;
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

  // A declaration is only meaningful against evidence, so an advisory that
  // arrives without a range or without paths cannot be reconciled at all.
  if (!isNonEmptyString(via.range)) {
    fail(`advisory ${advisory} was reported without an affected range and cannot be reconciled`);
  } else if (exception.range !== via.range) {
    fail(`advisory ${advisory} now covers ${via.range}, but the exception was accepted for ${exception.range}`);
  }

  const reported = vulnerability.nodes ?? [];
  if (reported.length === 0) {
    fail(`advisory ${advisory} was reported without any dependency path and cannot be reconciled`);
  } else {
    // Exact scope in both directions: a new path was never assessed, and a
    // declared path that is no longer reported would silently pre-authorise a
    // future move back into it.
    const declared = new Set(exception.paths);
    const observed = new Set(reported);
    const undeclared = [...observed].filter((node) => !declared.has(node));
    const unused = [...declared].filter((node) => !observed.has(node));
    if (undeclared.length > 0) {
      fail(`advisory ${advisory} appears at undeclared paths: ${undeclared.join(", ")}`);
    }
    if (unused.length > 0) {
      fail(`audit exception ${advisory} declares paths that are no longer reported: ${unused.join(", ")}`);
    }
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
 * Pure so the fail-closed paths can be proven offline against synthetic
 * reports instead of only against whatever the registry reports today.
 * Returns the matched advisories and every reason the gate should fail.
 */
export function reconcileAudit(report, exceptions, today) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const vulnerabilities = Object.values(report.vulnerabilities ?? {});
  const matched = new Set();

  // npm's own count must agree with the entries present, otherwise the report
  // is truncated or malformed and cannot be reconciled.
  const reportedTotal = report.metadata?.vulnerabilities?.total;
  if (typeof reportedTotal === "number" && reportedTotal !== vulnerabilities.length) {
    fail(`npm reported ${reportedTotal} vulnerabilities but described ${vulnerabilities.length}`);
  }

  for (const vulnerability of vulnerabilities) {
    const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];
    // Every entry must be positively accounted for. An entry that identifies no
    // advisory is the shape an undeclared vulnerability would take if the gate
    // only iterated the advisories it could read.
    let accounted = false;

    for (const entry of via) {
      if (typeof entry === "string") {
        // An effect of another vulnerable package. It is only covered when the
        // exception for that package names this one, so a new dependent forces
        // a fresh decision rather than inheriting cover.
        if (!report.vulnerabilities[entry]) {
          fail(`${vulnerability.name} is reported as affected via ${entry}, which npm did not report separately`);
          continue;
        }
        const cover = [...exceptions.values()].find(
          (exception) => exception.module === entry && (exception.effects ?? []).includes(vulnerability.name),
        );
        if (!cover) {
          fail(
            `${vulnerability.name} is vulnerable through ${entry}, which no exception covers for this dependent. ` +
              `Declare it in the "effects" of the ${entry} exception, or fix the dependency.`,
          );
          continue;
        }
        matched.add(cover.advisory);
        accounted = true;
        continue;
      }

      const advisory = advisoryIdFrom(entry);
      if (!advisory) {
        fail(`advisory for ${vulnerability.name} has no usable GitHub advisory URL and cannot be reconciled: ${JSON.stringify(entry)}`);
        continue;
      }

      checkAdvisory({ advisory, vulnerability, via: entry, exceptions, matched, today, fail });
      accounted = true;
    }

    if (!accounted) {
      fail(
        `${vulnerability.name} (${vulnerability.severity ?? "unknown severity"}) is reported as vulnerable but ` +
          "identifies no advisory this gate can reconcile",
      );
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
