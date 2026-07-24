# Changelog

All notable changes to this package are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
