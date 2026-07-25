# Dependency audit

CI audits the complete dependency tree, development dependencies included. The repository toolchain executes during CI and release builds, so a production-only audit would leave that trusted path unchecked.

This gate exists because of a specific upstream situation, not as permanent infrastructure. **When the exception list is empty and no new exception is expected, replace the gate with a bare `npm audit` step and delete it.** Reconciliation logic that outlives its reason becomes a place to hide things.

```bash
npm run audit:dependencies
```

The gate runs a full `npm audit --json` across production, development, optional, and peer dependencies, and reconciles the result against `.github/audit-exceptions.json`. It fails when any of the following is true:

- an advisory is reported that no declaration covers,
- a reported vulnerability identifies no advisory the gate can reconcile,
- a vulnerability is reported only as an effect of another package that no declaration covers for that dependent,
- a declaration no longer matches any reported advisory,
- a declaration has passed its `reviewBy` date,
- the advisory changed severity or affected range,
- the advisory is reported without an affected range or without any dependency path,
- the reported dependency paths and the declared paths are not exactly equal,
- an advisory carries no canonical GitHub advisory URL,
- npm's own vulnerability count disagrees with the entries it described, or with its severity buckets,
- a package's reported severity is higher than its own advisories account for,
- an advisory names a package other than the one it is reported under,
- a report key disagrees with the package name it describes,
- npm exits with any status other than 0 or 1, or exits non-zero without reporting any vulnerability,
- the report is unparsable or uses an unexpected schema version.

An unreadable, incomplete, or self-inconsistent report is a failure, never an implicit pass. The gate also strips ambient `npm_config_omit` settings, so neither a workflow `env` entry nor an `.npmrc` can shrink the audited tree without changing the gate itself.

The gate still trusts npm to report the advisories it knows about. It verifies that a report is internally consistent, not that the registry told the truth.

## What an exception may and may not say

The only statement an exception can express is:

> This exact advisory, in this exact module, at exactly these dependency paths, is accepted until this date.

There is deliberately no way to ignore a severity level, a package, or a path prefix. Wildcards are rejected, advisory IDs must be canonical GHSA identifiers, and the gate never receives `--audit-level`, `--omit`, or `--production`.

Paths must match what npm reports **exactly**, in both directions. A new path was never assessed; a declared path that is no longer reported would pre-authorise a future move back into it.

`reviewBy` may be at most 120 days after `acceptedOn`, so no entry can defer review indefinitely.

If another package becomes vulnerable *through* an excepted one, npm reports it as a separate entry. That dependent must be named in the excepted entry's optional `effects` array; otherwise the gate fails. Cover is never inherited silently.

`test/dependency-security.test.ts` enforces all of this, including by running the gate as a subprocess against a stubbed npm. Weakening the gate — even by removing its command-line entry point — breaks a test that states why it exists.

## When an exception is justified

Only when the vulnerable version cannot be raised from this repository. In practice that means an upstream package pins it through its own published `npm-shrinkwrap.json`, which is authoritative for its subtree: neither a root `overrides` entry nor `npm audit fix` can override it.

Fixing the dependency always wins over documenting it. Before adding an entry, confirm that:

1. a patched version exists,
2. upgrading the direct dependency does not pull it in,
3. a root `overrides` entry does not take effect,
4. `npm audit fix` cannot resolve it.

Record the result of that check in `reason`, and name the upstream change that would remove the entry in `upstreamFix`.

## Adding or renewing an exception

1. Reproduce the advisory and capture its paths:

   ```bash
   npm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).vulnerabilities;console.log(JSON.stringify(v,null,2))})'
   ```

2. Add one entry per advisory to `.github/audit-exceptions.json` with the advisory ID, module, severity, range, every reported path, a substantive `reason`, the `upstreamFix` that would retire it, `acceptedOn`, and a `reviewBy` date no more than 120 days later. Add `effects` only if npm reports dependents of the excepted package.
3. Run the gate and the offline policy tests:

   ```bash
   npm run audit:dependencies
   node --experimental-strip-types --test test/dependency-security.test.ts
   ```

`reviewBy` is a deadline, not a formality. When it passes, CI fails until someone re-checks the upstream state and either removes the entry or renews it with a fresh justification. That is the mechanism that stops an accepted risk from turning into a permanent one.

## Removing an exception

Once upstream ships the fix, upgrade the dependency and delete the entry. The gate fails on a declaration that matches nothing, so a stale entry cannot linger unnoticed.

## Current exceptions

| Advisory | Module | Pinned by | Review by |
| --- | --- | --- | --- |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | `brace-expansion` | `@earendil-works/pi-coding-agent` shrinkwrap | 2026-09-05 |

`brace-expansion` is a development-only transitive dependency of the Pi toolchain. It is never shipped in `@kliebhan/pi-prompt-autocomplete`, which declares Pi as a peer dependency, and CI runs it only against repository-controlled inputs. Retiring the entry requires `@earendil-works/pi-coding-agent` to bump its shrinkwrapped `brace-expansion` to `>=5.0.8`.
