# Releasing Prompt Autocomplete

Prompt Autocomplete is published from `extensions/prompt-autocomplete/` as the independent npm package `@kliebhan/pi-prompt-autocomplete`. The repository root remains a private development/collection package.

GitHub Actions dependencies used by this release follow the immutable-SHA and runtime policy in [`github-actions.md`](github-actions.md).

## Release gate

From a clean checkout on Node.js 22.19 or newer:

```bash
npm ci --ignore-scripts
npm run release:check:prompt-autocomplete
npm run audit:dependencies
```

The gate performs strict TypeScript checks, the complete repository suite, exact tarball inspection, clean offline installation, Pi discovery/load checks, and release-metadata validation. The suite includes the executable Pi host compatibility matrix (`test/pi-compat-matrix.test.ts`): every supported version in `scripts/prompt-autocomplete-support.mjs` is installed from the registry as a matched pi-ai/pi-coding-agent/pi-tui triplet and must pass a CLI discovery smoke and an editor/request lifecycle smoke, because Pi's package model keeps core peers at `"*"` and metadata cannot encode host support. The matrix needs registry access; set `PI_COMPAT_MATRIX=0` to skip it in offline local runs — CI never sets it. The separate audit gate runs a full `npm audit` that includes development dependencies, because the repository toolchain executes during CI; a production-only audit would miss vulnerabilities in that trusted build path. It fails on any advisory that is not explicitly documented and time-boxed in `.github/audit-exceptions.json`; see [`docs/dependency-audit.md`](dependency-audit.md). For an unpublished version the gate runs an npm publish dry run. If that exact version already exists after a bootstrap or retry, it packs locally and requires npm's immutable `dist.integrity` to match instead.

Before tagging, also verify the Gallery video locally when `ffprobe` and `ffmpeg` are available:

```bash
ffprobe -v error \
  -show_entries stream=codec_name,width,height,pix_fmt \
  -show_entries format=duration,size \
  -of json \
  extensions/prompt-autocomplete/media/prompt-autocomplete-demo.mp4

ffmpeg -v error \
  -i extensions/prompt-autocomplete/media/prompt-autocomplete-demo.mp4 \
  -f null -
```

## Versioning

1. Update `extensions/prompt-autocomplete/package.json`.
2. Add the matching heading to `extensions/prompt-autocomplete/CHANGELOG.md`.
3. Update the version-pinned `pi.video` release URL in the package manifest and package README.
4. Run the release gate from a clean commit.

Tags are package-qualified because this repository contains several extensions:

```text
pi-prompt-autocomplete-v<version>
```

For version `0.1.0`, the only valid tag is `pi-prompt-autocomplete-v0.1.0`.

## First npm publication

The local machine must control the `@kliebhan` npm scope. Verify before creating a tag:

```bash
npm login
npm whoami
```

If npm requires the package to exist before a trusted publisher can be configured, bootstrap the first version from the exact tested tarball:

```bash
mkdir -p dist
npm pack --pack-destination "$PWD/dist" ./extensions/prompt-autocomplete
npm publish ./dist/kliebhan-pi-prompt-autocomplete-<version>.tgz \
  --access public \
  --provenance=false
```

The bootstrap version will not carry GitHub Actions provenance. All subsequent releases should use the trusted workflow below rather than a local publish.

Then configure npm Trusted Publishing for:

- repository: `KLIEBHAN/pi-extensions`
- workflow: `release-prompt-autocomplete.yml`
- environment: `npm`

Protect the GitHub `npm` environment with the repository's normal release approval policy.

## Automated release

After npm ownership/trusted publishing is configured, tag the reviewed release commit and push the tag:

```bash
git tag -a pi-prompt-autocomplete-v<version> -m "Prompt Autocomplete v<version>"
git push origin pi-prompt-autocomplete-v<version>
```

`.github/workflows/release-prompt-autocomplete.yml` then:

1. validates and packs in a read-only job without publication credentials,
2. verifies tag, manifest, changelog, privacy documentation, and Gallery media,
3. transfers only the validated tarball, pack metadata, and MP4 to the protected `npm` environment, retaining that handoff artifact for 31 days so multi-day approval delays do not invalidate it,
4. creates a draft GitHub release and uploads the exact tarball and MP4,
5. publishes the package with npm provenance when it is not already present,
6. for a retry, requires npm's immutable `dist.integrity` to equal the validated tarball integrity,
7. publishes the GitHub release only after npm succeeds or that exact integrity match is proven.

The workflow is retry-safe for an existing draft release or an already-published byte-identical npm version. It fails closed if the same version exists with different bytes.

## Recovering an existing tag

If a tag-triggered run fails before creating its release artifact, keep the published tag immutable. Fix the release infrastructure on `main`, verify that `extensions/prompt-autocomplete/` and the release URLs in `README.md` are unchanged from the tag, then dispatch the repaired workflow against the existing tag:

```bash
gh workflow run release-prompt-autocomplete.yml \
  --ref main \
  -f tag=pi-prompt-autocomplete-v<version>
```

The recovery path fetches the annotated tag, rejects package or release-README drift, and still requires the protected `npm` environment. The validated handoff artifact is retained for 31 days; approve the deployment within that window. If the artifact is manually deleted or expires, dispatch the entire workflow again so validation and packing run afresh—do not retry only the publish job.

If the environment permits only release tags, temporarily allow the `main` branch for the recovery deployment and remove that branch rule immediately after the run finishes.

## Post-release checks

```bash
npm view @kliebhan/pi-prompt-autocomplete@<version> \
  name version dist.integrity repository pi --json

pi -e npm:@kliebhan/pi-prompt-autocomplete@<version> --help
```

Open `https://pi.dev/packages/@kliebhan/pi-prompt-autocomplete` and use the catalog search on `https://pi.dev/packages` to confirm that:

- the indexed version matches the npm release,
- the package is classified as `extension` rather than `prompt`, `skill`, or `theme`,
- the release-hosted MP4 preview opens and plays.

The catalog list infers resource badges from reserved npm keywords, while the detail page can inspect the full `pi` manifest. Keep the exact `extension` keyword and do not add `prompt`, `skill`, or `theme` unless the package actually declares those resource types. Gallery indexing and review are external to this repository and must not be claimed before they are visible.
