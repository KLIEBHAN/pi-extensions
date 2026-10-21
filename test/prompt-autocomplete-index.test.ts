import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyPromptAutocompleteSettingsPatch,
  completePromptAutocompleteArguments,
  PROMPT_AUTOCOMPLETE_COMMANDS,
  PROMPT_AUTOCOMPLETE_SET_USAGE,
  PROMPT_AUTOCOMPLETE_USAGE,
  type PromptAutocompletePersistedSettings,
} from "../extensions/prompt-autocomplete/core.ts";
import {
  createPromptAutocompleteExtension,
  createPromptAutocompleteFileSettingsStore,
  type PromptAutocompleteDependencies,
  type PromptAutocompleteProcessState,
  resolvePromptAutocompleteSettingsPath,
} from "../extensions/prompt-autocomplete/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown;
interface CommandDefinition {
  handler: CommandHandler;
  getArgumentCompletions?: (argumentPrefix: string) => unknown;
}
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
  /** Registry lookup; return undefined to emulate an unknown model. */
  findModel?: (provider: string, id: string) => { provider: string; id: string } | undefined;
  /** Per-model auth, for hosts where only some models are authenticated. */
  hasConfiguredAuth?: (model: { provider: string; id: string }) => boolean;
  /** Session entries visible to the extension, e.g. restored budget snapshots. */
  branch?: unknown[];
  /** Physical session id; a different id emulates a new or forked session. */
  sessionId?: string;
  /** Process-lifetime state; share one object between harnesses to emulate runtimes of one process. */
  processState?: PromptAutocompleteProcessState;
  /** Use the real process-wide default instead of an isolated state object. */
  useProcessGlobal?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const mode = options.mode ?? "tui";
  const flags = new Map<string, boolean | string>();
  if (options.enabled !== undefined) flags.set("prompt-autocomplete", options.enabled);

  const registeredFlags = new Map<string, { type: "boolean" | "string"; default?: boolean | string }>();
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const commandDefinitions = new Map<string, CommandDefinition>();
  const autocompleteProviders: unknown[] = [];
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
    // Spy: argument completion must use the command API, never a global provider.
    addAutocompleteProvider: (factory: unknown) => autocompleteProviders.push(factory),
  };

  const model = { provider: "test-provider", id: "test-model" };
  let branch: unknown[] = [...(options.branch ?? [])];
  const modelRegistry = {
    find: (provider: string, id: string) =>
      options.findModel ? options.findModel(provider, id) : { provider, id },
    hasConfiguredAuth: (model: { provider: string; id: string }) =>
      options.hasConfiguredAuth ? options.hasConfiguredAuth(model) : true,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
  };
  const sessionManager = {
    getBranch: () => branch,
    getEntries: () => branch,
    getLeafId: () => "leaf-1",
    getSessionId: () => options.sessionId ?? "session-1",
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
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition.handler);
      commandDefinitions.set(name, definition);
    },
    appendEntry(customType: string, data: unknown) {
      branch = [...branch, { type: "custom", customType, data, id: `custom-${branch.length + 1}` }];
    },
  } as unknown as ExtensionAPI;

  let storedSettings: PromptAutocompletePersistedSettings = { ...(options.savedSettings ?? {}) };
  const settingsSaves: PromptAutocompletePersistedSettings[] = [];
  const settingsStore = {
    load: () => ({ ...storedSettings }),
    update: (patch: Partial<PromptAutocompletePersistedSettings>) => {
      if (options.failingSettingsSave) throw new Error("read-only config directory");
      storedSettings = applyPromptAutocompleteSettingsPatch(storedSettings, patch);
      settingsSaves.push({ ...storedSettings });
    },
  };

  // Counting seams prove that no command or lifecycle path reaches a provider.
  let providerCalls = 0;
  createPromptAutocompleteExtension({
    settingsStore,
    processState: options.useProcessGlobal ? undefined : (options.processState ?? {}),
    completeSimple: (async () => {
      providerCalls += 1;
      throw new Error("index tests must not reach the provider");
    }) as unknown as NonNullable<PromptAutocompleteDependencies["completeSimple"]>,
    streamSimple: (() => {
      providerCalls += 1;
      throw new Error("index tests must not reach the provider");
    }) as unknown as NonNullable<PromptAutocompleteDependencies["streamSimple"]>,
  })(pi);

  return {
    commands,
    ctx,
    editorSetCalls,
    flags,
    handlers,
    notifications,
    commandDefinitions,
    autocompleteProviders,
    registeredFlags,
    settingsSaves,
    getStoredSettings: () => ({ ...storedSettings }),
    getBranch: () => branch,
    getProviderCalls: () => providerCalls,
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

  // Once proven, such a host is treated like any other non-interactive host:
  // reporting stays available and honest, while changes are still refused.
  await command(noOpHost, "status");
  assert.match(noOpHost.notifications.at(-1)?.message ?? "", /host=non-interactive \| enabled=no\(flag\) \| editor=unavailable/);
  await command(noOpHost, "on");
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
      "Budget: off (flag)",
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
    entry.message.includes("could not save the setting"),
  );
  assert.ok(warning);
  assert.equal(warning?.type, "warning");
  assert.equal(typeof harness.getEditorFactory(), "function");

  await command(harness, "status");
  assert.match(lastStatus(harness), /enabled=yes\(session\)/);
});

test("the default settings path honours the override, XDG, and the home fallback", () => {
  // Composed paths use path.join so the assertion matches Windows separators.
  // An explicit override is returned unchanged and stays a raw env string.
  assert.equal(
    resolvePromptAutocompleteSettingsPath({ PI_PROMPT_AUTOCOMPLETE_SETTINGS: "/tmp/pa.json" }, "/home/u"),
    "/tmp/pa.json",
  );
  assert.equal(
    resolvePromptAutocompleteSettingsPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"),
    join("/xdg", "pi-prompt-autocomplete", "settings.json"),
  );
  // A relative XDG_CONFIG_HOME is invalid per spec and must fall back to home.
  assert.equal(
    resolvePromptAutocompleteSettingsPath({ XDG_CONFIG_HOME: "relative/dir" }, "/home/u"),
    join("/home/u", ".config", "pi-prompt-autocomplete", "settings.json"),
  );
  assert.equal(
    resolvePromptAutocompleteSettingsPath({}, "/home/u"),
    join("/home/u", ".config", "pi-prompt-autocomplete", "settings.json"),
  );
});

test("min-chars slash command applies, persists, and reports its value", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");

  await command(harness, "min-chars 0");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true, minPromptChars: 0 });
  await command(harness, "status");
  assert.match(lastStatus(harness), /min-chars=0\(session\)/);

  await command(harness, "min-chars");
  assert.match(lastStatus(harness), /min-chars is 0 \(session\)/);

  await command(harness, "min-chars nonsense");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete min-chars \[0-500\]/);
  await command(harness, "min-chars 501");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete min-chars \[0-500\]/);
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true, minPromptChars: 0 });
});

test("a persisted min-chars value applies to later processes and is attributed", async () => {
  const harness = createHarness({ savedSettings: { enabled: true, minPromptChars: 0 } });
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /min-chars=0\(saved\)/);
});

test("an explicit non-default min-chars flag outranks the saved value", async () => {
  const harness = createHarness({ savedSettings: { enabled: true, minPromptChars: 0 } });
  harness.flags.set("prompt-autocomplete-min-chars", "3");
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /min-chars=3\(flag\)/);
});

test("a defaulted min-chars flag defers to the saved value", async () => {
  const harness = createHarness({ savedSettings: { enabled: true, minPromptChars: 0 } });
  harness.flags.set("prompt-autocomplete-min-chars", "1");
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /min-chars=0\(saved\)/);
});

test("bare set dumps status and set min-chars dispatches to the canonical command", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");

  await command(harness, "set");
  assert.match(lastStatus(harness), /enabled=yes\(saved\)/);
  assert.match(lastStatus(harness), /debounce=350ms\(flag\)/);
  assert.match(lastStatus(harness), /requested-model=current active model\(flag\)/);
  assert.match(lastStatus(harness), /max-suggestion-chars=160\(flag\)/);
  assert.match(lastStatus(harness), /max-alternatives=3\(flag\)/);

  await command(harness, "set min-chars 0");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true, minPromptChars: 0 });
  await command(harness, "set min-chars");
  assert.match(lastStatus(harness), /min-chars is 0 \(session\)/);
});

test("set persists remaining runtime knobs and reports their sources", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");

  await command(harness, "set Debounce-MS 100");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true, debounceMs: 100 });
  await command(harness, "set max-chars 240");
  assert.deepEqual(harness.settingsSaves.at(-1), { enabled: true, debounceMs: 100, maxSuggestionChars: 240 });
  await command(harness, "set max-alternatives 5");
  assert.deepEqual(harness.settingsSaves.at(-1), {
    enabled: true,
    debounceMs: 100,
    maxSuggestionChars: 240,
    maxAlternatives: 5,
  });
  await command(harness, "set model openai/GPT-5.4-Mini");
  assert.deepEqual(harness.settingsSaves.at(-1), {
    enabled: true,
    debounceMs: 100,
    maxSuggestionChars: 240,
    maxAlternatives: 5,
    model: "openai/GPT-5.4-Mini",
  });
  assert.ok(
    harness.notifications.some((entry) =>
      entry.message.includes("current draft and recent conversation context")
    ),
    "a cross-provider model change must restate the privacy notice",
  );

  await command(harness, "status");
  assert.match(lastStatus(harness), /debounce=100ms\(session\)/);
  assert.match(lastStatus(harness), /max-suggestion-chars=240\(session\)/);
  assert.match(lastStatus(harness), /max-alternatives=5\(session\)/);
  assert.match(lastStatus(harness), /requested-model=openai\/GPT-5.4-Mini\(session\)/);

  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /debounce=100ms\(session\)/);

  const next = createHarness({ savedSettings: harness.getStoredSettings() });
  await emit(next, "session_start");
  await command(next, "status");
  assert.match(lastStatus(next), /debounce=100ms\(saved\)/);
  assert.match(lastStatus(next), /max-suggestion-chars=240\(saved\)/);
  assert.match(lastStatus(next), /max-alternatives=5\(saved\)/);
  assert.match(lastStatus(next), /requested-model=openai\/GPT-5.4-Mini\(saved\)/);
});

test("set model active persists the sentinel and out-of-range values are rejected", async () => {
  const harness = createHarness({ savedSettings: { enabled: true, model: "openai/gpt-mini" } });
  await emit(harness, "session_start");

  await command(harness, "set model active");
  assert.equal(harness.getStoredSettings().model, "active");
  await command(harness, "status");
  assert.match(lastStatus(harness), /requested-model=current active model\(session\)/);

  const before = harness.getStoredSettings();
  await command(harness, "set debounce-ms 5001");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete set debounce-ms <0-5000>/);
  await command(harness, "set max-chars 15");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete set max-chars <16-1000>/);
  await command(harness, "set max-alternatives 0");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete set max-alternatives <1-5>/);
  await command(harness, "set timeout 1");
  assert.match(lastStatus(harness), /set \[debounce-ms/);
  assert.deepEqual(harness.getStoredSettings(), before);
});

test("an invalid or unusable set model leaves the previous config and does not persist", async () => {
  const harness = createHarness({
    savedSettings: { enabled: true, debounceMs: 100 },
    findModel: (provider, id) => (provider === "missing" ? undefined : { provider, id }),
    hasConfiguredAuth: (model) => model.provider === "test-provider",
  });
  await emit(harness, "session_start");
  const before = harness.getStoredSettings();

  await command(harness, "set model not-a-model");
  assert.match(lastStatus(harness), /not a provider\/model reference/);
  await command(harness, "set model missing/model-x");
  assert.match(lastStatus(harness), /is unknown/);
  await command(harness, "set model locked/model-y");
  assert.match(lastStatus(harness), /has no configured auth/);
  assert.deepEqual(harness.getStoredSettings(), before);

  await command(harness, "status");
  assert.match(lastStatus(harness), /requested-model=current active model\(flag\)/);
  assert.match(lastStatus(harness), /debounce=100ms\(saved\)/);
});

test("set model active is rejected while the known active model is unusable", async () => {
  const harness = createHarness({
    savedSettings: { enabled: true, model: "openai/gpt-mini" },
    hasConfiguredAuth: (model) => model.provider === "openai",
  });
  await emit(harness, "session_start");

  await command(harness, "set model active");
  assert.match(lastStatus(harness), /could not set the model to active/);
  assert.equal(harness.settingsSaves.length, 0);
  assert.equal(harness.getStoredSettings().model, "openai/gpt-mini");

  await command(harness, "status");
  assert.match(lastStatus(harness), /requested-model=openai\/gpt-mini\(saved\)/);
});

test("set model active stays committable when no active model is known yet", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");
  // A model event without a model clears the known active model, as on sparse
  // hosts that never forward one.
  await emit(harness, "model_select");

  await command(harness, "set model active");
  assert.equal(harness.getStoredSettings().model, "active");

  await command(harness, "status");
  assert.match(lastStatus(harness), /requested-model=current active model\(session\)/);
});

test("a cross-provider change restates the privacy notice even when the old model is unusable", async () => {
  const harness = createHarness({
    savedSettings: { enabled: true, model: "openai/gpt-mini" },
    findModel: (provider) => (provider === "openai" ? undefined : { provider, id: "model" }),
  });
  await emit(harness, "session_start");

  await command(harness, "set model active");
  assert.ok(
    harness.notifications.some((entry) =>
      entry.message.includes("current draft and recent conversation context")
    ),
    "a provider change from an unusable dedicated model still restates the privacy notice",
  );
  assert.equal(harness.getStoredSettings().model, "active");
});

test("a failed settings save does not claim durability in the success notice", async () => {
  const harness = createHarness({ enabled: true, failingSettingsSave: true });
  await emit(harness, "session_start");

  await command(harness, "set max-chars 240");
  const messages = harness.notifications.map((entry) => entry.message);
  assert.ok(messages.some((message) => message.includes("could not save the setting")));
  assert.ok(messages.some((message) => message.includes("session only")));
  assert.ok(!messages.some((message) => message.includes("saved for future sessions")));

  await command(harness, "status");
  assert.match(lastStatus(harness), /max-suggestion-chars=240\(session\)/);
});

test("an explicit non-default runtime flag outranks the saved set value", async () => {
  const harness = createHarness({
    savedSettings: { enabled: true, debounceMs: 100, maxSuggestionChars: 240, maxAlternatives: 5, model: "openai/saved" },
  });
  harness.flags.set("prompt-autocomplete-debounce-ms", "250");
  harness.flags.set("prompt-autocomplete-max-chars", "320");
  harness.flags.set("prompt-autocomplete-max-alternatives", "2");
  harness.flags.set("prompt-autocomplete-model", "anthropic/flag");
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /debounce=250ms\(flag\)/);
  assert.match(lastStatus(harness), /max-suggestion-chars=320\(flag\)/);
  assert.match(lastStatus(harness), /max-alternatives=2\(flag\)/);
  assert.match(lastStatus(harness), /requested-model=anthropic\/flag\(flag\)/);
});

test("a defaulted runtime flag defers to the saved set value", async () => {
  const harness = createHarness({
    savedSettings: { enabled: true, debounceMs: 100, model: "openai/saved" },
  });
  harness.flags.set("prompt-autocomplete-debounce-ms", "350");
  harness.flags.set("prompt-autocomplete-model", "current active model");
  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /debounce=100ms\(saved\)/);
  assert.match(lastStatus(harness), /requested-model=openai\/saved\(saved\)/);
});

test("budget reports, validates, and stays out of the settings file", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");

  await command(harness, "budget");
  assert.match(lastStatus(harness), /budget is off \(flag\); 0 provider requests used this session/);

  await command(harness, "budget 0");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete budget <1-100000\|off>/);
  await command(harness, "budget nonsense");
  assert.match(lastStatus(harness), /Usage: \/prompt-autocomplete budget <1-100000\|off>/);

  await command(harness, "budget 5");
  assert.match(lastStatus(harness), /budget set to 5 provider requests per session/);
  await command(harness, "status");
  assert.match(lastStatus(harness), /budget=0\/5\(session\)/);

  await command(harness, "budget off");
  await command(harness, "status");
  assert.match(lastStatus(harness), /budget=off\(session\)/);

  // The ceiling is session state: the process-wide settings file never sees it.
  for (const saved of harness.settingsSaves) {
    assert.deepEqual(Object.keys(saved).sort(), ["enabled"]);
  }
  assert.deepEqual(harness.getStoredSettings(), { enabled: true });
});

test("a restored budget snapshot defers to an explicit flag but outranks the default", async () => {
  const snapshot = {
    type: "custom",
    customType: "prompt-autocomplete-stats",
    data: { schemaVersion: 1, physicalSessionId: "session-1", limit: 4, used: 3 },
  };

  const restored = createHarness({ savedSettings: { enabled: true }, branch: [snapshot] });
  await emit(restored, "session_start");
  await command(restored, "status");
  assert.match(lastStatus(restored), /budget=3\/4\(saved\)/);

  const flagged = createHarness({ savedSettings: { enabled: true }, branch: [snapshot] });
  flagged.flags.set("prompt-autocomplete-max-requests", "9");
  await emit(flagged, "session_start");
  await command(flagged, "status");
  assert.match(lastStatus(flagged), /budget=3\/9\(flag\)/, "an explicit flag outranks the restored ceiling");

  const defaulted = createHarness({ savedSettings: { enabled: true }, branch: [snapshot] });
  defaulted.flags.set("prompt-autocomplete-max-requests", "off");
  await emit(defaulted, "session_start");
  await command(defaulted, "status");
  assert.match(lastStatus(defaulted), /budget=3\/4\(saved\)/, "the registered default defers to the restored ceiling");

  const forked = createHarness({ savedSettings: { enabled: true }, branch: [snapshot], sessionId: "session-2" });
  await emit(forked, "session_start");
  await command(forked, "status");
  assert.match(lastStatus(forked), /budget=off\(flag\)/, "a forked session ignores another session's snapshot");
});

test("a budget decision outlives a repeated session_start on the same runtime", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");
  await command(harness, "budget 2");

  await emit(harness, "session_start");
  await command(harness, "status");
  assert.match(lastStatus(harness), /budget=0\/2\(session\)/, "the ceiling persists in process while usage resets");
});

const conversationBranch = [
  { type: "message", message: { role: "user", content: "Please harden the parser" } },
  { type: "message", message: { role: "assistant", content: "The implementation is ready for review" } },
];

test("read-only commands report on a non-interactive host while changes stay TUI-only", async () => {
  const harness = createHarness({ enabled: true, mode: "rpc", branch: conversationBranch });
  await emit(harness, "session_start");
  for (const event of ["agent_start", "agent_end", "agent_settled", "model_select", "session_tree"]) {
    await emit(harness, event);
  }

  await command(harness, "status");
  assert.match(lastStatus(harness), /^host=non-interactive \| enabled=yes\(flag\) \| editor=unavailable/);
  assert.doesNotMatch(lastStatus(harness), /keys=/, "keys cannot be used without an interactive editor");
  await command(harness, "stats");
  assert.match(lastStatus(harness), /^Prompt Autocomplete — current session/);
  await command(harness, "inspect Review the parser");
  assert.match(lastStatus(harness), /automatic blocked \(this host has no interactive editor\)/);

  for (const mutating of [
    "on",
    "off",
    "toggle",
    "min-chars 3",
    "budget 2",
    "set debounce-ms 100",
    "stream off",
    "while-streaming on",
    "debug-on",
  ]) {
    await command(harness, mutating);
    assert.match(lastStatus(harness), /requires interactive TUI mode/, `${mutating} must stay TUI-only`);
  }
  assert.equal(harness.settingsSaves.length, 0);
  assert.equal(harness.editorSetCalls.length, 0);
  assert.equal(harness.getProviderCalls(), 0, "no provider seam is reachable outside the TUI");
});

test("hosts without a notification channel refuse every command and stay silent", async () => {
  for (const mode of ["print", "json"] as const) {
    const harness = createHarness({ enabled: true, mode });
    await emit(harness, "session_start");
    assert.ok(!harness.notifications.some((entry) => entry.message.includes("no autocomplete requests")));
    await command(harness, "status");
    assert.match(lastStatus(harness), /requires interactive TUI mode/);
    assert.equal(harness.editorSetCalls.length, 0);
    assert.equal(harness.getProviderCalls(), 0);
  }
});

test("an enabled extension on a non-interactive host says once per process that it cannot issue requests", async () => {
  const notice = "no autocomplete requests will be issued";
  const count = (harness: ReturnType<typeof createHarness>) =>
    harness.notifications.filter((entry) => entry.message.includes(notice)).length;

  // Pi re-imports the extension for every runtime (/new, /resume, /fork,
  // /reload); a fresh factory sharing the process state emulates that.
  const processState: PromptAutocompleteProcessState = {};
  const first = createHarness({ enabled: true, mode: "rpc", processState });
  await emit(first, "session_start");
  await emit(first, "session_start");
  assert.equal(count(first), 1);
  const reloaded = createHarness({ enabled: true, mode: "rpc", processState });
  await emit(reloaded, "session_start");
  assert.equal(count(reloaded), 0, "a replaced runtime in the same process stays quiet");

  const nextProcess = createHarness({ enabled: true, mode: "rpc", processState: {} });
  await emit(nextProcess, "session_start");
  assert.equal(count(nextProcess), 1, "a new process says it again");

  const disabled = createHarness({ enabled: false, mode: "rpc" });
  await emit(disabled, "session_start");
  assert.ok(!disabled.notifications.some((entry) => entry.message.includes(notice)));

  const tui = createHarness({ enabled: true, mode: "tui" });
  await emit(tui, "session_start");
  assert.ok(!tui.notifications.some((entry) => entry.message.includes(notice)));
});

test("inspection without a draft reports conversation sections and never invents a draft", async () => {
  const harness = createHarness({ savedSettings: { enabled: true }, branch: conversationBranch });
  await emit(harness, "session_start");
  await command(harness, "inspect");

  const report = lastStatus(harness);
  assert.match(report, /^Prompt Autocomplete — request inspection \(local only; no provider request was made\)/);
  assert.match(report, /Draft: not available — the slash command replaced the editor text/);
  assert.match(report, /one user message whose size depends on the draft/);
  assert.match(report, /Latest user message: 24 chars sent/);
  assert.match(report, /Recent conversation: \d+ chars sent \(up to 6 messages × 600 chars\)/);
  assert.match(report, /Output: up to 3 alternatives × 160 chars, at most \d+ output tokens/);
  assert.match(report, /Not evaluated here \(live editor state\)/);
  assert.match(report, /never sent; credentials and headers are never shown/);
  assert.doesNotMatch(report, /test-key|apiKey|Authorization/);
  assert.equal(harness.getProviderCalls(), 0);
});

test("inspection applies the shared draft policy and reports the budget", async () => {
  const exhausted = {
    type: "custom",
    customType: "prompt-autocomplete-stats",
    data: { schemaVersion: 1, physicalSessionId: "session-1", limit: 1, used: 1 },
  };
  const harness = createHarness({ savedSettings: { enabled: true, minPromptChars: 5 }, branch: [exhausted] });
  await emit(harness, "session_start");

  await command(harness, "inspect hi");
  assert.match(
    lastStatus(harness),
    /automatic blocked \(the draft is shorter than min-chars \(5\)\) · manual blocked \(the session budget is exhausted \(1\/1\)\)/,
  );
  assert.match(lastStatus(harness), /budget=1\/1\(saved\)/);

  await command(harness, "inspect /help");
  assert.match(lastStatus(harness), /automatic blocked \(the draft looks like a slash command or path\)/);
  assert.equal(harness.getProviderCalls(), 0);
});

test("inspection output is sanitized and bounded", async () => {
  const hostile = `\x1b]0;pwned\x07\x1b[31mred\x1b[0m ${"x".repeat(10_000)}\u202e`;
  const harness = createHarness({
    savedSettings: { enabled: true },
    branch: [{ type: "message", message: { role: "assistant", content: hostile } }],
  });
  await emit(harness, "session_start");
  await command(harness, `inspect \x1b[2Jdraft ${"y".repeat(5_000)}`);

  const report = lastStatus(harness);
  assert.doesNotMatch(report, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202E]/, "no terminal controls or bidi overrides");
  assert.doesNotMatch(report, /pwned/);
  assert.match(report, /Latest assistant message: \d+ chars sent \(cap 3000\)/);
  assert.match(report, /Draft: 5010 chars, 2000 sent \(only the last 2000 are sent\)/);
  for (const line of report.split("\n")) {
    assert.ok(line.length <= 400, `every report line stays bounded: ${line.length}`);
  }
});

test("a proven no-op editor host stays inactive in a later runtime of the same process", async () => {
  const processState: PromptAutocompleteProcessState = {};
  const host = { enabled: true, omitMode: true, hasUI: true, noOpEditorSlot: true, processState } as const;
  const first = createHarness(host);
  await emit(first, "session_start");
  assert.equal(first.editorSetCalls.length, 1, "the first runtime probes the host once");

  const reloaded = createHarness(host);
  await emit(reloaded, "session_start");
  assert.equal(reloaded.editorSetCalls.length, 0, "a replaced runtime does not probe the proven host again");
  assert.ok(
    !reloaded.notifications.some((entry) => /installs custom editors in the terminal process/.test(entry.message)),
    "the proven limitation is not reported again",
  );
  await command(reloaded, "on");
  assert.equal(reloaded.editorSetCalls.length, 0);
  assert.match(lastStatus(reloaded), /requires interactive TUI mode/);
});

test("a corrupt or frozen process-state occupant is replaced instead of trusted", async () => {
  const key = Symbol.for("@kliebhan/pi-prompt-autocomplete/process-state");
  const original = Reflect.getOwnPropertyDescriptor(globalThis, key);
  const notice = "no autocomplete requests will be issued";
  const occupy = (descriptor: PropertyDescriptor) => {
    Reflect.deleteProperty(globalThis, key);
    assert.ok(Reflect.defineProperty(globalThis, key, { configurable: true, ...descriptor }));
  };
  try {
    const throwingProxy = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("hostile trap");
      },
    });
    const accessor = {};
    Object.defineProperty(accessor, "hostInstallsEditors", { get: () => false, enumerable: true });
    for (const occupant of [
      { nonInteractiveNoticeShown: "false" },
      Object.freeze({}),
      "not-an-object",
      Object.create({ nonInteractiveNoticeShown: true }),
      accessor,
      throwingProxy,
    ]) {
      occupy({ value: occupant, writable: true });
      const harness = createHarness({ enabled: true, mode: "rpc", useProcessGlobal: true });
      await emit(harness, "session_start");
      assert.equal(
        harness.notifications.filter((entry) => entry.message.includes(notice)).length,
        1,
        "an invalid occupant must neither suppress the notice nor throw",
      );
    }

    // An inherited negative probe result must not block a real interactive host.
    occupy({ value: Object.create({ hostInstallsEditors: false }), writable: true });
    const tui = createHarness({ enabled: true, mode: "tui", useProcessGlobal: true });
    await emit(tui, "session_start");
    assert.equal(tui.editorSetCalls.length, 1);

    // A non-writable but configurable slot is still claimed, so later runtimes share it.
    occupy({ value: "corrupt", writable: false });
    const first = createHarness({ enabled: true, mode: "rpc", useProcessGlobal: true });
    await emit(first, "session_start");
    const reloaded = createHarness({ enabled: true, mode: "rpc", useProcessGlobal: true });
    await emit(reloaded, "session_start");
    assert.equal(first.notifications.filter((entry) => entry.message.includes(notice)).length, 1);
    assert.equal(reloaded.notifications.filter((entry) => entry.message.includes(notice)).length, 0);
  } finally {
    Reflect.deleteProperty(globalThis, key);
    if (original) Reflect.defineProperty(globalThis, key, original);
  }
});

test("the registered command completes arguments locally without a global provider", async () => {
  const harness = createHarness({ savedSettings: { enabled: true } });
  const definition = harness.commandDefinitions.get("prompt-autocomplete");
  assert.ok(definition?.getArgumentCompletions, "the command registers argument completions");
  assert.deepEqual(definition.getArgumentCompletions("stream o"), completePromptAutocompleteArguments("stream o"));
  assert.equal(definition.getArgumentCompletions("stats"), null);

  await emit(harness, "session_start");
  for (const args of ["off", "on", "toggle", "toggle"]) await command(harness, args);
  await emit(harness, "session_shutdown");
  assert.deepEqual(harness.autocompleteProviders, [], "no global autocomplete provider is ever installed");
  assert.equal(harness.getProviderCalls(), 0, "completion never reaches a provider");
});

test("every grammar command dispatches, and unknown commands show the usage", async () => {
  for (const spec of PROMPT_AUTOCOMPLETE_COMMANDS) {
    const harness = createHarness({ savedSettings: { enabled: true } });
    await emit(harness, "session_start");
    await command(harness, spec.name);
    assert.doesNotMatch(lastStatus(harness), /^Usage: \/prompt-autocomplete \[/, `${spec.name} is dispatched`);
    assert.doesNotMatch(lastStatus(harness), /requires interactive TUI mode/);
  }
  const harness = createHarness({ savedSettings: { enabled: true } });
  await emit(harness, "session_start");
  await command(harness, "bogus");
  assert.equal(lastStatus(harness), PROMPT_AUTOCOMPLETE_USAGE);
  await command(harness, "set bogus 1");
  assert.equal(lastStatus(harness), PROMPT_AUTOCOMPLETE_SET_USAGE);
});

test("the settings file keeps decisions other processes saved and fields it does not know", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-settings-"));
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ enabled: true, futureSetting: { kept: true } }), "utf8");
    // Two Pi processes: both load at activation, then save one decision each.
    const first = createPromptAutocompleteFileSettingsStore(path);
    const second = createPromptAutocompleteFileSettingsStore(path);
    assert.deepEqual(first.load(), { enabled: true });
    second.update({ minPromptChars: 3 });
    first.update({ debounceMs: 200, keys: { acceptLine: ["alt+l"] } });

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      enabled: true,
      futureSetting: { kept: true },
      minPromptChars: 3,
      debounceMs: 200,
      keys: { acceptLine: ["alt+l"] },
    });
    assert.deepEqual(readdirSync(dir), ["settings.json"], "no temporary file is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settings file that cannot be read is not replaced", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-settings-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ enabled: true, minPromptChars: 4 }), "utf8");
    chmodSync(path, 0o000);
    const store = createPromptAutocompleteFileSettingsStore(path);
    assert.deepEqual(store.load(), {}, "load stays non-throwing");
    assert.throws(() => store.update({ debounceMs: 200 }), /EACCES/);
    chmodSync(path, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: true, minPromptChars: 4 });
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved settings file is readable by its owner only", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-settings-"));
  try {
    const path = join(dir, "settings.json");
    createPromptAutocompleteFileSettingsStore(path).update({ enabled: true });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed settings save leaves no temporary file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-settings-"));
  try {
    // A non-empty directory where the file belongs makes the final rename fail.
    const path = join(dir, "settings.json");
    mkdirSync(join(path, "occupied"), { recursive: true });
    assert.throws(() => createPromptAutocompleteFileSettingsStore(path).update({ enabled: true }));
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
