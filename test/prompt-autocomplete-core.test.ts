import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acquireCoalescedRequest,
  buildLatestAssistantMessageContext,
  buildRecentConversationContext,
  cancelAllCoalescedRequests,
  DEFAULT_PREFERRED_MODEL,
  extractMessageText,
  extractNextSuggestionChunk,
  normalizePromptSuggestion,
  normalizePromptSuggestions,
  normalizeTemplateText,
  parseBoundedIntFlag,
  parseModelRef,
  PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
  PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT_TEMPLATE_VARIABLES,
  renderMiniTemplate,
  shouldSkipPromptAutocomplete,
  truncateDraftTail,
  type CoalescedRequestEntry,
} from "../extensions/prompt-autocomplete/core.ts";

test("parseModelRef parses provider/model strings", () => {
  assert.deepEqual(parseModelRef("openai/gpt-5-mini"), {
    provider: "openai",
    id: "gpt-5-mini",
  });
  assert.equal(parseModelRef("invalid"), undefined);
  assert.equal(parseModelRef("/missing-provider"), undefined);
});

test("parseBoundedIntFlag clamps invalid and out-of-range values", () => {
  assert.equal(parseBoundedIntFlag("350", 100, 0, 1000), 350);
  assert.equal(parseBoundedIntFlag("-1", 100, 0, 1000), 0);
  assert.equal(parseBoundedIntFlag("5000", 100, 0, 1000), 1000);
  assert.equal(parseBoundedIntFlag("abc", 100, 0, 1000), 100);
});

test("default prompt autocomplete model now follows the active model", () => {
  assert.equal(DEFAULT_PREFERRED_MODEL, "current active model");
});

test("prompt-autocomplete index no longer hardcodes a provider/model default", () => {
  const source = readFileSync(new URL("../extensions/prompt-autocomplete/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /default:\s*"openai\/[^"]+"/);
  assert.match(source, /Optional provider\/model override for prompt autocomplete/);
  assert.match(source, /description: "Enable inline AI prompt autocomplete in the editor",\n    type: "boolean",\n    default: true,/);
  assert.match(source, /default:\s*DEFAULT_PREFERRED_MODEL/);
});

test("prompt-autocomplete requests cap provider retries and timeouts for inline UX", () => {
  const source = readFileSync(new URL("../extensions/prompt-autocomplete/index.ts", import.meta.url), "utf8");
  assert.match(source, /REQUEST_TIMEOUT_MS\s*=\s*8_000/);
  assert.match(source, /REQUEST_MAX_RETRIES\s*=\s*0/);
  assert.match(source, /timeoutMs:\s*REQUEST_TIMEOUT_MS/);
  assert.match(source, /maxRetries:\s*REQUEST_MAX_RETRIES/);
});

test("renderMiniTemplate replaces placeholders and supports repeated variables", () => {
  assert.equal(
    renderMiniTemplate("Hello {{NAME}} / {{NAME}}", { NAME: "World" }),
    "Hello World / World",
  );
});

test("renderMiniTemplate uses fallback values when variables are missing", () => {
  assert.equal(
    renderMiniTemplate("Hello {{NAME|friend}} from {{ CITY | Berlin }}", {}),
    "Hello friend from Berlin",
  );
});

test("renderMiniTemplate prefers explicit variables over fallback values", () => {
  assert.equal(
    renderMiniTemplate("Hello {{NAME|friend}}", { NAME: "World" }),
    "Hello World",
  );
});

test("renderMiniTemplate leaves escaped placeholders literal", () => {
  assert.equal(
    renderMiniTemplate("Hello \\{{NAME}} and \\{{CITY|Berlin}}", { NAME: "World", CITY: "Paris" }),
    "Hello {{NAME}} and {{CITY|Berlin}}",
  );
});

test("renderMiniTemplate does not treat escaped placeholders as missing variables", () => {
  assert.equal(
    renderMiniTemplate("Hello \\{{MISSING}}", {}),
    "Hello {{MISSING}}",
  );
});

test("renderMiniTemplate throws when a placeholder variable is missing and no fallback exists", () => {
  assert.throws(
    () => renderMiniTemplate("Hello {{NAME}} {{MISSING}}", { NAME: "World" }),
    /Missing template variable\(s\): MISSING/,
  );
});

test("prompt autocomplete system prompt is rendered from the template file", () => {
  const template = normalizeTemplateText(
    readFileSync(
      new URL("../extensions/prompt-autocomplete/system-prompt.template.md", import.meta.url),
      "utf8",
    ),
  );

  const rendered = renderMiniTemplate(template, PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT_TEMPLATE_VARIABLES);
  assert.equal(PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT, rendered);
  assert.doesNotMatch(PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT, /\{\{\s*[A-Z0-9_]+(?:\|[\s\S]*?)?\s*\}\}/);
});

test("prompt-autocomplete core loads and renders the system prompt template file instead of inlining it", () => {
  const source = readFileSync(new URL("../extensions/prompt-autocomplete/core.ts", import.meta.url), "utf8");
  assert.match(source, /readFileSync\(\s*new URL\("\.\/system-prompt\.template\.md", import\.meta\.url\)/s);
  assert.match(source, /renderMiniTemplate\(/);
  assert.doesNotMatch(source, /Return ONLY valid JSON with exactly this shape:/);
});

test("normalizePromptSuggestion strips repeated draft and prefixes a space when needed", () => {
  assert.equal(
    normalizePromptSuggestion("Kannst du das refactoren", "Kannst du das refactoren und Tests ergänzen"),
    " und Tests ergänzen",
  );
});

test("normalizePromptSuggestion strips wrappers and sentinel responses", () => {
  assert.equal(normalizePromptSuggestion("Schreibe", '" eine kurze Zusammenfassung"'), " eine kurze Zusammenfassung");
  assert.equal(normalizePromptSuggestion("Schreibe", "<NO_COMPLETION>"), undefined);
  assert.equal(
    normalizePromptSuggestion("Schreibe", "```text\n eine kurze Zusammenfassung\n```"),
    " eine kurze Zusammenfassung",
  );
});

test("normalizePromptSuggestion does not add an extra leading space when draft already ends with one", () => {
  assert.equal(
    normalizePromptSuggestion("Kannst du mir helfen, ", " eine Pi Extension zu bauen"),
    "eine Pi Extension zu bauen",
  );
});

test("normalizePromptSuggestion completes partial words without inserting a separator", () => {
  assert.equal(
    normalizePromptSuggestion("Schrei", "be eine Antwort"),
    "be eine Antwort",
  );
  assert.equal(
    normalizePromptSuggestion("Bitte schrei", "Bitte schreibe eine Antwort"),
    "be eine Antwort",
  );
  assert.equal(
    normalizePromptSuggestion("Bitte schrei", "Schreibe eine Antwort"),
    "be eine Antwort",
  );
  assert.equal(
    normalizePromptSuggestion("Bitte schrei", " schreibe eine Antwort"),
    "be eine Antwort",
  );
});

test("normalizePromptSuggestion removes leading horizontal whitespace for empty drafts", () => {
  assert.equal(normalizePromptSuggestion("", "   Bitte fasse die letzten Änderungen zusammen"), "Bitte fasse die letzten Änderungen zusammen");
});

test("normalizePromptSuggestion preserves newline-prefixed multiline suggestions", () => {
  assert.equal(normalizePromptSuggestion("foo", "\nfoo bar"), "\nfoo bar");
});

test("normalizePromptSuggestions parses JSON alternatives and deduplicates them", () => {
  assert.deepEqual(
    normalizePromptSuggestions(
      "Schreibe eine Antwort",
      JSON.stringify({
        completions: [
          " mit Fokus auf Performance.",
          " mit Fokus auf Performance.",
          " und nenne zusätzlich die Risiken.",
        ],
      }),
    ),
    [" mit Fokus auf Performance.", " und nenne zusätzlich die Risiken."],
  );
});

test("extractNextSuggestionChunk returns the next word-like chunk", () => {
  assert.equal(extractNextSuggestionChunk(" und Tests für Edge Cases ergänzen"), " und ");
  assert.equal(extractNextSuggestionChunk("\n  eine Liste mit Schritten"), "\n  eine ");
  assert.equal(extractNextSuggestionChunk("."), ".");
});

test("truncateDraftTail keeps only the tail of very long drafts", () => {
  assert.equal(truncateDraftTail("abcdef", 4), "cdef");
  assert.equal(truncateDraftTail("abc", 4), "abc");
});

test("shouldSkipPromptAutocomplete skips command, symbol, and path contexts", () => {
  assert.equal(shouldSkipPromptAutocomplete("/settings"), true);
  assert.equal(shouldSkipPromptAutocomplete("!git status"), true);
  assert.equal(shouldSkipPromptAutocomplete("Bitte lies @README"), true);
  assert.equal(shouldSkipPromptAutocomplete("Bitte prüfe #123"), true);
  assert.equal(shouldSkipPromptAutocomplete("Öffne ./extensions/prompt-autocomplete"), true);
  assert.equal(shouldSkipPromptAutocomplete("Bitte refactore die Extension"), false);
});

test("extractMessageText marks truncated multi-block content within the character budget", () => {
  const text = extractMessageText(
    [
      { type: "text", text: "ab" },
      { type: "text", text: "cd" },
      { type: "text", text: "ef" },
    ],
    5,
  );

  assert.equal(text.length, 5);
  assert.equal(text.endsWith("…"), true);
});

test("buildRecentConversationContext keeps user/assistant text in chronological order", () => {
  const branch = [
    {
      type: "message",
      message: { role: "user", content: "Bitte reviewe die API." },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Klar, ich schaue zuerst auf Auth und Error Handling." }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] },
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Bitte achte auch auf Performance." }] },
    },
  ];

  assert.equal(
    buildRecentConversationContext(branch),
    [
      "User: Bitte reviewe die API.",
      "Assistant: Klar, ich schaue zuerst auf Auth und Error Handling.",
      "User: Bitte achte auch auf Performance.",
    ].join("\n\n"),
  );
});

test("coalesced requests share a single promise and abort only after the last subscriber leaves", async () => {
  const inFlight = new Map<string, CoalescedRequestEntry<string>>();
  const abortEvents: boolean[] = [];
  let resolveRequest: ((value: string) => void) | undefined;
  let startCount = 0;

  const first = acquireCoalescedRequest(inFlight, "same-key", "subscriber-a", async (signal) => {
    startCount += 1;
    signal.addEventListener("abort", () => abortEvents.push(true));
    return await new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
  });
  const second = acquireCoalescedRequest(inFlight, "same-key", "subscriber-b", async () => "unexpected");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(startCount, 1);
  assert.equal(first.promise, second.promise);
  assert.equal(inFlight.size, 1);
  assert.equal(first.subscriberCount(), 2);

  first.release();
  assert.equal(abortEvents.length, 0);
  assert.equal(second.subscriberCount(), 1);
  assert.equal(inFlight.size, 1);

  resolveRequest?.("done");
  assert.equal(await second.promise, "done");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(inFlight.size, 0);
});

test("coalesced requests abort when the final subscriber cancels", () => {
  const inFlight = new Map<string, CoalescedRequestEntry<string>>();
  let aborted = false;

  const subscription = acquireCoalescedRequest(inFlight, "same-key", "subscriber-a", async (signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return await new Promise<string>(() => undefined);
  });

  subscription.release();
  assert.equal(aborted, true);
  assert.equal(inFlight.size, 0);
  subscription.promise.catch(() => undefined);
});

test("cancelAllCoalescedRequests aborts and clears all active requests", () => {
  const inFlight = new Map<string, CoalescedRequestEntry<string>>();
  let aborted = 0;

  acquireCoalescedRequest(inFlight, "a", "subscriber-a", async (signal) => {
    signal.addEventListener("abort", () => {
      aborted += 1;
    });
    return await new Promise<string>(() => undefined);
  });
  acquireCoalescedRequest(inFlight, "b", "subscriber-b", async (signal) => {
    signal.addEventListener("abort", () => {
      aborted += 1;
    });
    return await new Promise<string>(() => undefined);
  });

  cancelAllCoalescedRequests(inFlight);
  assert.equal(aborted, 2);
  assert.equal(inFlight.size, 0);
});

test("coalesced requests turn synchronous start failures into rejected promises", async () => {
  const inFlight = new Map<string, CoalescedRequestEntry<string>>();
  const subscription = acquireCoalescedRequest(inFlight, "same-key", "subscriber-a", () => {
    throw new Error("boom");
  });

  await assert.rejects(subscription.promise, /boom/);
  assert.equal(inFlight.size, 0);
});

test("buildLatestAssistantMessageContext returns the newest assistant text", () => {
  const branch = [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Ältere Antwort" }] },
    },
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Neue Frage" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Neueste Antwort mit konkreten nächsten Schritten" }],
      },
    },
  ];

  assert.equal(
    buildLatestAssistantMessageContext(branch),
    "Neueste Antwort mit konkreten nächsten Schritten",
  );
});
