# Extension API compatibility gaps in prime-agent 0.7.0

Filed as https://github.com/PrimeIntellect-ai/prime-agent/issues/734 on 2026-08-06. Related: [#690](https://github.com/PrimeIntellect-ai/prime-agent/issues/690), the same root cause for `ctx.ui.setFooter()`.

## Summary

prime-agent inherits Pi's extension ecosystem, but three gaps make Pi extensions fail in ways that are hard to diagnose. Two are mechanical and cheap to fix. The third is architectural: in the default interactive chat, extension-provided editors and autocomplete providers are silently no-ops, although the extension documentation presents them as supported.

All observations are from `prime-agent@0.7.0` installed from npm, using `@kliebhan/pi-prompt-autocomplete` as the test extension.

---

## 1. `@earendil-works/pi-ai/compat` is not mapped for extensions

Pi maps both the root specifier and the `/compat` subpath for extensions:

```js
// @earendil-works/pi-coding-agent@0.83.0
// dist/core/extensions/loader.js
"@earendil-works/pi-ai/compat": piAiCompatEntry,
"@earendil-works/pi-ai": piAiCompatEntry,
```

prime-agent maps only the root specifier:

```js
// prime-agent@0.7.0
// dist/core/extensions/loader.js:39-45
const piAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "@earendil-works/pi-ai");
_aliases = {
  "@earendil-works/pi-coding-agent": piCodingAgentEntry,
  "@earendil-works/pi-ai": piAiEntry,
  "@earendil-works/pi-ai/oauth": piAiOauthEntry,
  …
};
```

Its bundled `@earendil-works/pi-ai` has no `./compat` export either, so any extension using the entrypoint that Pi's own migration guidance recommends fails to load:

```
$ prime-agent -ne -e ./node_modules/@kliebhan/pi-prompt-autocomplete …
Error: Failed to load extension ".../index.ts":
Failed to load extension: Cannot find module '@earendil-works/pi-ai/compat'
```

**Suggested fix:** alias `@earendil-works/pi-ai/compat` (and `@mariozechner/pi-ai/compat`) to the pi-ai entry, in both the jiti alias table and the bundled module table.

---

## 2. `ExtensionContext.mode` is missing

Pi exposes the run mode and documents it as the guard for terminal-only features:

```ts
// @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts
export type ExtensionMode = "tui" | "rpc" | "json" | "print";
/** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
mode: ExtensionMode;
```

prime-agent's `ExtensionContext` has `hasUI` but no `mode` (`dist/core/extensions/types.d.ts`, `dist/core/extensions/runner.js:375-395`). Every extension following Pi's guidance therefore evaluates `ctx.mode !== "tui"` as true and disables itself completely, including its own status command. The failure is silent: no load error, no diagnostic, the extension simply refuses to work.

**Suggested fix:** add `mode` to the extension context (`"tui"` for the interactive front-end, `"rpc"`, `"json"`, `"print"` for the others). Extensions that only check `hasUI` keep working unchanged.

---

## 3. Custom editors and autocomplete providers are no-ops in the default interactive chat

This is the substantive one.

`prime-agent` in a normal terminal chat is a daemon client:

```js
// dist/main.js:826-834
const useDaemonClient = shouldUseDaemonClientRuntime({ appMode, … });
const useDaemonInteractive = useDaemonClient && appMode === "interactive";
```

The in-process interactive path binds the real TUI UI context:

```js
// dist/main.js:1280-1285
const interactiveMode = new InteractiveMode({
  agentConnection: new InProcessAgentConnection(runtime),
  localSessionHost: createInteractiveModeLocalSessionHost(runtime),
  bindLocalSessionExtensions: true,
  …
```

```js
// dist/modes/interactive/interactive-mode.js:2899-2900
setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
getEditorComponent: () => this.editorComponentFactory,
```

The daemon-backed path does not:

```js
// dist/main.js:1100-1106
const interactiveMode = new InteractiveMode({
  agentConnection,
  daemonSocketPath,
  bindLocalSessionExtensions: false,
  …
```

Extensions then run inside the daemon, whose UI binding stubs out exactly the editor-related API:

```js
// dist/modes/daemon/daemon-extension-binding.js:174-178
addAutocompleteProvider: () => { },
setEditorComponent: () => { },
getEditorComponent: () => undefined,
```

`useDaemonClient` is false only for `--mode daemon`, `--help`, `--version`, `--list-models`, startup benchmarks, the internal owned-session worker, and SDK embedding with process-local extension factories. There is no user-facing way to get an in-process interactive chat; the `--no-daemon` string in `dist/modes/interactive/interactive-mode.js:4926` has no counterpart in the argument parser.

### Why this matters

`docs/extensions.md` documents custom editors as a first-class capability, with a full example (`Custom Editor`, `setEditorComponent`, `CustomEditor`, lines 2256-2422) and a mode table that lists `Interactive | Full TUI | Normal operation` (line 2500). In practice, the interactive mode users actually get silently drops that capability. An extension calling `setEditorComponent` observes success, receives no error, and never renders. Only a readback (`getEditorComponent() !== factory`) reveals it.

The same applies to `addAutocompleteProvider`, which is also stubbed.

### Suggested fixes, in order of preference

1. **Load UI-owning extensions in the client process.** Editor components and autocomplete providers are live TUI objects and cannot cross the daemon boundary; running them where the terminal lives is the only way to keep the documented behaviour.
2. **Make the limitation observable.** Have the daemon binding throw or report a diagnostic instead of silently accepting `setEditorComponent`/`addAutocompleteProvider`, so extensions can degrade deliberately.
3. **Document it.** At minimum, state in `docs/extensions.md` that custom editors and autocomplete providers are unavailable in daemon-backed interactive sessions, and which invocations avoid the daemon.

---

## Reproduction

```bash
npm i -g prime-agent@0.7.0

# 1. compat mapping
mkdir -p /tmp/probe && cd /tmp/probe
npm pack @kliebhan/pi-prompt-autocomplete@0.2.0 && tar -xzf *.tgz
prime-agent -ne -e /tmp/probe/package --offline --no-session \
  --api-key invalid --mode json -p noop
# → Cannot find module '@earendil-works/pi-ai/compat'

# 2 + 3. mode and editor slot
prime-agent            # normal interactive chat
/prompt-autocomplete on
# → "This host does not install custom editors; prompt autocomplete stays inactive"
```

Version `0.2.1` of that extension works around gaps 1 and 2 by importing the pi-ai root specifier and by treating a host without `ctx.mode` as interactive when it reports `hasUI` and a custom-editor slot. It then verifies the installation, which is how gap 3 becomes visible instead of appearing as a mysteriously inert extension.
