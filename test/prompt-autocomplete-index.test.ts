import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptAutocompletePersistedSettings } from "../extensions/prompt-autocomplete/core.ts";
import {
  createPromptAutocompleteExtension,
  resolvePromptAutocompleteSettingsPath,
} from "../extensions/prompt-autocomplete/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown;
type EditorFactory = Exclude<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0], undefined>;

interface HarnessOptions {
  enabled?: boolean;
  /** Initial contents of the injected in-memory settings store. */
  savedSettings?: PromptAutocompletePersistedSettings;
  /** Simulate a store whose writes fail, e.g. a read-only config directory. */
  failingSettingsSave?: boolean;
  existingEditorFactory?: EditorFactory;
  mode?: ExtensionContext["mode"];
  /** Emulate forked hosts (prime-agent) whose ExtensionContext predates `mode`. */
  omitMode?: boolean;
  /** Override `hasUI` for forked hosts that report UI availability differently. */
  hasUI?: boolean;
  /** Emulate hosts without a usable custom-editor slot. */
  omitEditorSlot?: boolean;
  /** Emulate hosts whose editor slot accepts a factory without installing it. */
  noOpEditorSlot?: boolean;
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

  const hostUi = options.omitEditorSlot
    ? { ...ui, getEditorComponent: undefined, setEditorComponent: undefined }
    : options.noOpEditorSlot
      ? {
          ...ui,
          getEditorComponent: () => undefined,
          setEditorComponent: (factory: EditorFactory | undefined) => {
            editorSetCalls.push(factory);
          },
        }
      : ui;

  const ctx = {
    ...(options.omitMode ? {} : { mode }),
    hasUI: options.hasUI ?? (mode === "tui" || mode === "rpc"),
    model,
    modelRegistry,
    sessionManager,
    ui: hostUi,
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

  let storedSettings: PromptAutocompletePersistedSettings = { ...(options.savedSettings ?? {}) };
  const settingsSaves: PromptAutocompletePersistedSettings[] = [];
  const settingsStore = {
    load: () => ({ ...storedSettings }),
    save: (settings: PromptAutocompletePersistedSettings) => {
      if (options.failingSettingsSave) throw new Error("read-only config directory");
      storedSettings = { ...settings };
      settingsSaves.push({ ...settings });
    },
  };

  createPromptAutocompleteExtension({ settingsStore })(pi);

  return {
    commands,
    ctx,
    editorSetCalls,
    flags,
    handlers,
    notifications,
    registeredFlags,
    settingsSaves,
    getStoredSettings: () => ({ ...storedSettings }),
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

test("forked hosts without ExtensionContext.mode mount the editor when a real editor slot exists", async () => {
  const legacyTui = createHarness({ enabled: true, omitMode: true, hasUI: true });
  await emit(legacyTui, "session_start");
  assert.equal(legacyTui.editorSetCalls.length, 1);
  assert.equal(typeof legacyTui.getEditorFactory(), "function");

  await command(legacyTui, "status");
  assert.doesNotMatch(legacyTui.notifications.at(-1)?.message ?? "", /requires interactive TUI mode/);
});

test("forked hosts without UI availability or an editor slot stay excluded", async () => {
  const headless = createHarness({ enabled: true, omitMode: true, hasUI: false });
  await emit(headless, "session_start");
  assert.equal(headless.editorSetCalls.length, 0);

  await command(headless, "on");
  assert.equal(headless.editorSetCalls.length, 0);
  assert.match(headless.notifications.at(-1)?.message ?? "", /interactive TUI mode/);

  const withoutEditorSlot = createHarness({
    enabled: true,
    omitMode: true,
    hasUI: true,
    omitEditorSlot: true,
  });
  await emit(withoutEditorSlot, "session_start");
  assert.equal(withoutEditorSlot.editorSetCalls.length, 0);
  await command(withoutEditorSlot, "on");
  assert.match(withoutEditorSlot.notifications.at(-1)?.message ?? "", /interactive TUI mode/);
});

test("a host whose editor slot silently drops the factory stays inactive", async () => {
  const noOpHost = createHarness({
    enabled: true,
    omitMode: true,
    hasUI: true,
    noOpEditorSlot: true,
  });

  await emit(noOpHost, "session_start");
  assert.equal(noOpHost.editorSetCalls.length, 1, "the host is probed exactly once");
  assert.match(
    noOpHost.notifications.at(-1)?.message ?? "",
    /installs custom editors in the terminal process/,
  );

  // Once proven, such a host is treated like any other non-interactive host.
  await command(noOpHost, "status");
  assert.match(noOpHost.notifications.at(-1)?.message ?? "", /requires interactive TUI mode/);

  await emit(noOpHost, "session_start");
  assert.equal(noOpHost.editorSetCalls.length, 1, "a proven host is not probed again");
});

test("enabling on a host that never installs the editor stops after one attempt", async () => {
  const noOpHost = createHarness({ omitMode: true, hasUI: true, noOpEditorSlot: true });

  await emit(noOpHost, "session_start");
  assert.equal(noOpHost.editorSetCalls.length, 0, "a disabled extension never touches the editor slot");

  await command(noOpHost, "on");
  assert.equal(noOpHost.editorSetCalls.length, 1);
  assert.match(noOpHost.notifications.at(-1)?.message ?? "", /installs custom editors in the terminal process/);

  await command(noOpHost, "on");
  assert.equal(noOpHost.editorSetCalls.length, 1, "the failed host is not retried");
  assert.match(noOpHost.notifications.at(-1)?.message ?? "", /requires interactive TUI mode/);
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
      "Suggestions: 0 offered, 0 accepted (0 full, 0 word/chunk)",
      "Usage: 0 tokens, estimated cost ~$0",
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

test("a persisted enabled decision mounts the editor without the flag", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");
  assert.equal(harness.editorSetCalls.length, 1);
  assert.equal(typeof harness.getEditorFactory(), "function");

  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=yes\(saved\)/);
});

test("a persisted disabled decision keeps the editor unmounted and is attributed", async () => {
  const harness = createHarness({ savedSettings: { enabled: false } });
  await emit(harness, "session_start");
  assert.equal(harness.editorSetCalls.length, 0);

  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=no\(saved\)/);
});

test("an explicit flag outranks a persisted disabled decision for this invocation", async () => {
  const harness = createHarness({ enabled: true, savedSettings: { enabled: false } });
  await emit(harness, "session_start");
  assert.equal(harness.editorSetCalls.length, 1);

  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=yes\(flag\)/);
});

test("slash-command enable and disable decisions persist across processes", async () => {
  const harness = createHarness();
  await emit(harness, "session_start");

  await command(harness, "on");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true });

  await command(harness, "off");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: false });

  await command(harness, "toggle");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true });

  // A fresh activation over the same store behaves like the saved decision.
  const next = createHarness({ savedSettings: harness.getStoredSettings() });
  await emit(next, "session_start");
  assert.equal(next.editorSetCalls.length, 1);
});

test("a redundant on or off still persists the decision", async () => {
  const enabled = createHarness({ enabled: true });
  await emit(enabled, "session_start");
  await command(enabled, "on");
  assert.deepEqual(enabled.settingsSaves.at(-1), { enabled: true });

  const disabled = createHarness();
  await emit(disabled, "session_start");
  await command(disabled, "off");
  assert.deepEqual(disabled.settingsSaves.at(-1), { enabled: false });
});

test("a host that refuses custom editors does not persist an enable decision", async () => {
  const harness = createHarness({ noOpEditorSlot: true });
  await emit(harness, "session_start");

  await command(harness, "on");
  assert.equal(harness.settingsSaves.length, 0);
});

test("a failing settings store warns without losing the in-process decision", async () => {
  const harness = createHarness({ failingSettingsSave: true });
  await emit(harness, "session_start");

  await command(harness, "on");
  const warning = harness.notifications.find((entry) =>
    entry.message.includes("could not save the enabled setting"),
  );
  assert.ok(warning);
  assert.equal(warning?.type, "warning");
  assert.equal(typeof harness.getEditorFactory(), "function");

  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=yes\(session\)/);
});

test("the default settings path honours the override, XDG, and the home fallback", () => {
  assert.equal(
    resolvePromptAutocompleteSettingsPath({ PI_PROMPT_AUTOCOMPLETE_SETTINGS: "/tmp/pa.json" }, "/home/u"),
    "/tmp/pa.json",
  );
  assert.equal(
    resolvePromptAutocompleteSettingsPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"),
    "/xdg/pi-prompt-autocomplete/settings.json",
  );
  // A relative XDG_CONFIG_HOME is invalid per spec and must fall back to home.
  assert.equal(
    resolvePromptAutocompleteSettingsPath({ XDG_CONFIG_HOME: "relative/dir" }, "/home/u"),
    "/home/u/.config/pi-prompt-autocomplete/settings.json",
  );
  assert.equal(
    resolvePromptAutocompleteSettingsPath({}, "/home/u"),
    "/home/u/.config/pi-prompt-autocomplete/settings.json",
  );
});
