# Changelog

All notable changes to this package are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
