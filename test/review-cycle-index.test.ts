import test from "node:test";
import assert from "node:assert/strict";
import { createReviewCycleExtension } from "../extensions/review-cycle/index.ts";

function createHarness() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const sentMessages: Array<{ text: string; options?: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const widgets: Array<{ key: string; content: string[] | undefined; options?: unknown }> = [];
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
    getFlag() {
      return undefined;
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
    cwd: "/repo",
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
    get aborted() {
      return aborted;
    },
  };
}

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
      options.onOutput?.("APPROVE_WITH_NOTES\n");
      options.onLine?.("✓ bash");
      options.onLine?.("  tests passed");
      return {
        text: "## Verdict\nAPPROVE_WITH_NOTES\n\n## Findings\nNo mandatory findings.",
        exitCode: 0,
        stderr: "",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "## Verdict\nAPPROVE_WITH_NOTES" }],
          },
        ],
      };
    },
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("implement auth hardening", harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.text, "implement auth hardening");
  assert.equal(harness.statuses.at(-1)?.key, "review-cycle");
  assert.match(harness.statuses.at(-1)?.value ?? "", /Review implement/);

  await harness.handlers.get("agent_end")?.({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Implemented auth hardening and ran npm test." }],
        stopReason: "stop",
      },
    ],
  }, harness.ctx);

  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0]?.cwd, "/repo");
  assert.match(reviewCalls[0]?.prompt ?? "", /implement auth hardening/);

  assert.equal(harness.sentMessages.length, 2);
  assert.match(harness.sentMessages[1]?.text ?? "", /Fresh-context review/);
  assert.match(harness.sentMessages[1]?.text ?? "", /APPROVE_WITH_NOTES/);

  const visibleWidgets = harness.widgets.filter((entry) => entry.content);
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("Starting fresh-context reviewer"))));
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("APPROVE_WITH_NOTES"))));
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("tests passed"))));

  await harness.commands.get("review-cycle")?.handler("output off", harness.ctx);
  assert.equal(harness.widgets.at(-1)?.key, "review-cycle-reviewer-output");
  assert.equal(harness.widgets.at(-1)?.content, undefined);

  await harness.commands.get("review-cycle")?.handler("output on", harness.ctx);
  assert.equal(harness.widgets.at(-1)?.key, "review-cycle-reviewer-output");
  assert.ok(harness.widgets.at(-1)?.content?.some((line) => line.includes("APPROVE_WITH_NOTES")));
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
  assert.equal(harness.widgets.filter((entry) => entry.content).length, 0);

  await harness.commands.get("review-cycle")?.handler("output on", harness.ctx);
  assert.ok(harness.widgets.at(-1)?.content?.some((line) => line.includes("reviewer line while hidden")));
});
