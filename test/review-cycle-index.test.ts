import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewCycleExtension } from "../extensions/review-cycle/index.ts";

function createHarness(options: { cwd?: string } = {}) {
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

test("review-cycle registers /rc alias and shows command help", async () => {
  const harness = createHarness();
  createReviewCycleExtension()(harness.pi as never);

  assert.ok(harness.commands.has("review-cycle"));
  assert.ok(harness.commands.has("rc"));

  await harness.commands.get("rc")?.handler("help", harness.ctx);

  assert.ok(harness.notifications.some((entry) => entry.message.includes("help shown")));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-help" && entry.content?.some((line) => line.includes("/rc <task>"))));
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
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-preflight" && entry.content?.some((line) => line.includes("Review-cycle preflight"))));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-preflight" && entry.content?.some((line) => line.includes("default safe test allowlist"))));

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
  assert.match(harness.sentMessages[1]?.text ?? "", /CHANGES_REQUESTED/);

  const visibleWidgets = harness.widgets.filter((entry) => entry.content);
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("Starting fresh-context reviewer"))));
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("CHANGES_REQUESTED"))));
  assert.ok(visibleWidgets.some((entry) => entry.content?.some((line) => line.includes("tests passed"))));
  assert.ok(visibleWidgets.some((entry) => entry.key === "review-cycle-review-summary" && entry.content?.some((line) => line.includes("[ ] 1. HIGH"))));

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

  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-review-summary" && entry.content?.some((line) => line.includes("[x] 1. HIGH"))));
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
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-review-summary" && entry.content?.some((line) => line.includes("no apply pass"))));
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

test("review-cycle pauses on dirty workspace until continue", async () => {
  const harness = createHarness();
  createReviewCycleExtension({
    getGitBaseline: async () => ({ isGitRepo: true, head: "abc123", status: "## main\n M existing.ts", dirty: true }),
  })(harness.pi as never);

  await harness.commands.get("review-cycle")?.handler("dirty task", harness.ctx);

  assert.equal(harness.sentMessages.length, 0);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("workspace already dirty")));
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-preflight" && entry.content?.some((line) => line.includes("continue or /review-cycle abort"))));

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
      tests: ["npm test"],
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
{"verdict":"CHANGES_REQUESTED","findings":[{"severity":"high","title":"Needs fix","file":"src/a.ts","line":3,"mandatory":true,"suggestion":"Fix it"}]}
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

    assert.deepEqual(allowedTestCommandSnapshots[0], ["npm test"]);
    assert.equal(harness.sentMessages.length, 1);
    assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-review-summary" && entry.content?.some((line) => line.includes("waiting for /review-cycle apply"))));

    await harness.commands.get("review-cycle")?.handler("apply", harness.ctx);
    assert.equal(harness.sentMessages.length, 2);
    assert.match(harness.sentMessages[1]?.text ?? "", /Fresh-context review/);

    await harness.handlers.get("agent_end")?.({
      messages: [{ role: "assistant", content: [{ type: "text", text: "applied and verified" }], stopReason: "stop" }],
    }, harness.ctx);

    const latest = await readFile(join(cwd, ".pi", "review-cycle", "latest.md"), "utf8");
    assert.match(latest, /Stage: apply-complete/);
    assert.match(latest, /Needs fix/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("review-cycle until-approved reruns review after apply", async () => {
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
  assert.ok(harness.widgets.some((entry) => entry.key === "review-cycle-review-summary" && entry.content?.some((line) => line.includes("reviewer failed"))));

  await harness.commands.get("review-cycle")?.handler("retry", harness.ctx);

  assert.equal(reviewCalls, 2);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("reviewer approved")));
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
