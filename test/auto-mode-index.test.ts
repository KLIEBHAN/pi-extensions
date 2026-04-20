import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import typescript from "typescript";
import { AUTO_MODE_STATE_TYPE } from "../extensions/auto-mode/core.ts";

let autoModeModulePromise: Promise<{ default: Function; createAutoModeExtension: Function }> | undefined;

async function loadAutoModeModule() {
  autoModeModulePromise ??= (async () => {
    const source = readFileSync(new URL("../extensions/auto-mode/index.ts", import.meta.url), "utf8");
    const transpiled = typescript.transpileModule(source, {
      compilerOptions: {
        module: typescript.ModuleKind.ES2022,
        target: typescript.ScriptTarget.ES2022,
        moduleResolution: typescript.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
      },
      fileName: "index.ts",
    }).outputText;

    const tempDir = mkdtempSync(join(tmpdir(), "auto-mode-index-test-"));
    const piAiStubPath = join(tempDir, "pi-ai.mjs");
    writeFileSync(piAiStubPath, 'export async function complete() { throw new Error("complete should not be called in auto-mode index tests"); }\n');

    const coreUrl = new URL("../extensions/auto-mode/core.ts", import.meta.url).href;
    const rewritten = transpiled
      .replace(/@mariozechner\/pi-ai/g, pathToFileURL(piAiStubPath).href)
      .replace(/\.\/core\.ts/g, coreUrl);

    const modulePath = join(tempDir, "index.mjs");
    writeFileSync(modulePath, rewritten);
    return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`) as Promise<{ default: Function; createAutoModeExtension: Function }>;
  })();

  return autoModeModulePromise;
}

function createHarness(initialFlags: Record<string, boolean | string | undefined> = {}) {
  const flags = new Map(Object.entries(initialFlags));
  const handlers = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const entries: unknown[] = [];
  const sentMessages: Array<{ text: string; options?: unknown }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
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
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(text: string, options?: unknown) {
      sentMessages.push({ text, options });
      entries.push({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      });
    },
    getFlag(name: string) {
      return flags.get(name);
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
    model: { provider: "openai", id: "gpt-worker" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
    },
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
    },
    isIdle: () => true,
    abort: () => {
      aborted = true;
    },
  };

  return { pi, handlers, commands, entries, sentMessages, notifications, statuses, ctx, get aborted() { return aborted; } };
}

function getLatestAutoState(entries: unknown[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType !== AUTO_MODE_STATE_TYPE) continue;
    return entry.data as Record<string, unknown>;
  }
  return undefined;
}

test("default export is a callable extension entry", async () => {
  const autoModeModule = await loadAutoModeModule();
  assert.equal(typeof autoModeModule.default, "function");
  assert.equal(typeof autoModeModule.createAutoModeExtension, "function");
});

test("session_start keeps the completion gate controller-only while before_agent_start appends worker rules", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-until": "Stop when onboarding is robust and tests are green",
  });

  createAutoModeExtension()(harness.pi as never);

  const sessionStart = harness.handlers.get("session_start");
  const beforeAgentStart = harness.handlers.get("before_agent_start");
  assert.ok(sessionStart);
  assert.ok(beforeAgentStart);

  await sessionStart?.({ reason: "startup" }, harness.ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.text, "improve onboarding robustness");
  assert.doesNotMatch(harness.sentMessages[0]?.text ?? "", /completion gate/i);

  const latestState = getLatestAutoState(harness.entries);
  assert.match(String(latestState?.controllerSummary ?? ""), /Completion gate:\nStop when onboarding is robust and tests are green/);

  const result = await beforeAgentStart?.({ systemPrompt: "BASE" });
  assert.equal(typeof result?.systemPrompt, "string");
  assert.match(result?.systemPrompt ?? "", /^BASE/);
  assert.match(result?.systemPrompt ?? "", /Auto-mode rules:/);
  assert.match(result?.systemPrompt ?? "", /Goal: improve onboarding robustness/);
  assert.doesNotMatch(result?.systemPrompt ?? "", /Completion gate:/);
});

test("agent_end no-change heuristic does not treat changed diffs in the same files as unchanged", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const snapshots = [
    {
      isGitRepo: true,
      head: "head-1",
      status: "## main\n M src/feature.ts",
      changedFiles: ["src/feature.ts"],
      dirty: true,
      hasUpstream: false,
      repoFingerprint: "fingerprint-a",
    },
    {
      isGitRepo: true,
      head: "head-1",
      status: "## main\n M src/feature.ts",
      changedFiles: ["src/feature.ts"],
      dirty: true,
      hasUpstream: false,
      repoFingerprint: "fingerprint-b",
    },
  ];
  const decisions = [
    {
      action: "continue",
      reason: "Keep iterating",
      updatedSummary: "First refinement in progress.",
      goalStatus: "in_progress",
      completionGateMet: false,
      progressPercent: 20,
      commitRecommendation: "none",
      nextPrompt: "Refine the first gap in the same file and verify it.",
    },
    {
      action: "continue",
      reason: "Keep iterating",
      updatedSummary: "Second refinement in progress.",
      goalStatus: "in_progress",
      completionGateMet: false,
      progressPercent: 35,
      commitRecommendation: "none",
      nextPrompt: "Refine the second gap in the same file and verify it.",
    },
  ];

  const harness = createHarness({
    "auto-goal": "improve feature robustness",
    "auto-iterations": "6",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => snapshots.shift(),
    decideControllerAction: async () => decisions.shift() as never,
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({ messages: [{ role: "assistant", content: "Implemented the first refinement.", stopReason: "stop" }] }, harness.ctx);
  let latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.consecutiveNoChangeCount, 0);
  assert.equal(latestState?.currentIteration, 2);

  await agentEnd?.({ messages: [{ role: "assistant", content: "Implemented the second refinement.", stopReason: "stop" }] }, harness.ctx);
  latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.consecutiveNoChangeCount, 0);
  assert.equal(latestState?.currentIteration, 3);
  assert.equal(latestState?.paused, false);
  assert.equal(harness.sentMessages.at(-1)?.text, "Refine the second gap in the same file and verify it.");
});

test("agent_end refines a repeated continue prompt before sending it again", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const repeatedPrompt = "improve onboarding robustness";
  let repetitionRefinementCalls = 0;
  const harness = createHarness({
    "auto-goal": repeatedPrompt,
    "auto-iterations": "6",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-repeat",
      status: "## main\n M src/onboarding.ts",
      changedFiles: ["src/onboarding.ts"],
      dirty: true,
      hasUpstream: false,
      repoFingerprint: "repeat-fingerprint",
    }),
    decideControllerAction: async () => ({
      action: "continue",
      reason: "A concrete onboarding follow-up remains",
      updatedSummary: "The onboarding work still needs one more direct step.",
      goalStatus: "in_progress",
      completionGateMet: false,
      progressPercent: 35,
      commitRecommendation: "none",
      nextPrompt: repeatedPrompt,
    }),
    getContinueRepetitionDecision: async (_ctx, _snapshot, decision) => {
      repetitionRefinementCalls += 1;
      assert.equal(decision.nextPrompt, repeatedPrompt);
      return {
        action: "continue",
        reason: "Make the follow-up materially more specific",
        updatedSummary: "The loop should target one concrete onboarding regression gap instead of repeating the generic goal.",
        goalStatus: "in_progress",
        completionGateMet: false,
        progressPercent: 35,
        commitRecommendation: "none",
        nextPrompt: "Inspect src/onboarding.ts for the remaining validation gap, add one focused regression test, and run that targeted test before continuing.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The onboarding flow is better, but I still need one concrete verification step.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(repetitionRefinementCalls, 1);
  assert.equal(latestState?.paused, false);
  assert.equal(latestState?.currentIteration, 2);
  assert.match(String(latestState?.controllerSummary ?? ""), /Controller repetition refinement:/);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Inspect src/onboarding.ts for the remaining validation gap, add one focused regression test, and run that targeted test before continuing.",
  );
});

test("agent_end does not auto-enter adjacent phase on a normal continue even when the primary goal is already met", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-continue",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint",
    }),
    decideControllerAction: async () => ({
      action: "continue",
      reason: "One concrete verification follow-up remains before stopping",
      updatedSummary: "The primary goal appears met, but there is still one direct next step before concluding.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 95,
      commitRecommendation: "none",
      nextPrompt: "Run one final targeted verification in the same area and summarize the result.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The main fix looks complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.phase, "primary");
  assert.equal(latestState?.adjacentContinuationCount, 0);
  assert.equal(harness.sentMessages.at(-1)?.text, "Run one final targeted verification in the same area and summarize the result.");
});

test("agent_end does not stop early when continue-similar has a clear local adjacent optimization after verified completion", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
  });
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-adjacent-regression",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal is verified complete",
      updatedSummary: "The onboarding robustness goal is complete and verified.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One adjacent hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one adjacent regression-hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "Ran npm test, all tests pass, and verified the fix manually.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Add one adjacent regression test in the same onboarding flow and verify it passes.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end can continue with an adjacent optimization after verified completion", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal is verified complete",
      updatedSummary: "The onboarding robustness goal is complete and verified.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => ({
      action: "continue",
      reason: "One adjacent hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one adjacent regression-hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "Ran npm test, all tests pass, and verified the fix manually.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 1);
  assert.equal(latestState?.maxAdjacentContinuations, 1);
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, 1);
  assert.equal(latestState?.primaryGoalCompletionSummary, "Primary goal complete; continuing with one adjacent regression-hardening step.");
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Add one adjacent regression test in the same onboarding flow and verify it passes.",
  );
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode exploring adjacent optimization")));
});

test("agent_end stops after the configured adjacent continuation limit is reached", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
    "auto-max-adjacent-continuations": "1",
  });
  let adjacentDecisionCalls = 0;
  const stopDecisions = [
    {
      action: "stop",
      reason: "Primary goal is verified complete",
      updatedSummary: "The onboarding robustness goal is complete and verified.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
    {
      action: "stop",
      reason: "Primary goal is still verified complete after one adjacent pass",
      updatedSummary: "The onboarding robustness goal remains complete and verified.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
  ];

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-3",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint",
    }),
    decideControllerAction: async () => stopDecisions.shift() as never,
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One adjacent hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one adjacent regression-hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "Primary goal is verified complete.", stopReason: "stop" }],
  }, harness.ctx);
  await agentEnd?.({
    messages: [{ role: "assistant", content: "The adjacent regression test also passes.", stopReason: "stop" }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, false);
  assert.equal(latestState?.adjacentContinuationCount, 1);
  assert.equal(harness.sentMessages.filter((entry) => entry.text.includes("adjacent regression test")).length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done now.")));
});
