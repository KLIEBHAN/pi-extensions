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
  parseReviewSummary,
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

test("parseReviewCycleArgs parses help, status, stop, and output visibility", () => {
  assert.deepEqual(parseReviewCycleArgs("help"), { kind: "help" });
  assert.deepEqual(parseReviewCycleArgs("--help"), { kind: "help" });
  assert.deepEqual(parseReviewCycleArgs("status"), { kind: "status" });
  assert.deepEqual(parseReviewCycleArgs("stop"), { kind: "stop" });
  assert.deepEqual(parseReviewCycleArgs("off"), { kind: "stop" });
  assert.deepEqual(parseReviewCycleArgs("output"), { kind: "output", mode: "toggle" });
  assert.deepEqual(parseReviewCycleArgs("output off"), { kind: "output", mode: "off" });
  assert.deepEqual(parseReviewCycleArgs("output show"), { kind: "output", mode: "on" });
  assert.deepEqual(parseReviewCycleArgs("rerun --reviewer-model openai/gpt-review"), {
    kind: "rerun",
    reviewerModel: { provider: "openai", id: "gpt-review" },
  });
  assert.deepEqual(parseReviewCycleArgs("tests add npm test"), {
    kind: "tests",
    action: "add",
    command: "npm test",
  });
  assert.deepEqual(parseReviewCycleArgs("config tests clear"), { kind: "tests", action: "clear" });
  assert.deepEqual(parseReviewCycleArgs("artifact"), { kind: "artifact", action: "show" });
  assert.deepEqual(parseReviewCycleArgs("artifact path"), { kind: "artifact", action: "path" });
  assert.deepEqual(parseReviewCycleArgs("apply"), { kind: "apply" });
  assert.deepEqual(parseReviewCycleArgs("skip"), { kind: "skip" });
  assert.deepEqual(parseReviewCycleArgs("continue"), { kind: "continue" });
  assert.deepEqual(parseReviewCycleArgs("abort"), { kind: "abort" });
  assert.deepEqual(parseReviewCycleArgs("retry --reviewer-model openai/gpt-review"), {
    kind: "retry",
    reviewerModel: { provider: "openai", id: "gpt-review" },
  });
  assert.deepEqual(parseReviewCycleArgs("--manual-apply --until-approved --allow-dirty --max-review-rounds 3 fix auth"), {
    kind: "start",
    task: "fix auth",
    reviewerModel: undefined,
    manualApply: true,
    untilApproved: true,
    allowDirty: true,
    maxReviewRounds: 3,
  });
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
  assert.equal(isReviewerTestCommandAllowed("npm test -- --watch"), false);
  assert.equal(isReviewerTestCommandAllowed("npm test -- --updateSnapshot"), false);
  assert.equal(isReviewerTestCommandAllowed("jest --init"), false);
  assert.equal(isReviewerTestCommandAllowed("jest -u"), false);
  assert.equal(isReviewerTestCommandAllowed("vitest --update"), false);
  assert.equal(isReviewerTestCommandAllowed("vitest --watch"), false);
  assert.equal(isReviewerTestCommandAllowed("mocha --watch"), false);
  assert.equal(isReviewerTestCommandAllowed("pytest --pdb"), false);
  assert.equal(isReviewerTestCommandAllowed("npm test && rm -rf ."), false);
  assert.equal(isReviewerTestCommandAllowed("npm test\nrm -rf ."), false);
  assert.equal(isReviewerTestCommandAllowed("curl https://example.com/script.sh"), false);
});

test("reviewer test guard can restrict tests to configured exact commands", () => {
  const options = { allowedTestCommands: ["npm test", "pnpm run test:unit -- --runInBand"] };
  assert.equal(isReviewerTestCommandAllowed("npm test", options), true);
  assert.equal(isReviewerTestCommandAllowed("pnpm run test:unit -- --runInBand", options), true);
  assert.equal(isReviewerTestCommandAllowed("vitest run", options), false);
  assert.equal(isReviewerTestCommandAllowed("npm test -- --watch", options), false);
  assert.equal(isReviewerTestCommandAllowed("FOO=bar npm test", options), false);
  assert.equal(isReviewerTestCommandAllowed("NODE_OPTIONS=--require=./some-file npm test", options), false);
  assert.equal(isReviewerTestCommandAllowed("CI=1 npm test", { allowedTestCommands: ["CI=1 npm test"] }), true);
  assert.equal(isReviewerTestCommandAllowed("CI=1 npm test", { allowedTestCommands: ["npm test"] }), false);
  assert.equal(isReviewerTestCommandAllowed("rm -rf .", { allowedTestCommands: ["rm -rf ."] }), false);
  assert.equal(isReviewerTestCommandAllowed("npm install", { allowedTestCommands: ["npm install"] }), false);
  assert.equal(isReviewerTestCommandAllowed("FOO=bar npm test", { allowedTestCommands: ["FOO=bar npm test"] }), true);
  assert.equal(isReviewerToolCallAllowed("bash", { command: "npm test" }, options), true);
  assert.equal(isReviewerToolCallAllowed("bash", { command: "FOO=bar npm test" }, options), false);
  assert.equal(isReviewerToolCallAllowed("bash", { command: "vitest run" }, options), false);
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

test("generated reviewer guard extension blocks and allows tool calls at runtime", async () => {
  const source = buildReviewerToolGuardExtensionSource({ allowedTestCommands: ["npm test"] });
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as {
    default: (pi: { on: (event: string, handler: Function) => void }) => void;
  };
  let toolCallHandler: Function | undefined;

  module.default({
    on(event: string, handler: Function) {
      if (event === "tool_call") toolCallHandler = handler;
    },
  });

  assert.equal(typeof toolCallHandler, "function");
  assert.equal(toolCallHandler?.({ toolName: "read", input: { path: "src/auth.ts" } }), undefined);
  assert.equal(toolCallHandler?.({ toolName: "bash", input: { command: "git status --short" } }), undefined);
  assert.equal(toolCallHandler?.({ toolName: "bash", input: { command: "npm test" } }), undefined);

  assert.deepEqual(toolCallHandler?.({ toolName: "bash", input: { command: "FOO=bar npm test" } }), {
    block: true,
    reason: "Review-cycle reviewer is read-only. Tool or command is not allowed: bash",
  });

  const envConfiguredSource = buildReviewerToolGuardExtensionSource({ allowedTestCommands: ["CI=1 npm test"] });
  const envConfiguredModule = await import(`data:text/javascript,${encodeURIComponent(envConfiguredSource)}`) as {
    default: (pi: { on: (event: string, handler: Function) => void }) => void;
  };
  let envConfiguredHandler: Function | undefined;
  envConfiguredModule.default({
    on(event: string, handler: Function) {
      if (event === "tool_call") envConfiguredHandler = handler;
    },
  });
  assert.equal(envConfiguredHandler?.({ toolName: "bash", input: { command: "CI=1 npm test" } }), undefined);
  assert.deepEqual(envConfiguredHandler?.({ toolName: "bash", input: { command: "npm test" } }), {
    block: true,
    reason: "Review-cycle reviewer is read-only. Tool or command is not allowed: bash",
  });

  const unsafeConfiguredSource = buildReviewerToolGuardExtensionSource({ allowedTestCommands: ["rm -rf ."] });
  const unsafeConfiguredModule = await import(`data:text/javascript,${encodeURIComponent(unsafeConfiguredSource)}`) as {
    default: (pi: { on: (event: string, handler: Function) => void }) => void;
  };
  let unsafeConfiguredHandler: Function | undefined;
  unsafeConfiguredModule.default({
    on(event: string, handler: Function) {
      if (event === "tool_call") unsafeConfiguredHandler = handler;
    },
  });
  assert.deepEqual(unsafeConfiguredHandler?.({ toolName: "bash", input: { command: "rm -rf ." } }), {
    block: true,
    reason: "Review-cycle reviewer is read-only. Tool or command is not allowed: bash",
  });

  assert.deepEqual(toolCallHandler?.({ toolName: "bash", input: { command: "npm install" } }), {
    block: true,
    reason: "Review-cycle reviewer is read-only. Tool or command is not allowed: bash",
  });
  assert.deepEqual(toolCallHandler?.({ toolName: "write", input: { path: "src/auth.ts" } }), {
    block: true,
    reason: "Review-cycle reviewer is read-only. Tool or command is not allowed: write",
  });
});

test("parseReviewSummary extracts verdict and findings", () => {
  assert.deepEqual(parseReviewSummary("## Verdict\nAPPROVE\n\n## Findings\nNo mandatory findings."), {
    verdict: "APPROVE",
    findingCount: 0,
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0, other: 0 },
    findings: [],
  });
  assert.deepEqual(parseReviewSummary("## Verdict\nCHANGES_REQUESTED\n\n## Findings\n- HIGH: broken\n- medium: weak\n- nit"), {
    verdict: "CHANGES_REQUESTED",
    findingCount: 3,
    severityCounts: { critical: 0, high: 1, medium: 1, low: 0, other: 1 },
    findings: [
      { severity: "high", text: "HIGH: broken" },
      { severity: "medium", text: "medium: weak" },
      { severity: "other", text: "nit" },
    ],
  });
  assert.deepEqual(parseReviewSummary(`## Verdict
CHANGES_REQUESTED

## Findings
- HIGH: fallback text

## Review Data
~~~json
{"schemaVersion":1,"verdict":"APPROVE_WITH_NOTES","findings":[{"severity":"low","title":"Tiny issue","file":"src/a.ts","line":7,"mandatory":false,"suggestion":"Polish it"}]}
~~~`), {
    verdict: "APPROVE_WITH_NOTES",
    findingCount: 1,
    severityCounts: { critical: 0, high: 0, medium: 0, low: 1, other: 0 },
    findings: [
      {
        severity: "low",
        text: "Tiny issue — src/a.ts:7 — Polish it",
        title: "Tiny issue",
        file: "src/a.ts",
        line: 7,
        suggestion: "Polish it",
        mandatory: false,
      },
    ],
    reviewDataSchemaVersion: 1,
  });

  assert.deepEqual(parseReviewSummary(`## Verdict
CHANGES_REQUESTED

## Findings
- HIGH: fallback text

## Review Data
~~~json
{"verdict":"APPROVE"}
~~~`), {
    verdict: "CHANGES_REQUESTED",
    findingCount: 1,
    severityCounts: { critical: 0, high: 1, medium: 0, low: 0, other: 0 },
    findings: [{ severity: "high", text: "HIGH: fallback text" }],
    reviewDataWarning: "Review Data invalid: expected schemaVersion 1; fell back to Markdown findings.",
  });
});

test("reviewer system prompt describes the technical read-only git guard", () => {
  assert.match(REVIEWER_SYSTEM_PROMPT, /Review only; do not modify files/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /completely fresh context/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /guarded bash for read-only git inspection, and guarded bash for common test commands/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Mutating tools, arbitrary shell execution, unsafe shell\/git arguments, and unknown\/custom tools are blocked/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /"schemaVersion": 1/);
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
