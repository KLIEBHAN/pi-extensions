import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutoStartConfigFromFlags,
  DEFAULT_AUTO_ITERATIONS,
  DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS,
  looksLikeCompletionClaim,
  normalizeComparableText,
  parseAutoCommandArgs,
  parseControllerDecision,
  parseModelRef,
  parsePositiveInteger,
  shouldPreRunVerifyCommand,
  summarizeGoal,
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

test("parseAutoCommandArgs parses /auto on with defaults", () => {
  const parsed = parseAutoCommandArgs("on improve onboarding flow");
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.goal, "improve onboarding flow");
  assert.equal(parsed.config.mode, "iterations");
  assert.equal(parsed.config.maxIterations, DEFAULT_AUTO_ITERATIONS);
  assert.equal(parsed.config.untilPrompt, undefined);
});

test("parseAutoCommandArgs parses hybrid mode with quoted until prompt and controller model", () => {
  const parsed = parseAutoCommandArgs(
    'on --iterations 14 --until "Stop when onboarding is robust and tests are green" --controller-model openai/gpt-5.4-mini improve onboarding flow',
  );
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.mode, "hybrid");
  assert.equal(parsed.config.maxIterations, 14);
  assert.equal(parsed.config.untilPrompt, "Stop when onboarding is robust and tests are green");
  assert.deepEqual(parsed.config.controllerModel, {
    provider: "openai",
    id: "gpt-5.4-mini",
  });
});

test("parseAutoCommandArgs parses no-controller-probes and max wall clock overrides", () => {
  const parsed = parseAutoCommandArgs("on --no-controller-probes --max-wall-clock-minutes 90 improve stability");
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.allowControllerProbes, false);
  assert.equal(parsed.config.maxWallClockMinutes, 90);
});

test("parseAutoCommandArgs uses until safety limit when only --until is provided", () => {
  const parsed = parseAutoCommandArgs('on --until "Stop when release readiness is reached" improve release readiness');
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.mode, "until");
  assert.equal(parsed.config.maxIterations, DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS);
});

test("parseAutoCommandArgs parses non-start subcommands", () => {
  assert.deepEqual(parseAutoCommandArgs("status"), { kind: "status" });
  assert.deepEqual(parseAutoCommandArgs("pause"), { kind: "pause" });
  assert.deepEqual(parseAutoCommandArgs("resume"), { kind: "resume" });
  assert.deepEqual(parseAutoCommandArgs("off"), { kind: "off" });
  assert.deepEqual(parseAutoCommandArgs("summary"), { kind: "summary" });
  assert.deepEqual(parseAutoCommandArgs("nudge focus on tests next"), {
    kind: "nudge",
    text: "focus on tests next",
  });
});

test("parseAutoCommandArgs reports invalid input", () => {
  assert.deepEqual(parseAutoCommandArgs(""), {
    error: "Usage: /auto <on|off|pause|resume|status|summary|nudge>",
  });
  assert.deepEqual(parseAutoCommandArgs("on --iterations 0 improve app"), {
    error: "--iterations must be an integer between 1 and 1000",
  });
  assert.deepEqual(parseAutoCommandArgs("on --commit-policy nope improve app"), {
    error: "--commit-policy must be one of: none, milestones, final-or-milestone",
  });
  assert.deepEqual(parseAutoCommandArgs("nudge   "), {
    error: "Usage: /auto nudge <instruction>",
  });
});

test("buildAutoStartConfigFromFlags applies defaults and parses optional values", () => {
  const parsed = buildAutoStartConfigFromFlags({
    goal: "improve settings UX",
    until: "Stop when the settings flow is robust",
    controllerModel: "openai/gpt-5.4-mini",
    verify: "npm test",
    allowControllerProbes: "false",
    resume: "true",
  });

  assert.ok(parsed && !('error' in parsed));
  if (!parsed || 'error' in parsed) return;

  assert.equal(parsed.goal, "improve settings UX");
  assert.equal(parsed.mode, "until");
  assert.equal(parsed.maxIterations, DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS);
  assert.equal(parsed.verifyCommand, "npm test");
  assert.equal(parsed.allowControllerProbes, false);
  assert.equal(parsed.resumeOnSessionStart, true);
  assert.deepEqual(parsed.controllerModel, {
    provider: "openai",
    id: "gpt-5.4-mini",
  });
});

test("buildAutoStartConfigFromFlags returns errors for invalid values", () => {
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "   ", iterations: "3" }), {
    error: "--auto-goal must be a non-empty string",
  });
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "improve app", controllerModel: "bad" }), {
    error: "--auto-controller-model must be in provider/model form",
  });
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "improve app", pushPolicy: "bad" }), {
    error: "--auto-push-policy must be one of: never, if-upstream, final-or-milestone-if-upstream",
  });
});

test("parseControllerDecision parses continue decisions and clamps progress", () => {
  const parsed = parseControllerDecision(`{"action":"continue","reason":"More tests are needed","nextPrompt":"Add regression tests for the onboarding flow and verify they pass.","updatedSummary":"Onboarding improved but tests remain.","goalStatus":"in_progress","qualityGoalMet":false,"progressPercent":135,"commitRecommendation":"none"}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "continue");
  if (!parsed || parsed.action !== "continue") return;

  assert.equal(parsed.progressPercent, 100);
  assert.equal(parsed.nextPrompt, "Add regression tests for the onboarding flow and verify they pass.");
});

test("parseControllerDecision parses stop decisions wrapped in extra text", () => {
  const parsed = parseControllerDecision(`Decision follows:\n{"action":"stop","reason":"The quality goal is met","updatedSummary":"Onboarding is robust and tests are green.","goalStatus":"met","qualityGoalMet":true,"progressPercent":100,"commitRecommendation":"finalize","finalMessage":"Stopping now."}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "stop");
  if (!parsed || parsed.action !== "stop") return;

  assert.equal(parsed.finalMessage, "Stopping now.");
});

test("parseControllerDecision parses probe decisions", () => {
  const parsed = parseControllerDecision(`{"action":"probe","reason":"Need fresh git status","updatedSummary":"Commit readiness unclear.","goalStatus":"in_progress","qualityGoalMet":false,"progressPercent":72,"commitRecommendation":"milestone","probe":{"kind":"git_status"}}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "probe");
  if (!parsed || parsed.action !== "probe") return;

  assert.equal(parsed.probe.kind, "git_status");
});

test("parseControllerDecision rejects invalid decisions", () => {
  assert.equal(parseControllerDecision("{}"), undefined);
  assert.equal(
    parseControllerDecision(`{"action":"continue","reason":"x","updatedSummary":"y","goalStatus":"in_progress","qualityGoalMet":false,"progressPercent":50,"commitRecommendation":"none"}`),
    undefined,
  );
  assert.equal(
    parseControllerDecision(`{"action":"probe","reason":"x","updatedSummary":"y","goalStatus":"in_progress","qualityGoalMet":false,"progressPercent":50,"commitRecommendation":"none","probe":{"kind":"bash"}}`),
    undefined,
  );
});

test("looksLikeCompletionClaim detects likely completion but rejects unresolved summaries", () => {
  assert.equal(looksLikeCompletionClaim("Implemented the fix, added regression tests, and everything is ready."), true);
  assert.equal(looksLikeCompletionClaim("Implemented most of the fix, but still need to add tests."), false);
  assert.equal(looksLikeCompletionClaim("Should I proceed with the final cleanup?"), false);
});

test("shouldPreRunVerifyCommand uses completion and budget heuristics", () => {
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: true,
      stopReason: "stop",
      assistantText: "Implemented the fix and all tests pass now.",
      currentIteration: 3,
      maxIterations: 8,
    }),
    true,
  );
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: true,
      stopReason: "stop",
      assistantText: "Still exploring the code paths.",
      currentIteration: 8,
      maxIterations: 8,
    }),
    true,
  );
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: true,
      stopReason: "toolUse",
      assistantText: "Implemented the fix and all tests pass now.",
      currentIteration: 3,
      maxIterations: 8,
    }),
    false,
  );
  assert.equal(
    shouldPreRunVerifyCommand({
      verifyCommandConfigured: false,
      stopReason: "stop",
      assistantText: "Implemented the fix and all tests pass now.",
      currentIteration: 3,
      maxIterations: 8,
    }),
    false,
  );
});

test("normalizeComparableText collapses whitespace and lowercases", () => {
  assert.equal(normalizeComparableText("  Add   Tests\nNow "), "add tests now");
});

test("summarizeGoal truncates long goal text", () => {
  assert.equal(summarizeGoal("Improve onboarding", 30), "Improve onboarding");
  assert.equal(
    summarizeGoal("Improve onboarding robustness, tests, and error handling", 24),
    "Improve onboarding robu…",
  );
});
