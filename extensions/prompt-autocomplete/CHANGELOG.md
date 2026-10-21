# Changelog

All notable changes to this package are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - Unreleased

### Added

- Configurable keys: `/prompt-autocomplete set key <action> <key...|default|none>` changes the keys of `accept-word`, `accept-line`, `cycle-next`, and `cycle-prev`, applies them at once, and saves them in the settings file. Keys follow Pi's key syntax and are space-separated. Keys that could never reach an action (Tab, Escape, Enter, Backspace and their legacy aliases, keys Pi's editor handles itself, keys that type text, Escape and F1–F12 with a modifier, Clear with other modifiers than Shift or Ctrl alone) and keys another action already has are rejected; a key that Pi's keymap binds is accepted with a warning, because Pi keeps it. `Tab` and `Escape` stay fixed.
- `/prompt-autocomplete keys` shows every action's keys, whether they are the default or saved, saved keys that are ignored, and keys Pi's keymap also binds.
- `accept-line` accepts a suggestion up to and including its first line break; a one-line suggestion is accepted whole. It has no default key.

### Changed

- `Escape` now dismisses a suggestion for as long as you keep typing the same draft, instead of only until the next keystroke. Previously the next character brought the dismissed suggestion back, from the prefix cache or through a new provider request. The dismissal ends for good when the draft no longer extends the dismissed text (for example after `Backspace`, submitting, clearing, or recalling another prompt), when the conversation, the autocomplete model, `max-chars`, or `max-alternatives` changes, or when you press `Ctrl+.`, accept, or cycle. An `Escape` on an empty-draft suggestion lasts only while the draft stays empty.

### Fixed

- Saving a setting no longer overwrites a decision another Pi process saved after this one started, and no longer drops fields a newer version wrote: each save re-reads the settings file and changes only its own decision, through a temporary file of its own process. Two saves in the same instant can still lose one decision.
- The word-accept and cycle keys (`Ctrl+Space`, `Ctrl+Tab`, `Ctrl+.`, `Alt+]`, `Ctrl+,`, `Alt+[`) no longer take input that Pi would use. A Pi action you bind to one of them in `keybindings.json`, including history and interrupt, another extension's shortcut on the same key, and a pending character jump (`Ctrl+]`) now get the key as they would without Prompt Autocomplete; previously visible ghost text took it. The check uses Pi's current keymap, so remaps loaded by `/reload` apply at once. `/prompt-autocomplete status` lists such keys under `keys-used-by-pi`. Pi's default keymap uses none of them, so nothing changes without remaps.

### Upgrading

- Version 0.3.0 and earlier drop the saved `keys`, like any other field they do not know, the next time they save a setting; the actions then return to their default keys.

## [0.3.0] - 2026-10-13

### Changed

- Supports Pi 1.x. Ghost text recognizes Pi 1.x fake-cursor markers next to the inverse-video cursor of Pi 0.x and the `\x1b[27m` variant of forked hosts, so suggestions keep rendering on all three. The compatibility matrix now covers Pi `0.80.6`, `0.83.0`, and `1.2.0`; the supported baseline stays `0.80.6`.
- On Pi 1.x, autocomplete requests route through the session's model registry instead of the global `pi-ai` compat functions. Those only serve Pi's built-in APIs on Pi 1.x, so a model from a provider that another extension registers with its own streaming implementation failed with "No API provider registered"; the registry serves those providers and resolves each provider's stored credential itself. No pre-resolved key is passed, because an explicit key would make Pi skip the stored credential and with it an OAuth-derived endpoint such as GitHub Copilot Enterprise's; header-only and ambient credentials are accepted on this path. Hosts without a registry entry point keep the compat functions, which still require an API key.
- On Pi 1.x, autocomplete context follows the model-visible session projection: messages that a `context_edit` omitted or replaced, for example to redact them, are omitted or replaced in autocomplete requests too, so autocomplete never sends what the model itself no longer sees. A failing projection sends no conversation context instead of the raw history. Older hosts, which have no context edits, keep using the raw branch. Besides user and assistant message text, autocomplete context includes only the newest compaction summary (see Added). The projection scans the whole session, so it is rebuilt only when the context-relevant conversation changes, not on every keystroke.
- Cache and stream currency now follow the newest conversation entry that affects autocomplete context, not Pi's raw leaf. Custom, label, and session-info entries can move the leaf without discarding an otherwise identical cached suggestion.
- Automatic suggestions wait for `agent_settled` on hosts that emit it, so a retry or queued continuation cannot use unfinished conversation context. Hosts without that event still settle on `agent_end`. Manual `Ctrl+.` remains an explicit one-shot.
- The read-only commands `status`, `stats`, and `inspect` now also run on hosts that can show notifications but have no interactive editor, such as RPC; there `status` reports `host=non-interactive` and `editor=unavailable`. Commands that change state or touch the editor stay TUI-only, and no provider seam is reachable outside the TUI. An extension enabled on such a host says once per process that it cannot issue requests.
- When another extension replaces the editor during a request, the request is now released at the first streamed progress or terminal response the old editor observes, instead of running to completion. Its result is never painted and the foreign editor is never touched.
- The documentation no longer claims that `stream`, `while-streaming`, and `debug-*` decisions survive `/new`: Pi replaces the extension runtime on `/new`, `/resume`, `/fork`, and `/reload`, so these runtime-only decisions end with it, while `on`/`off`, `min-chars`, and `set` persist through the settings file.
- The Gallery video now records a real Pi 1.2.0 session: streamed ghost text with alternatives, argument completion with runtime tuning, `inspect`, and an exhausted session budget. A local demo provider answers, so the recording needs no credentials and makes no network request.

### Added

- `/prompt-autocomplete set` persists the remaining runtime knobs (`debounce-ms`, `max-chars`, `max-alternatives`, and `model`) through the settings file that already stores the enable decision and `min-chars`. Bare `set` prints `status`. Interactive out-of-range values are rejected rather than clamped. A dedicated model is validated against the registry and auth before commit; `active` is an explicit sentinel that commits while no active model is known yet but is rejected when the known active model is unusable; mixed-case model identifiers are preserved; a cross-provider change restates the privacy notice, comparing configured destinations so an unusable previous model still triggers it. Request-identity changes cancel in-flight work without starting a replacement; debounce-only changes drop a waiting timer without aborting an in-flight call. `/prompt-autocomplete min-chars` remains the canonical command. Success notices only claim durability when the settings file was actually written.
- `--prompt-autocomplete-max-requests <n|off>` and `/prompt-autocomplete budget <n|off>` cap provider requests per session; the default `off` preserves existing behaviour. Only real invocations count, including failed and aborted ones and those made while the ceiling was off, while exact-cache hits, prefix reuse, and in-flight joins stay free. The reservation is taken synchronously after auth and immediately before the provider call, so concurrent requests cannot overshoot and a request whose credentials do not resolve consumes nothing. An exhausted budget blocks automatic and manual requests, reports itself once per exhaustion state, and never starts a replacement request. Usage and ceiling are snapshotted into the session's own non-LLM entries — never into `settings.json` — so `/new` and `/fork` start with a fresh usage count while a graceful `/reload` or `/resume` restores usage and ceiling; restoration scans the whole session and never lets usage go backwards, so branch switches cannot buy extra requests. A session that never touched the budget writes no entries. A ceiling set with `/prompt-autocomplete budget` belongs to the session as well: `/reload` and `/resume` restore it, `/new` and `/fork` start from the CLI flag. `status` and `stats` report `used/limit` with its source.
- `/prompt-autocomplete inspect [draft text]` previews locally what a request would send: resolved and requested model, the conversation sections with sizes and sanitized excerpts, the transmitted draft tail, the exact request size, output and token ceilings, and the shared request policy for automatic and manual requests. It renders the same request snapshot as the provider path, makes no provider request, persists nothing, and never shows credentials or headers. Without draft text it reports the conversation sections only instead of inventing a draft.
- `/prompt-autocomplete` completes its arguments in Pi's command menu, including nested forms such as `set debounce-ms`, `set model active`, `budget off`, and `stream on`. Values replace the whole argument span; an already complete command such as `stats` or `stream` opens no menu, so one `Enter` still submits it. Completion is local and synchronous and installs no global autocomplete provider. One grammar table now drives command dispatch, the usage texts (unchanged byte for byte), the completions, and a test that the README documents every command and `set` key.
- After a compaction, autocomplete requests include the newest compaction summary as a separate background section, bounded to 1,500 characters with the middle elided so the goal and the next steps survive. It applies on hosts with Pi's model-visible session projection (Pi 1.x), where the summarized messages are no longer part of the context; older hosts keep sending the raw messages instead. The compaction's system checkpoint, custom messages, and tool results are never sent. The summary is part of the request cache identity, and `/prompt-autocomplete inspect` shows its size and an excerpt.

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
