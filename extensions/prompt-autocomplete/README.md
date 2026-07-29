# @kliebhan/pi-prompt-autocomplete

Inline AI completions for the [Pi coding agent](https://github.com/earendil-works/pi-mono), rendered as unobtrusive ghost text in the prompt editor.

[Watch the demo](https://github.com/KLIEBHAN/pi-extensions/releases/download/pi-prompt-autocomplete-v0.2.0/prompt-autocomplete-demo.mp4)

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
| Enable, disable, or inspect | `/prompt-autocomplete on\|off\|toggle\|status` |
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

- The active Pi model is used unless `--prompt-autocomplete-model provider/model` selects a dedicated authenticated model.
- Automatic suggestions require at least one non-whitespace draft character by default. Set `--prompt-autocomplete-min-chars 0` to opt into empty-draft suggestions.
- Provider responses stream into the first ghost-text suggestion by default. Use `--prompt-autocomplete-stream off` or `/prompt-autocomplete stream off` to wait for complete responses instead. This changes rendering only: it sends the same single request with the same context and token budget.
- Partial text advances monotonically: Latin text waits for complete word boundaries, while CJK and other no-space scripts remain grapheme-safe. Alternatives appear only after the response finishes.
- `Tab` or `Ctrl+Space` accepts exactly the partial text currently visible and cancels that stream. Unlike accepting a completed suggestion, accepting a partial does not automatically start another paid request.
- Suggestions pause while the **main agent** is streaming by default. This is separate from streamed autocomplete responses. Use `--prompt-autocomplete-while-streaming` or `/prompt-autocomplete while-streaming on` to change that behavior.
- `Ctrl+.` with no active suggestion is an explicit one-shot request and may bypass the main-agent-streaming, cooldown, and minimum-length gates. Model, authentication, slash-command, and path safety checks still apply.
- Use `--prompt-autocomplete-debug` or `/prompt-autocomplete debug-on` for troubleshooting.

Slash-command toggles (`on`, `off`, `stream`, `while-streaming`, `debug-*`) outrank the CLI flags for the rest of the process, including in sessions started later. `status` labels each toggle with its source, `(flag)` or `(session)`. Settings you never toggled keep following their flag.

### Usage and cost accounting

`/prompt-autocomplete status` reports what the current session actually spent:

```text
usage=4 req, 5 cached, 1832 tok, ~$0.00214 est
```

- `req` counts provider calls that were actually issued; `cached` counts requests answered from the local cache without contacting a provider.
- `failed` appears only when a request errored or was aborted. Tokens already spent on a failed response are still counted.
- Token counts come from the provider.
- **The cost is an estimate, not an invoice.** Pi derives it locally by multiplying the reported tokens with its own model price table, so it can disagree with what your provider actually bills.
- A trailing `+` (`1832 tok+`, `~$0.00214 est+`) means at least one request did not report that metric, so the true total may be higher than shown. Tokens and cost are marked independently, because a response can report tokens without a cost figure.
- Counters live in memory, are scoped to the current session, and reset when a new session starts.

## Privacy, providers, and cost

Enabling Prompt Autocomplete permits additional model requests. Streaming changes only when the same response becomes visible; it does not add a second request. A request can contain:

- the current prompt draft or its bounded tail,
- the latest user and assistant messages,
- a bounded recent-conversation summary.

The active conversation leaf identity is used only in the local in-memory cache key and is not sent to the provider.

By default, requests use the active model. A dedicated `--prompt-autocomplete-model` may send this context to a different provider. Requests can incur token charges and consume provider rate limits.

Successful results are cached only in memory for up to 60 seconds. The cache is bounded and is cleared on session reset or when the extension is disabled. Provider failures are not cached.

The extension makes no autocomplete request while disabled. Automatic empty-draft requests are also disabled by default.

## Compatibility and editor ownership

- Supported baseline: Pi `0.80.6`, Node.js `22.19.0` or newer.
- Interactive ghost text requires Pi's TUI mode. RPC, JSON, and print modes do not install a custom editor.
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
