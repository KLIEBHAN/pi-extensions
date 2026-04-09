import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractAssistantText,
  parseLoopArgs,
  parsePositiveInteger,
  parseVerificationResponse,
  shouldTreatStopReasonAsFailure,
  summarizeTask,
} from "../extensions/ralphy-loop-core.ts";

test("parsePositiveInteger accepts valid positive integers", () => {
  assert.equal(parsePositiveInteger("1"), 1);
  assert.equal(parsePositiveInteger("42"), 42);
  assert.equal(parsePositiveInteger("10000"), 10000);
});

test("parsePositiveInteger rejects invalid values", () => {
  assert.equal(parsePositiveInteger("0"), undefined);
  assert.equal(parsePositiveInteger("-1"), undefined);
  assert.equal(parsePositiveInteger("1.5"), undefined);
  assert.equal(parsePositiveInteger("abc"), undefined);
  assert.equal(parsePositiveInteger("10001"), undefined);
});

test("parseLoopArgs parses positional repeat and task", () => {
  assert.deepEqual(parseLoopArgs("3 harden edge cases"), {
    task: "harden edge cases",
    repeat: 3,
    continueOnFailure: false,
  });
});

test("parseLoopArgs parses explicit flags", () => {
  assert.deepEqual(parseLoopArgs("--repeat 5 --continue-on-failure fix auth flow"), {
    task: "fix auth flow",
    repeat: 5,
    continueOnFailure: true,
  });
});

test("parseLoopArgs reports invalid repeat values", () => {
  assert.deepEqual(parseLoopArgs("--repeat nope task"), {
    error: "--repeat must be an integer between 1 and 10000",
  });
});

test("parseVerificationResponse parses direct JSON", () => {
  assert.deepEqual(
    parseVerificationResponse('{"done":false,"reason":"missing push","continuePrompt":"continue now"}'),
    {
      done: false,
      reason: "missing push",
      continuePrompt: "continue now",
    },
  );
});

test("parseVerificationResponse parses JSON wrapped in extra text", () => {
  assert.deepEqual(
    parseVerificationResponse(
      'Verifier output:\n{"done":true,"reason":"complete","continuePrompt":"unused"}\nThanks',
    ),
    {
      done: true,
      reason: "complete",
      continuePrompt: "unused",
    },
  );
});

test("extractAssistantText returns only text blocks", () => {
  assert.equal(
    extractAssistantText([
      { type: "text", text: "First line" },
      { type: "image", text: "ignored" },
      { type: "text", text: "Second line" },
    ]),
    "First line\nSecond line",
  );
});

test("shouldTreatStopReasonAsFailure matches expected reasons", () => {
  assert.equal(shouldTreatStopReasonAsFailure("stop"), false);
  assert.equal(shouldTreatStopReasonAsFailure("toolUse"), false);
  assert.equal(shouldTreatStopReasonAsFailure("error"), true);
  assert.equal(shouldTreatStopReasonAsFailure("aborted"), true);
  assert.equal(shouldTreatStopReasonAsFailure("length"), true);
});

test("summarizeTask truncates long text with ellipsis", () => {
  assert.equal(summarizeTask("a".repeat(10), 10), "a".repeat(10));
  assert.equal(summarizeTask("a".repeat(11), 10), `${"a".repeat(9)}…`);
});

test("ralphy-loop.ts stays standalone when symlinked as a single extension file", () => {
  const source = readFileSync(new URL("../extensions/ralphy-loop.ts", import.meta.url), "utf8");
  assert.equal(source.includes('from "./ralphy-loop-core.ts"'), false);
  assert.equal(source.includes("from './ralphy-loop-core.ts'"), false);
});
