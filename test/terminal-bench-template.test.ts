import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const TEMPLATE_PATH = new URL("../extensions/terminal-bench.system-prompt.template.md", import.meta.url);
const SECTION_PATTERN = /<!--\s*BEGIN\s+([A-Z_]+)\s*-->([\s\S]*?)<!--\s*END\s+\1\s*-->/g;

test("terminal-bench prompt template contains required sections and variables", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const sections = Object.fromEntries(
    [...template.matchAll(SECTION_PATTERN)].map((match) => [match[1], match[2]?.trim()]),
  );

  assert.ok(sections.TERMINAL_BENCH_GUIDELINES?.includes("## Terminal-Bench Rules"));
  assert.ok(sections.COMPLETION_CHECKLIST?.includes("{{TASK_HINT}}"));
  assert.ok(sections.COMPLETION_CHECKLIST?.includes("{{CONTRACT_SECTION}}"));
  assert.ok(sections.COMPLETION_CHECKLIST?.includes("{{RECENT_ACTIONS_SECTION}}"));
  assert.ok(sections.COMPLETION_CHECKLIST?.includes("{{TERMINAL_STATE}}"));
});
