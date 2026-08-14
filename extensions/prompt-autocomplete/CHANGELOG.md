# Changelog

All notable changes to this package are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - Unreleased

### Changed

- Cache and stream currency now follow the newest conversation entry that affects autocomplete context, not Pi's raw leaf. Custom, label, and session-info entries can move the leaf without discarding an otherwise identical cached suggestion.
- Automatic suggestions wait for `agent_settled` on hosts that emit it, so a retry or queued continuation cannot use unfinished conversation context. Hosts without that event still settle on `agent_end`. Manual `Ctrl+.` remains an explicit one-shot.

### Added

- Capture the physical session id at `session_start` as the identity later session-scoped accounting will use. Enable and `min-chars` continue to persist through the existing settings file, not through custom entries.
- `--prompt-autocomplete-max-requests <n|off>` and `/prompt-autocomplete budget <n|off>` cap provider requests per session; the default `off` preserves existing behaviour. Only real invocations count, including failed and aborted ones and those made while the ceiling was off, while exact-cache hits, prefix reuse, and in-flight joins stay free. The reservation is taken synchronously after auth and immediately before the provider call, so concurrent requests cannot overshoot and failed auth consumes nothing. An exhausted budget blocks automatic and manual requests, reports itself once per exhaustion state, and never starts a replacement request. Usage and ceiling are snapshotted into the session's own non-LLM entries — never into `settings.json` — so `/new` and `/fork` start fresh while a graceful `/reload` or `/resume` restores both; restoration scans the whole session and never lets usage go backwards, so branch switches cannot buy extra requests. `status` and `stats` report `used/limit` with its source.
- `/prompt-autocomplete set` persists the remaining runtime knobs (`debounce-ms`, `max-chars`, `max-alternatives`, and `model`) through that same settings file. Bare `set` prints `status`. Interactive out-of-range values are rejected rather than clamped. A dedicated model is validated against the registry and auth before commit; `active` is an explicit sentinel that commits while no active model is known yet but is rejected when the known active model is unusable; mixed-case model identifiers are preserved; a cross-provider change restates the privacy notice, comparing configured destinations so an unusable previous model still triggers it. Request-identity changes cancel in-flight work without starting a replacement; debounce-only changes drop a waiting timer without aborting an in-flight call. `/prompt-autocomplete min-chars` remains the canonical command. Success notices only claim durability when the settings file was actually written.

## [0.2.5] - 2026-08-07

### Added

- `/prompt-autocomplete min-chars <n>` sets the minimum draft length for automatic suggestions, applies it immediately, and persists it to the settings file for later processes. An explicit non-default `--prompt-autocomplete-min-chars` flag outranks the saved value for that invocation; the flag's default value defers to the saved setting. Out-of-range or malformed persisted values degrade to the default, and `status` attributes the value as `(flag)`, `(saved)`, or `(session)`.

## [0.2.4] - 2026-08-06

### Added

- `/prompt-autocomplete on` and `off` now persist across processes. The decision is saved to `$XDG_CONFIG_HOME/pi-prompt-autocomplete/settings.json` (`~/.config` fallback, `PI_PROMPT_AUTOCOMPLETE_SETTINGS` override) and enables autocomplete in later sessions without the CLI flag. An explicit `--prompt-autocomplete` flag still outranks a saved `off` for that invocation, a decision is only recorded when the host actually installs the editor, a failed save warns without losing the in-process decision, and a malformed file degrades to flag-only behaviour. `status` attributes the setting as `(flag)`, `(saved)`, or `(session)`.

## [0.2.3] - 2026-08-06

### Fixed

- Inline suggestions now render on hosts that keep an editor background surface alive. The renderer located the fake cursor by Pi's exact `\x1b[7m \x1b[0m` byte sequence, but forks such as prime-agent close the inverse-video cursor with `\x1b[27m` so the background survives the cursor cell. The lookup missed, so suggestions were generated and counted as showing yet never drawn. The cursor lookup now accepts both reset variants and rebuilds the line with the host's own reset.

## [0.2.2] - 2026-08-06

### Security

- Sanitize every untrusted string before it reaches the terminal. Provider errors, raw responses, model identifiers, and host diagnostics are stripped of complete escape sequences, including the DCS, SOS, PM, and APC payloads that Node's own helper leaves behind, of any remaining C0/C1 control such as a bare ESC or a carriage return, and of every Unicode format or default-ignorable character that could make a diagnostic display something other than its content; line and paragraph separators become real line breaks, while the joiners used by Arabic, Persian, Indic, and emoji sequences are preserved. Tabs and newlines are preserved, sanitization runs in a single linear scan so an unbounded provider error cannot stall the terminal, and diagnostic input is capped before display.
- An explicitly requested `--prompt-autocomplete-model` is now honoured or refused, never substituted. An unknown, unauthenticated, or malformed value suppresses autocomplete requests and reports the reason once instead of silently sending the draft and recent conversation context to the active model, which may belong to a different provider.

### Changed

- The notice for hosts that accept a custom editor without installing it now explains the cause: such hosts run extensions outside their terminal UI, so inline suggestions are unavailable.

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
