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

test("agent_end still takes one adjacent continuation after an earlier continue when the primary goal remains verified complete", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
  });
  const gitSnapshots = [
    {
      isGitRepo: true,
      head: "head-primary-verification",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-1",
    },
    {
      isGitRepo: true,
      head: "head-adjacent-follow-up",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-2",
    },
  ];
  const decisions = [
    {
      action: "continue",
      reason: "One direct verification pass remains before concluding",
      updatedSummary: "The primary goal appears complete, but one final direct verification step should run before stopping.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 96,
      commitRecommendation: "none",
      nextPrompt: "Run one final targeted onboarding verification and summarize the result.",
    },
    {
      action: "stop",
      reason: "Primary goal is verified complete",
      updatedSummary: "The onboarding robustness goal is complete and verified.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done.",
    },
  ];
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => gitSnapshots.shift() as never,
    decideControllerAction: async () => decisions.shift() as never,
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
      content: "The main fix looks complete, but I will run one final targeted verification.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  let latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.phase, "primary");
  assert.equal(latestState?.adjacentContinuationCount, 0);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Run one final targeted onboarding verification and summarize the result.",
  );

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "Ran the final targeted onboarding verification; the primary goal is verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 1);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Add one adjacent regression test in the same onboarding flow and verify it passes.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
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

test("agent_end keeps one bounded local adjacent continue when a valid stop and one nearby optimization coexist", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
  });
  const adjacentPrompt = "Update one nearby onboarding regression assertion and rerun that single focused test.";
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-adjacent-bounded-nearby-step",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-bounded-nearby-step",
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
        reason: "One nearby onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: adjacentPrompt,
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
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 1);
  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.sentMessages[1]?.text, adjacentPrompt);
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end keeps a single clear local adjacent continuation instead of stopping after verified completion", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
  });
  const adjacentPrompt = "Add one adjacent regression test in the same onboarding flow and verify it passes.";
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-adjacent-single-step",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-single-step",
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
        nextPrompt: adjacentPrompt,
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
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 1);
  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.sentMessages[1]?.text, adjacentPrompt);
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

test("agent_end stops after verified completion when continue-similar is not active", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
  });
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-stop-default-policy",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-stop",
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
        reason: "This adjacent step should never be requested when completionPolicy=stop",
        updatedSummary: "Unexpected adjacent continuation.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Do not send this prompt.",
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
  assert.equal(adjacentDecisionCalls, 0);
  assert.equal(latestState?.enabled, false);
  assert.equal(latestState?.phase, "primary");
  assert.notEqual(harness.sentMessages.at(-1)?.text, "Do not send this prompt.");
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done.")));
});

test("agent_end consumes the final adjacent slot and then stops on the next renewed completion", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;
  const finalAdjacentPrompt = "Refine one final nearby onboarding validation assertion and rerun that focused test.";

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent-final-slot",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 12,
      currentIteration: 8,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 7,
      maxAdjacentContinuations: 8,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; one final adjacent slot remains for a nearby onboarding hardening step.",
      recentDecisions: [{
        iteration: 7,
        action: "continue",
        reason: "One nearby onboarding hardening step remained",
        nextPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  const gitSnapshots = [
    {
      isGitRepo: true,
      head: "head-restored-adjacent-final-slot-1",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-final-slot-1",
    },
    {
      isGitRepo: true,
      head: "head-restored-adjacent-final-slot-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-final-slot-2",
    },
  ];
  const stopDecisions = [
    {
      action: "stop",
      reason: "Primary goal remains verified complete after the latest adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the latest adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
    {
      action: "stop",
      reason: "Primary goal remains verified complete after consuming the final adjacent slot",
      updatedSummary: "The onboarding robustness goal remains complete and verified after consuming the final adjacent hardening slot.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
  ];

  createAutoModeExtension({
    getGitSnapshot: async () => gitSnapshots.shift() as never,
    decideControllerAction: async () => stopDecisions.shift() as never,
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One final nearby onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one final nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: finalAdjacentPrompt,
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The latest adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  let latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 8);
  assert.equal(harness.sentMessages.at(-1)?.text, finalAdjacentPrompt);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The final adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, false);
  assert.equal(latestState?.adjacentContinuationCount, 8);
  assert.equal(harness.sentMessages.filter((entry) => entry.text === finalAdjacentPrompt).length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done now.")));
});

test("agent_end persists one final allowed adjacent continuation before the budget is exhausted", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent-final-allowed",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 12,
      currentIteration: 8,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 4,
      maxAdjacentContinuations: 5,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; one final adjacent slot remains for a nearby onboarding hardening step.",
      recentDecisions: [{
        iteration: 4,
        action: "continue",
        reason: "One nearby onboarding hardening step remained",
        nextPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-final-allowed",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-final-allowed",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the latest adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the latest adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One final nearby onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one final nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Refine one final nearby onboarding validation assertion and rerun that focused test.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The latest adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, 1);
  assert.equal(latestState?.adjacentContinuationCount, 5);
  assert.equal(latestState?.maxAdjacentContinuations, 5);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Refine one final nearby onboarding validation assertion and rerun that focused test.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end stops from restored adjacent state when the adjacent budget is already exhausted", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent-at-limit",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 12,
      currentIteration: 9,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 8,
      maxAdjacentContinuations: 8,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; no adjacent continuation budget remains.",
      recentDecisions: [{
        iteration: 8,
        action: "continue",
        reason: "One nearby onboarding hardening step remained",
        nextPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-limit",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-limit",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the final adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the final adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "This adjacent continuation should not be requested once the budget is exhausted",
        updatedSummary: "Unexpected extra adjacent continuation.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Do not send this prompt.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The final adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 0);
  assert.equal(latestState?.enabled, false);
  assert.equal(latestState?.adjacentContinuationCount, 8);
  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done now.")));
});

test("agent_end leaves restored exhausted adjacent state unchanged and stops immediately", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const initialState = {
    version: 1,
    enabled: true,
    paused: false,
    runId: "auto-restored-adjacent-renewed-at-limit",
    goal: "improve onboarding robustness",
    mode: "iterations",
    maxIterations: 8,
    currentIteration: 4,
    startedAt: 1,
    commitPolicy: "final-or-milestone",
    pushPolicy: "never",
    completionPolicy: "continue-similar",
    phase: "adjacent",
    primaryGoalVerifiedAtIteration: 1,
    adjacentContinuationCount: 3,
    maxAdjacentContinuations: 3,
    primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
    allowControllerProbes: true,
    controllerSummary: "Primary goal complete; no adjacent continuation budget remains.",
    recentDecisions: [{
      iteration: 3,
      action: "continue",
      reason: "One adjacent hardening step remained",
      nextPrompt: "Refine one final nearby onboarding validation assertion and rerun that focused test.",
      timestamp: 1,
    }],
    lastAutoPrompt: "Refine one final nearby onboarding validation assertion and rerun that focused test.",
    consecutiveControllerFailures: 0,
    consecutiveWorkerFailures: 0,
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 0,
    resumePolicy: "restore-running",
  };

  const harness = createHarness();
  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: initialState,
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-renewed-at-limit",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-renewed-at-limit",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the final adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the final adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => ({
      action: "continue",
      reason: "This adjacent continuation should not be requested once the budget is exhausted",
      updatedSummary: "Unexpected extra adjacent continuation.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: "Do not send this prompt.",
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The final adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.enabled, false);
  assert.equal(latestState?.adjacentContinuationCount, initialState.adjacentContinuationCount);
  assert.equal(latestState?.maxAdjacentContinuations, initialState.maxAdjacentContinuations);
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, initialState.primaryGoalVerifiedAtIteration);
  assert.equal(latestState?.primaryGoalCompletionSummary, initialState.primaryGoalCompletionSummary);
  assert.equal(harness.sentMessages.length, 1);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done now.")));
});

test("agent_end increments restored adjacent continuation state exactly once per renewed continue without mutating the limit", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const initialState = {
    version: 1,
    enabled: true,
    paused: false,
    runId: "auto-restored-adjacent-renewed",
    goal: "improve onboarding robustness",
    mode: "iterations",
    maxIterations: 8,
    currentIteration: 2,
    startedAt: 1,
    commitPolicy: "final-or-milestone",
    pushPolicy: "never",
    completionPolicy: "continue-similar",
    phase: "adjacent",
    primaryGoalVerifiedAtIteration: 1,
    adjacentContinuationCount: 1,
    maxAdjacentContinuations: 3,
    primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
    allowControllerProbes: true,
    controllerSummary: "Primary goal complete; one nearby onboarding hardening step remains.",
    recentDecisions: [{
      iteration: 1,
      action: "continue",
      reason: "One adjacent hardening step remains",
      nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
      timestamp: 1,
    }],
    lastAutoPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
    consecutiveControllerFailures: 0,
    consecutiveWorkerFailures: 0,
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 0,
    resumePolicy: "restore-running",
  };
  const firstPrompt = "Tighten one nearby onboarding error-path assertion and rerun that focused test.";
  const secondPrompt = "Refine one final nearby onboarding validation assertion and rerun that focused test.";

  const harness = createHarness();
  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: initialState,
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-renewed-1",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-renewed-1",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => ({
      action: "continue",
      reason: "One more local onboarding hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one more nearby onboarding hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: firstPrompt,
    }),
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The first restored adjacent hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  let latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(latestState?.maxAdjacentContinuations, 3);
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, 1);
  assert.equal(latestState?.primaryGoalCompletionSummary, initialState.primaryGoalCompletionSummary);
  assert.equal(harness.sentMessages.at(-1)?.text, firstPrompt);

  const restoredHarness = createHarness();
  restoredHarness.entries.push(...JSON.parse(JSON.stringify(harness.entries)));

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-renewed-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-renewed-2",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the next adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the next adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => ({
      action: "continue",
      reason: "One final nearby onboarding hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one final nearby onboarding hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: secondPrompt,
    }),
  })(restoredHarness.pi as never);

  await restoredHarness.handlers.get("session_start")?.({ reason: "startup" }, restoredHarness.ctx);
  const restoredAgentEnd = restoredHarness.handlers.get("agent_end");
  assert.ok(restoredAgentEnd);

  await restoredAgentEnd?.({
    messages: [{
      role: "assistant",
      content: "The second restored adjacent hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, restoredHarness.ctx);

  latestState = getLatestAutoState(restoredHarness.entries);
  assert.equal(latestState?.adjacentContinuationCount, 3);
  assert.equal(latestState?.maxAdjacentContinuations, 3);
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, 1);
  assert.equal(latestState?.primaryGoalCompletionSummary, initialState.primaryGoalCompletionSummary);
  assert.equal(restoredHarness.sentMessages.at(-1)?.text, secondPrompt);
  assert.ok(restoredHarness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end continues one more local adjacent follow-up from restored adjacent state while budget remains", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 6,
      currentIteration: 2,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 1,
      maxAdjacentContinuations: 2,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with one adjacent regression-hardening step.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; one nearby onboarding hardening step remains.",
      recentDecisions: [{
        iteration: 1,
        action: "continue",
        reason: "One adjacent hardening step remains",
        nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-2",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the first adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the first adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One more local onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one more nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The first adjacent regression hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end allows another repeated local adjacent continuation while adjacent budget still remains", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent-repeat",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 7,
      currentIteration: 3,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 2,
      maxAdjacentContinuations: 3,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; one more nearby onboarding hardening step remains.",
      recentDecisions: [{
        iteration: 2,
        action: "continue",
        reason: "One more local onboarding hardening step remains",
        nextPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-3",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-3",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the second adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the second adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One final nearby onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one final nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The second adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 3);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end emits exactly one bounded adjacent follow-up on a repeated continue after verified completion", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;
  const boundedAdjacentPrompt = "Add one more nearby onboarding assertion for the same error path and rerun that focused test.";

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent-bounded-repeat",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 8,
      currentIteration: 3,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 2,
      maxAdjacentContinuations: 4,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; one more nearby onboarding hardening step remains.",
      recentDecisions: [{
        iteration: 2,
        action: "continue",
        reason: "One more local onboarding hardening step remains",
        nextPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-bounded-repeat",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-bounded-repeat",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the repeated adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the repeated adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One final nearby onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one final nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: boundedAdjacentPrompt,
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The repeated adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 3);
  assert.equal(harness.sentMessages.filter((entry) => entry.text === boundedAdjacentPrompt).length, 1);
  assert.equal(harness.sentMessages.at(-1)?.text, boundedAdjacentPrompt);
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end keeps one final repeated local adjacent continuation instead of stopping while one nearby step remains", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness();
  let adjacentDecisionCalls = 0;

  harness.entries.push({
    type: "custom",
    customType: AUTO_MODE_STATE_TYPE,
    data: {
      version: 1,
      enabled: true,
      paused: false,
      runId: "auto-restored-adjacent-final-repeat",
      goal: "improve onboarding robustness",
      mode: "iterations",
      maxIterations: 8,
      currentIteration: 4,
      startedAt: 1,
      commitPolicy: "final-or-milestone",
      pushPolicy: "never",
      completionPolicy: "continue-similar",
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 1,
      adjacentContinuationCount: 2,
      maxAdjacentContinuations: 3,
      primaryGoalCompletionSummary: "Primary goal complete; continuing with nearby onboarding hardening.",
      allowControllerProbes: true,
      controllerSummary: "Primary goal complete; one final nearby onboarding hardening step remains.",
      recentDecisions: [{
        iteration: 3,
        action: "continue",
        reason: "One more local onboarding hardening step remained",
        nextPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
        timestamp: 1,
      }],
      lastAutoPrompt: "Add one more nearby onboarding assertion for the same error path and rerun that focused test.",
      consecutiveControllerFailures: 0,
      consecutiveWorkerFailures: 0,
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 0,
      resumePolicy: "restore-running",
    },
  });

  createAutoModeExtension({
    getGitSnapshot: async () => ({
      isGitRepo: true,
      head: "head-restored-adjacent-final-repeat",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-restored-adjacent-final-repeat",
    }),
    decideControllerAction: async () => ({
      action: "stop",
      reason: "Primary goal remains verified complete after the repeated adjacent step",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the repeated adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    }),
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: "One final nearby onboarding hardening step remains",
        updatedSummary: "Primary goal complete; continuing with one final nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: "Refine one final nearby onboarding validation assertion and rerun that focused test.",
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The repeated adjacent onboarding hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, 1);
  assert.equal(latestState?.adjacentContinuationCount, 3);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Refine one final nearby onboarding validation assertion and rerun that focused test.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end keeps an adjacent repeated continue from falling back to stop in the active flow", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
    "auto-max-adjacent-continuations": "3",
  });
  const repeatedPrompt = "Add one adjacent regression test in the same onboarding flow and verify it passes.";
  const refinedPrompt = "Tighten one nearby onboarding error-path assertion and rerun that focused test.";
  const gitSnapshots = [
    {
      isGitRepo: true,
      head: "head-adjacent-repeat-1",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-repeat-1",
    },
    {
      isGitRepo: true,
      head: "head-adjacent-repeat-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-repeat-2",
    },
  ];
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
      reason: "Primary goal remains verified complete after the adjacent regression test",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the adjacent regression test.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
  ];
  const adjacentDecisions = [
    {
      action: "continue",
      reason: "One adjacent regression-hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one adjacent regression-hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: repeatedPrompt,
    },
    {
      action: "continue",
      reason: "One nearby onboarding hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one nearby onboarding hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: repeatedPrompt,
    },
  ];
  let adjacentDecisionCalls = 0;
  let repetitionRefinementCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => gitSnapshots.shift() as never,
    decideControllerAction: async () => stopDecisions.shift() as never,
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return adjacentDecisions.shift() as never;
    },
    getContinueRepetitionDecision: async (_ctx, _snapshot, decision) => {
      repetitionRefinementCalls += 1;
      assert.equal(decision.nextPrompt, repeatedPrompt);
      return {
        action: "continue",
        reason: "Keep the adjacent step local but make it more specific",
        updatedSummary: "Primary goal complete; refining the next adjacent hardening step without broadening scope.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: refinedPrompt,
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

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The adjacent regression test passes and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 2);
  assert.equal(repetitionRefinementCalls, 1);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(harness.sentMessages.at(-1)?.text, refinedPrompt);
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end keeps continuing adjacent local follow-ups after a prior continue while adjacent budget remains", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
    "auto-max-adjacent-continuations": "2",
  });
  const gitSnapshots = [
    {
      isGitRepo: true,
      head: "head-adjacent-1",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-1",
    },
    {
      isGitRepo: true,
      head: "head-adjacent-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-2",
    },
  ];
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
      reason: "Primary goal remains verified complete after one adjacent pass",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the first adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
  ];
  const adjacentDecisions = [
    {
      action: "continue",
      reason: "One adjacent regression-hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one nearby regression-hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
    },
    {
      action: "continue",
      reason: "One more local onboarding hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one more nearby onboarding hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
    },
  ];
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => gitSnapshots.shift() as never,
    decideControllerAction: async () => stopDecisions.shift() as never,
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return adjacentDecisions.shift() as never;
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

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The first adjacent regression hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 2);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end keeps repeated adjacent continuations stable across renewed completion in the active flow", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "6",
    "auto-completion-policy": "continue-similar",
    "auto-max-adjacent-continuations": "3",
  });
  const gitSnapshots = [
    {
      isGitRepo: true,
      head: "head-adjacent-stable-1",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-stable-1",
    },
    {
      isGitRepo: true,
      head: "head-adjacent-stable-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-stable-2",
    },
  ];
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
      reason: "Primary goal remains verified complete after one adjacent pass",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the first adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
  ];
  const firstAdjacentSummary = "Primary goal complete; continuing with one nearby regression-hardening step.";
  const adjacentDecisions = [
    {
      action: "continue",
      reason: "One adjacent regression-hardening step remains",
      updatedSummary: firstAdjacentSummary,
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: "Add one adjacent regression test in the same onboarding flow and verify it passes.",
    },
    {
      action: "continue",
      reason: "One more local onboarding hardening step remains",
      updatedSummary: "Primary goal complete; continuing with one more nearby onboarding hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "milestone",
      nextPrompt: "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
    },
  ];
  let adjacentDecisionCalls = 0;

  createAutoModeExtension({
    getGitSnapshot: async () => gitSnapshots.shift() as never,
    decideControllerAction: async () => stopDecisions.shift() as never,
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return adjacentDecisions.shift() as never;
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

  await agentEnd?.({
    messages: [{
      role: "assistant",
      content: "The first adjacent regression hardening step is done and the primary goal is still verified complete.",
      stopReason: "stop",
    }],
  }, harness.ctx);

  const latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 2);
  assert.equal(latestState?.enabled, true);
  assert.equal(latestState?.phase, "adjacent");
  assert.equal(latestState?.primaryGoalVerifiedAtIteration, 1);
  assert.equal(latestState?.primaryGoalCompletionSummary, firstAdjacentSummary);
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(
    harness.sentMessages.at(-1)?.text,
    "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
  );
  assert.ok(harness.notifications.every((entry) => !entry.message.includes("Auto-mode stopped")));
});

test("agent_end increments adjacent continuation count across repeated continues and then stops at the limit", async () => {
  const { createAutoModeExtension } = await loadAutoModeModule();
  const harness = createHarness({
    "auto-goal": "improve onboarding robustness",
    "auto-iterations": "8",
    "auto-completion-policy": "continue-similar",
    "auto-max-adjacent-continuations": "2",
  });
  let adjacentDecisionCalls = 0;
  const gitSnapshots = [
    {
      isGitRepo: true,
      head: "head-adjacent-limit-1",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-adjacent-limit-1",
    },
    {
      isGitRepo: true,
      head: "head-adjacent-limit-2",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-adjacent-limit-2",
    },
    {
      isGitRepo: true,
      head: "head-adjacent-limit-3",
      status: "## main",
      changedFiles: [],
      dirty: false,
      hasUpstream: false,
      repoFingerprint: "clean-fingerprint-adjacent-limit-3",
    },
  ];
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
      reason: "Primary goal remains verified complete after one adjacent pass",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the first adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
    {
      action: "stop",
      reason: "Primary goal remains verified complete after two adjacent passes",
      updatedSummary: "The onboarding robustness goal remains complete and verified after the second adjacent hardening step.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done now.",
    },
  ];
  const adjacentPrompts = [
    "Add one adjacent regression test in the same onboarding flow and verify it passes.",
    "Tighten one nearby onboarding error-path assertion and rerun that focused test.",
  ];

  createAutoModeExtension({
    getGitSnapshot: async () => gitSnapshots.shift() as never,
    decideControllerAction: async () => stopDecisions.shift() as never,
    getStopOverrideDecision: async () => undefined,
    getAdjacentContinuationDecision: async () => {
      adjacentDecisionCalls += 1;
      return {
        action: "continue",
        reason: adjacentDecisionCalls === 1 ? "One adjacent hardening step remains" : "One more local onboarding hardening step remains",
        updatedSummary: adjacentDecisionCalls === 1
          ? "Primary goal complete; continuing with one adjacent regression-hardening step."
          : "Primary goal complete; continuing with one more nearby onboarding hardening step.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "milestone",
        nextPrompt: adjacentPrompts[adjacentDecisionCalls - 1]!,
      };
    },
  })(harness.pi as never);

  await harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);
  const agentEnd = harness.handlers.get("agent_end");
  assert.ok(agentEnd);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "Primary goal is verified complete.", stopReason: "stop" }],
  }, harness.ctx);
  let latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.adjacentContinuationCount, 1);
  assert.equal(harness.sentMessages.at(-1)?.text, adjacentPrompts[0]);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "The first adjacent regression test also passes.", stopReason: "stop" }],
  }, harness.ctx);
  latestState = getLatestAutoState(harness.entries);
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(harness.sentMessages.at(-1)?.text, adjacentPrompts[1]);

  await agentEnd?.({
    messages: [{ role: "assistant", content: "The second adjacent hardening step also passes.", stopReason: "stop" }],
  }, harness.ctx);

  latestState = getLatestAutoState(harness.entries);
  assert.equal(adjacentDecisionCalls, 2);
  assert.equal(latestState?.enabled, false);
  assert.equal(latestState?.adjacentContinuationCount, 2);
  assert.equal(harness.sentMessages.filter((entry) => adjacentPrompts.includes(entry.text)).length, 2);
  assert.ok(harness.notifications.some((entry) => entry.message.includes("Auto-mode stopped: Done now.")));
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
