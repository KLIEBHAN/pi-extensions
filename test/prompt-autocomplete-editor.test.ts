import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteProvider,
  CURSOR_MARKER,
  type EditorComponent,
  type EditorTheme,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  createPromptAutocompleteExtension,
  type PromptAutocompleteDependencies,
} from "../extensions/prompt-autocomplete/index.ts";

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<unknown> | unknown;
type EditorFactory = Exclude<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0], undefined>;
type CompleteSimple = NonNullable<PromptAutocompleteDependencies["completeSimple"]>;
type CompletionResult = Awaited<ReturnType<CompleteSimple>>;

const passthrough = (text: string): string => text;
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

function makeCompletion(completions: string[]): CompletionResult {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ completions }) }],
    stopReason: "stop",
  } as CompletionResult;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface EditorHarnessOptions {
  authConfigured?: boolean;
  completeSimple: CompleteSimple;
  debounceMs?: number;
  maxAlternatives?: number;
  now?: () => number;
  preferredModel?: string;
}

function createEditorHarness(options: EditorHarnessOptions) {
  const flags = new Map<string, boolean | string>([
    ["prompt-autocomplete", true],
    ["prompt-autocomplete-debounce-ms", String(options.debounceMs ?? 0)],
    ["prompt-autocomplete-max-alternatives", String(options.maxAlternatives ?? 3)],
  ]);
  if (options.preferredModel) flags.set("prompt-autocomplete-model", options.preferredModel);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const notifications: string[] = [];
  let editorFactory: EditorFactory | undefined;
  let renderRequests = 0;
  let branch: unknown[] = [];
  let model = { provider: "test-provider", id: "model-a" };

  const ui = {
    getEditorComponent: () => editorFactory,
    setEditorComponent: (factory: EditorFactory | undefined) => {
      editorFactory = factory;
    },
    setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
    notify: (message: string) => notifications.push(message),
  };
  const modelRegistry = {
    find: (provider: string, id: string) => ({ provider, id }),
    hasConfiguredAuth: () => options.authConfigured ?? true,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
  };
  const sessionManager = {
    getBranch: () => branch,
    getLeafId: () => "leaf-1",
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    get model() {
      return model;
    },
    modelRegistry,
    sessionManager,
    ui,
  } as unknown as ExtensionContext;
  const pi = {
    registerFlag(name: string, definition: { default?: boolean | string }) {
      if (!flags.has(name) && definition.default !== undefined) flags.set(name, definition.default);
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

  createPromptAutocompleteExtension({
    completeSimple: options.completeSimple,
    now: options.now,
  })(pi);

  const tui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: () => {
      renderRequests += 1;
    },
  } as unknown as TUI;

  return {
    commands,
    ctx,
    handlers,
    notifications,
    widgets,
    createEditor: async (): Promise<EditorComponent> => {
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      assert.ok(editorFactory, "session_start should install an editor factory");
      const keybindings = { matches: () => false } as unknown as KeybindingsManager;
      return editorFactory(tui, editorTheme, keybindings);
    },
    emit: async (name: string, event: unknown = {}) => {
      await handlers.get(name)?.(event, ctx);
    },
    command: async (args: string) => {
      await commands.get("prompt-autocomplete")?.(args, ctx);
    },
    getEditorFactory: () => editorFactory,
    getRenderRequests: () => renderRequests,
    replaceEditorExternally: (factory: EditorFactory | undefined) => {
      editorFactory = factory;
    },
    setBranch: (nextBranch: unknown[]) => {
      branch = nextBranch;
    },
    setModel: (nextModel: { provider: string; id: string }) => {
      model = nextModel;
    },
  };
}

function renderedText(editor: EditorComponent, width = 80): string {
  return editor.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

const CTRL_DOT = "\x1b[46;5u";
const CTRL_SPACE = "\x1b[32;5u";

test("editor renders and accepts full and word-level suggestions", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return calls === 1
        ? makeCompletion([" the implementation carefully"])
        : makeCompletion([]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();

  assert.match(renderedText(editor), /the implementation carefully/);
  assert.equal(
    harness.widgets.filter((entry) => entry.key === "prompt-autocomplete-spinner").at(-1)?.content,
    undefined,
  );
  editor.handleInput(CTRL_SPACE);
  assert.equal(editor.getText(), "Review the ");
  await flushAsyncWork();

  editor.setText("Review");
  await flushAsyncWork();
  editor.handleInput("\t");
  assert.equal(editor.getText(), "Review the implementation carefully");
  assert.ok(harness.getRenderRequests() > 0);
});

test("provider request contains bounded conversation context and inline UX limits", async () => {
  let capturedModel: unknown;
  let capturedContext: any;
  let capturedOptions: any;
  const harness = createEditorHarness({
    completeSimple: (async (model, context, requestOptions) => {
      capturedModel = model;
      capturedContext = context;
      capturedOptions = requestOptions;
      return makeCompletion([" with tests"]);
    }) as CompleteSimple,
  });
  harness.setBranch([
    { type: "message", message: { role: "user", content: "Please harden the parser" } },
    { type: "message", message: { role: "assistant", content: "The implementation is ready for review" } },
  ]);
  const editor = await harness.createEditor();
  editor.setText("Review it");
  await flushAsyncWork();

  assert.deepEqual(capturedModel, { provider: "test-provider", id: "model-a" });
  assert.match(capturedContext.systemPrompt, /inline prompt suggestions/);
  const requestText = capturedContext.messages[0].content[0].text;
  assert.match(requestText, /Latest assistant message.*implementation is ready for review/s);
  assert.match(requestText, /Latest user message.*Please harden the parser/s);
  assert.match(requestText, /Current draft.*Review it/s);
  assert.equal(capturedOptions.timeoutMs, 8_000);
  assert.equal(capturedOptions.maxRetries, 0);
  assert.equal(capturedOptions.maxRetryDelayMs, 2_000);
  assert.ok(capturedOptions.maxTokens >= 192);
  assert.ok(capturedOptions.signal instanceof AbortSignal);
});

test("dedicated model selection is honored and missing auth suppresses requests", async () => {
  let selectedModel: unknown;
  const dedicated = createEditorHarness({
    preferredModel: "fast/model-b",
    completeSimple: (async (model) => {
      selectedModel = model;
      return makeCompletion([" dedicated"]);
    }) as CompleteSimple,
  });
  const dedicatedEditor = await dedicated.createEditor();
  dedicatedEditor.setText("Select");
  await flushAsyncWork();
  assert.deepEqual(selectedModel, { provider: "fast", id: "model-b" });

  let unauthenticatedCalls = 0;
  const unauthenticated = createEditorHarness({
    authConfigured: false,
    completeSimple: (async () => {
      unauthenticatedCalls += 1;
      return makeCompletion([" forbidden"]);
    }) as CompleteSimple,
  });
  const unauthenticatedEditor = await unauthenticated.createEditor();
  unauthenticatedEditor.setText("No auth");
  await flushAsyncWork();
  assert.equal(unauthenticatedCalls, 0);
  assert.doesNotMatch(renderedText(unauthenticatedEditor), /forbidden/);
});

test("automatic suppression and manual intent follow the configured gates", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" suggestion"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("");
  editor.setText("/settings");
  editor.setText("Read @README.md");
  await flushAsyncWork();
  assert.equal(calls, 0);

  await harness.emit("agent_start");
  editor.setText("Manual while streaming");
  await flushAsyncWork();
  assert.equal(calls, 0);
  editor.handleInput(CTRL_DOT);
  await flushAsyncWork();
  assert.equal(calls, 1, "manual one-shot should bypass streaming and minimum-character gates");

  await harness.emit("agent_end");
  await flushAsyncWork();
  editor.handleInput("\x1b[D");
  editor.insertTextAtCursor?.("x");
  await flushAsyncWork();
  assert.equal(calls, 1, "editing away from the draft end must not issue another request");
});

test("provider failures enter cooldown while manual one-shot can retry", async () => {
  let now = 50_000;
  let calls = 0;
  const harness = createEditorHarness({
    now: () => now,
    completeSimple: (async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider failure");
      return makeCompletion([" recovered"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Failure");
  await flushAsyncWork();
  assert.equal(calls, 1);
  assert.doesNotMatch(renderedText(editor), /recovered/);

  editor.setText("Failure again");
  await flushAsyncWork();
  assert.equal(calls, 1, "automatic refresh must respect the cooldown");

  editor.handleInput(CTRL_DOT);
  await flushAsyncWork();
  assert.equal(calls, 2);
  assert.match(renderedText(editor), /recovered/);

  now += 5_000;
});

test("manual one-shot bypasses a settled cache entry", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    maxAlternatives: 1,
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([calls === 1 ? " cached" : " refreshed"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Use");
  await flushAsyncWork();
  assert.equal(calls, 1);
  assert.match(renderedText(editor), /cached/);

  editor.setText("Use");
  await flushAsyncWork();
  assert.equal(calls, 1, "same draft should reuse the settled cache");

  editor.handleInput(CTRL_DOT);
  await flushAsyncWork();
  assert.equal(calls, 2);
  assert.match(renderedText(editor), /refreshed/);
});

test("integrated request cache expires after its TTL", async () => {
  let now = 10_000;
  let calls = 0;
  const harness = createEditorHarness({
    now: () => now,
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([` result-${calls}`]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("Cache");
  await flushAsyncWork();
  editor.setText("Cache");
  await flushAsyncWork();
  assert.equal(calls, 1);

  now += 60_000;
  editor.setText("Cache");
  await flushAsyncWork();
  assert.equal(calls, 2);
  assert.match(renderedText(editor), /result-2/);
});

test("same draft with changed conversation context misses the integrated cache", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([` context-${calls}`]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  harness.setBranch([{ type: "message", message: { role: "assistant", content: "Context A" } }]);
  editor.setText("Contextual");
  await flushAsyncWork();
  editor.setText("Contextual");
  await flushAsyncWork();
  assert.equal(calls, 1);

  harness.setBranch([{ type: "message", message: { role: "assistant", content: "Context B" } }]);
  editor.setText("Contextual");
  await flushAsyncWork();
  assert.equal(calls, 2);
  assert.match(renderedText(editor), /context-2/);
});

test("stale request results are discarded after a newer draft wins", async () => {
  const first = deferred<CompletionResult>();
  const second = deferred<CompletionResult>();
  const signals: AbortSignal[] = [];
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async (_model, _context, requestOptions) => {
      signals.push(requestOptions?.signal as AbortSignal);
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("First");
  await flushAsyncWork();
  editor.setText("Second");
  await flushAsyncWork();
  assert.equal(signals[0]?.aborted, true);

  first.resolve(makeCompletion([" stale"]));
  await flushAsyncWork();
  assert.equal(calls, 2, "settling the stale request must not restart or duplicate the newer request");
  assert.notEqual(
    harness.widgets.filter((entry) => entry.key === "prompt-autocomplete-spinner").at(-1)?.content,
    undefined,
    "the newer request must retain spinner ownership while pending",
  );
  assert.doesNotMatch(renderedText(editor), /stale/);

  second.resolve(makeCompletion([" winner"]));
  await flushAsyncWork();
  assert.match(renderedText(editor), /winner/);
  assert.equal(
    harness.widgets.filter((entry) => entry.key === "prompt-autocomplete-spinner").at(-1)?.content,
    undefined,
  );
});

test("disabling or shutting down clears a scheduled debounce before it can call the provider", async () => {
  for (const scenario of ["off", "shutdown"] as const) {
    let calls = 0;
    const harness = createEditorHarness({
      debounceMs: 50,
      completeSimple: (async () => {
        calls += 1;
        return makeCompletion([" too late"]);
      }) as CompleteSimple,
    });
    const editor = await harness.createEditor();
    editor.setText(`Debounce ${scenario}`);
    await flushAsyncWork();
    assert.equal(calls, 0);

    if (scenario === "off") {
      await harness.command("off");
    } else {
      await harness.emit("session_shutdown", { reason: "reload" });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    assert.equal(calls, 0, `${scenario} must clear the debounce timer`);
    assert.equal(
      harness.widgets.filter((entry) => entry.key === "prompt-autocomplete-spinner").at(-1)?.content,
      undefined,
    );
  }
});

test("turning off, shutdown, and editor ownership loss abort active requests", async () => {
  for (const scenario of ["off", "shutdown", "ownership-loss"] as const) {
    const pending = deferred<CompletionResult>();
    let signal: AbortSignal | undefined;
    const harness = createEditorHarness({
      completeSimple: (async (_model, _context, requestOptions) => {
        signal = requestOptions?.signal;
        return pending.promise;
      }) as CompleteSimple,
    });
    const editor = await harness.createEditor();
    editor.setText(`Pending ${scenario}`);
    await flushAsyncWork();
    assert.equal(signal?.aborted, false);

    if (scenario === "off") {
      await harness.command("off");
    } else if (scenario === "shutdown") {
      await harness.emit("session_shutdown", { reason: "reload" });
    } else {
      harness.replaceEditorExternally((() => ({ })) as unknown as EditorFactory);
      editor.setText("ownership changed");
    }

    assert.equal(signal?.aborted, true, `${scenario} should abort the active provider request`);
    pending.resolve(makeCompletion([" must not render"]));
    await flushAsyncWork();
    assert.doesNotMatch(renderedText(editor), /must not render/);
  }
});

test("model changes and agent streaming transitions cancel stale work", async () => {
  const pending = deferred<CompletionResult>();
  const streamingPending = deferred<CompletionResult>();
  const signals: AbortSignal[] = [];
  const harness = createEditorHarness({
    completeSimple: (async (_model, _context, requestOptions) => {
      signals.push(requestOptions?.signal as AbortSignal);
      if (signals.length === 1) return pending.promise;
      if (signals.length === 3) return streamingPending.promise;
      return makeCompletion([" fresh model"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Model");
  await flushAsyncWork();

  harness.setModel({ provider: "test-provider", id: "model-b" });
  await harness.emit("model_select", {
    model: { provider: "test-provider", id: "model-b" },
    previousModel: { provider: "test-provider", id: "model-a" },
    source: "set",
  });
  await flushAsyncWork();
  assert.equal(signals[0]?.aborted, true);
  assert.match(renderedText(editor), /fresh model/);

  editor.setText("Streaming");
  await flushAsyncWork();
  const latestSignal = signals.at(-1);
  await harness.emit("agent_start");
  assert.equal(latestSignal?.aborted, true);
  streamingPending.resolve(makeCompletion([" stale streaming"]));
  await flushAsyncWork();
  assert.doesNotMatch(renderedText(editor), /fresh model|stale streaming/);
});

test("escape dismissal persists until a manual one-shot re-arms the same draft", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    maxAlternatives: 1,
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([calls === 1 ? " dismiss me" : " rearmed"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Escape");
  await flushAsyncWork();
  assert.match(renderedText(editor), /dismiss me/);

  editor.handleInput("\x1b");
  assert.doesNotMatch(renderedText(editor), /dismiss me/);
  editor.setText("Escape");
  await flushAsyncWork();
  assert.equal(calls, 1);
  assert.doesNotMatch(renderedText(editor), /dismiss me/);

  editor.handleInput(CTRL_DOT);
  await flushAsyncWork();
  assert.equal(calls, 2);
  assert.match(renderedText(editor), /rearmed/);
});

test("Pi built-in autocomplete keeps Tab precedence over ghost suggestions", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" ghost"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  const provider: AutocompleteProvider = {
    triggerCharacters: ["/"],
    async getSuggestions() {
      return { prefix: "/he", items: [{ value: "/help", label: "/help" }] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const next = [...lines];
      next[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(cursorCol)}`;
      return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
    },
  };
  editor.setAutocompleteProvider?.(provider);
  editor.handleInput("/");
  editor.handleInput("h");
  editor.handleInput("e");
  await flushAsyncWork();

  assert.equal(calls, 0, "slash commands must not call the model");
  editor.handleInput("\t");
  assert.equal(editor.getText(), "/help");
});

test("rendering preserves IME cursor marker and display widths for Unicode and narrow terminals", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () => makeCompletion([" 続きを確認する ✅"])) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  (editor as EditorComponent & { focused: boolean }).focused = true;
  editor.setText("次");
  await flushAsyncWork();

  const wideLines = editor.render(40);
  assert.ok(wideLines.some((line) => line.includes(CURSOR_MARKER)), "IME cursor marker must be preserved");
  assert.match(wideLines.map((line) => stripVTControlCharacters(line)).join("\n"), /続きを確認する/);

  editor.handleInput("\t");
  assert.equal(editor.getText(), "次 続きを確認する ✅");

  editor.setText("次");
  await flushAsyncWork();
  for (const width of [4, 8, 12, 20, 40]) {
    for (const line of editor.render(width)) {
      assert.ok(visibleWidth(line) <= width, `rendered line exceeds width ${width}: ${visibleWidth(line)}`);
    }
  }
});

test("newline previews remain compact while acceptance preserves the original newline", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () => makeCompletion(["\n  add verification details"])) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Plan");
  await flushAsyncWork();

  assert.match(renderedText(editor), /⏎\s+add verification details/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "Plan\n  add verification details");
});

test("multiple alternatives cycle without issuing another provider request", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" first", " second", " third"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Choose");
  await flushAsyncWork();
  assert.match(renderedText(editor), /first/);
  assert.match(renderedText(editor), /‹1\/3›/);

  editor.handleInput(CTRL_DOT);
  assert.match(renderedText(editor), /second/);
  assert.match(renderedText(editor), /‹2\/3›/);
  assert.equal(calls, 1);
});
