# Dependency audit

CI audits the complete dependency tree, development dependencies included. The repository toolchain executes during CI and release builds, so a production-only audit would leave that trusted path unchecked.

```bash
npm run audit:dependencies
```

The script is a plain `npm audit` that includes every dependency class explicitly:

```bash
npm audit --include=prod --include=dev --include=optional --include=peer
```

`--include` outranks `--omit`, so an ambient `NODE_ENV=production` or `npm_config_omit` cannot shrink the audited tree. The command fails on any reported advisory, regardless of severity, and on any audit error. `test/dependency-security.test.ts` pins both the exact command and that the `release-audit` CI job runs it, so neither can be narrowed silently.

## When an advisory is reported

1. Upgrade the affected dependency, or the package that pulls it in.
2. If a transitive version is only constrained by ordinary semver ranges, raise it through the root lockfile, or an `overrides` entry in `package.json` when a range blocks the fix.
3. Re-run `npm run audit:dependencies` and the repository checks.

## Accepted advisories

None. Until October 2026 this repository ran a reconciliation gate that could accept individual advisories. It existed only because `@earendil-works/pi-coding-agent` 0.x published an `npm-shrinkwrap.json` that pinned vulnerable `brace-expansion` and `undici` copies, which no root lockfile or override can raise. Pi 1.x ships no shrinkwrap; after the development toolchain moved to Pi `1.2.0`, all seven accepted advisories resolved through this repository's own lockfile, and the gate was retired as its own documentation prescribed.

If an upstream shrinkwrap ever pins a vulnerable version again, prefer upgrading or replacing that package. Accepting an advisory instead is a deliberate decision: restore the reconciliation gate from the repository history, with each exception naming one advisory, module, severity, range, and every reported path, a substantive reason, the upstream fix that would retire it, and a review date no more than 120 days out.
