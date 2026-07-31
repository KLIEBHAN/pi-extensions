import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import promptAutocompleteExtension from "../extensions/prompt-autocomplete/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown;
type EditorFactory = Exclude<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0], undefined>;

interface HarnessOptions {
  enabled?: boolean;
  existingEditorFactory?: EditorFactory;
  mode?: ExtensionContext["mode"];
}

function createHarness(options: HarnessOptions = {}) {
  const mode = options.mode ?? "tui";
  const flags = new Map<string, boolean | string>();
  if (options.enabled !== undefined) flags.set("prompt-autocomplete", options.enabled);

  const registeredFlags = new Map<string, { type: "boolean" | "string"; default?: boolean | string }>();
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const editorSetCalls: Array<EditorFactory | undefined> = [];
  let editorFactory = options.existingEditorFactory;

  const ui = {
    getEditorComponent: () => editorFactory,
    setEditorComponent: (factory: EditorFactory | undefined) => {
      editorFactory = factory;
      editorSetCalls.push(factory);
    },
    setWidget: () => undefined,
    notify: (message: string, type?: string) => notifications.push({ message, type }),
  };

  const model = { provider: "test-provider", id: "test-model" };
  const modelRegistry = {
    find: () => undefined,
    hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
  };
  const sessionManager = {
    getBranch: () => [],
    getLeafId: () => "leaf-1",
  };

  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model,
    modelRegistry,
    sessionManager,
    ui,
  } as unknown as ExtensionContext;

  const pi = {
    registerFlag(name: string, definition: { type: "boolean" | "string"; default?: boolean | string }) {
      registeredFlags.set(name, definition);
      if (!flags.has(name) && definition.default !== undefined) {
        flags.set(name, definition.default);
      }
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      commands.set(name, definition.handler);
    },
  } as unknown as ExtensionAPI;

  promptAutocompleteExtension(pi);

  return {
    commands,
    ctx,
    editorSetCalls,
    flags,
    handlers,
    notifications,
    registeredFlags,
    getEditorFactory: () => editorFactory,
    replaceEditorExternally: (factory: EditorFactory | undefined) => {
      editorFactory = factory;
    },
  };
}

async function emit(harness: ReturnType<typeof createHarness>, name: string): Promise<void> {
  await harness.handlers.get(name)?.({}, harness.ctx);
}

async function command(
  harness: ReturnType<typeof createHarness>,
  args: string,
): Promise<void> {
  await harness.commands.get("prompt-autocomplete")?.(args, harness.ctx);
}

const dummyEditorFactory = (() => ({ })) as unknown as EditorFactory;
const replacementEditorFactory = (() => ({ })) as unknown as EditorFactory;

test("prompt autocomplete is disabled by default while response streaming defaults on", () => {
  const harness = createHarness();

  assert.equal(harness.registeredFlags.get("prompt-autocomplete")?.default, false);
  assert.equal(harness.registeredFlags.get("prompt-autocomplete-min-chars")?.default, "1");
  assert.equal(harness.registeredFlags.get("prompt-autocomplete-stream")?.type, "string");
  assert.equal(harness.registeredFlags.get("prompt-autocomplete-stream")?.default, "on");
});

test("session start mounts the editor only in TUI mode", async () => {
  const tui = createHarness({ enabled: true, mode: "tui" });
  await emit(tui, "session_start");
  assert.equal(tui.editorSetCalls.length, 1);
  assert.equal(typeof tui.getEditorFactory(), "function");

  for (const mode of ["rpc", "json", "print"] as const) {
    const nonTui = createHarness({ enabled: true, mode });
    await emit(nonTui, "session_start");
    assert.equal(nonTui.editorSetCalls.length, 0, `${mode} must not mount a custom editor`);
  }
});

test("commands refuse to mount a custom editor outside TUI mode", async () => {
  const harness = createHarness({ mode: "rpc" });

  await command(harness, "on");

  assert.equal(harness.editorSetCalls.length, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /interactive TUI mode/);
});

test("repeated on, off, and toggle cycles keep editor ownership balanced", async () => {
  const harness = createHarness();
  await emit(harness, "session_start");
  assert.equal(harness.getEditorFactory(), undefined);

  await command(harness, "on");
  const firstFactory = harness.getEditorFactory();
  assert.equal(typeof firstFactory, "function");
  await command(harness, "on");
  assert.equal(harness.editorSetCalls.length, 1, "repeated on must not remount an owned editor");

  await command(harness, "off");
  await command(harness, "toggle");
  const secondFactory = harness.getEditorFactory();
  assert.equal(typeof secondFactory, "function");
  assert.notEqual(secondFactory, firstFactory);
  await command(harness, "toggle");
  assert.equal(harness.getEditorFactory(), undefined);
  assert.deepEqual(harness.editorSetCalls, [firstFactory, undefined, secondFactory, undefined]);
});

test("mount refuses to replace an existing custom editor", async () => {
  const harness = createHarness({ enabled: true, existingEditorFactory: dummyEditorFactory });

  await emit(harness, "session_start");

  assert.equal(harness.editorSetCalls.length, 0);
  assert.equal(harness.getEditorFactory(), dummyEditorFactory);
  assert.match(harness.notifications.at(-1)?.message ?? "", /Another custom editor is already active/);
});

test("turning autocomplete off restores the editor only while it still owns the factory", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  const installedFactory = harness.getEditorFactory();
  assert.equal(typeof installedFactory, "function");

  await command(harness, "off");

  assert.deepEqual(harness.editorSetCalls, [installedFactory, undefined]);
  assert.equal(harness.getEditorFactory(), undefined);
});

test("session shutdown restores the owned editor and a later start remounts cleanly", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  const firstFactory = harness.getEditorFactory();

  await emit(harness, "session_shutdown");
  assert.equal(harness.getEditorFactory(), undefined);

  await emit(harness, "session_start");
  const secondFactory = harness.getEditorFactory();
  assert.equal(typeof secondFactory, "function");
  assert.notEqual(secondFactory, firstFactory);
  assert.deepEqual(harness.editorSetCalls, [firstFactory, undefined, secondFactory]);
});

test("repeated session starts replace an owned factory instead of orphaning it", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  const firstFactory = harness.getEditorFactory();

  await emit(harness, "session_start");
  const secondFactory = harness.getEditorFactory();

  assert.equal(typeof secondFactory, "function");
  assert.notEqual(secondFactory, firstFactory);
  assert.deepEqual(harness.editorSetCalls, [firstFactory, undefined, secondFactory]);
  assert.equal(harness.notifications.length, 0);
});

test("turning autocomplete off never erases a later editor replacement", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  assert.equal(harness.editorSetCalls.length, 1);

  harness.replaceEditorExternally(replacementEditorFactory);
  await command(harness, "off");

  assert.equal(harness.editorSetCalls.length, 1);
  assert.equal(harness.getEditorFactory(), replacementEditorFactory);
});

test("an enabled but blocked extension can retry after the conflicting editor is removed", async () => {
  const harness = createHarness({ enabled: true, existingEditorFactory: dummyEditorFactory });
  await emit(harness, "session_start");
  assert.equal(harness.editorSetCalls.length, 0);

  harness.replaceEditorExternally(undefined);
  await command(harness, "on");

  assert.equal(harness.editorSetCalls.length, 1);
  assert.equal(typeof harness.getEditorFactory(), "function");
});

test("request state has no non-expiring last-result shortcut", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../extensions/prompt-autocomplete/index.ts", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /lastResolvedKey|lastResolvedSuggestions/);
  assert.match(source, /new SequenceOwnedSlot<PendingSuggestionRequest>/);
  assert.match(source, /getCachedRequest\(this\.shared, request\.cacheKey, \{ bypass: options\.manual \}\)/);
});

function lastStatus(harness: ReturnType<typeof createHarness>): string {
  return harness.notifications.at(-1)?.message ?? "";
}

test("slash-command activation survives a new session", async () => {
  const harness = createHarness({ enabled: false });
  await emit(harness, "session_start");
  assert.equal(harness.getEditorFactory(), undefined);

  await command(harness, "on");
  assert.equal(typeof harness.getEditorFactory(), "function");

  await emit(harness, "session_start");

  assert.equal(typeof harness.getEditorFactory(), "function", "a new session must keep the editor mounted");
  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=yes\(session\)/);
});

test("slash-command deactivation survives a new session", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  assert.equal(typeof harness.getEditorFactory(), "function");

  await command(harness, "off");
  assert.equal(harness.getEditorFactory(), undefined);

  await emit(harness, "session_start");

  assert.equal(harness.getEditorFactory(), undefined, "a new session must not re-enable a disabled extension");
  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=no\(session\)/);
});

test("stream, while-streaming, and debug overrides survive a new session", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");

  await command(harness, "stream off");
  await command(harness, "while-streaming on");
  await command(harness, "debug-on");
  await emit(harness, "session_start");
  await command(harness, "status");

  assert.match(lastStatus(harness), /stream=no\(session\)/);
  assert.match(lastStatus(harness), /request-path=complete/);
  assert.match(lastStatus(harness), /while-streaming=yes\(session\)/);
  assert.match(lastStatus(harness), /debug=yes\(session\)/);
});

test("flags still drive settings that were never overridden", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /while-streaming=no\(flag\)/);
  assert.match(lastStatus(harness), /stream=yes\(flag\)/);
  assert.match(lastStatus(harness), /request-path=stream/);
  assert.match(lastStatus(harness), /debug=no\(flag\)/);

  // A flag change between sessions must win while no session override exists.
  harness.flags.set("prompt-autocomplete-while-streaming", true);
  await emit(harness, "session_start");
  await command(harness, "status");

  assert.match(lastStatus(harness), /while-streaming=yes\(flag\)/);
});

test("explicit overrides keep winning over later flag changes", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  await command(harness, "while-streaming off");
  await command(harness, "stream off");

  harness.flags.set("prompt-autocomplete-while-streaming", true);
  harness.flags.set("prompt-autocomplete-stream", "on");
  await emit(harness, "session_start");
  await command(harness, "status");

  assert.match(lastStatus(harness), /while-streaming=no\(session\)/);
  assert.match(lastStatus(harness), /stream=no\(session\)/);
});

test("stream command toggles immediately and rejects invalid values", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");

  await command(harness, "stream off");
  assert.match(harness.notifications.at(-1)?.message ?? "", /streaming disabled \(completion path\)/);
  await command(harness, "status");
  assert.match(lastStatus(harness), /stream=no\(session\).*request-path=complete/);

  await command(harness, "stream toggle");
  await command(harness, "status");
  assert.match(lastStatus(harness), /stream=yes\(session\).*request-path=stream/);

  await command(harness, "stream maybe");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Usage: \/prompt-autocomplete stream/);
});

test("session shutdown does not record a disable override", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  await emit(harness, "session_shutdown");
  await emit(harness, "session_start");

  assert.equal(typeof harness.getEditorFactory(), "function", "shutdown must not disable the next session");
  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=yes\(flag\)/);
});

test("status stays compatible while stats reports an empty current session", async () => {
  const harness = createHarness({ enabled: true });
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /usage=0 req, 0 cached, 0 tok, ~\$0 est/);

  await command(harness, "stats");
  assert.equal(
    lastStatus(harness),
    [
      "Prompt Autocomplete — current session",
      "Requests: 0 issued, 0 failed",
      "Cache: 0 hits (0 exact, 0 prefix)",
      "Suggestions: 0 shown, 0 accepted (0 full, 0 word/chunk)",
      "Usage: 0 tok, ~$0 est",
      "Mean provider latency: n/a",
    ].join("\n"),
  );

  await command(harness, "unknown");
  assert.match(lastStatus(harness), /\|stats\|/);
});

test("a redundant on or off still records the user's intent", async () => {
  const enabled = createHarness({ enabled: true });
  await emit(enabled, "session_start");
  // Already enabled by the flag: the redundant command must still be durable.
  await command(enabled, "on");
  await command(enabled, "status");
  assert.match(lastStatus(enabled), /enabled=yes\(session\)/);

  const disabled = createHarness({ enabled: false });
  await emit(disabled, "session_start");
  await command(disabled, "off");
  await command(disabled, "status");
  assert.match(lastStatus(disabled), /enabled=no\(session\)/);
});
