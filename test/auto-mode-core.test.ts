import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendDecisionHistory,
  AUTO_MODE_STATE_TYPE,
  AUTO_MODE_SYSTEM_PROMPT_TEMPLATE,
  AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS,
  buildAutoControllerSystemPrompt,
  buildAutoStartConfigFromFlags,
  buildAutoWorkerSystemPrompt,
  buildAutoWorkerSystemPromptTemplateVariables,
  buildBlockedStopFollowUp,
  buildResumePrompt,
  buildStartPrompt,
  decideAutoModeSessionStart,
  DEFAULT_AUTO_ITERATIONS,
  DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS,
  DEFAULT_CONTROLLER_MODEL,
  DEFAULT_DECISION_HISTORY_LIMIT,
  DEFAULT_STAGNATION_LIMIT,
  evaluateAutoStopGuard,
  extractLatestAutoModeState,
  normalizeComparableText,
  normalizeTemplateText,
  parseAutoCommandArgs,
  parseControllerDecision,
  parseModelRef,
  parsePositiveInteger,
  planAutoFollowUp,
  renderMiniTemplate,
  shouldAutoResumeOnSessionStart,
  shouldPreRunVerifyCommand,
  summarizeGoal,
  truncateControllerSummary,
} from "../extensions/auto-mode/core.ts";

test("parsePositiveInteger accepts valid positive integers within range", () => {
  assert.equal(parsePositiveInteger("1", 10), 1);
  assert.equal(parsePositiveInteger("12", 20), 12);
  assert.equal(parsePositiveInteger("0", 10), undefined);
  assert.equal(parsePositiveInteger("-1", 10), undefined);
  assert.equal(parsePositiveInteger("abc", 10), undefined);
  assert.equal(parsePositiveInteger("21", 20), undefined);
});

test("parseModelRef parses provider/model strings", () => {
  assert.deepEqual(parseModelRef("openai/gpt-5.4-mini"), {
    provider: "openai",
    id: "gpt-5.4-mini",
  });
  assert.equal(parseModelRef("invalid"), undefined);
});

test("default controller model follows the active worker model", () => {
  assert.equal(DEFAULT_CONTROLLER_MODEL, "active worker model");
});

test("auto-mode system prompts are rendered from the template file with only worker and controller sections", () => {
  const template = normalizeTemplateText(
    readFileSync(
      new URL("../extensions/auto-mode/system-prompt.template.md", import.meta.url),
      "utf8",
    ),
  );

  const workerInput = {
    goal: "Improve onboarding robustness",
    verifyCommand: "npm test",
    commitPolicy: "final-or-milestone" as const,
    pushPolicy: "final-or-milestone-if-upstream" as const,
  };

  assert.equal(AUTO_MODE_SYSTEM_PROMPT_TEMPLATE, template);
  assert.deepEqual(Object.keys(AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS).sort(), ["controller", "worker"]);
  assert.equal(
    buildAutoWorkerSystemPrompt(workerInput),
    renderMiniTemplate(
      AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS.worker,
      buildAutoWorkerSystemPromptTemplateVariables(workerInput),
    ),
  );
  assert.equal(buildAutoControllerSystemPrompt(), AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS.controller);
  assert.doesNotMatch(buildAutoControllerSystemPrompt(), /probe/i);
  assert.doesNotMatch(buildAutoControllerSystemPrompt(), /continue-similar/i);
});

test("parseAutoCommandArgs parses /auto on with defaults", () => {
  const parsed = parseAutoCommandArgs("on improve onboarding flow");
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.goal, "improve onboarding flow");
  assert.equal(parsed.config.mode, "iterations");
  assert.equal(parsed.config.maxIterations, DEFAULT_AUTO_ITERATIONS);
  assert.equal(parsed.config.untilPrompt, undefined);
  assert.equal(parsed.config.assuranceMode, "pragmatic");
  assert.deepEqual(parsed.warnings, []);
});

test("parseAutoCommandArgs parses strict mode with verify", () => {
  const parsed = parseAutoCommandArgs(
    'on --assurance strict --verify "npm test" --until "Stop when tests are green" improve onboarding flow',
  );
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.assuranceMode, "strict");
  assert.equal(parsed.config.verifyCommand, "npm test");
  assert.equal(parsed.config.mode, "until");
  assert.equal(parsed.config.maxIterations, DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS);
});

test("parseAutoCommandArgs warns for deprecated flags but still starts in V2", () => {
  const parsed = parseAutoCommandArgs(
    "on --completion-policy continue-similar --worker-reflection improve onboarding flow",
  );
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.match(parsed.warnings.join("\n"), /--completion-policy is deprecated/i);
  assert.match(parsed.warnings.join("\n"), /--worker-reflection is deprecated/i);
  assert.equal(parsed.config.assuranceMode, "pragmatic");
});

test("parseAutoCommandArgs rejects strict mode without verify", () => {
  assert.deepEqual(parseAutoCommandArgs("on --assurance strict improve onboarding flow"), {
    error: "--assurance strict requires --verify <cmd>",
  });
});

test("parseAutoCommandArgs reports invalid known flags before missing-goal usage", () => {
  assert.deepEqual(parseAutoCommandArgs("on --iterations nope"), {
    error: "--iterations must be an integer between 1 and 1000",
  });
});

test("buildAutoStartConfigFromFlags parses defaults and warnings", () => {
  const parsed = buildAutoStartConfigFromFlags({
    goal: "improve settings UX",
    until: "Stop when the settings flow is robust",
    controllerModel: "openai/gpt-5.4-mini",
    verify: "npm test",
    assurance: "strict",
    workerReflection: true,
  });

  assert.ok(parsed && !("error" in parsed));
  if (!parsed || "error" in parsed) return;

  assert.equal(parsed.config.goal, "improve settings UX");
  assert.equal(parsed.config.mode, "until");
  assert.equal(parsed.config.maxIterations, DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS);
  assert.equal(parsed.config.verifyCommand, "npm test");
  assert.equal(parsed.config.assuranceMode, "strict");
  assert.equal(parsed.config.resumeOnSessionStart, false);
  assert.deepEqual(parsed.config.controllerModel, {
    provider: "openai",
    id: "gpt-5.4-mini",
  });
  assert.match(parsed.warnings.join("\n"), /--auto-worker-reflection is deprecated/i);
});

test("buildAutoStartConfigFromFlags returns errors for invalid assurance and strict without verify", () => {
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "improve app", assurance: "bad" }), {
    error: "--auto-assurance must be one of: pragmatic, strict",
  });
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "improve app", assurance: "strict" }), {
    error: "--auto-assurance strict requires --auto-verify <cmd>",
  });
});

test("parseControllerDecision parses continue and stop decisions and ignores extra fields", () => {
  const continueDecision = parseControllerDecision(`Decision follows:\n{"action":"continue","reason":"One step remains","nextPrompt":"Add one focused regression test.","updatedSummary":"One focused regression test remains.","goalStatus":"in_progress","completionGateMet":false,"progressPercent":88}`);
  assert.ok(continueDecision);
  assert.equal(continueDecision?.action, "continue");
  if (!continueDecision || continueDecision.action !== "continue") return;
  assert.equal(continueDecision.nextPrompt, "Add one focused regression test.");

  const stopDecision = parseControllerDecision(`{"action":"stop","reason":"Done","updatedSummary":"Goal is complete.","goalStatus":"met","qualityGoalMet":true,"finalMessage":"Stopping now."}`);
  assert.ok(stopDecision);
  assert.equal(stopDecision?.action, "stop");
  if (!stopDecision || stopDecision.action !== "stop") return;
  assert.equal(stopDecision.completionGateMet, true);
  assert.equal(stopDecision.finalMessage, "Stopping now.");
});

test("parseControllerDecision scans balanced JSON objects after invalid brace examples", () => {
  const decision = parseControllerDecision(`Here is an invalid example first: "Object { action: continue }.

Actual decision:
{"action":"pause","reason":"Blocked by repeated failures with {details} in text","updatedSummary":"Paused after controller review.","goalStatus":"blocked","completionGateMet":false}`);

  assert.ok(decision);
  assert.equal(decision?.action, "pause");
  assert.equal(decision?.reason, "Blocked by repeated failures with {details} in text");
});

test("shouldPreRunVerifyCommand runs near stop when verify is configured", () => {
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: true,
      stopReason: "stop",
      currentIteration: 2,
      maxIterations: 8,
    }),
    true,
  );
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: true,
      stopReason: "toolUse",
      currentIteration: 8,
      maxIterations: 8,
    }),
    true,
  );
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: false,
      stopReason: "stop",
      currentIteration: 2,
      maxIterations: 8,
    }),
    false,
  );
});

test("shouldAutoResumeOnSessionStart only resumes on startup", () => {
  assert.equal(shouldAutoResumeOnSessionStart("startup", true, "restore-paused"), true);
  assert.equal(shouldAutoResumeOnSessionStart("startup", false, "restore-running"), true);
  assert.equal(shouldAutoResumeOnSessionStart("startup", false, "restore-paused"), false);
  assert.equal(shouldAutoResumeOnSessionStart("reload", true, "restore-running"), false);
});

test("decideAutoModeSessionStart prefers startup flags but restores persisted state when flags are invalid", () => {
  assert.deepEqual(
    decideAutoModeSessionStart({
      reason: "startup",
      hasPersistedSnapshot: true,
      autoStartConfigState: "valid",
      autoResumeFlag: true,
      persistedResumePolicy: "restore-running",
    }),
    { action: "start-from-flags", autoResume: false },
  );

  assert.deepEqual(
    decideAutoModeSessionStart({
      reason: "startup",
      hasPersistedSnapshot: true,
      autoStartConfigState: "invalid",
      autoStartError: "--auto-goal is invalid",
      autoResumeFlag: true,
      persistedResumePolicy: "restore-running",
    }),
    { action: "restore", autoResume: true, warning: "--auto-goal is invalid" },
  );
});

test("buildStartPrompt and buildResumePrompt stay minimal", () => {
  const startPrompt = buildStartPrompt({ goal: "Improve onboarding robustness" });
  assert.equal(startPrompt, "Improve onboarding robustness");

  const resumePrompt = buildResumePrompt({
    goal: "Improve onboarding robustness",
    controllerSummary: "One direct regression test remains.",
  });
  assert.match(resumePrompt, /Resume the active goal from the current repository state\./);
  assert.match(resumePrompt, /Goal: Improve onboarding robustness/);
  assert.match(resumePrompt, /Controller summary:\nOne direct regression test remains\./);
  assert.doesNotMatch(resumePrompt, /Completion gate:/);
});

test("buildAutoWorkerSystemPrompt keeps completion gates controller-only", () => {
  const prompt = buildAutoWorkerSystemPrompt({
    goal: "Improve onboarding robustness",
    verifyCommand: "npm test",
    commitPolicy: "final-or-milestone",
    pushPolicy: "final-or-milestone-if-upstream",
  });

  assert.match(prompt, /^Auto-mode worker rules:/);
  assert.match(prompt, /run this verification command before you stop: npm test/i);
  assert.match(prompt, /Goal: Improve onboarding robustness/);
  assert.doesNotMatch(prompt, /Completion gate:/);
});

test("buildAutoControllerSystemPrompt is short and only allows continue stop or pause", () => {
  const prompt = buildAutoControllerSystemPrompt();

  assert.match(prompt, /^You are the controller for an autonomous coding loop\./);
  assert.match(prompt, /continue, stop, or pause/);
  assert.doesNotMatch(prompt, /probe/i);
  assert.doesNotMatch(prompt, /adjacent/i);
  assert.doesNotMatch(prompt, /continue-similar/i);
});

test("evaluateAutoStopGuard allows pragmatic stop without verify when goal is met and git is clean", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: false,
      completionGateMet: true,
      verifyCommandConfigured: false,
      verifyCommandPassed: false,
      commitPolicy: "final-or-milestone",
      pushPolicy: "if-upstream",
      git: {
        dirty: false,
        hasUpstream: true,
        ahead: 0,
        behind: 0,
      },
    }),
    {
      allowed: true,
      blockers: [],
    },
  );
});

test("evaluateAutoStopGuard blocks failed verification and git finalization gaps", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: false,
      completionGateMet: true,
      verifyCommandConfigured: true,
      verifyCommandPassed: false,
      commitPolicy: "final-or-milestone",
      pushPolicy: "final-or-milestone-if-upstream",
      git: {
        dirty: true,
        hasUpstream: true,
        ahead: 2,
        behind: 1,
      },
    }),
    {
      allowed: false,
      blockers: ["verification-failed", "commit-required", "push-required", "sync-required"],
    },
  );
});

test("buildBlockedStopFollowUp produces short deterministic follow-ups", () => {
  const verifyFollowUp = buildBlockedStopFollowUp({
    blockers: ["verification-failed"],
    goal: "Improve onboarding robustness",
    verifyCommand: "npm test",
  });
  assert.match(verifyFollowUp, /Run npm test until it passes/);
  assert.doesNotMatch(verifyFollowUp, /git show/i);

  const mixedFollowUp = buildBlockedStopFollowUp({
    blockers: ["commit-required", "sync-required", "push-required"],
    goal: "Improve onboarding robustness",
  });
  assert.match(mixedFollowUp, /Create the final atomic commit/);
  assert.match(mixedFollowUp, /Bring the current branch back in sync with upstream/);
  assert.match(mixedFollowUp, /Push the current branch to upstream/);
});

test("planAutoFollowUp sends new prompts and pauses on repetition or no-change", () => {
  assert.deepEqual(
    planAutoFollowUp({
      nextPrompt: "Add one focused regression test.",
      currentIteration: 2,
      maxIterations: 8,
      lastAutoPrompt: "Inspect the remaining onboarding gap.",
      consecutiveStagnationCount: 1,
      consecutiveNoChangeCount: 0,
      budgetPauseReason: "iteration budget exhausted",
    }),
    {
      action: "send",
      nextPrompt: "Add one focused regression test.",
      nextIteration: 3,
      nextStagnationCount: 0,
    },
  );

  assert.deepEqual(
    planAutoFollowUp({
      nextPrompt: "Add one focused regression test.",
      currentIteration: 2,
      maxIterations: 8,
      lastAutoPrompt: "Add one focused regression test.",
      consecutiveStagnationCount: DEFAULT_STAGNATION_LIMIT - 1,
      consecutiveNoChangeCount: 0,
      budgetPauseReason: "iteration budget exhausted",
    }),
    {
      action: "pause",
      reason: "controller produced the same next prompt repeatedly",
      nextStagnationCount: DEFAULT_STAGNATION_LIMIT,
    },
  );

  assert.deepEqual(
    planAutoFollowUp({
      nextPrompt: "Create the final commit.",
      currentIteration: 4,
      maxIterations: 8,
      lastAutoPrompt: "Run npm test.",
      consecutiveStagnationCount: 0,
      consecutiveNoChangeCount: 3,
      budgetPauseReason: "iteration budget exhausted",
    }),
    {
      action: "pause",
      reason: "repository state has not changed across several iterations",
      nextStagnationCount: 0,
    },
  );
});

test("extractLatestAutoModeState migrates legacy V1 state to V2 pragmatic semantics with warnings", () => {
  const entries = [
    {
      type: "custom",
      customType: AUTO_MODE_STATE_TYPE,
      data: {
        version: 1,
        enabled: true,
        paused: false,
        runId: "auto-old",
        goal: "old goal",
        mode: "iterations",
        maxIterations: 8,
        currentIteration: 2,
        startedAt: 1,
        commitPolicy: "final-or-milestone",
        pushPolicy: "final-or-milestone-if-upstream",
        completionPolicy: "continue-similar",
        controllerSummary: "old",
        recentDecisions: [],
        consecutiveControllerFailures: 0,
        consecutiveWorkerFailures: 0,
        consecutiveStagnationCount: 0,
        consecutiveNoChangeCount: 0,
        resumePolicy: "restore-paused",
      },
    },
  ];

  const migrated = extractLatestAutoModeState(entries);
  assert.ok(migrated);
  assert.equal(migrated?.version, 2);
  assert.equal(migrated?.assuranceMode, "pragmatic");
  assert.match(migrated?.migrationWarnings?.join("\n") ?? "", /legacy auto-mode V1 state/i);
});

test("normalization helpers keep summaries compact", () => {
  assert.equal(normalizeComparableText("  Add   Tests\nNow "), "add tests now");
  assert.equal(normalizeComparableText("Run `npm test` before stopping."), "run npm test before stopping");
  assert.equal(summarizeGoal("Improve onboarding", 30), "Improve onboarding");
  assert.equal(
    summarizeGoal("Improve onboarding robustness, tests, and error handling", 24),
    "Improve onboarding robu…",
  );
  assert.equal(
    truncateControllerSummary("x".repeat(10), 6),
    "xxxxx…",
  );
});

test("appendDecisionHistory keeps only the latest entries", () => {
  const history = Array.from({ length: DEFAULT_DECISION_HISTORY_LIMIT }, (_, index) => ({
    iteration: index + 1,
    action: "continue" as const,
    reason: `reason-${index + 1}`,
    nextPrompt: `prompt-${index + 1}`,
    timestamp: index + 1,
  }));

  const next = appendDecisionHistory(history, {
    iteration: 99,
    action: "pause",
    reason: "done",
    timestamp: 99,
  }, DEFAULT_DECISION_HISTORY_LIMIT);

  assert.equal(next.length, DEFAULT_DECISION_HISTORY_LIMIT);
  assert.equal(next.at(-1)?.iteration, 99);
  assert.equal(next[0]?.iteration, 2);
});
