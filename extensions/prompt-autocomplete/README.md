# @kliebhan/pi-prompt-autocomplete

Inline AI completions for the [Pi coding agent](https://github.com/earendil-works/pi-mono), rendered as unobtrusive ghost text in the prompt editor.

[Watch the demo](https://github.com/KLIEBHAN/pi-extensions/releases/download/pi-prompt-autocomplete-v0.1.0/prompt-autocomplete-demo.mp4)

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

Legacy fallbacks are available for terminals that forward them: `Ctrl+Tab`, `Alt+[`, and `Alt+]`.

Built-in slash-command and file/path completion keeps precedence over ghost suggestions.

### Configuration

```bash
pi \
  --prompt-autocomplete \
  --prompt-autocomplete-model openai/gpt-5.4-mini \
  --prompt-autocomplete-min-chars 1 \
  --prompt-autocomplete-debounce-ms 250 \
  --prompt-autocomplete-max-chars 240 \
  --prompt-autocomplete-max-alternatives 3
```

- The active Pi model is used unless `--prompt-autocomplete-model provider/model` selects a dedicated authenticated model.
- Automatic suggestions require at least one non-whitespace draft character by default. Set `--prompt-autocomplete-min-chars 0` to opt into empty-draft suggestions.
- Suggestions pause while the main agent is streaming by default. Use `--prompt-autocomplete-while-streaming` or `/prompt-autocomplete while-streaming on` to change that behavior.
- `Ctrl+.` with no active suggestion is an explicit one-shot request and may bypass the streaming, cooldown, and minimum-length gates. Model, authentication, slash-command, and path safety checks still apply.
- Use `--prompt-autocomplete-debug` or `/prompt-autocomplete debug-on` for troubleshooting.

## Privacy, providers, and cost

Enabling Prompt Autocomplete permits additional model requests. A request can contain:

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
