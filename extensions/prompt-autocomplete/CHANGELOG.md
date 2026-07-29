# Changelog

All notable changes to this package are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- Streamed ghost text for the first suggestion, enabled by default without additional provider requests. Partial Latin text advances only at stable word boundaries, no-space scripts remain grapheme-safe, and ranked alternatives appear after the terminal response.
- `--prompt-autocomplete-stream on|off` and `/prompt-autocomplete stream on|off|toggle` select between streamed previews and complete-response rendering. The slash-command choice survives later session starts in the same process.
- Accepting visible partial text cancels its stream and does not automatically issue a second paid request.
- Session accounting for autocomplete requests: `/prompt-autocomplete status` now reports issued requests, requests served from the cache, failed requests, provider-reported tokens, and an estimated cost derived from pi's local model price table. Tokens and cost are marked independently with a trailing `+` when a request did not report that metric.
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
