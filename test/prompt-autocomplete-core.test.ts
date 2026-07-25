import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acquireCoalescedRequest,
  buildLatestAssistantMessageContext,
  buildPromptAutocompleteCacheKey,
  buildRecentConversationContext,
  cancelAllCoalescedRequests,
  computeRequestMaxTokens,
  createOwnerRefCounter,
  createPromptAutocompleteUsageStats,
  DEFAULT_MAX_ALTERNATIVES,
  DEFAULT_MAX_SUGGESTION_CHARS,
  DEFAULT_MIN_PROMPT_CHARS,
  DEFAULT_PREFERRED_MODEL,
  DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED,
  describeSettingSource,
  ExpiringLruCache,
  formatUsageStats,
  MAX_REQUEST_MAX_TOKENS,
  MIN_REQUEST_MAX_TOKENS,
  recordProviderUsage,
  resolveOverride,
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
  SequenceOwnedSlot,
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

test("computeRequestMaxTokens scales with alternatives and clamps to the budget", () => {
  // Default config (3 alternatives, 160 chars) lands above the old fixed 192 budget.
  assert.equal(computeRequestMaxTokens(DEFAULT_MAX_ALTERNATIVES, DEFAULT_MAX_SUGGESTION_CHARS), 210);
  // Small requests are floored to the minimum budget.
  assert.equal(computeRequestMaxTokens(1, 16), MIN_REQUEST_MAX_TOKENS);
  // Extreme requests are capped at the maximum budget.
  assert.equal(computeRequestMaxTokens(5, 1000), MAX_REQUEST_MAX_TOKENS);
  // More alternatives never decrease the budget.
  assert.ok(computeRequestMaxTokens(4, 160) > computeRequestMaxTokens(3, 160));
});

test("privacy-safe autocomplete defaults require explicit enablement and a non-empty draft", () => {
  assert.equal(DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED, false);
  assert.equal(DEFAULT_MIN_PROMPT_CHARS, 1);
  assert.equal(DEFAULT_PREFERRED_MODEL, "current active model");
});

test("prompt-autocomplete index no longer hardcodes a provider/model default", () => {
  const source = readFileSync(new URL("../extensions/prompt-autocomplete/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /default:\s*"openai\/[^"]+"/);
  assert.match(source, /Optional provider\/model override for prompt autocomplete/);
  assert.match(source, /default:\s*DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED/);
  assert.match(source, /default:\s*DEFAULT_PREFERRED_MODEL/);
});

test("prompt autocomplete cache identity includes draft, context, and output configuration", () => {
  const base = {
    leafId: "leaf-1",
    modelLabel: "openai/gpt-test",
    maxAlternatives: 3,
    maxSuggestionChars: 160,
    draft: "Review the change",
    latestAssistantContext: "Implementation finished",
    latestUserContext: "Please implement it",
    recentContext: "User: Please implement it\n\nAssistant: Implementation finished",
  };

  const key = buildPromptAutocompleteCacheKey(base);
  assert.equal(key, buildPromptAutocompleteCacheKey({ ...base }));
  assert.notEqual(key, buildPromptAutocompleteCacheKey({ ...base, draft: "Review all changes" }));
  assert.notEqual(
    key,
    buildPromptAutocompleteCacheKey({ ...base, latestAssistantContext: "Tests are still failing" }),
  );
  assert.notEqual(key, buildPromptAutocompleteCacheKey({ ...base, maxSuggestionChars: 320 }));
  assert.doesNotMatch(key, /Implementation finished|Please implement it|Review the change/);
});

test("expiring LRU cache enforces TTL, manual bypass, and the entry bound", () => {
  let now = 1_000;
  const cache = new ExpiringLruCache<string>(60_000, 2, () => now);

  cache.set("positive", "suggestion");
  cache.set("empty", "");
  assert.equal(cache.get("positive"), "suggestion");
  assert.equal(cache.get("positive", { bypass: true }), undefined);
  assert.equal(cache.get("empty"), "");

  now += 60_000;
  assert.equal(cache.get("positive"), undefined);
  assert.equal(cache.get("empty"), undefined);
  assert.equal(cache.size, 0);

  cache.set("a", "A");
  cache.set("b", "B");
  cache.get("a");
  cache.set("c", "C");
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c"), "C");
});

test("sequence-owned slot does not let an older completion clear newer pending state", () => {
  const slot = new SequenceOwnedSlot<{ seq: number; key: string }>();
  slot.set({ seq: 1, key: "same-key" });
  slot.set({ seq: 2, key: "same-key" });

  assert.equal(slot.clearIfOwned(1), false);
  assert.deepEqual(slot.current, { seq: 2, key: "same-key" });
  assert.equal(slot.clearIfOwned(2), true);
  assert.equal(slot.current, undefined);

  slot.set({ seq: 3, key: "other-key" });
  assert.deepEqual(slot.take(), { seq: 3, key: "other-key" });
  assert.equal(slot.current, undefined);
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

test("normalizePromptSuggestions salvages complete entries from truncated JSON responses", () => {
  const truncated =
    '{"completions":["Prüfe, ob die Suiten mit eigenen Factory-Mocks auch auf den manuellen Mock umstellbar sind","Konvertiere den manuellen Mock von module.exports';
  assert.deepEqual(normalizePromptSuggestions("", truncated), [
    "Prüfe, ob die Suiten mit eigenen Factory-Mocks auch auf den manuellen Mock umstellbar sind",
  ]);
});

test("normalizePromptSuggestions salvages entries with escaped quotes and brackets from truncated JSON", () => {
  const truncated = '{"completions":["Nutze arr[0] und \\"quoted\\" Text","Zweiter vollständiger Eintrag","abgeschn';
  assert.deepEqual(normalizePromptSuggestions("", truncated), [
    'Nutze arr[0] und "quoted" Text',
    "Zweiter vollständiger Eintrag",
  ]);
});

test("normalizePromptSuggestions ignores nested strings while salvaging truncated JSON arrays", () => {
  assert.deepEqual(
    normalizePromptSuggestions("", '{"completions":[{"text":"bad"},"good","trunc'),
    ["good"],
  );
  assert.deepEqual(
    normalizePromptSuggestions("", '{"completions":[["nested"],"good","trunc'),
    ["good"],
  );
});

test("normalizePromptSuggestions uses top-level suggestion key priority while salvaging", () => {
  assert.deepEqual(
    normalizePromptSuggestions("", '{"items":["metadata"],"completions":["good","trunc'),
    ["good"],
  );
  assert.deepEqual(
    normalizePromptSuggestions("", '{"metadata":{"items":["metadata"]},"completions":["good","trunc'),
    ["good"],
  );
  assert.deepEqual(
    normalizePromptSuggestions("", '{"completions":[],"suggestions":["fallback","trunc'),
    ["fallback"],
  );
  assert.deepEqual(
    normalizePromptSuggestions("", '{"completions":[{"text":"bad"}],"suggestions":["fallback","trunc'),
    ["fallback"],
  );
});

test("normalizePromptSuggestions salvages JSON payloads after leading prose", () => {
  assert.deepEqual(
    normalizePromptSuggestions("", 'Here is JSON:\n```json\n{"completions":["good","trunc'),
    ["good"],
  );
});

test("normalizePromptSuggestions discards trailing broken escapes in truncated JSON", () => {
  assert.deepEqual(normalizePromptSuggestions("", '{"completions":["complete","broken\\'), ["complete"]);
  assert.deepEqual(normalizePromptSuggestions("", '{"completions":["complete","broken\\u12"'), ["complete"]);
});

test("normalizePromptSuggestions never leaks unparseable JSON payloads as ghost text", () => {
  assert.deepEqual(normalizePromptSuggestions("", '{"completions":["abgeschnittener Eintr'), []);
  assert.deepEqual(normalizePromptSuggestions("", '{"unknown":"shape"}'), []);
  assert.deepEqual(normalizePromptSuggestions("", '```json\n{"completions":["abgeschn'), []);
});

test("normalizePromptSuggestions salvages truncated bare JSON arrays", () => {
  assert.deepEqual(normalizePromptSuggestions("", '["Vollständiger Eintrag","abgeschn'), ["Vollständiger Eintrag"]);
});

test("normalizePromptSuggestions keeps plain-text responses as fallback suggestion", () => {
  assert.deepEqual(normalizePromptSuggestions("", "Fasse die letzten Änderungen zusammen"), [
    "Fasse die letzten Änderungen zusammen",
  ]);
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

test("cancelAllCoalescedRequests tolerates active promises settling after clear", async () => {
  const inFlight = new Map<string, CoalescedRequestEntry<string>>();
  let resolveLate: ((value: string) => void) | undefined;
  let rejectLate: ((error: Error) => void) | undefined;

  const resolving = acquireCoalescedRequest(inFlight, "resolve-late", "subscriber-a", async () => {
    return await new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
  });
  const rejecting = acquireCoalescedRequest(inFlight, "reject-late", "subscriber-b", async () => {
    return await new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });
  });

  assert.equal(inFlight.size, 2);
  cancelAllCoalescedRequests(inFlight);
  assert.equal(inFlight.size, 0);

  resolveLate?.("late success");
  rejectLate?.(new Error("late failure"));

  assert.equal(await resolving.promise, "late success");
  await assert.rejects(rejecting.promise, /late failure/);
  assert.equal(inFlight.size, 0);
});

test("owner ref counter keeps shared UI state active until the final owner releases", () => {
  const owners = createOwnerRefCounter();

  assert.equal(owners.activate("request-a"), true);
  assert.equal(owners.activate("request-a"), false, "duplicate owner should not create a new transition");
  assert.equal(owners.activate("request-b"), false);
  assert.equal(owners.size(), 2);
  assert.equal(owners.has("request-a"), true);

  assert.equal(owners.deactivate("missing"), false);
  assert.equal(owners.deactivate("request-a"), false);
  assert.equal(owners.size(), 1);
  assert.equal(owners.deactivate("request-b"), true);
  assert.equal(owners.size(), 0);
});

test("owner ref counter clear resets remount-style leaked owners", () => {
  const owners = createOwnerRefCounter();

  owners.activate("old-activation-a");
  owners.activate("old-activation-b");
  assert.equal(owners.clear(), true);
  assert.equal(owners.size(), 0);
  assert.equal(owners.has("old-activation-a"), false);
  assert.equal(owners.clear(), false);

  assert.equal(owners.activate("new-activation"), true);
  assert.equal(owners.deactivate("new-activation"), true);
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

test("usage accumulates reported tokens and locally estimated cost", () => {
  const stats = createPromptAutocompleteUsageStats();

  recordProviderUsage(stats, {
    input: 120,
    output: 30,
    totalTokens: 150,
    cost: { total: 0.00042 },
  });
  recordProviderUsage(stats, { input: 80, output: 20, cost: { total: 0.0001 } });

  assert.equal(stats.tokenReports, 2);
  assert.equal(stats.costReports, 2);
  // The second report omits totalTokens, so the component tokens are the fallback.
  assert.equal(stats.totalTokens, 250);
  assert.equal(Number(stats.estimatedCost.toFixed(5)), 0.00052);
});

test("the token fallback includes cached tokens because they are billed too", () => {
  const stats = createPromptAutocompleteUsageStats();

  recordProviderUsage(stats, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 });

  assert.equal(stats.totalTokens, 135);
});

test("a reported total wins over the component tokens instead of adding to them", () => {
  const stats = createPromptAutocompleteUsageStats();

  recordProviderUsage(stats, { input: 10, output: 5, cacheRead: 100, totalTokens: 115 });

  assert.equal(stats.totalTokens, 115);
});

test("usage ignores missing, malformed, and negative reports", () => {
  const stats = createPromptAutocompleteUsageStats();

  recordProviderUsage(stats, undefined);
  recordProviderUsage(stats, null);
  recordProviderUsage(stats, "usage");
  recordProviderUsage(stats, {});
  recordProviderUsage(stats, { input: Number.NaN, output: Number.POSITIVE_INFINITY });
  recordProviderUsage(stats, { input: -10, output: -5, cost: { total: -1 } });

  assert.deepEqual(stats, createPromptAutocompleteUsageStats());
});

test("a legitimate all-zero report counts as reported rather than as missing", () => {
  const stats = createPromptAutocompleteUsageStats();
  stats.providerRequests = 1;

  recordProviderUsage(stats, { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } });

  assert.equal(stats.tokenReports, 1);
  assert.equal(stats.costReports, 1);
  // Nothing is missing, so nothing may be flagged as incomplete.
  assert.equal(formatUsageStats(stats), "1 req, 0 cached, 0 tok, ~$0 est");
});

test("a throwing usage object cannot break accounting", () => {
  const stats = createPromptAutocompleteUsageStats();
  const hostile = {
    get input(): number {
      throw new Error("hostile getter");
    },
    output: 5,
    get cost(): { total: number } {
      throw new Error("hostile getter");
    },
  };

  recordProviderUsage(stats, hostile);

  assert.equal(stats.tokenReports, 1);
  assert.equal(stats.costReports, 0);
  assert.equal(stats.totalTokens, 5);
});

test("usage stats mark token and cost totals partial independently", () => {
  const stats = createPromptAutocompleteUsageStats();
  stats.providerRequests = 3;
  stats.cacheHits = 5;
  stats.failedRequests = 1;
  // Tokens without a cost figure: the cost total is incomplete, the token total is not.
  recordProviderUsage(stats, { input: 100, output: 20, totalTokens: 120 });
  recordProviderUsage(stats, { input: 40, output: 10, totalTokens: 50, cost: { total: 0.0004 } });
  recordProviderUsage(stats, { input: 10, output: 5, totalTokens: 15, cost: { total: 0.0002 } });

  const formatted = formatUsageStats(stats);

  assert.match(formatted, /3 req/);
  assert.match(formatted, /5 cached/);
  assert.match(formatted, /1 failed/);
  // Every request reported tokens, so the token total is complete.
  assert.match(formatted, /185 tok,/);
  // Only two of three reported a cost, so the estimate is explicitly incomplete.
  assert.match(formatted, /~\$0\.00060 est\+/);
});

test("cost is presented as an estimate and never rounds a real cost to zero", () => {
  const stats = createPromptAutocompleteUsageStats();
  stats.providerRequests = 1;
  recordProviderUsage(stats, { totalTokens: 15, cost: { total: 0.000001 } });

  // A real but tiny cost must not be displayed as $0.
  assert.match(formatUsageStats(stats), /~<\$0\.00001 est/);

  const larger = createPromptAutocompleteUsageStats();
  larger.providerRequests = 1;
  recordProviderUsage(larger, { totalTokens: 15, cost: { total: 0.25 } });
  assert.match(formatUsageStats(larger), /~\$0\.2500 est/);
  assert.doesNotMatch(formatUsageStats(larger), /\+/);
});


test("runtime overrides outrank flags only when explicitly set", () => {
  assert.equal(resolveOverride(undefined, true), true);
  assert.equal(resolveOverride(undefined, false), false);
  assert.equal(resolveOverride(false, true), false);
  assert.equal(resolveOverride(true, false), true);

  assert.equal(describeSettingSource(undefined), "flag");
  assert.equal(describeSettingSource(false), "session");
  assert.equal(describeSettingSource(true), "session");
});

test("cache-only token reports still establish a token report", () => {
  const stats = createPromptAutocompleteUsageStats();
  stats.providerRequests = 1;

  recordProviderUsage(stats, { cacheRead: 100, cacheWrite: 20 });

  assert.equal(stats.tokenReports, 1);
  assert.equal(stats.totalTokens, 120);
  // Tokens were reported, so only the cost may be flagged as incomplete.
  assert.match(formatUsageStats(stats), /120 tok, ~\$0 est\+/);
});

test("an explicit zero total wins over the component tokens", () => {
  const stats = createPromptAutocompleteUsageStats();

  recordProviderUsage(stats, { input: 5, output: 3, totalTokens: 0 });

  assert.equal(stats.tokenReports, 1);
  assert.equal(stats.totalTokens, 0);
});

test("a side-effecting usage getter cannot report different values to totals and completeness", () => {
  const stats = createPromptAutocompleteUsageStats();
  stats.providerRequests = 1;
  let totalReads = 0;
  let costReads = 0;
  const shifting = {
    get totalTokens(): number {
      totalReads += 1;
      return totalReads === 1 ? -1 : 100;
    },
    get cost(): { total: number } {
      costReads += 1;
      return { total: costReads === 1 ? 1 : -1 };
    },
  };

  recordProviderUsage(stats, shifting);

  // Each field is read exactly once, so the first observed value decides both
  // the accumulated total and whether the metric counts as reported.
  assert.equal(totalReads, 1);
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.tokenReports, 0);
  assert.equal(stats.costReports, 1);
  assert.equal(stats.estimatedCost, 1);
});
