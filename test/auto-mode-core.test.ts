import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyControllerContinueRepetitionRefinement,
  applyControllerStopOverrideRefinement,
  AUTO_MODE_STATE_TYPE,
  AUTO_MODE_SYSTEM_PROMPT_TEMPLATE,
  AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS,
  buildAutoControllerAdjacentContinuationSystemPrompt,
  buildAutoControllerContinueRepetitionSystemPrompt,
  buildAutoControllerStopOverrideSystemPrompt,
  buildAutoControllerSystemPrompt,
  buildAutoStartConfigFromFlags,
  buildAutoStopOverrideDecision,
  buildAutoWorkerSystemPrompt,
  buildAutoWorkerSystemPromptTemplateVariables,
  buildResumePrompt,
  buildStartPrompt,
  decideAutoModeSessionStart,
  DEFAULT_AUTO_ITERATIONS,
  DEFAULT_CONTROLLER_MODEL,
  DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS,
  DEFAULT_MAX_ADJACENT_CONTINUATIONS,
  DEFAULT_STAGNATION_LIMIT,
  deriveAutoContinueProgressState,
  evaluateAutoStopGuard,
  extractLatestAutoModeState,
  hasConcreteVerificationEvidence,
  looksLikeCompletionClaim,
  normalizeComparableText,
  normalizeTemplateText,
  parseAutoCommandArgs,
  parseControllerDecision,
  parseModelRef,
  parsePositiveInteger,
  planAutoFollowUp,
  renderMiniTemplate,
  shouldAttemptAutoAdjacentContinuation,
  shouldAutoResumeOnSessionStart,
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

test("default controller model now follows the active worker model", () => {
  assert.equal(DEFAULT_CONTROLLER_MODEL, "active worker model");
});

test("auto-mode index no longer hardcodes a provider/model fallback for the controller", () => {
  const source = readFileSync(new URL("../extensions/auto-mode/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /parseModelRef\(DEFAULT_CONTROLLER_MODEL\)/);
  assert.match(source, /if \(ctx\.model && registry\.hasConfiguredAuth\(ctx\.model\)\) \{/);
  assert.match(source, /defaults to the \$\{DEFAULT_CONTROLLER_MODEL\}/);
  assert.match(source, /controller-model=\$\{DEFAULT_CONTROLLER_MODEL\} \(default\)/);
});

test("auto-mode system prompts are rendered from the template file", () => {
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
  assert.equal(
    buildAutoWorkerSystemPrompt(workerInput),
    renderMiniTemplate(
      AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS.worker,
      buildAutoWorkerSystemPromptTemplateVariables(workerInput),
    ),
  );
  assert.equal(buildAutoControllerSystemPrompt(), AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS.controller);
  assert.equal(
    buildAutoControllerAdjacentContinuationSystemPrompt(),
    AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS["controller-adjacent-continuation"],
  );
  assert.equal(
    buildAutoControllerStopOverrideSystemPrompt(),
    AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS["controller-stop-override"],
  );
  assert.equal(
    buildAutoControllerContinueRepetitionSystemPrompt(),
    AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS["controller-continue-repetition"],
  );
  assert.doesNotMatch(buildAutoWorkerSystemPrompt(workerInput), /\{\{\s*[A-Z0-9_]+(?:\|[\s\S]*?)?\s*\}\}/);
});

test("auto-mode core loads and renders prompt templates from the template file instead of inlining them", () => {
  const source = readFileSync(new URL("../extensions/auto-mode/core.ts", import.meta.url), "utf8");
  assert.match(source, /readFileSync\(\s*new URL\("\.\/system-prompt\.template\.md", import\.meta\.url\)/s);
  assert.match(source, /renderMiniTemplate\(/);
  assert.doesNotMatch(source, /You are the controller for an autonomous coding loop\./);
  assert.doesNotMatch(source, /You are revising a blocked stop decision in an autonomous coding loop\./);
});

test("parseAutoCommandArgs parses \/auto on with defaults", () => {
  const parsed = parseAutoCommandArgs("on improve onboarding flow");
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.goal, "improve onboarding flow");
  assert.equal(parsed.config.mode, "iterations");
  assert.equal(parsed.config.maxIterations, DEFAULT_AUTO_ITERATIONS);
  assert.equal(parsed.config.untilPrompt, undefined);
  assert.equal(parsed.config.completionPolicy, "stop");
  assert.equal(parsed.config.maxAdjacentContinuations, DEFAULT_MAX_ADJACENT_CONTINUATIONS);
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

test("parseAutoCommandArgs parses no-controller-probes", () => {
  const parsed = parseAutoCommandArgs("on --no-controller-probes improve stability");
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.allowControllerProbes, false);
});

test("parseAutoCommandArgs parses completion-policy continue-similar", () => {
  const parsed = parseAutoCommandArgs("on --completion-policy continue-similar --max-adjacent-continuations 3 improve nearby reliability");
  assert.equal(parsed.kind, "on");
  if (parsed.kind !== "on") return;

  assert.equal(parsed.config.completionPolicy, "continue-similar");
  assert.equal(parsed.config.maxAdjacentContinuations, 3);
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
  assert.deepEqual(parseAutoCommandArgs("on --completion-policy nope improve app"), {
    error: "--completion-policy must be one of: stop, continue-similar",
  });
  assert.deepEqual(parseAutoCommandArgs("on --max-adjacent-continuations 0 improve app"), {
    error: "--max-adjacent-continuations must be an integer between 1 and 1000",
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
  assert.equal(parsed.completionPolicy, "stop");
  assert.equal(parsed.maxAdjacentContinuations, DEFAULT_MAX_ADJACENT_CONTINUATIONS);
  assert.equal(parsed.allowControllerProbes, false);
  assert.equal(parsed.resumeOnSessionStart, true);
  assert.deepEqual(parsed.controllerModel, {
    provider: "openai",
    id: "gpt-5.4-mini",
  });
});

test("buildAutoStartConfigFromFlags parses completion policy overrides", () => {
  const parsed = buildAutoStartConfigFromFlags({
    goal: "improve settings UX",
    completionPolicy: "continue-similar",
    maxAdjacentContinuations: "3",
  });

  assert.ok(parsed && !("error" in parsed));
  if (!parsed || "error" in parsed) return;
  assert.equal(parsed.completionPolicy, "continue-similar");
  assert.equal(parsed.maxAdjacentContinuations, 3);
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
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "improve app", completionPolicy: "bad" }), {
    error: "--auto-completion-policy must be one of: stop, continue-similar",
  });
  assert.deepEqual(buildAutoStartConfigFromFlags({ goal: "improve app", maxAdjacentContinuations: "0" }), {
    error: "--auto-max-adjacent-continuations must be an integer between 1 and 1000",
  });
});

test("parseControllerDecision parses continue decisions and clamps progress", () => {
  const parsed = parseControllerDecision(`{"action":"continue","reason":"More tests are needed","nextPrompt":"Add regression tests for the onboarding flow and verify they pass.","updatedSummary":"Onboarding improved but tests remain.","goalStatus":"in_progress","completionGateMet":false,"progressPercent":135,"commitRecommendation":"none"}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "continue");
  if (!parsed || parsed.action !== "continue") return;

  assert.equal(parsed.progressPercent, 100);
  assert.equal(parsed.nextPrompt, "Add regression tests for the onboarding flow and verify they pass.");
});

test("parseControllerDecision parses stop decisions wrapped in extra text", () => {
  const parsed = parseControllerDecision(`Decision follows:\n{"action":"stop","reason":"The completion gate is met","updatedSummary":"Onboarding is robust and tests are green.","goalStatus":"met","completionGateMet":true,"progressPercent":100,"commitRecommendation":"finalize","finalMessage":"Stopping now."}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "stop");
  if (!parsed || parsed.action !== "stop") return;

  assert.equal(parsed.finalMessage, "Stopping now.");
});

test("parseControllerDecision parses probe decisions", () => {
  const parsed = parseControllerDecision(`{"action":"probe","reason":"Need fresh git status","updatedSummary":"Commit readiness unclear.","goalStatus":"in_progress","completionGateMet":false,"progressPercent":72,"commitRecommendation":"milestone","probe":{"kind":"git_status"}}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "probe");
  if (!parsed || parsed.action !== "probe") return;

  assert.equal(parsed.probe.kind, "git_status");
});

test("parseControllerDecision still accepts legacy qualityGoalMet output", () => {
  const parsed = parseControllerDecision(`{"action":"stop","reason":"Legacy controller payload","updatedSummary":"Legacy payload remains compatible.","goalStatus":"met","qualityGoalMet":true,"progressPercent":100,"commitRecommendation":"finalize"}`);
  assert.ok(parsed);
  assert.equal(parsed?.action, "stop");
  if (!parsed || parsed.action !== "stop") return;

  assert.equal(parsed.completionGateMet, true);
});

test("parseControllerDecision rejects invalid decisions", () => {
  assert.equal(parseControllerDecision("{}"), undefined);
  assert.equal(
    parseControllerDecision(`{"action":"continue","reason":"x","updatedSummary":"y","goalStatus":"in_progress","completionGateMet":false,"progressPercent":50,"commitRecommendation":"none"}`),
    undefined,
  );
  assert.equal(
    parseControllerDecision(`{"action":"probe","reason":"x","updatedSummary":"y","goalStatus":"in_progress","completionGateMet":false,"progressPercent":50,"commitRecommendation":"none","probe":{"kind":"bash"}}`),
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

test("shouldAutoResumeOnSessionStart only resumes on startup", () => {
  assert.equal(shouldAutoResumeOnSessionStart("startup", true, "restore-paused"), true);
  assert.equal(shouldAutoResumeOnSessionStart("startup", false, "restore-running"), true);
  assert.equal(shouldAutoResumeOnSessionStart("startup", false, "restore-paused"), false);
  assert.equal(shouldAutoResumeOnSessionStart("reload", true, "restore-running"), false);
  assert.equal(shouldAutoResumeOnSessionStart("resume", true, "restore-running"), false);
});

test("decideAutoModeSessionStart prefers startup flags but still restores persisted state when flags are invalid", () => {
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

  assert.deepEqual(
    decideAutoModeSessionStart({
      reason: "reload",
      hasPersistedSnapshot: true,
      autoStartConfigState: "invalid",
      autoStartError: "--auto-goal is invalid",
      autoResumeFlag: true,
      persistedResumePolicy: "restore-running",
    }),
    { action: "restore", autoResume: false, warning: "--auto-goal is invalid" },
  );

  assert.deepEqual(
    decideAutoModeSessionStart({
      reason: "resume",
      hasPersistedSnapshot: false,
      autoStartConfigState: "invalid",
      autoStartError: "--auto-goal is invalid",
      autoResumeFlag: true,
    }),
    { action: "noop", autoResume: false, warning: "--auto-goal is invalid" },
  );
});

test("buildStartPrompt stays minimal and keeps the worker focused on the main goal", () => {
  const prompt = buildStartPrompt({
    goal: "Improve onboarding robustness",
  });

  assert.equal(prompt, "Improve onboarding robustness");
  assert.doesNotMatch(prompt, /Completion gate:/);
  assert.doesNotMatch(prompt, /Iteration budget:/);
  assert.doesNotMatch(prompt, /Do not ask the user anything/i);
  assert.doesNotMatch(prompt, /Verification command:/);
});

test("buildAutoWorkerSystemPrompt keeps only required rules and worker-visible metadata", () => {
  const prompt = buildAutoWorkerSystemPrompt({
    goal: "Improve onboarding robustness",
    verifyCommand: "npm test",
    commitPolicy: "final-or-milestone",
    pushPolicy: "final-or-milestone-if-upstream",
  });

  assert.match(prompt, /^Auto-mode rules:/);
  assert.match(prompt, /Do not claim completion until the active goal is actually satisfied\./);
  assert.match(prompt, /Before claiming completion or requesting stop, run this verification command: npm test/);
  assert.doesNotMatch(prompt, /Before concluding, run this verification command: npm test/);
  assert.match(prompt, /Follow this commit policy: final-or-milestone/);
  assert.match(prompt, /Follow this push policy: final-or-milestone-if-upstream/);
  assert.match(prompt, /Goal: Improve onboarding robustness/);
  assert.doesNotMatch(prompt, /Completion gate:/);

  assert.doesNotMatch(prompt, /Do not ask the user/i);
  assert.doesNotMatch(prompt, /Prefer concrete, verifiable progress/i);
  assert.doesNotMatch(prompt, /Re-check repository state/i);
  assert.doesNotMatch(prompt, /Avoid repetitive meta-planning/i);
  assert.doesNotMatch(prompt, /one local improvement is done/i);
  assert.doesNotMatch(prompt, /Iteration:/);
  assert.doesNotMatch(prompt, /Mode:/);
});

test("buildAutoControllerSystemPrompt strongly biases against premature stopping", () => {
  const prompt = buildAutoControllerSystemPrompt();

  assert.match(prompt, /^You are the controller for an autonomous coding loop\./);
  assert.match(prompt, /Default to continue, not stop\./);
  assert.match(prompt, /goalStatus must always refer to the original primary goal/);
  assert.match(prompt, /Never treat a worker completion claim by itself as proof that the goal is done\./);
  assert.match(prompt, /If goalStatus=in_progress and obvious implementation work remains, prefer the highest-value implementation step over extra verification\./);
  assert.match(prompt, /Prefer extra verification or finalization mainly when goalStatus is likely_met or met, or when one focused check would materially reduce uncertainty about a near-complete result or candidate stop\./);
  assert.match(prompt, /Near a plausible stop, if in doubt between stop and continue, prefer continue with the single highest-value verification or finalization step\./);
  assert.match(prompt, /Use stop only when goalStatus=met\./);
  assert.match(prompt, /If a completion gate exists, use stop only when it is met too\./);
  assert.match(prompt, /Use stop only when completion is supported by concrete verification evidence/);
  assert.match(prompt, /If verification is failing or still missing, the task is not complete\./);
  assert.match(prompt, /If final commit\/push expectations are still unmet in a git repo, the task is not complete\./);
  assert.match(prompt, /If the primary goal is verified complete and a normal stop would otherwise be allowed, return stop here even when completionPolicy=continue-similar/);
  assert.match(prompt, /If the next prompt would be nearly identical to the previous one, make it materially more specific or prefer pause over repetition\./);
  assert.match(prompt, /Prefer to resolve worker questions yourself from the existing goal, repository state, and controller summary\./);
  assert.doesNotMatch(prompt, /Do not ask the user anything/i);
});


test("buildAutoControllerAdjacentContinuationSystemPrompt keeps adjacent work bounded", () => {
  const prompt = buildAutoControllerAdjacentContinuationSystemPrompt();

  assert.match(prompt, /^You are deciding whether an autonomous run should continue after the primary goal has already been verified complete\./);
  assert.match(prompt, /This decision point exists only because a normal stop would already be valid and completionPolicy=continue-similar explicitly asked for nearby follow-up work\./);
  assert.match(prompt, /Use exactly one of these actions: continue, stop, pause\./);
  assert.match(prompt, /Do NOT use probe\./);
  assert.match(prompt, /Default to continue, not stop, when there is any clear, local, high-value adjacent optimization within the remaining adjacent continuation budget\./);
  assert.match(prompt, /Do not broaden scope into a new major task or unrelated workstream\./);
  assert.match(prompt, /Use stop only when no worthwhile bounded adjacent optimization is clear or no adjacent continuation budget remains\./);
  assert.match(prompt, /Prefer to resolve worker questions yourself from the existing goal, repository state, and controller summary\./);
  assert.doesNotMatch(prompt, /Do not ask the user anything/i);
});


test("buildAutoControllerStopOverrideSystemPrompt asks for a specific continue or pause", () => {
  const prompt = buildAutoControllerStopOverrideSystemPrompt();

  assert.match(prompt, /^You are revising a blocked stop decision in an autonomous coding loop\./);
  assert.match(prompt, /Use exactly one of these actions: continue, pause\./);
  assert.match(prompt, /Do NOT use stop or probe\./);
  assert.match(prompt, /make the nextPrompt materially more specific than the fallback prompt when possible\./);
  assert.match(prompt, /If the best next step would still be nearly identical to the previous or fallback prompt, prefer pause over repetition\./);
  assert.match(prompt, /Prefer to resolve worker questions yourself from the existing goal, repository state, and controller summary\./);
  assert.doesNotMatch(prompt, /Do not ask the user anything/i);
});


test("buildAutoControllerContinueRepetitionSystemPrompt asks for a materially better continue or pause", () => {
  const prompt = buildAutoControllerContinueRepetitionSystemPrompt();

  assert.match(prompt, /^You are revising a repeated continue decision in an autonomous coding loop\./);
  assert.match(prompt, /Use exactly one of these actions: continue, pause\./);
  assert.match(prompt, /Do NOT use stop or probe\./);
  assert.match(prompt, /materially more specific than both the previous prompt and the proposed repeated prompt\./);
  assert.match(prompt, /If the best next step would still be nearly identical to the previous or proposed prompt, prefer pause over repetition\./);
  assert.match(prompt, /Prefer to resolve worker questions yourself from the existing goal, repository state, and controller summary\./);
  assert.doesNotMatch(prompt, /Do not ask the user anything/i);
});


test("hasConcreteVerificationEvidence requires real validation signals", () => {
  assert.equal(hasConcreteVerificationEvidence("Ran npm test, all tests pass, and verified the fix manually."), true);
  assert.equal(
    hasConcreteVerificationEvidence(
      "Verifikation im aktuellen Checkout erneut nachgewiesen. pnpm lint exit 0 with All checks passed; pnpm build exit 0 with Compiled successfully; working tree clean, ahead=0, behind=0.",
    ),
    true,
  );
  assert.equal(hasConcreteVerificationEvidence("Verifikation nicht nachgewiesen, Tests nicht ausgeführt."), false);
  assert.equal(hasConcreteVerificationEvidence("Verified with npm test, but tests failed."), false);
  assert.equal(hasConcreteVerificationEvidence("Implemented the fix and updated the docs."), false);
  assert.equal(hasConcreteVerificationEvidence("Added regression tests but did not run them yet."), false);
});


test("evaluateAutoStopGuard accepts German structured verification evidence when no verify command is configured", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: false,
      completionGateMet: true,
      verifyCommandConfigured: false,
      verifyCommandPassed: false,
      workerAssistantText:
        "1. HEAD / Repo-Status: git rev-parse HEAD => abc123; git status --short --branch => ## master...origin/master. 2. Checks: pnpm lint — exit 0 — All checks passed!; pnpm build exit 0 — Compiled successfully. 3. Remote-Sync: working tree clean, ahead=0, behind=0. 4. Abschluss: Verifikation im aktuellen Checkout erneut nachgewiesen, keine Codeänderungen.",
      commitPolicy: "none",
      pushPolicy: "never",
    }),
    {
      allowed: true,
      blockers: [],
    },
  );
});


test("evaluateAutoStopGuard blocks stop until goal and completion gate are actually met", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "likely_met",
      requiresCompletionGate: true,
      completionGateMet: false,
      verifyCommandConfigured: true,
      verifyCommandPassed: true,
      workerAssistantText: "Ran npm test and all tests pass.",
      commitPolicy: "none",
      pushPolicy: "never",
    }),
    {
      allowed: false,
      blockers: ["goal-not-met", "completion-gate-not-met"],
    },
  );
});


test("evaluateAutoStopGuard blocks stop when verification evidence is still missing", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: false,
      completionGateMet: true,
      verifyCommandConfigured: false,
      verifyCommandPassed: false,
      workerAssistantText: "Implemented the fix and cleaned up the code.",
      commitPolicy: "none",
      pushPolicy: "never",
    }),
    {
      allowed: false,
      blockers: ["verification-missing"],
    },
  );
});


test("evaluateAutoStopGuard blocks stop when the configured verification command has not passed", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: false,
      completionGateMet: true,
      verifyCommandConfigured: true,
      verifyCommandPassed: false,
      workerAssistantText: "Implemented the fix and believe it is done.",
      commitPolicy: "none",
      pushPolicy: "never",
    }),
    {
      allowed: false,
      blockers: ["verification-failed"],
    },
  );
});


test("evaluateAutoStopGuard blocks stop until commit and push expectations are satisfied", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: false,
      completionGateMet: true,
      verifyCommandConfigured: true,
      verifyCommandPassed: true,
      workerAssistantText: "Ran npm test and all tests pass.",
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
      blockers: ["commit-required", "push-required", "sync-required"],
    },
  );
});


test("evaluateAutoStopGuard allows stop only after verified completion and clean git finalization", () => {
  assert.deepEqual(
    evaluateAutoStopGuard({
      goalStatus: "met",
      requiresCompletionGate: true,
      completionGateMet: true,
      verifyCommandConfigured: false,
      verifyCommandPassed: false,
      workerAssistantText: "Verified the fix manually, ran the relevant checks, and all tests pass.",
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

test("buildAutoStopOverrideDecision converts blocked stop into a concrete continue decision", () => {
  const override = buildAutoStopOverrideDecision({
    decision: {
      action: "stop",
      reason: "Everything appears done",
      updatedSummary: "Core work is implemented.",
      goalStatus: "met",
      completionGateMet: true,
      progressPercent: 100,
      commitRecommendation: "finalize",
      finalMessage: "Done.",
    },
    stopGuard: {
      allowed: false,
      blockers: ["verification-missing", "commit-required"],
    },
  });

  assert.ok(override);
  assert.equal(override?.action, "continue");
  assert.match(override?.reason ?? "", /Stop overridden:/);
  assert.match(override?.reason ?? "", /verification evidence is still missing/);
  assert.match(override?.reason ?? "", /a final commit is still required/);
  assert.match(override?.updatedSummary ?? "", /Stop overridden\./);
  assert.match(override?.updatedSummary ?? "", /Previous stop reason: Everything appears done\./);
  assert.match(override?.nextPrompt ?? "", /Run the most relevant available verification/);
  assert.match(override?.nextPrompt ?? "", /Create an atomic commit/);
  assert.equal(override?.goalStatus, "likely_met");
  assert.equal(override?.progressPercent, 99);
});

test("buildAutoStopOverrideDecision returns undefined when stop is actually allowed", () => {
  assert.equal(
    buildAutoStopOverrideDecision({
      decision: {
        action: "stop",
        reason: "Verified completion",
        updatedSummary: "Goal is complete and checks passed.",
        goalStatus: "met",
        completionGateMet: true,
        progressPercent: 100,
        commitRecommendation: "finalize",
      },
      stopGuard: {
        allowed: true,
        blockers: [],
      },
    }),
    undefined,
  );
});

test("applyControllerStopOverrideRefinement adopts a controller-specific continue prompt", () => {
  const refined = applyControllerStopOverrideRefinement({
    fallbackDecision: {
      action: "continue",
      reason: "Stop overridden: verification evidence is still missing.",
      updatedSummary: "Stop overridden. Remaining blockers: verification evidence is still missing.",
      goalStatus: "likely_met",
      completionGateMet: true,
      progressPercent: 99,
      commitRecommendation: "finalize",
      nextPrompt: "Run the most relevant available verification from the current repository state, summarize the concrete passing evidence, and only then consider the task complete.",
    },
    controllerDecision: {
      action: "continue",
      reason: "Run one concrete final verification step",
      updatedSummary: "The remaining gap is specific verification evidence.",
      goalStatus: "likely_met",
      completionGateMet: true,
      progressPercent: 99,
      commitRecommendation: "finalize",
      nextPrompt: "Run npm test, summarize the passing result in one sentence, and then check git status before concluding.",
    },
  });

  assert.equal(refined.action, "continue");
  assert.equal(refined.reason, "Stop overridden: verification evidence is still missing.");
  assert.match(refined.updatedSummary, /Controller refinement:/);
  assert.equal(refined.nextPrompt, "Run npm test, summarize the passing result in one sentence, and then check git status before concluding.");
});

test("applyControllerStopOverrideRefinement can pause instead of repeating a low-value prompt", () => {
  const refined = applyControllerStopOverrideRefinement({
    fallbackDecision: {
      action: "continue",
      reason: "Stop overridden: verification evidence is still missing.",
      updatedSummary: "Stop overridden. Remaining blockers: verification evidence is still missing.",
      goalStatus: "likely_met",
      completionGateMet: true,
      progressPercent: 99,
      commitRecommendation: "finalize",
      nextPrompt: "Run the most relevant available verification from the current repository state, summarize the concrete passing evidence, and only then consider the task complete.",
    },
    controllerDecision: {
      action: "pause",
      reason: "No materially more specific verification step is available without repeating the same instruction.",
      updatedSummary: "The loop is close to completion but would just restate the same verification request.",
      goalStatus: "stalled",
      completionGateMet: true,
      progressPercent: 99,
      commitRecommendation: "finalize",
    },
  });

  assert.equal(refined.action, "pause");
  assert.match(refined.reason, /Stop overridden: verification evidence is still missing\./);
  assert.match(refined.reason, /Controller requested pause instead of another repeated follow-up/);
  assert.match(refined.updatedSummary, /Controller refinement requested a pause:/);
  assert.equal(refined.goalStatus, "stalled");
});

test("applyControllerContinueRepetitionRefinement adopts a controller-specific continue prompt", () => {
  const refined = applyControllerContinueRepetitionRefinement({
    repeatedDecision: {
      action: "continue",
      reason: "A concrete verification step is still warranted.",
      updatedSummary: "Verification still needs one more direct step before stopping.",
      goalStatus: "likely_met",
      completionGateMet: true,
      progressPercent: 94,
      commitRecommendation: "none",
      nextPrompt: "Run one more targeted verification and summarize the result.",
    },
    controllerDecision: {
      action: "continue",
      reason: "Focus the follow-up on the exact failing area",
      updatedSummary: "The next step should target one concrete verification gap instead of repeating the generic request.",
      goalStatus: "likely_met",
      completionGateMet: true,
      progressPercent: 94,
      commitRecommendation: "none",
      nextPrompt: "Run the onboarding regression test that changed in this cycle, summarize the passing output, and then check git status before concluding.",
    },
  });

  assert.equal(refined.action, "continue");
  assert.equal(refined.reason, "A concrete verification step is still warranted.");
  assert.match(refined.updatedSummary, /Controller repetition refinement:/);
  assert.equal(refined.nextPrompt, "Run the onboarding regression test that changed in this cycle, summarize the passing output, and then check git status before concluding.");
});

test("applyControllerContinueRepetitionRefinement can pause instead of repeating a low-value continue prompt", () => {
  const refined = applyControllerContinueRepetitionRefinement({
    repeatedDecision: {
      action: "continue",
      reason: "A concrete verification step is still warranted.",
      updatedSummary: "Verification still needs one more direct step before stopping.",
      goalStatus: "likely_met",
      completionGateMet: true,
      progressPercent: 94,
      commitRecommendation: "none",
      nextPrompt: "Run one more targeted verification and summarize the result.",
    },
    controllerDecision: {
      action: "pause",
      reason: "No materially more specific next step is available without restating the same follow-up.",
      updatedSummary: "The loop would just repeat the same verification request.",
      goalStatus: "stalled",
      completionGateMet: true,
      progressPercent: 94,
      commitRecommendation: "none",
    },
  });

  assert.equal(refined.action, "pause");
  assert.match(refined.reason, /A concrete verification step is still warranted\./);
  assert.match(refined.reason, /Controller requested pause instead of another repeated continue prompt/);
  assert.match(refined.updatedSummary, /Controller repetition refinement requested a pause:/);
  assert.equal(refined.goalStatus, "stalled");
});

test("shouldAttemptAutoAdjacentContinuation only continues similar work when goal is met, budget remains, and the adjacent limit is not exhausted", () => {
  assert.equal(
    shouldAttemptAutoAdjacentContinuation({
      completionPolicy: "continue-similar",
      goalStatus: "met",
      currentIteration: 3,
      maxIterations: 8,
      adjacentContinuationCount: 0,
      maxAdjacentContinuations: 1,
    }),
    true,
  );
  assert.equal(
    shouldAttemptAutoAdjacentContinuation({
      completionPolicy: "stop",
      goalStatus: "met",
      currentIteration: 3,
      maxIterations: 8,
      adjacentContinuationCount: 0,
      maxAdjacentContinuations: 1,
    }),
    false,
  );
  assert.equal(
    shouldAttemptAutoAdjacentContinuation({
      completionPolicy: "continue-similar",
      goalStatus: "likely_met",
      currentIteration: 3,
      maxIterations: 8,
      adjacentContinuationCount: 0,
      maxAdjacentContinuations: 1,
    }),
    false,
  );
  assert.equal(
    shouldAttemptAutoAdjacentContinuation({
      completionPolicy: "continue-similar",
      goalStatus: "met",
      currentIteration: 8,
      maxIterations: 8,
      adjacentContinuationCount: 0,
      maxAdjacentContinuations: 1,
    }),
    false,
  );
  assert.equal(
    shouldAttemptAutoAdjacentContinuation({
      completionPolicy: "continue-similar",
      goalStatus: "met",
      currentIteration: 3,
      maxIterations: 8,
      adjacentContinuationCount: 1,
      maxAdjacentContinuations: 1,
    }),
    false,
  );
});

test("deriveAutoContinueProgressState enters adjacent phase only when an adjacent continuation is explicitly triggered", () => {
  assert.deepEqual(
    deriveAutoContinueProgressState({
      completionPolicy: "continue-similar",
      phase: "primary",
      goalStatus: "met",
      currentIteration: 4,
      updatedSummary: "Primary goal is verified complete.",
      adjacentContinuationTriggered: true,
      adjacentContinuationCount: 0,
    }),
    {
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 4,
      adjacentContinuationCount: 1,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    },
  );
});

test("deriveAutoContinueProgressState does not auto-enter adjacent on an ordinary continue after verified completion", () => {
  assert.deepEqual(
    deriveAutoContinueProgressState({
      completionPolicy: "continue-similar",
      phase: "primary",
      goalStatus: "met",
      currentIteration: 6,
      updatedSummary: "Primary goal remains met while a regular continue path is used.",
      adjacentContinuationTriggered: false,
      adjacentContinuationCount: 0,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    }),
    {
      phase: "primary",
      primaryGoalVerifiedAtIteration: undefined,
      adjacentContinuationCount: 0,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    },
  );
});

test("deriveAutoContinueProgressState increments adjacent count only for explicit adjacent continuation turns and falls back to primary when verified completion is lost", () => {
  assert.deepEqual(
    deriveAutoContinueProgressState({
      completionPolicy: "continue-similar",
      phase: "adjacent",
      goalStatus: "met",
      currentIteration: 6,
      updatedSummary: "Primary goal remains met while adjacent work continues.",
      adjacentContinuationTriggered: true,
      primaryGoalVerifiedAtIteration: 4,
      adjacentContinuationCount: 2,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    }),
    {
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: 4,
      adjacentContinuationCount: 3,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    },
  );

  assert.deepEqual(
    deriveAutoContinueProgressState({
      completionPolicy: "continue-similar",
      phase: "adjacent",
      goalStatus: "in_progress",
      currentIteration: 6,
      updatedSummary: "Adjacent work regressed the original goal.",
      adjacentContinuationTriggered: false,
      primaryGoalVerifiedAtIteration: 4,
      adjacentContinuationCount: 2,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    }),
    {
      phase: "primary",
      primaryGoalVerifiedAtIteration: 4,
      adjacentContinuationCount: 0,
      primaryGoalCompletionSummary: "Primary goal is verified complete.",
    },
  );
});

test("planAutoFollowUp sends a concrete finalization pass when the prompt is new", () => {
  const plan = planAutoFollowUp({
    nextPrompt: "Run npm test, create the final commit, and push if upstream is configured.",
    currentIteration: 4,
    maxIterations: 8,
    lastAutoPrompt: "Inspect the regression test coverage and fill any remaining gaps.",
    consecutiveStagnationCount: 1,
    consecutiveNoChangeCount: 0,
    budgetPauseReason: "iteration budget exhausted before verified completion",
  });

  assert.deepEqual(plan, {
    action: "send",
    nextPrompt: "Run npm test, create the final commit, and push if upstream is configured.",
    nextIteration: 5,
    nextStagnationCount: 0,
  });
});

test("planAutoFollowUp pauses repeated finalization prompts instead of looping", () => {
  const repeatedPrompt = "Run npm test, create the final commit, and push if upstream is configured.";
  const plan = planAutoFollowUp({
    nextPrompt: repeatedPrompt,
    currentIteration: 4,
    maxIterations: 8,
    lastAutoPrompt: repeatedPrompt,
    consecutiveStagnationCount: DEFAULT_STAGNATION_LIMIT - 1,
    consecutiveNoChangeCount: 0,
    budgetPauseReason: "iteration budget exhausted before verified completion",
  });

  assert.deepEqual(plan, {
    action: "pause",
    reason: "controller produced the same next prompt repeatedly",
    nextStagnationCount: DEFAULT_STAGNATION_LIMIT,
  });
});

test("planAutoFollowUp pauses unverified finalization at the iteration budget", () => {
  const plan = planAutoFollowUp({
    nextPrompt: "Run npm test before concluding.",
    currentIteration: 8,
    maxIterations: 8,
    lastAutoPrompt: "Create the final commit.",
    consecutiveStagnationCount: 2,
    consecutiveNoChangeCount: 0,
    budgetPauseReason: "iteration budget exhausted before verified completion: Everything appears done",
  });

  assert.deepEqual(plan, {
    action: "pause",
    reason: "iteration budget exhausted before verified completion: Everything appears done",
    nextStagnationCount: 2,
  });
});

test("planAutoFollowUp pauses finalization when the repository is not changing", () => {
  const plan = planAutoFollowUp({
    nextPrompt: "Create the final commit and verify git status is clean.",
    currentIteration: 5,
    maxIterations: 8,
    lastAutoPrompt: "Run npm test before concluding.",
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 3,
    budgetPauseReason: "iteration budget exhausted before verified completion",
  });

  assert.deepEqual(plan, {
    action: "pause",
    reason: "repository state has not changed across several iterations",
    nextStagnationCount: 0,
  });
});

test("buildAutoWorkerSystemPrompt still requires verification without an explicit command", () => {
  const prompt = buildAutoWorkerSystemPrompt({
    goal: "Improve onboarding robustness",
    commitPolicy: "milestones",
    pushPolicy: "if-upstream",
  });

  assert.match(prompt, /Before claiming completion or requesting stop, run the most relevant available verification\./);
  assert.doesNotMatch(prompt, /Before concluding, run the most relevant available verification\./);
  assert.doesNotMatch(prompt, /Verification command:/);
});

test("buildResumePrompt stays focused and keeps completion gates controller-only", () => {
  const prompt = buildResumePrompt({
    goal: "improve onboarding robustness",
    controllerSummary: "We hardened error handling, but regression tests still look thin.",
  });

  assert.match(prompt, /Resume the active goal from the current repository state\./);
  assert.match(prompt, /Goal: improve onboarding robustness/);
  assert.doesNotMatch(prompt, /Completion gate:/);
  assert.match(prompt, /Controller summary:\nWe hardened error handling, but regression tests still look thin\./);
  assert.doesNotMatch(prompt, /Iteration budget:/);
  assert.doesNotMatch(prompt, /Verification command:/);
  assert.doesNotMatch(prompt, /Do not ask the user anything/i);
});

test("extractLatestAutoModeState returns the latest valid state from the current branch entries", () => {
  const oldState = {
    version: 1,
    enabled: true,
    paused: true,
    runId: "auto-old",
    goal: "old goal",
    mode: "iterations",
    maxIterations: 8,
    currentIteration: 2,
    startedAt: 1,
    commitPolicy: "final-or-milestone",
    pushPolicy: "final-or-milestone-if-upstream",
    allowControllerProbes: true,
    controllerSummary: "old",
    recentDecisions: [],
    consecutiveControllerFailures: 0,
    consecutiveWorkerFailures: 0,
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 0,
    resumePolicy: "restore-paused",
  } as const;
  const newState = {
    ...oldState,
    runId: "auto-new",
    goal: "current branch goal",
    currentIteration: 5,
    controllerSummary: "new",
  };

  const entries = [
    { type: "custom", customType: AUTO_MODE_STATE_TYPE, data: oldState },
    { type: "message", message: { role: "user", content: "ignored" } },
    { type: "custom", customType: AUTO_MODE_STATE_TYPE, data: { nope: true } },
    { type: "custom", customType: AUTO_MODE_STATE_TYPE, data: newState },
  ];

  assert.deepEqual(extractLatestAutoModeState(entries), {
    ...newState,
    completionPolicy: "stop",
    phase: "primary",
    adjacentContinuationCount: 0,
    maxAdjacentContinuations: DEFAULT_MAX_ADJACENT_CONTINUATIONS,
    primaryGoalVerifiedAtIteration: undefined,
    primaryGoalCompletionSummary: undefined,
  });
});

test("normalizeComparableText collapses whitespace, lowercases, and strips punctuation noise", () => {
  assert.equal(normalizeComparableText("  Add   Tests\nNow "), "add tests now");
  assert.equal(normalizeComparableText("Add regression-tests now!!!"), "add regression tests now");
  assert.equal(normalizeComparableText("Run `npm test` before stopping."), "run npm test before stopping");
});

test("summarizeGoal truncates long goal text", () => {
  assert.equal(summarizeGoal("Improve onboarding", 30), "Improve onboarding");
  assert.equal(
    summarizeGoal("Improve onboarding robustness, tests, and error handling", 24),
    "Improve onboarding robu…",
  );
});
