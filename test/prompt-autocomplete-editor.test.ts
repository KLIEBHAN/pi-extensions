import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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
type StreamSimple = NonNullable<PromptAutocompleteDependencies["streamSimple"]>;
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

function makeCompletion(completions: string[], usage?: unknown): CompletionResult {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify({ completions }) }],
    stopReason: "stop",
    ...(usage === undefined ? {} : { usage }),
  } as CompletionResult;
}

function makeUsage(input: number, output: number, cost: number): unknown {
  return { input, output, totalTokens: input + output, cost: { total: cost } };
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

function makeRawCompletion(
  text: string,
  options: { stopReason?: "stop" | "length" | "error" | "aborted"; usage?: unknown; errorMessage?: string } = {},
): CompletionResult {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: options.stopReason ?? "stop",
    ...(options.usage === undefined ? {} : { usage: options.usage }),
    ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
  } as CompletionResult;
}

function controlledStream() {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    delta(rawText: string, delta = "") {
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: makeRawCompletion(rawText),
      });
    },
    textEnd(rawText: string) {
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: rawText,
        partial: makeRawCompletion(rawText),
      });
    },
    done(completions: string[], usage?: unknown) {
      stream.push({ type: "done", reason: "stop", message: makeCompletion(completions, usage) });
      stream.end();
    },
    error(message: string, usage?: unknown, reason: "error" | "aborted" = "error") {
      stream.push({
        type: "error",
        reason,
        error: makeRawCompletion("", { stopReason: reason, usage, errorMessage: message }),
      });
      stream.end();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface EditorHarnessOptions {
  authConfigured?: boolean;
  completeSimple: CompleteSimple;
  streamSimple?: StreamSimple;
  streamSetting?: "on" | "off";
  debounceMs?: number;
  maxAlternatives?: number;
  now?: () => number;
  preferredModel?: string;
  /** Registry lookup; return undefined to emulate an unknown model. */
  findModel?: (provider: string, id: string) => { provider: string; id: string } | undefined;
  /** Per-model auth, for hosts where only some models are authenticated. */
  hasConfiguredAuth?: (model: { provider: string; id: string }) => boolean;
  /** Emulate forked hosts (prime-agent) whose ExtensionContext predates `mode`. */
  omitHostMode?: boolean;
}

function createEditorHarness(options: EditorHarnessOptions) {
  const flags = new Map<string, boolean | string>([
    ["prompt-autocomplete", true],
    ["prompt-autocomplete-debounce-ms", String(options.debounceMs ?? 0)],
    ["prompt-autocomplete-max-alternatives", String(options.maxAlternatives ?? 3)],
  ]);
  if (options.streamSetting) flags.set("prompt-autocomplete-stream", options.streamSetting);
  if (options.preferredModel) flags.set("prompt-autocomplete-model", options.preferredModel);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandHandler>();
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const notifications: string[] = [];
  let editorFactory: EditorFactory | undefined;
  let renderRequests = 0;
  let branch: unknown[] = [];
  let leafId = "leaf-1";
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
    find: (provider: string, id: string) =>
      options.findModel ? options.findModel(provider, id) : { provider, id },
    hasConfiguredAuth: (model: { provider: string; id: string }) =>
      options.hasConfiguredAuth ? options.hasConfiguredAuth(model) : (options.authConfigured ?? true),
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
  };
  const sessionManager = {
    getBranch: () => branch,
    getLeafId: () => leafId,
  };
  const ctx = {
    ...(options.omitHostMode ? {} : { mode: "tui" }),
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
    streamSimple: options.streamSimple,
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
    setLeafId: (nextLeafId: string) => {
      leafId = nextLeafId;
    },
    setModel: (nextModel: { provider: string; id: string }) => {
      model = nextModel;
    },
  };
}

function renderedText(editor: EditorComponent, width = 80): string {
  return editor.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function insertAtCursor(editor: EditorComponent, text: string): void {
  assert.ok(editor.insertTextAtCursor);
  editor.insertTextAtCursor(text);
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

test("a forked host without ExtensionContext.mode still renders and accepts suggestions", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    omitHostMode: true,
    completeSimple: (async () => {
      calls += 1;
      return calls === 1 ? makeCompletion([" the implementation carefully"]) : makeCompletion([]);
    }) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();

  assert.match(renderedText(editor), /the implementation carefully/);
  editor.handleInput("\t");
  assert.equal(editor.getText(), "Review the implementation carefully");

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";
  assert.doesNotMatch(status, /requires interactive TUI mode/);
  assert.match(status, /enabled=yes/);
  assert.match(status, /editor=mounted/);
});

test("streaming renders monotonic first-suggestion progress before terminal alternatives", async () => {
  const provider = controlledStream();
  let streamCalls = 0;
  let capturedOptions: any;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("completion path must not run");
    }) as CompleteSimple,
    streamSimple: ((_model, _context, options) => {
      streamCalls += 1;
      capturedOptions = options;
      return provider.stream;
    }) as StreamSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();

  assert.equal(streamCalls, 1);
  assert.ok(capturedOptions.signal instanceof AbortSignal);
  assert.equal(capturedOptions.timeoutMs, 8_000);
  assert.equal(capturedOptions.maxRetries, 0);

  provider.delta('{"completions":[" the imple', " the imple");
  await flushAsyncWork();
  assert.match(renderedText(editor), /the/);
  assert.doesNotMatch(renderedText(editor), /imple/);
  assert.doesNotMatch(renderedText(editor), /completions|\{\"/);
  assert.equal(
    harness.widgets.filter((entry) => entry.key === "prompt-autocomplete-spinner").at(-1)?.content,
    undefined,
    "the spinner should leave once useful ghost text is visible",
  );

  provider.delta('{"completions":[" the implementation care', "mentation care");
  await flushAsyncWork();
  assert.match(renderedText(editor), /the implementation/);
  assert.doesNotMatch(renderedText(editor), /care/);
  assert.doesNotMatch(renderedText(editor), /‹/);

  // text_end carries cumulative content as well as content. It must not be
  // appended to the prior deltas, which would duplicate the JSON.
  const completeJson = JSON.stringify({ completions: [" the implementation carefully", " with tests"] });
  provider.textEnd(completeJson);
  await flushAsyncWork();
  assert.match(renderedText(editor), /the implementation carefully/);
  assert.doesNotMatch(renderedText(editor), /‹/, "alternatives stay terminal-only");

  provider.done([" the implementation carefully", " with tests"], makeUsage(80, 20, 0.0003));
  await flushAsyncWork();
  assert.match(renderedText(editor), /‹1\/2›/);

  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /usage=1 req, 0 cached, 100 tok, ~\$0\.00030 est/);
  await harness.command("stats");
  assert.match(harness.notifications.at(-1) ?? "", /Suggestions: 1 offered, 0 accepted/);
});

test("accepting streamed partial text aborts without issuing an automatic second request", async () => {
  for (const acceptance of ["full", "word"] as const) {
    const provider = controlledStream();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const harness = createEditorHarness({
      completeSimple: (async () => {
        throw new Error("completion path must not run");
      }) as CompleteSimple,
      streamSimple: ((_model, _context, options) => {
        calls += 1;
        signal = options?.signal;
        return provider.stream;
      }) as StreamSimple,
    });
    const editor = await harness.createEditor();
    editor.setText("Draft");
    await flushAsyncWork();

    provider.delta('{"completions":[" accepted next word', " accepted next word");
    await flushAsyncWork();
    assert.match(renderedText(editor), /accepted next/);

    editor.handleInput(acceptance === "full" ? "\t" : CTRL_SPACE);
    assert.equal(editor.getText(), acceptance === "full" ? "Draft accepted next" : "Draft accepted ");
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1, "accepting a partial must not immediately buy another request");

    // The single consumer still receives the terminal aborted message so usage
    // already spent before cancellation remains visible in accounting.
    provider.error("Request was aborted", makeUsage(40, 5, 0.0001), "aborted");
    await flushAsyncWork();
    assert.doesNotMatch(renderedText(editor), /accepted next word/);
    assert.equal(calls, 1);

    await harness.command("status");
    assert.match(harness.notifications.at(-1) ?? "", /usage=1 req, 0 cached, 1 failed, 45 tok, ~\$0\.00010 est/);
    await harness.command("stats");
    assert.match(
      harness.notifications.at(-1) ?? "",
      acceptance === "full"
        ? /Suggestions: 1 offered, 1 accepted \(1 full, 0 word\/chunk\)/
        : /Suggestions: 1 offered, 1 accepted \(0 full, 1 word\/chunk\)/,
    );
  }
});

test("a request settles after the drain grace when a provider never terminates", async () => {
  const provider = controlledStream();
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("completion path must not run");
    }) as CompleteSimple,
    // This fake deliberately ignores both AbortSignal and timeoutMs and never
    // emits a terminal event.
    streamSimple: (() => provider.stream) as StreamSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Draft");
  await flushAsyncWork();
  provider.delta('{"completions":[" accepted partial text', " accepted partial text");
  await flushAsyncWork();

  editor.handleInput("\t");
  assert.equal(editor.getText(), "Draft accepted partial");
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  await flushAsyncWork();

  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /1 failed/);
  assert.match(harness.notifications.at(-1) ?? "", /0 tok\+/, "late usage is explicitly incomplete");
});

test("stream errors clear partial text and enter the existing cooldown", async () => {
  const provider = controlledStream();
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("completion path must not run");
    }) as CompleteSimple,
    streamSimple: (() => {
      calls += 1;
      return provider.stream;
    }) as StreamSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();
  provider.delta('{"completions":[" with tests and', " with tests and");
  await flushAsyncWork();
  assert.match(renderedText(editor), /with tests/);

  provider.error("stream failed", makeUsage(25, 4, 0.00008));
  await flushAsyncWork();
  assert.doesNotMatch(renderedText(editor), /with tests/);

  editor.setText("Review again");
  await flushAsyncWork();
  assert.equal(calls, 1, "automatic retry must respect the error cooldown");
});

test("newer drafts and conversation branches reject stale streamed progress", async () => {
  const first = controlledStream();
  const second = controlledStream();
  const third = controlledStream();
  const streams = [first, second, third];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("completion path must not run");
    }) as CompleteSimple,
    streamSimple: ((_model, _context, options) => {
      signals.push(options?.signal as AbortSignal);
      return streams[calls++]!.stream;
    }) as StreamSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("First");
  await flushAsyncWork();
  editor.setText("Second");
  await flushAsyncWork();
  assert.equal(signals[0]?.aborted, true);
  first.delta('{"completions":[" stale draft text', " stale draft text");
  await flushAsyncWork();
  assert.doesNotMatch(renderedText(editor), /stale draft/);

  second.delta('{"completions":[" current draft text', " current draft text");
  await flushAsyncWork();
  assert.match(renderedText(editor), /current draft/);

  harness.setLeafId("leaf-2");
  harness.setBranch([{ type: "message", message: { role: "assistant", content: "Different branch" } }]);
  await harness.emit("session_tree", { oldLeafId: "leaf-1", newLeafId: "leaf-2" });
  await flushAsyncWork();
  assert.equal(signals[1]?.aborted, true);
  second.delta('{"completions":[" stale branch text', " stale branch text");
  await flushAsyncWork();
  assert.doesNotMatch(renderedText(editor), /current draft|stale branch/);

  third.delta('{"completions":[" fresh branch text', " fresh branch text");
  await flushAsyncWork();
  assert.match(renderedText(editor), /fresh branch/);

  first.error("aborted", undefined, "aborted");
  second.error("aborted", undefined, "aborted");
  third.done([" fresh branch text"]);
  await flushAsyncWork();
});

test("turning response streaming off cancels active work and applies on the next edit", async () => {
  const provider = controlledStream();
  let streamSignal: AbortSignal | undefined;
  let streamCalls = 0;
  let completeCalls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      completeCalls += 1;
      return makeCompletion([" completed path"]);
    }) as CompleteSimple,
    streamSimple: ((_model, _context, options) => {
      streamCalls += 1;
      streamSignal = options?.signal;
      return provider.stream;
    }) as StreamSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Use");
  await flushAsyncWork();
  provider.delta('{"completions":[" streamed partial text', " streamed partial text");
  await flushAsyncWork();
  assert.match(renderedText(editor), /streamed partial/);

  await harness.command("stream off");
  await flushAsyncWork();
  assert.equal(streamSignal?.aborted, true);
  assert.equal(streamCalls, 1);
  assert.equal(completeCalls, 0, "a presentation toggle must not buy a replacement request");
  assert.doesNotMatch(renderedText(editor), /streamed partial|completed path/);

  provider.error("aborted", undefined, "aborted");
  await flushAsyncWork();
  assert.doesNotMatch(renderedText(editor), /streamed partial|completed path/);

  editor.setText("Use again");
  await flushAsyncWork();
  assert.equal(completeCalls, 1, "the next user edit uses the newly selected completion path");
  assert.match(renderedText(editor), /completed path/);

  await harness.command("stream off");
  await flushAsyncWork();
  assert.equal(completeCalls, 1, "a redundant stream command must be request-idempotent");
  assert.match(renderedText(editor), /completed path/, "a redundant command should preserve a terminal suggestion");
});

test("a stream ending without a terminal event fails closed and clears partial text", async () => {
  const provider = controlledStream();
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("completion path must not run");
    }) as CompleteSimple,
    streamSimple: (() => provider.stream) as StreamSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();
  provider.delta('{"completions":[" partial result text', " partial result text");
  await flushAsyncWork();
  assert.match(renderedText(editor), /partial result/);

  provider.stream.end();
  await flushAsyncWork();
  assert.doesNotMatch(renderedText(editor), /partial result/);
  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /1 failed/);
  assert.match(harness.notifications.at(-1) ?? "", /ended without a terminal event/);
});

test("stream-off and complete-only DI use the compatibility completion path", async () => {
  for (const scenario of ["flag-off", "complete-only"] as const) {
    let completes = 0;
    let streams = 0;
    const harness = createEditorHarness({
      streamSetting: scenario === "flag-off" ? "off" : undefined,
      completeSimple: (async () => {
        completes += 1;
        return makeCompletion([" completed"]);
      }) as CompleteSimple,
      ...(scenario === "flag-off"
        ? {
            streamSimple: (() => {
              streams += 1;
              return controlledStream().stream;
            }) as StreamSimple,
          }
        : {}),
    });
    const editor = await harness.createEditor();
    editor.setText("Use");
    await flushAsyncWork();

    assert.equal(completes, 1);
    assert.equal(streams, 0);
    assert.match(renderedText(editor), /completed/);
    await harness.command("status");
    assert.match(
      harness.notifications.at(-1) ?? "",
      scenario === "flag-off" ? /stream=no\(flag\).*request-path=complete/ : /stream=yes\(flag\).*request-path=complete-compat/,
    );
  }
});

test("runtime stream toggles stay on complete-only DI without invoking a stream", async () => {
  let completes = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      completes += 1;
      return makeCompletion([` completed-${completes}`]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Compat");
  await flushAsyncWork();
  assert.equal(completes, 1);

  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /stream=yes\(flag\).*request-path=complete-compat/);

  await harness.command("stream off");
  await flushAsyncWork();
  assert.equal(completes, 1, "the toggle itself must not issue a completion");
  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /stream=no\(session\).*request-path=complete/);

  await harness.command("stream on");
  await flushAsyncWork();
  assert.equal(completes, 1);
  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /stream=yes\(session\).*request-path=complete-compat/);

  editor.setText("Compat next");
  await flushAsyncWork();
  assert.equal(completes, 2);
  assert.match(renderedText(editor), /completed-2/);
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
      return makeCompletion([calls === 1 ? " cached value" : " refreshed"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Use");
  await flushAsyncWork();
  assert.equal(calls, 1);
  assert.match(renderedText(editor), /cached value/);

  editor.setText("Use");
  await flushAsyncWork();
  assert.equal(calls, 1, "same draft should reuse the settled cache");

  insertAtCursor(editor, " cached");
  await flushAsyncWork();
  assert.equal(calls, 1, "an extended draft should reuse the cached prefix");
  assert.match(renderedText(editor), /value/);

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
  await harness.command("stats");
  assert.match(harness.notifications.at(-1) ?? "", /Suggestions: 2 offered, 0 accepted/);
});

test("typing a cached suggestion prefix reuses its remainder without another provider request", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" the implementation carefully"], makeUsage(40, 10, 0.0002));
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();
  assert.equal(calls, 1);

  for (const character of " the") {
    editor.handleInput(character);
    await flushAsyncWork();
  }

  assert.equal(editor.getText(), "Review the");
  assert.match(renderedText(editor), /implementation carefully/);
  assert.equal(calls, 1, "every matching edit must stay local");

  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /usage=1 req, 4 cached, 50 tok, ~\$0\.00020 est/);
});

test("accepting a reused repeated-word suffix reconstructs the exact cached target", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" foo foobar later"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Say");
  await flushAsyncWork();

  insertAtCursor(editor, " foo");
  await flushAsyncWork();
  assert.equal(calls, 1);
  assert.match(renderedText(editor), /foobar later/);

  editor.handleInput("\t");
  assert.equal(editor.getText(), "Say foo foobar later");
});

test("streamed partial text is never eligible for prefix reuse before the terminal response", async () => {
  const providers = [controlledStream(), controlledStream()];
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("completion path must not run");
    }) as CompleteSimple,
    streamSimple: (() => providers[calls++]!.stream) as StreamSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();

  providers[0]!.delta('{"completions":[" the implementation care');
  await flushAsyncWork();
  assert.match(renderedText(editor), /the implementation/);

  insertAtCursor(editor, " the");
  await flushAsyncWork();
  assert.equal(calls, 2, "a provisional preview must not populate either cache");

  providers[0]!.error("cancelled", makeUsage(10, 2, 0.0001), "aborted");
  providers[1]!.done([" implementation carefully"]);
  await flushAsyncWork();
  assert.match(renderedText(editor), /implementation carefully/);
});

test("prefix reuse filters alternatives and preserves the selected surviving origin", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" alpha one", " beta two", " beta three"]);
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();

  editor.handleInput(CTRL_DOT);
  editor.handleInput(CTRL_DOT);
  assert.match(renderedText(editor), /beta three/);
  assert.match(renderedText(editor), /‹3\/3›/);

  editor.handleInput(CTRL_SPACE);
  await flushAsyncWork();

  assert.equal(editor.getText(), "Review beta ");
  assert.equal(calls, 1);
  assert.match(renderedText(editor), /three/);
  assert.match(renderedText(editor), /‹2\/2›/);
});

test("prefix reuse misses on divergence, changed context, changed leaf, and expiry", async () => {
  const scenarios = ["diverged", "context", "leaf", "expired"] as const;

  for (const scenario of scenarios) {
    let calls = 0;
    let now = 1_000;
    const harness = createEditorHarness({
      now: () => now,
      completeSimple: (async () => {
        calls += 1;
        return makeCompletion([calls === 1 ? " the implementation" : " fallback"]);
      }) as CompleteSimple,
    });
    harness.setBranch([
      { type: "message", message: { role: "user", content: "Initial context" } },
      { type: "message", message: makeRawCompletion("Initial answer") },
    ]);
    const editor = await harness.createEditor();
    editor.setText("Review");
    await flushAsyncWork();
    assert.equal(calls, 1);

    if (scenario === "context") {
      harness.setBranch([
        { type: "message", message: { role: "user", content: "Changed context" } },
        { type: "message", message: makeRawCompletion("Changed answer") },
      ]);
    } else if (scenario === "leaf") {
      harness.setLeafId("leaf-2");
    } else if (scenario === "expired") {
      now += 60_001;
    }

    insertAtCursor(editor, scenario === "diverged" ? " x" : " the");
    await flushAsyncWork();
    assert.equal(calls, 2, `${scenario} must issue a fresh request`);
  }
});

test("an older exact cache hit re-arms prefix reuse without extending its TTL", async () => {
  for (const scenario of ["still-valid", "expired-after-rearm"] as const) {
    let calls = 0;
    let now = 1_000;
    const harness = createEditorHarness({
      now: () => now,
      completeSimple: (async () => {
        calls += 1;
        if (calls === 1) return makeCompletion([" the implementation"]);
        if (calls === 2) return makeCompletion([" diverged result"]);
        return makeCompletion([" fresh result"]);
      }) as CompleteSimple,
    });
    const editor = await harness.createEditor();
    editor.setText("Review");
    await flushAsyncWork();
    assert.equal(calls, 1);

    now += 10_000;
    editor.setText("Review x");
    await flushAsyncWork();
    assert.equal(calls, 2);

    now = scenario === "still-valid" ? 20_000 : 60_999;
    editor.setText("Review");
    await flushAsyncWork();
    assert.equal(calls, 2, "the older exact entry should still be available");
    assert.match(renderedText(editor), /the implementation/);

    if (scenario === "expired-after-rearm") now = 61_001;
    insertAtCursor(editor, " the");
    await flushAsyncWork();

    assert.equal(calls, scenario === "still-valid" ? 2 : 3);
    assert.match(renderedText(editor), scenario === "still-valid" ? /implementation/ : /fresh result/);
  }
});

test("a new session clears prefix-reuse entries with the exact cache", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([calls === 1 ? " the implementation" : " fresh session"]);
    }) as CompleteSimple,
  });
  const firstEditor = await harness.createEditor();
  firstEditor.setText("Review");
  await flushAsyncWork();
  assert.equal(calls, 1);

  const secondEditor = await harness.createEditor();
  secondEditor.setText("Review the");
  await flushAsyncWork();
  assert.equal(calls, 2);
  assert.match(renderedText(secondEditor), /fresh session/);
});

test("stats reports provider, cache, presentation, acceptance, usage, and latency metrics", async () => {
  let calls = 0;
  let now = 1_000;
  const harness = createEditorHarness({
    now: () => now,
    completeSimple: (async () => {
      calls += 1;
      if (calls === 1) {
        now += 120;
        return makeCompletion(
          [" the implementation carefully", " with focused tests", " now"],
          makeUsage(80, 20, 0.0003),
        );
      }
      now += 80;
      return makeCompletion([], makeUsage(40, 10, 0.0001));
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();
  editor.setText("Review");
  await flushAsyncWork();

  editor.handleInput(CTRL_SPACE);
  await flushAsyncWork();
  assert.equal(editor.getText(), "Review the ");

  editor.handleInput("\t");
  await flushAsyncWork();
  assert.equal(editor.getText(), "Review the implementation carefully");
  assert.equal(calls, 2);

  editor.setText("Review");
  await flushAsyncWork();
  assert.equal(calls, 2, "returning to the first draft must be an exact cache hit");

  const expectedStats = [
    "Prompt Autocomplete — current session",
    "Requests: 2 issued, 0 failed",
    "Cache: 2 hits (1 exact, 1 prefix)",
    "Suggestions: 3 offered, 2 accepted (1 full, 1 word/chunk)",
    "Usage: 150 tokens, estimated cost ~$0.00040",
    "Mean provider latency: 100 ms (2 samples)",
  ].join("\n");

  await harness.command("stats");
  assert.equal(harness.notifications.at(-1), expectedStats);
  await harness.command("off");
  await harness.command("stats");
  assert.equal(harness.notifications.at(-1), expectedStats, "disabling must not erase current-session stats");
});

test("in-flight stats settle after disable but cannot contaminate a new session", async () => {
  for (const lifecycle of ["disable", "new-session"] as const) {
    let calls = 0;
    let now = 1_000;
    const pending = deferred<CompletionResult>();
    const harness = createEditorHarness({
      now: () => now,
      completeSimple: (async () => {
        calls += 1;
        return pending.promise;
      }) as CompleteSimple,
    });
    const editor = await harness.createEditor();
    editor.setText("Pending");
    await flushAsyncWork();
    assert.equal(calls, 1);

    await harness.command("stats");
    assert.match(harness.notifications.at(-1) ?? "", /Requests: 1 issued, 0 failed/);
    assert.match(harness.notifications.at(-1) ?? "", /Usage: 0 tokens\+, estimated cost ~\$0\+/);
    assert.match(harness.notifications.at(-1) ?? "", /Mean provider latency: n\/a/);

    if (lifecycle === "disable") {
      await harness.command("off");
    } else {
      await harness.emit("session_start", { reason: "new-session" });
    }

    now = 1_250;
    pending.resolve(makeCompletion([" late result"], makeUsage(10, 5, 0.0001)));
    await flushAsyncWork();
    await harness.command("stats");

    const stats = harness.notifications.at(-1) ?? "";
    if (lifecycle === "disable") {
      assert.match(stats, /Requests: 1 issued, 1 failed/);
      assert.match(stats, /Suggestions: 0 offered, 0 accepted/);
      assert.match(stats, /Usage: 15 tokens, estimated cost ~\$0\.00010/);
      assert.match(stats, /Mean provider latency: 250 ms \(1 sample\)/);
    } else {
      assert.match(stats, /Requests: 0 issued, 0 failed/);
      assert.match(stats, /Suggestions: 0 offered, 0 accepted/);
      assert.match(stats, /Mean provider latency: n\/a/);
    }
  }
});

test("accounting records usage and never bills a cache hit", async () => {
  let calls = 0;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      calls += 1;
      return makeCompletion([" the implementation carefully"], makeUsage(120, 30, 0.00042));
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("Review");
  await flushAsyncWork();
  assert.equal(calls, 1);

  // Leaving and re-entering the same draft must be served from the cache.
  editor.setText("Review the report");
  await flushAsyncWork();
  editor.setText("Review");
  await flushAsyncWork();

  assert.equal(calls, 2, "only the two distinct drafts may reach the provider");

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";

  assert.match(status, /usage=2 req, 1 cached, 300 tok, ~\$0\.00084 est/);
  // Both requests reported tokens and cost, so nothing may be flagged incomplete.
  assert.doesNotMatch(status, /tok\+/);
  assert.doesNotMatch(status, /est\+/);
  assert.doesNotMatch(status, /failed/);
});

test("accounting marks a failed request and flags the totals as incomplete", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("provider unavailable");
    }) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("Review");
  await flushAsyncWork();

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";

  assert.match(status, /usage=1 req, 0 cached, 1 failed, 0 tok\+, ~\$0 est\+/);
  await harness.command("stats");
  assert.match(harness.notifications.at(-1) ?? "", /Mean provider latency: \d+ ms \(1 sample\)/);
});

test("accounting counts a provider error response as failed while keeping its usage", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () =>
      ({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "quota exceeded",
        usage: makeUsage(40, 0, 0.0001),
      }) as unknown as CompletionResult) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("Review");
  await flushAsyncWork();

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";

  assert.match(status, /usage=1 req/);
  assert.match(status, /1 failed/);
  // Tokens spent on a rejected response were still spent.
  assert.match(status, /40 tok/);
  assert.match(status, /~\$0\.00010 est/);
});

test("accounting resets when a new session starts", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () =>
      makeCompletion([" carefully"], makeUsage(120, 30, 0.00042))) as CompleteSimple,
  });
  const editor = await harness.createEditor();

  editor.setText("Review");
  await flushAsyncWork();
  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /usage=1 req, 0 cached, 150 tok/);
  await harness.command("stats");
  assert.match(harness.notifications.at(-1) ?? "", /Requests: 1 issued.*Suggestions: 1 offered/s);

  await harness.emit("session_start", { reason: "new-session" });
  await harness.command("status");
  assert.match(harness.notifications.at(-1) ?? "", /usage=0 req, 0 cached, 0 tok, ~\$0 est/);
  await harness.command("stats");
  assert.match(harness.notifications.at(-1) ?? "", /Requests: 0 issued.*Suggestions: 0 offered/s);
});

test("an explicitly requested model that is unusable never falls back to the active model", async () => {
  const scenarios = [
    {
      name: "unknown model",
      preferredModel: "missing/model-x",
      findModel: (provider: string, id: string) =>
        provider === "test-provider" ? { provider, id } : undefined,
      expected: /unknown/,
    },
    {
      name: "unauthenticated model",
      preferredModel: "locked/model-y",
      hasConfiguredAuth: (model: { provider: string }) => model.provider === "test-provider",
      expected: /no configured auth/,
    },
    {
      name: "malformed value",
      preferredModel: "malformed-without-slash",
      expected: /not a provider\/model reference/,
    },
  ];

  for (const scenario of scenarios) {
    let calls = 0;
    const harness = createEditorHarness({
      preferredModel: scenario.preferredModel,
      findModel: scenario.findModel,
      hasConfiguredAuth: scenario.hasConfiguredAuth,
      completeSimple: (async () => {
        calls += 1;
        return makeCompletion([" leaked"]);
      }) as CompleteSimple,
    });

    const editor = await harness.createEditor();
    editor.setText("Draft that would be sent");
    await flushAsyncWork();

    // The active model is authenticated in every scenario, so a fallback would
    // send the draft and conversation context to a provider the user did not pick.
    assert.equal(calls, 0, `${scenario.name} must not issue a request`);
    assert.doesNotMatch(renderedText(editor), /leaked/);

    const warning = harness.notifications.at(-1) ?? "";
    assert.match(warning, scenario.expected, scenario.name);
    assert.match(warning, /not sent to the active model/, scenario.name);

    // The refusal repeats on every keystroke; the notice must not.
    const notificationCount = harness.notifications.length;
    editor.setText("Draft that would be sent again");
    await flushAsyncWork();
    assert.equal(harness.notifications.length, notificationCount, `${scenario.name} must notify once`);
    assert.equal(calls, 0);
  }
});

test("an explicitly requested model is reported without terminal control sequences", async () => {
  const harness = createEditorHarness({
    preferredModel: "\u001B[31mmalformed\u001B[0m",
    completeSimple: (async () => makeCompletion([" leaked"])) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  editor.setText("Draft");
  await flushAsyncWork();

  const warning = harness.notifications.at(-1) ?? "";
  assert.doesNotMatch(warning, /\u001B/);
  assert.match(warning, /malformed \(invalid\)/);

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";
  assert.doesNotMatch(status, /\u001B/);
  assert.match(status, /requested-model=malformed \(invalid\)/);
});

test("provider diagnostics reach the terminal without control sequences", async () => {
  const hostileRaw = "\u001B[2J\u001B]0;pwned\u0007not json\rrewritten";
  const harness = createEditorHarness({
    completeSimple: (async () => makeRawCompletion(hostileRaw)) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  await harness.command("debug-on");
  editor.setText("Draft");
  await flushAsyncWork();

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";
  assert.doesNotMatch(status, /\u001B|\u0007|\r/);
  assert.match(status, /raw=/);
  assert.match(status, /not jsonrewritten/);

  const widgetLines = harness.widgets
    .flatMap((entry) => entry.content ?? [])
    .join("\n");
  assert.doesNotMatch(widgetLines.replace(/\u001B\[[0-9;]*m/g, ""), /\u001B|\u0007/);
});

test("provider errors reach the terminal without control sequences", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error("\u001B]52;c;cGF5bG9hZA==\u0007provider exploded");
    }) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  editor.setText("Draft");
  await flushAsyncWork();

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";
  assert.doesNotMatch(status, /\u001B|\u0007/);
  assert.match(status, /provider exploded/);
});

test("diagnostics stay well formed and bounded for hostile provider text", async () => {
  // The visible cut lands inside an astral character, which slicing would split.
  const astralBoundaryError = `${"e".repeat(88)}😀 trailing detail`;
  const harness = createEditorHarness({
    completeSimple: (async () => {
      throw new Error(astralBoundaryError);
    }) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  editor.setText("Draft");
  await flushAsyncWork();

  await harness.command("status");
  const status = harness.notifications.at(-1) ?? "";
  const errorField = /error=([^|]*)/.exec(status)?.[1]?.trim() ?? "";
  assert.equal(errorField, `${"e".repeat(88)}…`, "the astral character is dropped, not split");
  assert.equal(errorField.isWellFormed(), true, "a split surrogate must not reach the terminal");
  assert.equal(status.isWellFormed(), true);
});

test("an unbounded provider error cannot stall the terminal", async () => {
  const harness = createEditorHarness({
    completeSimple: (async () => {
      // Unterminated introducers used to make sanitization quadratic, and a
      // provider error body has no length limit.
      throw new Error(`${"\u001B_".repeat(400_000)}boom`);
    }) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  editor.setText("Draft");
  const started = process.hrtime.bigint();
  await flushAsyncWork();
  await harness.command("status");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(elapsedMs < 1_000, `handling a 800KB error took ${elapsedMs.toFixed(1)}ms`);
  const status = harness.notifications.at(-1) ?? "";
  assert.doesNotMatch(status, /\u001B/);
  assert.equal(status.isWellFormed(), true);
});

test("a refused model is reported again after disabling and re-enabling", async () => {
  const harness = createEditorHarness({
    preferredModel: "missing/model-x",
    findModel: (provider: string, id: string) => (provider === "test-provider" ? { provider, id } : undefined),
    completeSimple: (async () => makeCompletion([" leaked"])) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  editor.setText("Draft");
  await flushAsyncWork();
  assert.match(harness.notifications.at(-1) ?? "", /is unknown/);

  await harness.command("off");
  await harness.command("on");
  // Enabling must not claim that auth is missing: the active model is fine and
  // deliberately unused.
  const enableNotice = harness.notifications.at(-1) ?? "";
  assert.match(enableNotice, /is unknown/);
  assert.match(enableNotice, /not sent to the active model/);

  const reEnabledEditor = await harness.createEditor();
  reEnabledEditor.setText("Draft again");
  await flushAsyncWork();
  assert.match(harness.notifications.at(-1) ?? "", /is unknown/);
});

test("the notification channel is inert after the editor runtime is released", async () => {
  const harness = createEditorHarness({
    preferredModel: "missing/model-x",
    findModel: (provider: string, id: string) => (provider === "test-provider" ? { provider, id } : undefined),
    completeSimple: (async () => makeCompletion([" leaked"])) as CompleteSimple,
  });

  const editor = await harness.createEditor();
  await harness.emit("session_shutdown");

  const notificationCount = harness.notifications.length;
  editor.setText("Draft after shutdown");
  await flushAsyncWork();
  assert.equal(harness.notifications.length, notificationCount);
});
