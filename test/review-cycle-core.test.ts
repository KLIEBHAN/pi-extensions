import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApplyReviewPrompt,
  buildReviewerUserPrompt,
  extractAssistantText,
  parseModelRef,
  parseReviewCycleArgs,
  REVIEWER_SYSTEM_PROMPT,
  shouldTreatStopReasonAsFailure,
  summarizeTask,
} from "../extensions/review-cycle/core.ts";

test("parseReviewCycleArgs starts directly with a task", () => {
  assert.deepEqual(parseReviewCycleArgs("add input validation to the login form"), {
    kind: "start",
    task: "add input validation to the login form",
    reviewerModel: undefined,
  });
});

test("parseReviewCycleArgs supports explicit on and reviewer model", () => {
  assert.deepEqual(parseReviewCycleArgs("on --reviewer-model anthropic/claude-sonnet-4-5 fix auth"), {
    kind: "start",
    task: "fix auth",
    reviewerModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
  });
});

test("parseReviewCycleArgs parses status and stop", () => {
  assert.deepEqual(parseReviewCycleArgs("status"), { kind: "status" });
  assert.deepEqual(parseReviewCycleArgs("stop"), { kind: "stop" });
  assert.deepEqual(parseReviewCycleArgs("off"), { kind: "stop" });
});

test("parseReviewCycleArgs validates reviewer model", () => {
  assert.deepEqual(parseReviewCycleArgs("--reviewer-model nope fix auth"), {
    error: "--reviewer-model must be in provider/model form",
  });
});

test("parseModelRef parses provider/model strings", () => {
  assert.deepEqual(parseModelRef("openai/gpt-5.4"), { provider: "openai", id: "gpt-5.4" });
  assert.equal(parseModelRef("missing-slash"), undefined);
});

test("buildReviewerUserPrompt includes baseline, diff, untracked files, and fresh-review instructions", () => {
  const prompt = buildReviewerUserPrompt({
    task: "fix auth",
    implementationSummary: "Implemented auth changes and ran npm test.",
    baseline: {
      isGitRepo: true,
      head: "abc123",
      status: "## main",
      dirty: false,
    },
    changes: {
      isGitRepo: true,
      baselineHead: "abc123",
      status: "## main\n M src/auth.ts",
      diffStat: "src/auth.ts | 10 +++++-----",
      diff: "diff --git a/src/auth.ts b/src/auth.ts",
      committedChanges: "def456 fix auth",
      untrackedFiles: ["src/auth.test.ts"],
      notes: [],
    },
  });

  assert.match(prompt, /fresh-context code review/i);
  assert.match(prompt, /fix auth/);
  assert.match(prompt, /baseline commit: abc123/);
  assert.match(prompt, /git diff abc123 --/);
  assert.match(prompt, /src\/auth\.test\.ts/);
});

test("reviewer system prompt forbids modifications", () => {
  assert.match(REVIEWER_SYSTEM_PROMPT, /Review only; do not modify files/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /completely fresh context/);
});

test("buildApplyReviewPrompt returns reviewer feedback to the implementation agent", () => {
  const prompt = buildApplyReviewPrompt({
    task: "fix auth",
    review: "## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- high: src/auth.ts: missing null check",
  });

  assert.match(prompt, /fresh-context reviewer agent/);
  assert.match(prompt, /Original request:\nfix auth/);
  assert.match(prompt, /missing null check/);
  assert.match(prompt, /run the most relevant local verification/i);
});

test("extractAssistantText and failure stop reasons match review-cycle expectations", () => {
  assert.equal(
    extractAssistantText([
      { type: "text", text: "hello" },
      { type: "toolCall", name: "bash" },
      { type: "text", text: "world" },
    ]),
    "hello\nworld",
  );

  assert.equal(shouldTreatStopReasonAsFailure("stop"), false);
  assert.equal(shouldTreatStopReasonAsFailure("length"), true);
  assert.equal(shouldTreatStopReasonAsFailure("error"), true);
});

test("summarizeTask compacts long labels", () => {
  assert.equal(summarizeTask("a".repeat(10), 10), "a".repeat(10));
  assert.equal(summarizeTask("a".repeat(11), 10), `${"a".repeat(9)}…`);
});
