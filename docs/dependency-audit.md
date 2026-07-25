# Dependency audit

CI audits the complete dependency tree, development dependencies included. The repository toolchain executes during CI and release builds, so a production-only audit would leave that trusted path unchecked.

```bash
npm run audit:dependencies
```

The gate runs `npm audit --json` and reconciles the result against `.github/audit-exceptions.json`. It fails when any of the following is true:

- an advisory is reported that no declaration covers,
- a declaration no longer matches any reported advisory,
- a declaration has passed its `reviewBy` date,
- the advisory changed severity or affected range,
- the advisory reached a dependency path the declaration does not list,
- an advisory carries no GitHub advisory URL,
- the report is unparsable or uses an unexpected schema version.

An unreadable report is a failure, never an implicit pass.

## What an exception may and may not say

The only statement an exception can express is:

> This exact advisory, in this exact module, at these exact dependency paths, is accepted until this date.

There is deliberately no way to ignore a severity level, a package, or a path prefix. Wildcards are rejected, and the gate never receives `--audit-level`, `--omit`, or `--production`. `test/dependency-security.test.ts` enforces this, so weakening the gate requires deleting a test that says why it exists.

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

2. Add one entry per advisory to `.github/audit-exceptions.json` with the advisory ID, module, severity, range, every reported path, a substantive `reason`, the `upstreamFix` that would retire it, `acceptedOn`, and a `reviewBy` date.
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
