# Changelog

All notable changes to this package are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-06

### Fixed

- Load the simple completion API from the `@earendil-works/pi-ai` root specifier, which Pi maps to its compat entrypoint and forked hosts export directly. Hosts that never mapped the `@earendil-works/pi-ai/compat` subpath, such as prime-agent, can now load the extension at all.
- Detect the interactive editor host without requiring `ExtensionContext.mode`. Hosts that report a mode keep the previous behaviour, so Pi's RPC, JSON, and print runs stay excluded unchanged. Hosts built on an older extension API are treated as candidates only when they report UI availability and expose a custom-editor slot, and the installation is then verified: a host that accepts an editor factory without installing it — such as a forked headless or daemon front-end — is detected on the first attempt, is never retried, is not left enabled, and can neither render ghost text nor issue a provider request. This restores `/prompt-autocomplete` commands and ghost text on prime-agent.

## [0.2.0] - 2026-07-31

### Added

- Streamed ghost text for the first suggestion, enabled by default without additional provider requests. Partial Latin text advances only at stable word boundaries, no-space scripts remain grapheme-safe, and ranked alternatives appear after the terminal response.
- `--prompt-autocomplete-stream on|off` and `/prompt-autocomplete stream on|off|toggle` select between streamed previews and complete-response rendering. The slash-command choice survives later session starts in the same process.
- Accepting visible partial text cancels its stream and does not automatically issue a second paid request.
- Forward prefix reuse serves the remaining suffix of a still-valid terminal cache entry while the user types through it, avoiding another provider request without crossing model, branch, context, output-configuration, TTL, or grapheme boundaries.
- Session accounting for autocomplete requests: `/prompt-autocomplete status` now reports issued requests, requests served from the cache, failed requests, provider-reported tokens, and an estimated cost derived from pi's local model price table. Tokens and cost are marked independently with a trailing `+` when a request did not report that metric.
- `/prompt-autocomplete stats` presents current-session requests, failures, exact and prefix cache hits, active suggestions offered, full and word/chunk acceptance, token/cost totals, and mean provider latency without a live overlay or persistence.
- Status output now names the source of each toggle, so a session override is distinguishable from a CLI flag.

### Security

- Strip terminal C0/C1 control characters and reject unpaired UTF-16 surrogates before suggestions reach the TUI; length limits now truncate only at complete grapheme boundaries.

### Fixed

- `/prompt-autocomplete on`, `off`, `while-streaming`, and the debug toggles no longer revert to their CLI-flag values when a new session starts.

## [0.1.2] - 2026-07-24

### Fixed

- Corrected the Pi Gallery catalog badge from `prompt` to `extension` by aligning reserved type keywords with the package manifest.
- Added release checks that prevent Gallery type keywords from drifting away from the resources declared by the package.

## [0.1.1] - 2026-07-24

### Changed

- Verified the standalone package, clean installation, Pi discovery, and editor integration against Pi 0.82.0.
- Updated the Gallery media link to the immutable v0.1.1 GitHub release asset.

### Security

- Hardened release validation with a full dependency audit and offline advisory-range checks.
- Prepared publication through npm Trusted Publishing with provenance and immutable Node 24 GitHub Actions.

## [0.1.0] - 2026-07-10

### Added

- Inline ghost-text suggestions in Pi's interactive prompt editor.
- Full-suggestion and word/chunk acceptance.
- Multiple ranked alternatives with forward and backward cycling.
- Active-model and dedicated-model selection.
- Manual one-shot completion and configurable streaming behavior.
- Bounded in-memory caching, request coalescing, cancellation, and stale-result protection.
- Unicode, CJK, emoji, narrow-terminal, multiline, and IME-aware rendering.
- Debug and lifecycle commands for enabling, disabling, toggling, and inspecting state.

### Security and privacy

- Autocomplete is opt-in and disabled by default.
- Automatic empty-draft requests are disabled by default.
- Provider/context transfer and possible costs are documented.
- Other custom editors are never overwritten or removed.

### Validation

- Strict TypeScript checks against Pi 0.80.6.
- Executable editor, request, lifecycle, packaging, clean-install, and Pi-discovery tests.
