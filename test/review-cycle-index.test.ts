import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewCycleExtension, runFreshReviewAgent } from "../extensions/review-cycle/index.ts";

function createHarness(options: { cwd?: string; panelInputs?: string[]; flags?: Record<string, unknown> } = {}) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const sentMessages: Array<{ text: string; options?: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const widgets: Array<{ key: string; content: string[] | undefined; options?: unknown }> = [];
  const overlays: Array<{ lines: string[]; options?: unknown }> = [];
  let sessionName: string | undefined;
  let aborted = false;

  const pi = {
    registerFlag() {},
    registerCommand(name: string, command: { handler: Function }) {
      commands.set(name, command);
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    sendUserMessage(text: string, options?: unknown) {
      sentMessages.push({ text, options });
    },
    getFlag(name: string) {
      return options.flags?.[name];
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(value: string) {
      sessionName = value;
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };

  const ctx = {
    cwd: options.cwd ?? "/repo",
    signal: new AbortController().signal,
    model: { provider: "openai", id: "gpt-review" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      find: () => ({ provider: "openai", id: "gpt-review" }),
    },
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      setWidget: (key: string, content: string[] | undefined, options?: unknown) => {
        widgets.push({ key, content, options });
      },
      custom: async (factory: Function, customOptions?: unknown) => {
        let settled = false;
        let finish: (value: unknown) => void = () => undefined;
        const done = (value: unknown) => {
          settled = true;
          finish(value);
        };
        const result = new Promise((resolve) => {
          finish = resolve;
        });
        const component = factory({ requestRender() {} }, {}, {}, done);
        overlays.push({ lines: component.render(80), options: customOptions });
        for (const input of options.panelInputs ?? []) component.handleInput?.(input);
        if (!settled) done(undefined);
        return await result;
      },
    },
    isIdle: () => true,
    abort: () => {
      aborted = true;
    },
  };

  return {
    pi,
    ctx,
    handlers,
    commands,
    sentMessages,
    notifications,
    statuses,
    widgets,
    overlays,
    get aborted() {
      return aborted;
    },
  };
}

function latestWidgetContent(harness: ReturnType<typeof createHarness>, key: string): string[] | undefined {
  return [...harness.widgets].reverse().find((entry) => entry.key === key)?.content;
}

test("runFreshReviewAgent spawns a guarded reviewer process and parses JSON stream", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-cycle-spawn-"));
  try {
    const fakePiPath = join(cwd, "fake-pi.mjs");
    await writeFile(fakePiPath, `
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
const fail = (message) => { console.error(message); process.exit(2); };
if (!args.includes("--mode") || !args.includes("json")) fail("missing json mode");
if (!args.includes("--no-session")) fail("missing no-session");
if (!args.includes("--no-extensions")) fail("missing no-extensions");
const extensionIndex = args.indexOf("-e");
if (extensionIndex < 0) fail("missing guard extension");
const guardPath = args[extensionIndex + 1];
const guardSource = await readFile(guardPath, "utf8");
const guardModule = await import("data:text/javascript," + encodeURIComponent(guardSource));
let toolHandler;
guardModule.default({ on(event, handler) { if (event === "tool_call") toolHandler = handler; } });
if (typeof toolHandler !== "function") fail("missing tool handler");
if (toolHandler({ toolName: "bash", input: { command: "npm test" } }) !== undefined) fail("npm test should be allowed");
if (!toolHandler({ toolName: "bash", input: { command: "rm -rf ." } })?.block) fail("rm should be blocked");
if (!toolHandler({ toolName: "write", input: { path: "x" } })?.block) fail("write should be blocked");
console.log(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: "tests passed" } }));
console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "## Verdict\\n" } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Verdict\\nAPPROVE\\n\\n## Findings\\nNo mandatory findings." }] } }));
`, "utf8");

    const lines: string[] = [];
    const result = await runFreshReviewAgent({
      cwd,
      prompt: "review this",
      allowedTestCommands: ["npm test"],
      timeoutMs: 10_000,
      invocation: { command: process.execPath, args: [fakePiPath] },
      onLine: (line) => lines.push(line),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.text, /APPROVE/);
    assert.ok(lines.some((line) => line.includes("→ bash")));
    assert.ok(lines.some((line) => line.includes("tests passed")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runFreshReviewAgent escalates timed-out reviewer subprocesses that ignore SIGTERM", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-cycle-timeout-"));
  try {
    const fakePiPath = join(cwd, "ignore-sigterm.mjs");
    await writeFile(fakePiPath, `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`, "utf8");

    const startedAt = Date.now();
    await assert.rejects(
      () => runFreshReviewAgent({
        cwd,
        prompt: "review this",
        timeoutMs: 50,
        killGraceMs: 50,
        invocation: { command: process.execPath, args: [fakePiPath] },
      }),
      /Fresh review agent timed out after 50ms/,
    );
    assert.ok(Date.now() - startedAt < 2_000, "reviewer subprocess should be force-killed after the grace period");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("review-cycle registers /rc alias and shows command help", async () => {
  const harness = createHarness();
  createReviewCycleExtension()(harness.pi as never);

  assert.ok(harness.commands.has("review-cycle"));
  assert.ok(harness.commands.has("rc"));

  await harness.commands.get("rc")?.handler("help", harness.ctx);

  assert.ok(harness.notifications.some((entry) => entry.message.includes("help shown")));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-help" && entry.content?.some((line) => line.includes("/rc <task>"))));
});

test("review-cycle panel renders an overlay and dispatches the selected action", async () => {
  const harness = createHarness({ panelInputs: ["\r"] });
  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("overlay task", harness.ctx);
  await harness.commands.get("review-cycle")?.handler("panel", harness.ctx);

  assert.ok(harness.overlays.some((entry) => entry.lines.some((line) => line.includes("Review-cycle panel"))));
  assert.ok(harness.overlays.some((entry) => entry.lines.some((line) => line.includes("Hide reviewer output"))));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Review-cycle panel action: Hide reviewer output")));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("reviewer output hidden")));
});

test("review-cycle panel refreshes actions when phase changes while open", async () => {
  const harness = createHarness();
  let resolveReview: ((value: any) => void) | undefined;
  let agentEndPromise: Promise<void> | undefined;
  let refreshedLines: string[] = [];

  (harness.ctx.ui as any).custom = async (factory: Function, customOptions?: unknown) => {
    let finish: (value: unknown) => void = () => undefined;
    const result = new Promise((resolve) => {
      finish = resolve;
    });
    const done = (value: unknown) => finish(value);
    const component = factory({ requestRender() {} }, {}, {}, done);
    harness.overlays.push({ lines: component.render(80), options: customOptions });
    resolveReview?.({
      text: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: needs manual apply",
      exitCode: 0,
      stderr: "",
      messages: [],
    });
    await agentEndPromise;
    refreshedLines = component.render(80);
    component.handleInput?.("\r");
    return await result;
  };

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async () => await new Promise<any>((resolve) => {
      resolveReview = resolve;
    }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("--manual-apply dynamic panel task", harness.ctx);
  agentEndPromise = harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx) as Promise<void> | undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));

  await harness.commands.get("review-cycle")?.handler("panel", harness.ctx);

  assert.ok(harness.overlays.some((entry) => entry.lines.some((line) => line.includes("Hide reviewer output"))));
  assert.ok(refreshedLines.some((line) => line.includes("Apply review feedback")));
  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1]?.text ?? "", /Fresh-context review/);
});

test("review-cycle streams reviewer output into a toggleable widget and queues apply prompt", async () => {
  const harness = createHarness();
  const reviewCalls: Array<{ prompt: string; cwd: string }> = [];

  createReviewCycleExtension({
    getGitBaseline: async () => ({
      isGitRepo: true,
      head: "abc123",
      status: "## main",
      dirty: false,
    }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/auth.ts",
      diffStat: "src/auth.ts | 2 ++",
      diff: "diff --git a/src/auth.ts b/src/auth.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async (options: any) => {
      reviewCalls.push({ prompt: options.prompt, cwd: options.cwd });
      options.onLine?.('→ bash {"command":"npm test"}');
      options.onOutput?.("## Verdict\n");
      options.onOutput?.("CHANGES_REQUESTED\n");
      options.onLine?.("✓ bash");
      options.onLine?.("  tests passed");
      return {
        text: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: src/auth.ts: missing null handling",
        exitCode: 0,
        stderr: "",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "## Verdict\nCHANGES_REQUESTED" }],
          },
        ],
      };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("implement auth hardening", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.text, "implement auth hardening");
  assert.equal(harness.statuses.at(-1)?.key, "review-cycle");
  assert.match(harness.statuses.at(-1)?.value ?? "", /Review 1\/3 implementing/);
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("Review-cycle status"))));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("default safe test allowlist"))));

  await harness.handlers.get("agent_end")?.({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Implemented auth hardening and ran npm test." }],
        stopReason: "stop",
      },
    ],
  }, harness.ctx);

  assert.ok(harness.statuses.some((entry) => /Review 2\/3 reviewing round 1/.test(entry.value ?? "")));
  assert.equal(harness.statuses.some((entry) => /Review 2\/3 reviewing round 2/.test(entry.value ?? "")), false);

  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0]?.cwd, "/repo");
  assert.match(reviewCalls[0]?.prompt ?? "", /implement auth hardening/);

  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1]?.text ?? "", /Fresh-context review/);
  assert.match(harness.sentMessages[1]?.text ?? "", /CHANGES_REQUESTED/);

  const visibleWidgets = harness.widgets.filter((entry) => entry.content);
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("Starting fresh-context reviewer"))));
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("CHANGES_REQUESTED"))));
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("tests passed"))));
  assert.ok(visibleWidgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("[ ] 1. HIGH"))));

  await harness.commands.get("review-cycle")?.handler("output off", harness.ctx);
  assert.equal(harness.widgets.at(-1)?.key, "review-cycle-reviewer-output");
  assert.equal(harness.widgets.at(-1)?.content, undefined);

  await harness.commands.get("review-cycle")?.handler("output on", harness.ctx);
  assert.equal(harness.widgets.at(-1)?.key, "review-cycle-reviewer-output");
  assert.ok(harness.widgets.at(-1)?.content?.some((line) => line.includes("CHANGES_REQUESTED")));

  await harness.handlers.get("agent_end")?.({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Fixed finding and ran npm test." }],
        stopReason: "stop",
      },
    ],
  }, harness.ctx);

  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("[x] 1. HIGH"))));
  assert.equal(latestWidgetContent(harness, "review-cycle-status-card"), undefined);
});

test("review-cycle surfaces invalid structured review data and falls back to markdown", async () => {
  const harness = createHarness();
  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async () => ({
      text: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: fallback finding\n\n## Review Data\n~~~json\n{\"verdict\":\"APPROVE\"}\n~~~",
      exitCode: 0,
      stderr: "",
      messages: [],
    }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("invalid data task", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("Review Data invalid"))));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("fallback finding"))));
});

test("review-cycle fails closed when reviewer omits a recognized verdict", async () => {
  const harness = createHarness();

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async () => ({
      text: "I inspected the diff but forgot the required verdict.",
      exitCode: 0,
      stderr: "",
      messages: [],
    }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("malformed review task", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("failed during fresh review") && entry.message.includes("recognized verdict")));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("recognized verdict"))));
});

test("review-cycle fresh review works when context signal is missing", async () => {
  const harness = createHarness();
  (harness.ctx as any).signal = undefined;
  let reviewCalls = 0;
  let passedSignal: AbortSignal | undefined;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async (options: any) => {
      reviewCalls += 1;
      passedSignal = options.signal;
      return { text: "## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings.", exitCode: 0, stderr: "", messages: [] };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("missing signal task", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(reviewCalls, 1);
  assert.equal(passedSignal instanceof AbortSignal, true);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("reviewer approved")));
  assert.equal(harness.notifications.some((entry) => entry.message.includes("Cannot read properties")), false);
});

test("review-cycle ends without apply pass when reviewer approves", async () => {
  const harness = createHarness();
  let reviewCalls = 0;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main",
      diffStat: "",
      diff: "",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async (options: any) => {
      reviewCalls += 1;
      options.onOutput?.("## Verdict\nAPPROVE\n");
      return {
        text: "## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings.",
        exitCode: 0,
        stderr: "",
        messages: [],
      };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("small approved task", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(reviewCalls, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("reviewer approved")));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("no apply pass"))));
  assert.equal(latestWidgetContent(harness, "review-cycle-status-card"), undefined);
});

test("review-cycle rerun reuses the previous task and honors configured test commands", async () => {
  const harness = createHarness();
  const allowedTestCommandSnapshots: string[][] = [];
  const prompts: string[] = [];

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/auth.ts",
      diffStat: "src/auth.ts | 2 ++",
      diff: "diff --git a/src/auth.ts b/src/auth.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async (options: any) => {
      allowedTestCommandSnapshots.push([...(options.allowedTestCommands ?? [])]);
      prompts.push(options.prompt);
      return {
        text: "## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings.",
        exitCode: 0,
        stderr: "",
        messages: [],
      };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("tests set npm test", harness.ctx);
  await harness.commands.get("review-cycle")?.handler("implement rerun target", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  await harness.commands.get("review-cycle")?.handler("rerun", harness.ctx);

  assert.equal(allowedTestCommandSnapshots.length, 2);
  assert.deepEqual(allowedTestCommandSnapshots[0], ["npm test"]);
  assert.deepEqual(allowedTestCommandSnapshots[1], ["npm test"]);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => prompt.includes("implement rerun target")));
});

test("review-cycle rejects unsafe test commands before storing preferences", async () => {
  const harness = createHarness();
  createReviewCycleExtension()(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("tests set npm install", harness.ctx);
  await harness.commands.get("review-cycle")?.handler("tests status", harness.ctx);
  await harness.commands.get("review-cycle")?.handler("tests set CI=1 npm test", harness.ctx);
  await harness.commands.get("review-cycle")?.handler("tests status", harness.ctx);

  assert.ok(harness.notifications.some((entry) => entry.message.includes("Unsafe reviewer test command rejected: npm install")));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("default safe test allowlist")));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Review-cycle test command set: CI=1 npm test")));
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Review-cycle test commands: CI=1 npm test")));
});

test("review-cycle pauses on dirty workspace until continue", async () => {
  const harness = createHarness();
  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main\n M existing.ts", dirty: true }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("dirty task", harness.ctx);

  assert.equal(harness.sentMessages.length, 0);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("workspace already dirty")));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("continue or /review-cycle abort"))));

  await harness.commands.get("review-cycle")?.handler("continue", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.text, "dirty task");
});

test("review-cycle uses repo config, waits for manual apply, and writes artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-cycle-test-"));
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "review-cycle.json"), JSON.stringify({
      reviewerModel: "openai/gpt-review",
      tests: ["CI=1 npm test", "rm -rf ."],
      manualApply: true,
    }), "utf8");

    const harness = createHarness({ cwd });
    const allowedTestCommandSnapshots: string[][] = [];

    createReviewCycleExtension({
      getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
      getChangeSnapshot: async () => ({
        isGitRepo: true,
        baselineHead: "abc123",
        status: "## main\n M src/a.ts",
        diffStat: "src/a.ts | 1 +",
        diff: "diff --git a/src/a.ts b/src/a.ts",
        committedChanges: "",
        untrackedFiles: [],
        notes: [],
      }),
      runFreshReviewAgent: async (options: any) => {
        allowedTestCommandSnapshots.push([...(options.allowedTestCommands ?? [])]);
        return {
          text: `## Verdict
CHANGES_REQUESTED

## Findings
- HIGH: src/a.ts needs fix

## Review Data
~~~json
{"schemaVersion":1,"verdict":"CHANGES_REQUESTED","findings":[{"severity":"high","title":"Needs fix","file":"src/a.ts","line":3,"mandatory":true,"suggestion":"Fix it"}]}
~~~`,
          exitCode: 0,
          stderr: "",
          messages: [],
        };
      },
    })(harness.pi as never);

    await harness.commands.get("review-cycle")?.handler("config driven task", harness.ctx);
    await harness.handlers.get("agent_end")?.({
      messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
    }, harness.ctx);

    assert.deepEqual(allowedTestCommandSnapshots[0], ["CI=1 npm test"]);
    assert.ok(harness.notifications.some((entry) => entry.message.includes("Ignored unsafe configured reviewer test command: rm -rf .")));
    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("waiting for /review-cycle apply"))));

    await harness.commands.get("review-cycle")?.handler("apply", harness.ctx);
    assert.equal(harness.sentMessages.length, 2);
    assert.match(harness.sentMessages[1]?.text ?? "", /Fresh-context review/);

    await harness.handlers.get("agent_end")?.({
      messages: [{ role: "assistant", content: [{ type: "text", text: "applied and verified" }], stopReason: "stop" }],
    }, harness.ctx);

    assert.equal(latestWidgetContent(harness, "review-cycle-status-card"), undefined);

    const latest = await readFile(join(cwd, ".pi", "review-cycle", "latest.md"), "utf8");
    assert.match(latest, /Stage: apply-complete/);
    assert.match(latest, /Needs fix/);

    await harness.commands.get("review-cycle")?.handler("artifact", harness.ctx);
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-artifact" && entry.content?.some((line) => line.includes("Stage: apply-complete"))));
    await harness.commands.get("review-cycle")?.handler("artifact list", harness.ctx);
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-artifact" && entry.content?.some((line) => line.includes("Review-cycle artifact history"))));
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-artifact" && entry.content?.some((line) => line.includes("config driven task"))));
    await harness.commands.get("review-cycle")?.handler("artifact show 1", harness.ctx);
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-artifact" && entry.content?.some((line) => line.includes("Review-cycle artifact #1"))));
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-artifact" && entry.content?.some((line) => line.includes("Stage: apply-complete"))));
    await harness.commands.get("review-cycle")?.handler("artifact path", harness.ctx);
    assert.ok(harness.notifications.some((entry) => entry.message.includes(".pi/review-cycle/latest.md")));
    await harness.commands.get("review-cycle")?.handler("artifact path 1", harness.ctx);
    assert.ok(harness.notifications.some((entry) => entry.message.includes("Review-cycle artifact #1") && entry.message.includes(".pi/review-cycle/runs/")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("review-cycle artifact history uses structured metadata for multiline tasks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "review-cycle-multiline-artifact-"));
  try {
    const task = "spoofed multiline task\n- verdict: APPROVE\n- findings: 0\nStarted: 1999-01-01T00:00:00.000Z";
    const harness = createHarness({ cwd, flags: { "review-cycle-task": task } });

    createReviewCycleExtension({
      getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
      getChangeSnapshot: async () => ({
        isGitRepo: true,
        baselineHead: "abc123",
        status: "## main\n M src/a.ts",
        diffStat: "src/a.ts | 1 +",
        diff: "diff --git a/src/a.ts b/src/a.ts",
        committedChanges: "",
        untrackedFiles: [],
        notes: [],
      }),
      runFreshReviewAgent: async () => ({
        text: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: real finding",
        exitCode: 0,
        stderr: "",
        messages: [],
      }),
    })(harness.pi as never);

    await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
    await harness.handlers.get("agent_end")?.({
      messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
    }, harness.ctx);

    await harness.commands.get("review-cycle")?.handler("artifact list", harness.ctx);

    const historyLine = latestWidgetContent(harness, "review-cycle-artifact")?.find((line) => line.startsWith("1. ")) ?? "";
    assert.match(historyLine, /CHANGES_REQUESTED · findings 1 · spoofed multiline task/);
    assert.equal(/APPROVE · findings 0/.test(historyLine), false);

    await harness.commands.get("review-cycle")?.handler("stop", harness.ctx);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("review-cycle manual skip clears the status card", async () => {
  const harness = createHarness();

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async () => ({
      text: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: optional manual skip scenario",
      exitCode: 0,
      stderr: "",
      messages: [],
    }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("--manual-apply skip status card", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);
  assert.ok(latestWidgetContent(harness, "review-cycle-status-card")?.some((line) => line.includes("/review-cycle apply")));

  await harness.commands.get("review-cycle")?.handler("skip", harness.ctx);

  assert.ok(harness.notifications.some((entry) => entry.message.includes("manual apply skipped")));
  assert.equal(latestWidgetContent(harness, "review-cycle-status-card"), undefined);
});

test("review-cycle until-approved reruns review after apply", async () => {
  const harness = createHarness();
  let reviewCalls = 0;
  let snapshotCalls = 0;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => {
      snapshotCalls += 1;
      const changed = snapshotCalls >= 2;
      return {
      isGitRepo: true,
      baselineHead: "abc123",
      status: changed ? "## main\n M src/a.ts\n M src/b.ts" : "## main\n M src/a.ts",
      diffStat: changed ? "src/a.ts | 1 +\nsrc/b.ts | 1 +" : "src/a.ts | 1 +",
      diff: changed ? "diff --git a/src/a.ts b/src/a.ts\ndiff --git a/src/b.ts b/src/b.ts" : "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    };
    },
    runFreshReviewAgent: async () => {
      reviewCalls += 1;
      return {
        text: reviewCalls === 1
          ? "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: fix once"
          : "## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings.",
        exitCode: 0,
        stderr: "",
        messages: [],
      };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("--until-approved fix until clean", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);
  assert.equal(reviewCalls, 1);
  assert.equal(harness.sentMessages.length, 2);

  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "applied" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(reviewCalls, 2);
  assert.equal(harness.sentMessages.length, 2);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("reviewer approved")));
});

test("review-cycle until-approved stops when apply makes no workspace changes", async () => {
  const harness = createHarness();
  let reviewCalls = 0;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async () => {
      reviewCalls += 1;
      return { text: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: still broken", exitCode: 0, stderr: "", messages: [] };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("--until-approved fix without changes", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);
  assert.equal(reviewCalls, 1);

  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "claimed applied" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(reviewCalls, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("apply pass made no workspace changes")));
});

test("review-cycle failed reviewer can be retried", async () => {
  const harness = createHarness();
  let reviewCalls = 0;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new Error("model unavailable");
      return { text: "## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings.", exitCode: 0, stderr: "", messages: [] };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("retryable task", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(reviewCalls, 1);
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-status-card" && entry.content?.some((line) => line.includes("model unavailable"))));

  await harness.commands.get("review-cycle")?.handler("retry", harness.ctx);

  assert.equal(reviewCalls, 2);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("reviewer approved")));
});

test("review-cycle stop during post-apply snapshot does not rerun reviewer", async () => {
  const harness = createHarness();
  let reviewCalls = 0;
  let snapshotCalls = 0;
  let resolvePostApplySnapshot: ((value: any) => void) | undefined;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        return {
          isGitRepo: true,
          baselineHead: "abc123",
          status: "## main\n M src/a.ts",
          diffStat: "src/a.ts | 1 +",
          diff: "diff --git a/src/a.ts b/src/a.ts",
          committedChanges: "",
          untrackedFiles: [],
          notes: [],
        };
      }
      return await new Promise((resolve) => {
        resolvePostApplySnapshot = resolve;
      });
    },
    runFreshReviewAgent: async () => {
      reviewCalls += 1;
      return {
        text: reviewCalls === 1
          ? "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: fix once"
          : "## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings.",
        exitCode: 0,
        stderr: "",
        messages: [],
      };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("--until-approved stop after apply", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);
  assert.equal(reviewCalls, 1);

  const applyEndPromise = harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "applied" }], stopReason: "stop" }],
  }, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await harness.commands.get("review-cycle")?.handler("stop", harness.ctx);
  resolvePostApplySnapshot?.({
    isGitRepo: true,
    baselineHead: "abc123",
    status: "## main\n M src/a.ts\n M src/b.ts",
    diffStat: "src/a.ts | 1 +\nsrc/b.ts | 1 +",
    diff: "diff --git a/src/a.ts b/src/a.ts\ndiff --git a/src/b.ts b/src/b.ts",
    committedChanges: "",
    untrackedFiles: [],
    notes: [],
  });
  await applyEndPromise;

  assert.equal(reviewCalls, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Stopped review-cycle")));
  assert.equal(harness.notifications.some((entry) => entry.message.includes("rerunning fresh review")), false);
});

test("review-cycle stop during change snapshot does not launch reviewer", async () => {
  const harness = createHarness();
  let resolveSnapshot: ((value: any) => void) | undefined;
  let reviewCalls = 0;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => await new Promise((resolve) => {
      resolveSnapshot = resolve;
    }),
    runFreshReviewAgent: async () => {
      reviewCalls += 1;
      return { text: "## Verdict\nAPPROVE", exitCode: 0, stderr: "", messages: [] };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("snapshot stop task", harness.ctx);
  const agentEndPromise = harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await harness.commands.get("review-cycle")?.handler("stop", harness.ctx);
  resolveSnapshot?.({
    isGitRepo: true,
    baselineHead: "abc123",
    status: "## main\n M src/a.ts",
    diffStat: "src/a.ts | 1 +",
    diff: "diff --git a/src/a.ts b/src/a.ts",
    committedChanges: "",
    untrackedFiles: [],
    notes: [],
  });
  await agentEndPromise;

  assert.equal(reviewCalls, 0);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Stopped review-cycle")));
  assert.equal(harness.notifications.some((entry) => entry.message.includes("failed during fresh review")), false);
});

test("review-cycle stop aborts an active reviewer without reporting a failure", async () => {
  const harness = createHarness();
  let reviewerSignal: AbortSignal | undefined;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/a.ts",
      diffStat: "src/a.ts | 1 +",
      diff: "diff --git a/src/a.ts b/src/a.ts",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async (options: any) => {
      reviewerSignal = options.signal;
      return await new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
      });
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("abortable reviewer task", harness.ctx);
  const agentEndPromise = harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }], stopReason: "stop" }],
  }, harness.ctx);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await harness.commands.get("review-cycle")?.handler("stop", harness.ctx);
  await agentEndPromise;

  assert.equal(reviewerSignal?.aborted, true);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Stopped review-cycle")));
  assert.equal(harness.notifications.some((entry) => entry.message.includes("failed during fresh review")), false);
});

test("review-cycle output command toggles persisted visibility before a run starts", async () => {
  const harness = createHarness();
  let outputLineCalls = 0;

  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: false, status: "not a git repository", dirty: false }),
    getChangeSnapshot: async () => ({
      isGitRepo: false,
      status: "not a git repository",
      diffStat: "",
      diff: "",
      committedChanges: "",
      untrackedFiles: [],
      notes: [],
    }),
    runFreshReviewAgent: async (options: any) => {
      outputLineCalls += 1;
      options.onLine?.("reviewer line while hidden");
      return { text: "## Verdict\nAPPROVE", exitCode: 0, stderr: "", messages: [] };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("output off", harness.ctx);
  await harness.commands.get("review-cycle")?.handler("small task", harness.ctx);
  await harness.handlers.get("agent_end")?.({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
  }, harness.ctx);

  assert.equal(outputLineCalls, 1);
  assert.equal(
    harness.widgets.filter((entry) => entry.key === "review-cycle-reviewer-output" && entry.content).length,
    0,
  );

  await harness.commands.get("review-cycle")?.handler("output on", harness.ctx);
  assert.ok(harness.widgets.at(-1)?.content?.some((line) => line.includes("reviewer line while hidden")));
});
