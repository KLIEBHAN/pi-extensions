# @kliebhan/pi-prompt-autocomplete

Inline AI completions for the [Pi coding agent](https://github.com/earendil-works/pi-mono), rendered as unobtrusive ghost text in the prompt editor.

[Watch the demo](https://github.com/KLIEBHAN/pi-extensions/releases/download/pi-prompt-autocomplete-v0.2.2/prompt-autocomplete-demo.mp4)

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

Or enable it for the current interactive session:

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
| Dismiss the suggestion for this draft | `Escape` |
| Enable, disable, or inspect configuration | `/prompt-autocomplete on\|off\|toggle\|status` |
| Show current-session effectiveness and cost | `/prompt-autocomplete stats` |
| Toggle streamed response previews | `/prompt-autocomplete stream on\|off\|toggle` |

Legacy fallbacks are available for terminals that forward them: `Ctrl+Tab`, `Alt+[`, and `Alt+]`.

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
  --prompt-autocomplete-max-alternatives 3
```

- The active Pi model is used unless `--prompt-autocomplete-model provider/model` selects a dedicated authenticated model; `active` selects the session model explicitly. An explicitly requested model is never substituted: if it is unknown, unauthenticated, or malformed, autocomplete stays inactive and reports why.
- Automatic suggestions require at least one non-whitespace draft character by default. Set `--prompt-autocomplete-min-chars 0` to opt into empty-draft suggestions.
- Provider responses stream into the first ghost-text suggestion by default. Use `--prompt-autocomplete-stream off` or `/prompt-autocomplete stream off` to wait for complete responses instead. This changes rendering only: each suggestion request still uses the same context and token budget.
- Changing `/prompt-autocomplete stream` cancels active autocomplete work but does **not** start a replacement request; the selected path applies to the next edit or manual one-shot.
- Partial text advances monotonically: Latin text waits for complete word boundaries, while CJK and other no-space scripts remain grapheme-safe. Alternatives appear only after the response finishes.
- `Tab` accepts all partial text currently visible. `Ctrl+Space` accepts only its next visible word/chunk. Both cancel that stream, and unlike accepting a completed suggestion, neither automatically starts another paid request.
- Suggestions pause while the **main agent** is streaming by default. This is separate from streamed autocomplete responses. Use `--prompt-autocomplete-while-streaming` or `/prompt-autocomplete while-streaming on` to change that behavior.
- `Ctrl+.` with no active suggestion is an explicit one-shot request and may bypass the main-agent-streaming, cooldown, and minimum-length gates. Model, authentication, slash-command, and path safety checks still apply.
- Use `--prompt-autocomplete-debug` or `/prompt-autocomplete debug-on` for troubleshooting.

Slash-command toggles (`on`, `off`, `stream`, `while-streaming`, `debug-*`) outrank the CLI flags for the rest of the process, including in sessions started later. `status` labels each toggle with its source, `(flag)` or `(session)`. Settings you never toggled keep following their flag.

### Usage and cost accounting

`/prompt-autocomplete stats` gives the current session a dedicated, readable report:

```text
Prompt Autocomplete — current session
Requests: 4 issued, 1 failed
Cache: 5 hits (2 exact, 3 prefix)
Suggestions: 8 offered, 3 accepted (2 full, 1 word/chunk)
Usage: 1832 tokens, estimated cost ~$0.00214
Mean provider latency: 410 ms (4 samples)
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
- Counters live only in memory, are scoped to the current session, and reset when a new session starts.

## Privacy, providers, and cost

Enabling Prompt Autocomplete permits additional model requests. Streaming changes only when the same response becomes visible; it does not add a second request. A request can contain:

- the current prompt draft or its bounded tail,
- the latest user and assistant messages,
- a bounded recent-conversation summary.

The active conversation leaf identity is used only in the local in-memory cache key and is not sent to the provider.

By default, requests use the active model. A dedicated `--prompt-autocomplete-model` may send this context to a different provider, so an explicitly requested model that cannot be used suppresses requests instead of falling back to the active one. Requests can incur token charges and consume provider rate limits.

Provider errors, raw responses, model identifiers, and host diagnostics are stripped of terminal control sequences and of bidirectional or invisible formatting characters before they are displayed, so untrusted text cannot repaint the terminal, hide output, drive OSC clipboard and hyperlink escapes, or misrepresent what it names.

Successful results are cached only in memory for up to 60 seconds; a terminal entry retains its base draft in process memory for the prefix comparison. If the draft then grows by an exact prefix of a cached suggestion, Prompt Autocomplete removes the text you typed and shows the remaining suffix locally instead of issuing another provider request. Prefix reuse is forward-only, stays scoped to the same conversation leaf, model, bounded context and output configuration, and never uses partial streamed text. Divergence, expiry or any context change falls through to a fresh request. The caches are bounded and are cleared on session reset or when the extension is disabled. Provider failures are not cached.

The extension makes no autocomplete request while disabled. Automatic empty-draft requests are also disabled by default.

## Compatibility and editor ownership

- Supported baseline: Pi `0.80.6`, Node.js `22.19.0` or newer.
- Interactive ghost text requires Pi's TUI mode. RPC, JSON, and print modes do not install a custom editor.
- Forks of Pi's extension API whose `ExtensionContext` predates `mode`, such as [prime-agent](https://www.npmjs.com/package/prime-agent), are supported. For those hosts the extension first requires UI availability and a custom-editor slot, and then verifies that the host actually installed the editor. A front-end that accepts an editor factory without installing it, as forked RPC and daemon modes do, is detected on the first attempt and stays inactive: it is not retried, not left enabled, and can neither render ghost text nor issue a provider request.
- The simple completion API is imported from the `@earendil-works/pi-ai` root specifier, which Pi maps to its compat entrypoint and such forks export directly. If a host exposes that module without `streamSimple`, the extension uses the completion path instead of failing requests.
- Prompt Autocomplete requires exclusive ownership of Pi's custom-editor slot. It refuses to replace another custom editor and never removes a later replacement editor.

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
