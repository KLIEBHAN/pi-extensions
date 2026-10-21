# @kliebhan/pi-prompt-autocomplete

Inline AI completions for the [Pi coding agent](https://github.com/earendil-works/pi-mono), rendered as unobtrusive ghost text in the prompt editor.

[Watch the demo](https://github.com/KLIEBHAN/pi-extensions/releases/download/pi-prompt-autocomplete-v0.4.0/prompt-autocomplete-demo.mp4)

## Install

Review the source before installing: Pi extensions execute with your user permissions.

```bash
pi install npm:@kliebhan/pi-prompt-autocomplete
```

Try the package for one run without installing it permanently:

```bash
pi -e npm:@kliebhan/pi-prompt-autocomplete --prompt-autocomplete
```

Prompt Autocomplete is **disabled by default**. Enable it explicitly for a process:

```bash
pi --prompt-autocomplete
```

Or enable it from inside an interactive session; the decision is saved for later sessions:

```text
/prompt-autocomplete on
```

## Usage

| Action | Key or command |
| --- | --- |
| Accept the full suggestion | `Tab` |
| Accept the next word or chunk | `Ctrl+Space` |
| Next alternative / manual one-shot | `Ctrl+.` |
| Previous alternative | `Ctrl+,` |
| Accept up to the end of the line | none by default; see [Keys](#keys) |
| Dismiss suggestions while you keep typing this draft | `Escape` |
| Enable, disable, or inspect configuration | `/prompt-autocomplete on\|off\|toggle\|status` |
| Show in-memory effectiveness and cost counters | `/prompt-autocomplete stats` |
| Preview what a request would send, locally | `/prompt-autocomplete inspect [draft text]` |
| Toggle streamed response previews | `/prompt-autocomplete stream on\|off\|toggle` |
| Allow suggestions while the main agent works | `/prompt-autocomplete while-streaming on\|off\|toggle` |
| Set and persist the minimum draft length | `/prompt-autocomplete min-chars <n>` |
| Cap provider requests for this session | `/prompt-autocomplete budget <n\|off>` |
| Persist remaining runtime knobs | `/prompt-autocomplete set debounce-ms\|max-chars\|max-alternatives\|model` |
| Inspect effective runtime knobs | `/prompt-autocomplete set` |
| Show the key of every action | `/prompt-autocomplete keys` |
| Change and persist an action's keys | `/prompt-autocomplete set key <action> <key...\|default\|none>` |
| Show or hide the debug status line | `/prompt-autocomplete debug-on\|debug-off\|debug-toggle` |

Legacy fallbacks are available for terminals that forward them: `Ctrl+Tab`, `Alt+[`, and `Alt+]`.

### Keys

`/prompt-autocomplete set key <action> <key...>` changes the keys of `accept-word`, `accept-line`, `cycle-next` (also the manual one-shot), or `cycle-prev`; it applies at once and is saved with the other [persistent settings](#persistent-settings). Separate several keys with spaces, since `,` is a key itself: `set key cycle-prev ctrl+, alt+[`. `default` restores an action's default keys and `none` unbinds it. `accept-line` has no default key; `set key accept-line alt+l` gives it one. Accepting a line inserts the suggestion up to and including its first line break; a one-line suggestion is accepted whole.

Keys use Pi's syntax (`ctrl+shift+x`, `alt+l`, `f5`; see Pi's `docs/keybindings.md`). Keys that cannot reach an action are rejected: `Tab`, `Escape`, `Enter`, `Backspace` and their legacy aliases such as `ctrl+i`, keys Pi's editor handles itself such as `shift+enter`, keys that type text such as `a` or `shift+a`, and keys Pi does not recognize: Escape and F1–F12 with a modifier, and Clear with anything but Shift or Ctrl alone. A key another Prompt Autocomplete action has must be freed there first. `Tab` (accept) and `Escape` (dismiss) are fixed. `/prompt-autocomplete keys` shows every action's keys, whether they are the default or saved, and saved keys that are ignored.

Pi comes first: if your Pi keymap (`keybindings.json`) binds one of these keys, or another extension registers it as a shortcut, the key does what Pi or that extension defines. `keys` and `status` (`keys-used-by-pi`) list such keys once the editor is active, and `set key` warns when you choose one. `Tab` and `Escape` keep their ghost-text meaning while a suggestion is visible.

After `/prompt-autocomplete ` and a few letters, Pi's command menu completes the arguments, including nested forms such as `set debounce-ms` or `set model active`; `Tab` or `Enter` inserts the selection. A command that is already complete, such as `stats` or `stream on`, opens no menu, so `Enter` still submits it at once. Completion is local and installs no global autocomplete provider.

Built-in slash-command and file/path completion keeps precedence over ghost suggestions.

### Configuration

```bash
pi \
  --prompt-autocomplete \
  --prompt-autocomplete-model openai/gpt-5.4-mini \
  --prompt-autocomplete-stream on \
  --prompt-autocomplete-min-chars 1 \
  --prompt-autocomplete-debounce-ms 250 \
  --prompt-autocomplete-max-chars 240 \
  --prompt-autocomplete-max-alternatives 3 \
  --prompt-autocomplete-max-requests off
```

- The active Pi model is used unless `--prompt-autocomplete-model provider/model` selects a dedicated authenticated model; `active` selects the session model explicitly. An explicitly requested model is never substituted: if it is unknown, unauthenticated, or malformed, autocomplete stays inactive and reports why.
- Automatic suggestions require at least one non-whitespace draft character by default. Set `--prompt-autocomplete-min-chars 0` or `/prompt-autocomplete min-chars 0` (persisted) to opt into empty-draft suggestions.
- Provider responses stream into the first ghost-text suggestion by default. Use `--prompt-autocomplete-stream off` or `/prompt-autocomplete stream off` to wait for complete responses instead. This changes rendering only: each suggestion request still uses the same context and token budget.
- Changing `/prompt-autocomplete stream` cancels active autocomplete work but does **not** start a replacement request; the selected path applies to the next edit or manual one-shot.
- Partial text advances monotonically: Latin text waits for complete word boundaries, while CJK and other no-space scripts remain grapheme-safe. Alternatives appear only after the response finishes.
- `Tab` accepts all partial text currently visible. `Ctrl+Space` accepts only its next visible word/chunk. Both cancel that stream, and unlike accepting a completed suggestion, neither automatically starts another paid request.
- Suggestions pause while the **main agent** is working by default, and stay paused until `agent_settled` on hosts that emit it. This is separate from streamed autocomplete responses. Use `--prompt-autocomplete-while-streaming` or `/prompt-autocomplete while-streaming on` to change that behavior.
- `Escape` dismissal lasts while the draft extends the dismissed text: further typing starts no request and does not bring the suggestion back. It ends for good when the draft stops extending it (`Backspace`, submit, clear, history), when the conversation, autocomplete model, `max-chars`, or `max-alternatives` changes, or on `Ctrl+.`, accept, or cycling. Dismissing an empty-draft suggestion lasts only while the draft stays empty.
- `Ctrl+.` with no active suggestion is an explicit one-shot request and may bypass the main-agent-streaming, cooldown, and minimum-length gates. Model, authentication, slash-command, and path safety checks still apply.
- Use `--prompt-autocomplete-debug` or `/prompt-autocomplete debug-on` for troubleshooting.

Slash-command decisions outrank the CLI flags. `on`, `off`, `min-chars`, and `set` are also saved for later sessions and processes (see [Persistent settings](#persistent-settings)). `stream`, `while-streaming`, and `debug-*` live only in the current extension runtime: Pi replaces that runtime on `/new`, `/resume`, `/fork`, and `/reload`, after which their flags apply again. `status` labels each value with its source, `(flag)`, `(saved)`, or `(session)`. Settings you never toggled keep following their flag. Interactive `set` values outside the documented range are rejected rather than clamped; CLI flags still clamp.

Changing `max-chars`, `max-alternatives`, or `model` cancels in-flight autocomplete work and drops the request caches. It does **not** start a replacement request. Changing `debounce-ms` only drops a waiting timer; an already-started provider call continues. Debug toggles change neither.

#### Session request budget

`--prompt-autocomplete-max-requests <n|off>` and `/prompt-autocomplete budget <n|off>` cap how many provider requests one session may issue. The default `off` keeps the 0.2 behaviour.

- Only real provider invocations count, including failed and aborted ones, and including invocations made while the ceiling was off — enabling a ceiling later cannot hand out an allowance that ignores what the session already spent. Exact-cache hits, prefix reuse, and joining an in-flight request are free and keep working above the ceiling.
- A request whose credentials do not resolve consumes nothing: the reservation happens after credentials resolve and immediately before the provider call, so two concurrent requests can never overshoot a ceiling of one. If a credential fails only inside the provider call, for example an OAuth token revoked in between, that counts like any failed call.
- An exhausted budget blocks automatic **and** manual (`Ctrl+.`) requests and reports itself once per exhaustion state. Raise the ceiling with `/prompt-autocomplete budget <n>` or lift it with `/prompt-autocomplete budget off`; neither starts a replacement request.
- The budget is **session-scoped**, not process-wide: usage and ceiling are snapshotted into the session's own non-LLM entries and never into `settings.json`. `/new` and `/fork` therefore start with a fresh usage count, while a graceful `/reload` or `/resume` of the same session restores usage and ceiling. Restoration scans the whole session rather than the current branch and never lets usage go backwards, so switching branches cannot buy extra requests. A session that never touched the budget writes no entries at all; once a ceiling has been set or restored, accounting stays durable even while the ceiling is off. A crash before the last snapshot, or a host without `pi.appendEntry`, can lose that durability — the in-process ceiling still applies.
- A ceiling set with `/prompt-autocomplete budget` belongs to the session as well: `/reload` and `/resume` restore it, while `/new` and `/fork` start from the CLI flag or `off`. A CLI flag applies to its invocation, and `status` labels the ceiling `(flag)`, `(saved)`, or `(session)`.
- Interactive values outside `1`–`100000` are rejected; the CLI flag clamps. `budget` without an argument, `status`, and `stats` all report `used/limit` with the source of the ceiling. The budget counter and the `stats` block have different scopes: `stats` covers the current extension runtime and restarts after a reload, while the budget counter covers the physical session and survives one.
- This is a request ceiling only: there is no token or dollar budget.

#### Persistent settings

`/prompt-autocomplete on`, `off`, `min-chars <n>`, and `/prompt-autocomplete set` (`debounce-ms`, `max-chars`, `max-alternatives`, `model`, `key`) are durable: the decision is saved to `$XDG_CONFIG_HOME/pi-prompt-autocomplete/settings.json` (falling back to `~/.config`; override the location with `PI_PROMPT_AUTOCOMPLETE_SETTINGS`) and applies to later processes without any CLI flag. `/prompt-autocomplete min-chars` remains the canonical command; `set min-chars` dispatches to it. An explicit CLI flag still outranks the saved value for that invocation — for numeric knobs and the model flag, passing the registered default is indistinguishable from not passing the flag and defers to the saved value. `set model` validates syntax, registry presence, and auth before saving: a dedicated model must resolve, and `active` commits while no active model is known yet but is rejected when the known active model is unusable. `active` is an explicit sentinel for the session model, mixed-case model ids are preserved, and a cross-provider change restates the privacy notice. An enable decision is only recorded when the host actually installs the editor. The file stores nothing but these decisions; deleting it restores flag-only behaviour. Each save re-reads the file and changes only the decision being saved, so decisions another Pi process saved in the meantime survive, as do fields a newer version wrote; if the file exists but cannot be read, the save is aborted rather than replacing it. On POSIX systems the file is readable by its owner only. Two saves in the same instant can still lose one decision; there is no lock. `status` labels each value with its source, and success notices only claim durability when the file was actually written.

### Usage and cost accounting

`/prompt-autocomplete stats` gives the in-memory counters a dedicated, readable report:

```text
Prompt Autocomplete — current session
Requests: 4 issued, 1 failed
Cache: 5 hits (2 exact, 3 prefix)
Suggestions: 8 offered, 3 accepted (2 full, 1 word/chunk)
Usage: 1832 tokens, estimated cost ~$0.00214
Mean provider latency: 410 ms (4 samples)
Budget: 4/25 (session)
```

`/prompt-autocomplete status` keeps its existing compact `usage=4 req, 5 cached, …` field for configuration troubleshooting.

- `issued` counts provider calls actually made. Cache hits add no provider request, tokens, cost, or latency sample.
- Cache hits distinguish exact-draft results from prefix reuse while you type through a cached suggestion.
- `offered` counts active ghost-text suggestions handed to the editor. Streamed revisions of the same active suggestion do not inflate it; cycling to another alternative counts a new offer. A terminal that is too narrow to draw ghost text can still count an offer.
- Full and word/chunk acceptance are counted separately, including acceptance of visible streamed partials.
- `failed` includes provider errors and aborted requests. Tokens from a failed response are counted when the provider returns its terminal usage report within the bounded cancellation drain; otherwise `tok+`/`est+` marks the totals incomplete.
- Mean provider latency measures local elapsed time from each actual provider invocation until it resolves or rejects; cache hits are excluded.
- Token counts come from the provider.
- **The cost is an estimate, not an invoice.** Pi derives it locally by multiplying the reported tokens with its own model price table, so it can disagree with what your provider actually bills.
- A trailing `+` (`1832 tokens+`, `estimated cost ~$0.00214+`; compact `status`: `1832 tok+`, `~$0.00214 est+`) means at least one request did not report that metric, so the true total may be higher than shown. Tokens and cost are marked independently, because a response can report tokens without a cost figure.
- Counters live only in memory and belong to the current extension runtime: they restart whenever Pi replaces it — a new session, `/resume`, `/fork`, or `/reload`. The session request budget is the exception and survives `/reload` and `/resume` (see [Session request budget](#session-request-budget)).

### Inspecting a request

`/prompt-autocomplete inspect [draft text]` shows locally what an autocomplete request would send. It makes no provider request, persists nothing, and never shows credentials or headers; at most it warms the in-memory context cache that the next request in the same conversation reuses.

- The report renders the same request snapshot the provider path uses: the resolved and requested model, the latest assistant and user messages, the recent-conversation summary, the compaction summary, the transmitted draft tail, the exact request size, and the output and token ceilings. Long sections appear as character counts with short sanitized excerpts.
- Without draft text the report covers the conversation sections only. The slash command replaced the editor text when you submitted it, so the draft a real request would carry cannot be recovered and is not invented; pass one explicitly to preview a complete request. Pi trims trailing whitespace from submitted commands.
- `Shared policy` evaluates only the gates every editor shares — enabled state, editor ownership, the main-agent gate, model and auth, `min-chars` and slash/path detection for the given draft, and the session budget — separately for automatic requests and the manual `Ctrl+.` one-shot. Cursor position, the built-in autocomplete menu, Escape dismissal, the per-editor error cooldown, and cached responses belong to the live editor and are not evaluated.

## Privacy, providers, and cost

Enabling Prompt Autocomplete permits additional model requests. Streaming changes only when the same response becomes visible; it does not add a second request. A request can contain:

- the current prompt draft or its bounded tail,
- the latest user and assistant messages,
- a bounded recent-conversation summary,
- on hosts with Pi's model-visible session projection (Pi 1.x), the newest compaction summary, bounded to 1,500 characters with the middle elided.

The newest conversation entry that affects autocomplete context is used only in the local in-memory cache key and is not sent to the provider. Custom, label, and session-info entries can move Pi's raw leaf without invalidating that key.

By default, requests use the active model. A dedicated `--prompt-autocomplete-model` may send this context to a different provider, so an explicitly requested model that cannot be used suppresses requests instead of falling back to the active one. Requests can incur token charges and consume provider rate limits.

Provider errors, raw responses, model identifiers, and host diagnostics are stripped of terminal control sequences and of bidirectional or invisible formatting characters before they are displayed, so untrusted text cannot repaint the terminal, hide output, drive OSC clipboard and hyperlink escapes, or misrepresent what it names.

Successful results are cached only in memory for up to 60 seconds; a terminal entry retains its base draft in process memory for the prefix comparison. If the draft then grows by an exact prefix of a cached suggestion, Prompt Autocomplete removes the text you typed and shows the remaining suffix locally instead of issuing another provider request. Prefix reuse is forward-only, stays scoped to the same context-relevant conversation, model, bounded context and output configuration, and never uses partial streamed text. Divergence, expiry or any context change falls through to a fresh request. The caches are bounded and are cleared on session reset or when the extension is disabled. Provider failures are not cached.

The extension makes no autocomplete request while disabled. Automatic empty-draft requests are also disabled by default.

## Compatibility and editor ownership

- Supported baseline: Pi `0.80.6`, Node.js `22.19.0` or newer.
- Every release is verified against Pi `0.80.6`, `0.83.0`, and `1.2.0`. Pi 1.x draws the editor cursor through fake-cursor markers instead of inverse video; ghost text supports both forms.
- On hosts that expose Pi's model-visible session projection (Pi 1.x), autocomplete context follows it: a message that `context_edit` omitted or replaced, for example to redact it, is omitted or replaced in autocomplete requests too. If that projection fails, requests carry no conversation context rather than the raw history. Besides user and assistant message text, autocomplete sends only the newest compaction summary, so suggestions keep the summarized background after a compaction; custom messages, tool results, and the compaction's system checkpoint are not sent.
- Interactive ghost text requires Pi's TUI mode. RPC, JSON, and print modes do not install a custom editor and never reach a provider.
- The read-only commands `status`, `stats`, and `inspect` also work on hosts that can show notifications, such as RPC; there `status` reports `host=non-interactive` and `editor=unavailable`. Every command that changes state or touches the editor stays TUI-only. If the extension is enabled on such a host, it says once per process that no autocomplete request will be issued.
- Forks of Pi's extension API whose `ExtensionContext` predates `mode`, such as [prime-agent](https://www.npmjs.com/package/prime-agent), are supported. For those hosts the extension first requires UI availability and a custom-editor slot, and then verifies that the host actually installed the editor. A front-end that accepts an editor factory without installing it, as forked RPC and daemon modes do, is detected on the first attempt and stays inactive: it is not retried, not left enabled, and can neither render ghost text nor issue a provider request.
- On Pi 1.x, requests go through the session's model registry, which resolves each provider's stored credential itself. Models from providers that other extensions register therefore work as well, as do OAuth credentials that derive their own endpoint (such as GitHub Copilot Enterprise) and header-only or ambient credentials. Older hosts use the simple completion API below and need an API key.
- The simple completion API is imported from the `@earendil-works/pi-ai` root specifier, which Pi maps to its compat entrypoint and such forks export directly. If a host exposes that module without `streamSimple`, the extension uses the completion path instead of failing requests.
- Prompt Autocomplete requires exclusive ownership of Pi's custom-editor slot. It refuses to replace another custom editor and never removes a later replacement editor.
- If another extension replaces the editor while a request runs, the request is released at the next boundary the old editor observes — an edit, streamed progress, or the terminal response — and its result is never painted. Pi exposes no editor-change event, so a provider that never yields cannot be interrupted earlier.

## Development

From the repository root:

```bash
npm ci
npm run test:prompt-autocomplete
npm run typecheck:prompt-autocomplete
npm run test:package
```

The package smoke test packs this directory, verifies the exact tarball contents, installs it into a clean temporary consumer, and discovers it with the supported Pi version.

## License

[MIT](LICENSE)
