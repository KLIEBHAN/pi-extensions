import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLatestAssistantMessageContext,
  buildRecentConversationContext,
  extractNextSuggestionChunk,
  normalizePromptSuggestion,
  normalizePromptSuggestions,
  parseBoundedIntFlag,
  parseModelRef,
  truncateDraftTail,
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

test("normalizePromptSuggestion removes leading horizontal whitespace for empty drafts", () => {
  assert.equal(normalizePromptSuggestion("", "   Bitte fasse die letzten Änderungen zusammen"), "Bitte fasse die letzten Änderungen zusammen");
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
