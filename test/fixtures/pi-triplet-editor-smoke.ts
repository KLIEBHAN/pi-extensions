/**
 * Editor/request lifecycle smoke for one installed Pi host triplet.
 *
 * The compat-matrix test copies this file into a temporary consumer next to a
 * `pkg/` directory containing the installed package's source files, so that
 * every `@earendil-works/*` import resolves against the consumer's own
 * node_modules — i.e. against the host triplet under test, not against this
 * repository's development dependencies.
 *
 * The file is executed with `node --experimental-strip-types` and exits
 * non-zero with an assertion message on any failure; the matrix test only
 * checks for the final marker line.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { createPromptAutocompleteExtension } from "./pkg/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type EditorFactory = Exclude<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0], undefined>;

const flags = new Map<string, boolean | string>([
  ["prompt-autocomplete", true],
  ["prompt-autocomplete-debounce-ms", "0"],
]);
const handlers = new Map<string, Handler>();
let editorFactory: EditorFactory | undefined;
let renderRequests = 0;

const ui = {
  getEditorComponent: () => editorFactory,
  setEditorComponent: (factory: EditorFactory | undefined) => {
    editorFactory = factory;
  },
  setWidget: () => undefined,
  notify: () => undefined,
};
const ctx = {
  mode: "tui",
  hasUI: true,
  model: { provider: "test-provider", id: "smoke-model" },
  modelRegistry: {
    find: (provider: string, id: string) => ({ provider, id }),
    hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "smoke-key", headers: {} }),
  },
  sessionManager: { getBranch: () => [], getLeafId: () => "leaf-1" },
  ui,
} as unknown as ExtensionContext;

const pi = {
  registerFlag(name: string, definition: { default?: boolean | string }) {
    if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default);
  },
  getFlag: (name: string) => flags.get(name),
  on(name: string, handler: Handler) {
    handlers.set(name, handler);
  },
  registerCommand: () => undefined,
} as unknown as ExtensionAPI;

let providerCalls = 0;
createPromptAutocompleteExtension({
  completeSimple: (async () => {
    providerCalls += 1;
    return {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({ completions: [" the implementation carefully"] }) }],
      stopReason: "stop",
    };
  }) as never,
})(pi);

await handlers.get("session_start")?.({ reason: "startup" }, ctx);
assert.ok(editorFactory, "session_start must install an editor factory");

const tui = {
  terminal: { columns: 80, rows: 24 },
  requestRender: () => {
    renderRequests += 1;
  },
} as unknown as TUI;
const passthrough = (text: string) => text;
const editorTheme: EditorTheme = {
  borderColor: passthrough,
  selectList: {
    selectedPrefix: passthrough,
    selectedText: passthrough,
    description: passthrough,
    scrollInfo: passthrough,
    noMatch: passthrough,
  },
};
const editor = editorFactory(tui, editorTheme, { matches: () => false } as never);

editor.setText("Review");
for (let index = 0; index < 6; index += 1) {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

assert.equal(providerCalls, 1, "exactly one provider request must be issued");
const rendered = editor
  .render(80)
  .map((line: string) => stripVTControlCharacters(line))
  .join("\n");
assert.match(rendered, /the implementation carefully/, `ghost text missing. rendered:\n${rendered}`);

editor.handleInput("\t");
assert.equal(editor.getText(), "Review the implementation carefully", "Tab must accept the suggestion");
assert.ok(renderRequests > 0, "the editor must request renders");

await handlers.get("session_shutdown")?.({}, ctx);
assert.equal(ui.getEditorComponent(), undefined, "shutdown must restore the default editor");

console.log("editor-smoke-ok");
