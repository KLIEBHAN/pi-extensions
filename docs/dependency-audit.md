# Dependency audit

CI audits the complete dependency tree, development dependencies included. The repository toolchain executes during CI and release builds, so a production-only audit would leave that trusted path unchecked.

```bash
npm run audit:dependencies
```

The script is a plain `npm audit` with its scope pinned on the command line:

```bash
npm audit --audit-level=info --offline=false --include=prod --include=dev --include=optional --include=peer
```

Command-line flags outrank `.npmrc` files and `npm_config_*` environment variables, so each flag closes one way the audit could pass without auditing everything:

- `--audit-level=info` fails on an advisory of any severity. npm otherwise treats the threshold as `low`, so an `info` advisory, or an ambient `audit-level`, would exit 0.
- `--offline=false` forces the registry request. An ambient `offline` setting makes npm skip the audit and report a clean tree.
- `--include=...` keeps every dependency class. npm drops included types from any ambient `omit`, including the one `NODE_ENV=production` implies.

The command also fails on any audit error, for example an unreachable registry. `test/dependency-security.test.ts` pins the exact command and checks that the `release-audit` CI job runs it in a step that has no condition, no tolerated failure, and no injected environment.

## When an advisory is reported

1. Upgrade the affected dependency, or the package that pulls it in.
2. If a transitive version is only constrained by ordinary semver ranges, raise it through the root lockfile, or an `overrides` entry in `package.json` when a range blocks the fix.
3. Re-run `npm run audit:dependencies` and the repository checks.

## Accepted advisories

None. Until October 2026 this repository ran a reconciliation gate that could accept individual advisories. It existed only because `@earendil-works/pi-coding-agent` 0.x published an `npm-shrinkwrap.json` that pinned vulnerable `brace-expansion` and `undici` copies, which no root lockfile or override can raise. Pi 1.x ships no shrinkwrap; after the development toolchain moved to Pi `1.2.0`, all seven accepted advisories resolved through this repository's own lockfile, and the gate was retired as its own documentation prescribed.

If an upstream shrinkwrap ever pins a vulnerable version again, prefer upgrading or replacing that package. Accepting an advisory instead is a deliberate decision: restore the reconciliation gate from the repository history, with each exception naming one advisory, module, severity, range, and every reported path, a substantive reason, the upstream fix that would retire it, and a review date no more than 120 days out.
