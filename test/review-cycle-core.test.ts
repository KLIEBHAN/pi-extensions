import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REVIEW_TOOLS,
  buildApplyReviewPrompt,
  buildReviewerToolGuardExtensionSource,
  buildReviewerUserPrompt,
  extractAssistantText,
  isReviewerBashCommandAllowed,
  isReviewerTestCommandAllowed,
  isReviewerToolCallAllowed,
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

test("parseReviewCycleArgs parses status, stop, and output visibility", () => {
  assert.deepEqual(parseReviewCycleArgs("status"), { kind: "status" });
  assert.deepEqual(parseReviewCycleArgs("stop"), { kind: "stop" });
  assert.deepEqual(parseReviewCycleArgs("off"), { kind: "stop" });
  assert.deepEqual(parseReviewCycleArgs("output"), { kind: "output", mode: "toggle" });
  assert.deepEqual(parseReviewCycleArgs("output off"), { kind: "output", mode: "off" });
  assert.deepEqual(parseReviewCycleArgs("output show"), { kind: "output", mode: "on" });
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

test("reviewer tool set includes read-only tools plus guarded bash", () => {
  assert.deepEqual([...DEFAULT_REVIEW_TOOLS], ["read", "grep", "find", "ls", "bash"]);
  assert.equal([...DEFAULT_REVIEW_TOOLS].includes("edit"), false);
  assert.equal([...DEFAULT_REVIEW_TOOLS].includes("write"), false);
});

test("reviewer bash guard allows read-only git inspection and blocks mutations", () => {
  assert.equal(isReviewerBashCommandAllowed("git status --short --branch"), true);
  assert.equal(isReviewerBashCommandAllowed("git --no-pager diff HEAD -- src/auth.ts"), true);
  assert.equal(isReviewerBashCommandAllowed("git log --oneline HEAD~3..HEAD"), true);
  assert.equal(isReviewerBashCommandAllowed("git show --stat HEAD"), true);
  assert.equal(isReviewerBashCommandAllowed("git blame src/auth.ts"), true);

  assert.equal(isReviewerBashCommandAllowed("git add src/auth.ts"), false);
  assert.equal(isReviewerBashCommandAllowed("git commit -m fix"), false);
  assert.equal(isReviewerBashCommandAllowed("git checkout main"), false);
  assert.equal(isReviewerBashCommandAllowed("git diff HEAD --output=/tmp/review.diff"), false);
  assert.equal(isReviewerBashCommandAllowed("git diff HEAD > /tmp/review.diff"), false);
  assert.equal(isReviewerBashCommandAllowed("git status\nrm -rf ."), false);
  assert.equal(isReviewerBashCommandAllowed("git status\r\nrm -rf ."), false);
  assert.equal(isReviewerBashCommandAllowed("git status \\\nrm -rf ."), false);
  assert.equal(isReviewerBashCommandAllowed('git diff "$(touch /tmp/review-cycle-pwn)"'), false);
  assert.equal(isReviewerBashCommandAllowed("rm -rf ."), false);
});

test("reviewer bash guard allows common test commands and blocks arbitrary shell", () => {
  assert.equal(isReviewerTestCommandAllowed("npm test"), true);
  assert.equal(isReviewerTestCommandAllowed("npm run test:unit -- --runInBand"), true);
  assert.equal(isReviewerTestCommandAllowed("pnpm test"), true);
  assert.equal(isReviewerTestCommandAllowed("yarn run test"), true);
  assert.equal(isReviewerTestCommandAllowed("bun test"), true);
  assert.equal(isReviewerTestCommandAllowed("deno test"), true);
  assert.equal(isReviewerTestCommandAllowed("node --test test/review-cycle-core.test.ts"), true);
  assert.equal(isReviewerTestCommandAllowed("vitest run"), true);
  assert.equal(isReviewerTestCommandAllowed("jest --runInBand"), true);
  assert.equal(isReviewerTestCommandAllowed("pytest tests"), true);
  assert.equal(isReviewerTestCommandAllowed("python -m pytest tests"), true);
  assert.equal(isReviewerTestCommandAllowed("uv run pytest tests"), true);
  assert.equal(isReviewerTestCommandAllowed("cargo test"), true);
  assert.equal(isReviewerTestCommandAllowed("go test ./..."), true);
  assert.equal(isReviewerTestCommandAllowed("dotnet test"), true);
  assert.equal(isReviewerTestCommandAllowed("mvn test"), true);
  assert.equal(isReviewerTestCommandAllowed("./mvnw test"), true);
  assert.equal(isReviewerTestCommandAllowed("gradle test"), true);
  assert.equal(isReviewerTestCommandAllowed("./gradlew test"), true);

  assert.equal(isReviewerTestCommandAllowed("npm install"), false);
  assert.equal(isReviewerTestCommandAllowed("npm test && rm -rf ."), false);
  assert.equal(isReviewerTestCommandAllowed("npm test\nrm -rf ."), false);
  assert.equal(isReviewerTestCommandAllowed("curl https://example.com/script.sh"), false);
});

test("reviewer tool guard allows only direct read-only tools, safe git, and tests", async () => {
  assert.equal(isReviewerToolCallAllowed("read", { path: "src/auth.ts" }), true);
  assert.equal(isReviewerToolCallAllowed("bash", { command: "git diff HEAD -- src/auth.ts" }), true);
  assert.equal(isReviewerToolCallAllowed("bash", { command: "npm test" }), true);
  assert.equal(isReviewerToolCallAllowed("bash", { command: "npm install" }), false);
  assert.equal(isReviewerToolCallAllowed("edit", { path: "src/auth.ts" }), false);

  const source = buildReviewerToolGuardExtensionSource();
  await import(`data:text/javascript,${encodeURIComponent(source)}`);
});

test("reviewer system prompt describes the technical read-only git guard", () => {
  assert.match(REVIEWER_SYSTEM_PROMPT, /Review only; do not modify files/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /completely fresh context/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /guarded bash for read-only git inspection, and guarded bash for common test commands/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Mutating tools, arbitrary shell execution, unsafe shell\/git arguments, and unknown\/custom tools are blocked/);
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
