import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  acquireCoalescedRequest,
  buildLatestAssistantMessageContext,
  buildPromptAutocompleteCacheKey,
  buildPromptAutocompletePrefixContextKey,
  buildRecentConversationContext,
  cancelAllCoalescedRequests,
  computeRequestMaxTokens,
  buildPromptAutocompleteBudgetSnapshot,
  BUDGET_REQUESTS_MAX,
  BUDGET_REQUESTS_MIN,
  findPromptAutocompleteBudgetSnapshot,
  parsePromptAutocompleteBudgetFlag,
  parsePromptAutocompleteBudgetValue,
  parsePromptAutocompleteBudgetSnapshot,
  PROMPT_AUTOCOMPLETE_BUDGET_ENTRY_TYPE,
  resolvePromptAutocompleteBudgetLimit,
  createOwnerRefCounter,
  createPromptAutocompleteUsageStats,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_ALTERNATIVES,
  DEFAULT_MAX_SUGGESTION_CHARS,
  DEFAULT_MIN_PROMPT_CHARS,
  DEFAULT_PREFERRED_MODEL,
  DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED,
  DEBOUNCE_MS_MAX,
  DEBOUNCE_MS_MIN,
  MAX_ALTERNATIVES_MAX,
  MAX_ALTERNATIVES_MIN,
  MAX_SUGGESTION_CHARS_MAX,
  MAX_SUGGESTION_CHARS_MIN,
  describePromptAutocompleteModelSelection,
  describeSettingSource,
  ExpiringLruCache,
  formatPromptAutocompleteStats,
  formatUsageStats,
  hostSupportsStreamedResponses,
  isInteractiveEditorHost,
  MAX_REQUEST_MAX_TOKENS,
  MIN_REQUEST_MAX_TOKENS,
  recordProviderLatency,
  recordProviderUsage,
  resolveOverride,
  sanitizeTerminalText,
  reusePromptAutocompleteSuggestions,
  extractMessageText,
  extractNextSuggestionChunk,
  normalizePromptSuggestion,
  normalizePromptSuggestions,
  normalizeTemplateText,
  parseBoundedIntFlag,
  parsePartialPromptSuggestion,
  parseModelRef,
  parsePromptAutocompleteModelSelection,
  parseExplicitBoundedIntFlag,
  parseExplicitModelFlag,
  parsePersistedModelRaw,
  parsePromptAutocompletePersistedSettings,
  parseStrictBoundedInt,
  persistableModelRaw,
  resolveAutocompleteConversationId,
  resolvePersistedEnabled,
  resolvePersistedModelSelection,
  resolvePersistedNumber,
  serializePromptAutocompletePersistedSettings,
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
    conversationId: "leaf-1",
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

  const { draft: _draft, ...prefixIdentity } = base;
  const prefixKey = buildPromptAutocompletePrefixContextKey(prefixIdentity);
  assert.equal(prefixKey, buildPromptAutocompletePrefixContextKey({ ...prefixIdentity }));
  assert.notEqual(
    prefixKey,
    buildPromptAutocompletePrefixContextKey({ ...prefixIdentity, conversationId: "leaf-2" }),
  );
  assert.notEqual(
    prefixKey,
    buildPromptAutocompletePrefixContextKey({ ...prefixIdentity, recentContext: "changed" }),
  );
  assert.doesNotMatch(prefixKey, /Implementation finished|Please implement it/);
});

test("conversation identity skips metadata entries and unnamed entries", () => {
  const user = { type: "message", id: "msg-user", message: { role: "user", content: "Hi" } };
  const assistant = { type: "message", id: "msg-asst", message: { role: "assistant", content: "Hello" } };
  const custom = { type: "custom", id: "custom-1", customType: "prompt-autocomplete-stats" };
  const label = { type: "label", id: "label-1", targetId: "msg-asst", label: "keep" };
  const sessionInfo = { type: "session_info", id: "info-1", name: "Session" };
  const customMessage = { type: "custom_message", id: "ext-1", customType: "other", content: "Injected" };

  assert.equal(resolveAutocompleteConversationId([user, assistant, custom, label, sessionInfo], "fallback"), "msg-asst");
  assert.equal(resolveAutocompleteConversationId([user, assistant, customMessage], "fallback"), "ext-1");
  assert.equal(resolveAutocompleteConversationId([custom, label, sessionInfo], "session-1"), "session-1");
  assert.equal(
    resolveAutocompleteConversationId([{ type: "message", message: { role: "user", content: "no id" } }], "leaf-1"),
    "leaf-1",
  );
  assert.equal(resolveAutocompleteConversationId([], "session-1"), "session-1");
  assert.notEqual(
    resolveAutocompleteConversationId([user, { ...assistant, id: "msg-asst-2" }], "fallback"),
    resolveAutocompleteConversationId([user, assistant], "fallback"),
  );
});

test("prompt-autocomplete waits for agent_settled and uses conversation identity", () => {
  const source = readFileSync(new URL("../extensions/prompt-autocomplete/index.ts", import.meta.url), "utf8");
  assert.match(source, /physicalSessionId/);
  assert.match(source, /getSessionId/);
  assert.match(source, /pi\.on\("agent_settled"/);
  assert.match(source, /hostEmitsAgentSettled/);
  assert.match(source, /resolveAutocompleteConversationId/);
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

  const original = new ExpiringLruCache<string>(60_000, 2, () => now);
  const secondary = new ExpiringLruCache<string>(60_000, 2, () => now);
  original.set("source", "value");
  const originalExpiration = original.getExpiration("source");
  assert.equal(originalExpiration, now + 60_000);
  now += 50_000;
  secondary.set("copy", "value", { expiresAt: originalExpiration });
  assert.equal(secondary.get("copy"), "value");
  now += 10_000;
  assert.equal(secondary.get("copy"), undefined, "copying an entry must not restart its TTL");
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

test("suggestion normalization strips terminal controls and truncates at grapheme boundaries", () => {
  assert.equal(normalizePromptSuggestion("", "safe \u001b[2J\u0008 next"), "safe [2J next");
  assert.equal(normalizePromptSuggestion("", "abc\uD83D x"), "abc");
  assert.equal(normalizePromptSuggestion("", "abc\uDC69 x"), "abc");
  assert.equal(normalizePromptSuggestion("", "12345678901234👩‍💻tail", 16), "12345678901234…");
  assert.doesNotMatch(normalizePromptSuggestion("", "12345678901234👩‍💻tail", 16) ?? "", /�|\u200D/);
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

test("prefix reuse consumes exact typed deltas and preserves the normalized target", () => {
  assert.deepEqual(
    reusePromptAutocompleteSuggestions(
      "Review",
      "Review the",
      [" the implementation carefully", " with focused tests"],
    ),
    {
      suggestions: [" implementation carefully"],
      origins: [" the implementation carefully"],
    },
  );
  assert.deepEqual(
    reusePromptAutocompleteSuggestions("Schrei", "Schreib", ["be eine Antwort"]),
    { suggestions: ["e eine Antwort"], origins: ["be eine Antwort"] },
  );
  for (const [cachedDraft, currentDraft, origin] of [
    ["Say", "Say foo", " foo foobar later"],
    ["Review", "Review the", " the theorem"],
    ["List", "List\n", "\n  item"],
    ["Call", "Call)", ")result"],
  ] as const) {
    const reused = reusePromptAutocompleteSuggestions(cachedDraft, currentDraft, [origin]);
    assert.ok(reused);
    assert.equal(
      currentDraft + reused.suggestions[0],
      cachedDraft + origin,
      "reuse must preserve the exact normalized cached target",
    );
  }
  assert.equal(
    reusePromptAutocompleteSuggestions("Review", "Review something else", [" the implementation"]),
    undefined,
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Review", "Review", [" the implementation"]),
    undefined,
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Review all", "Review", [" the implementation"]),
    undefined,
  );
});

test("prefix reuse filters alternatives while retaining stable origin identities", () => {
  assert.deepEqual(
    reusePromptAutocompleteSuggestions(
      "Review",
      "Review beta",
      [" alpha one", " beta two", " beta three", " gamma four"],
    ),
    {
      suggestions: [" two", " three"],
      origins: [" beta two", " beta three"],
    },
  );
});

test("prefix reuse is Unicode- and grapheme-safe for CJK, emoji, and combining marks", () => {
  assert.deepEqual(
    reusePromptAutocompleteSuggestions("続きを", "続きを確", ["確認して報告"]),
    { suggestions: ["認して報告"], origins: ["確認して報告"] },
  );
  assert.deepEqual(
    reusePromptAutocompleteSuggestions("Use", "Use 👩‍💻", [" 👩‍💻 mode"]),
    { suggestions: [" mode"], origins: [" 👩‍💻 mode"] },
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Cafe", "Cafee", ["e\u0301 noir"]),
    undefined,
    "do not consume only the base code point of a combining grapheme",
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Flag", "Flag 🇩", [" 🇩🇪 locale"]),
    undefined,
    "do not consume half of a regional-indicator pair",
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Use", "Use 👩", [" 👩‍💻 mode"]),
    undefined,
    "do not consume only the first code point of a ZWJ sequence",
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Use 👩", "Use 👩\u200D", ["\u200D💻 mode"]),
    undefined,
    "the grapheme boundary must include the cached-draft seam",
  );
  assert.equal(
    reusePromptAutocompleteSuggestions("Flag 🇦", "Flag 🇦🇧🇨", ["🇧🇨🇩 locale"]),
    undefined,
    "regional-indicator pairing depends on the cached draft",
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

test("partial suggestions advance only across stable word boundaries", () => {
  assert.equal(parsePartialPromptSuggestion("Review", '{"completions":[" the imple'), " the");
  assert.equal(parsePartialPromptSuggestion("Review", '{"completions":[" the implementation care'), " the implementation");
  assert.equal(
    parsePartialPromptSuggestion("Review", '{"completions":[" the implementation carefully"'),
    " the implementation carefully",
  );
  assert.equal(parsePartialPromptSuggestion("Review", '[" the imple'), " the");
  assert.equal(parsePartialPromptSuggestion("Review", '{"suggestions":[" the imple'), " the");
  assert.equal(parsePartialPromptSuggestion("Review", '{"alternatives":[" the imple'), " the");
  assert.equal(parsePartialPromptSuggestion("Review", '{"items":[" the imple'), " the");
});

test("partial suggestions never expose JSON, prose, or unresolved normalization prefixes", () => {
  assert.equal(parsePartialPromptSuggestion("Review", '{"completions":["Rev'), undefined);
  assert.equal(parsePartialPromptSuggestion("Review the", '{"completions":["Review the care'), undefined);
  assert.equal(parsePartialPromptSuggestion("Review", '{"completions":["suggestion: care'), undefined);
  assert.equal(parsePartialPromptSuggestion("Review", '{"completions":["\\\"quoted'), undefined);
  assert.equal(parsePartialPromptSuggestion("Review", '{"unknown":[" raw JSON'), undefined);
  assert.equal(parsePartialPromptSuggestion("Review", "Here is a suggestion"), undefined);
});

test("partial suggestions decode complete escapes but withhold incomplete ones", () => {
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["line\\nnext ch'), "line\nnext");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["safe broken\\'), "safe");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["safe broken\\u12'), "safe");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["safe \\u4F60 next'), "safe 你");
});

test("core loads safely without Intl.Segmenter and disables uncertain partial graphemes", () => {
  const moduleUrl = new URL("../extensions/prompt-autocomplete/core.ts?without-segmenter", import.meta.url).href;
  const script = [
    'Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });',
    `const core = await import(${JSON.stringify(moduleUrl)});`,
    'console.log(core.normalizePromptSuggestion("", "abcdefghijklmnopq", 16));',
    'console.log(String(core.parsePartialPromptSuggestion("", \'{"completions":["続きを確\')));',
    'console.log(JSON.stringify(core.reusePromptAutocompleteSuggestions("Review", "Review the", [" the result"])));',
    'console.log(String(core.reusePromptAutocompleteSuggestions("", "e", ["e\\u0301 noir"])));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    '…\nundefined\n{"suggestions":[" result"],"origins":[" the result"]}\nundefined',
  );
});

test("partial suggestions are grapheme-safe for CJK, combining marks, flags, and ZWJ emoji", () => {
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["続きを確'), "続きを");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["é'), undefined);
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["é n'), "é");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":[" résumé incom'), "résumé");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["🇩🇪 n'), "🇩🇪");
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["👩‍💻 n'), "👩‍💻");
  assert.doesNotMatch(parsePartialPromptSuggestion("", '{"completions":["\\uD83D') ?? "", /�/);
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["abc\\uD83D x'), undefined);
  assert.equal(parsePartialPromptSuggestion("", '{"completions":["abc\\uDC69 x'), undefined);
  assert.equal(
    parsePartialPromptSuggestion("", '{"completions":["\\uD83D\\uDC69\\u200D\\uD83D\\uDCBB n'),
    "👩‍💻",
  );
});

test("partial suggestions strip escaped terminal controls before rendering", () => {
  const partial = parsePartialPromptSuggestion("", '{"completions":["safe \\u001b[2J next');
  assert.equal(partial, "safe [2J");
  assert.doesNotMatch(partial ?? "", /\u001b|\u0008/);
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

test("coalesced request progress reaches subscribers, replays to late joiners, and isolates callbacks", async () => {
  const inFlight = new Map<string, CoalescedRequestEntry<string, string>>();
  const firstProgress: string[] = [];
  const lateProgress: string[] = [];
  let publishProgress: ((progress: string) => void) | undefined;
  let resolveRequest: ((value: string) => void) | undefined;

  const first = acquireCoalescedRequest(
    inFlight,
    "same-key",
    "same-readable-id",
    async (_signal, publish) => {
      publishProgress = publish;
      publish("first");
      return await new Promise<string>((resolve) => {
        resolveRequest = resolve;
      });
    },
    (progress) => firstProgress.push(progress),
  );
  const throwing = acquireCoalescedRequest(
    inFlight,
    "same-key",
    "same-readable-id",
    async () => "unexpected",
    () => {
      throw new Error("subscriber failure");
    },
  );
  const late = acquireCoalescedRequest(
    inFlight,
    "same-key",
    "late",
    async () => "unexpected",
    (progress) => lateProgress.push(progress),
  );

  assert.deepEqual(firstProgress, ["first"]);
  assert.deepEqual(lateProgress, ["first"], "late subscribers receive the latest immutable snapshot");
  assert.equal(first.subscriberCount(), 3, "duplicate readable IDs must still be distinct subscriptions");

  publishProgress?.("live");
  assert.deepEqual(firstProgress, ["first", "live"]);
  assert.deepEqual(lateProgress, ["first", "live"]);

  throwing.release();
  publishProgress?.("second");
  assert.deepEqual(firstProgress, ["first", "live", "second"]);
  assert.deepEqual(lateProgress, ["first", "live", "second"]);

  first.release();
  resolveRequest?.("done");
  assert.equal(await late.promise, "done");
  late.release();
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

test("session stats format reachable metrics and preserve incomplete usage markers", () => {
  const empty = createPromptAutocompleteUsageStats();
  assert.equal(
    formatPromptAutocompleteStats(empty),
    [
      "Prompt Autocomplete — current session",
      "Requests: 0 issued, 0 failed",
      "Cache: 0 hits (0 exact, 0 prefix)",
      "Suggestions: 0 offered, 0 accepted (0 full, 0 word/chunk)",
      "Usage: 0 tokens, estimated cost ~$0",
      "Mean provider latency: n/a",
    ].join("\n"),
  );

  const stats = createPromptAutocompleteUsageStats();
  stats.providerRequests = 3;
  stats.failedRequests = 1;
  stats.cacheHits = 5;
  stats.prefixReuseHits = 3;
  stats.suggestionsOffered = 8;
  stats.fullAccepts = 2;
  stats.chunkAccepts = 1;
  recordProviderUsage(stats, { totalTokens: 120, cost: { total: 0.0006 } });
  recordProviderUsage(stats, { totalTokens: 50 });
  recordProviderLatency(stats, 200);
  recordProviderLatency(stats, 50);
  recordProviderLatency(stats, -1);
  recordProviderLatency(stats, Number.NaN);

  assert.equal(stats.latencySamples, 2);
  assert.equal(stats.totalLatencyMs, 250);
  assert.equal(
    formatPromptAutocompleteStats(stats),
    [
      "Prompt Autocomplete — current session",
      "Requests: 3 issued, 1 failed",
      "Cache: 5 hits (2 exact, 3 prefix)",
      "Suggestions: 8 offered, 3 accepted (2 full, 1 word/chunk)",
      "Usage: 170 tokens+, estimated cost ~$0.00060+",
      "Mean provider latency: 125 ms (2 samples)",
    ].join("\n"),
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

test("hosts that report a mode keep authoritative editor-ownership semantics", () => {
  const slot = { hasUI: true, canInstallEditor: true };

  assert.equal(isInteractiveEditorHost({ mode: "tui", ...slot }), true);
  for (const mode of ["rpc", "json", "print"]) {
    assert.equal(isInteractiveEditorHost({ mode, ...slot }), false, `${mode} must not own the editor`);
  }

  // A reported TUI mode stays authoritative even when hasUI is missing.
  assert.equal(isInteractiveEditorHost({ mode: "tui" }), true);
});

test("forked hosts without a mode fall back to UI availability plus a real editor slot", () => {
  // prime-agent and other forks of an older extension API omit `mode`.
  assert.equal(isInteractiveEditorHost({ hasUI: true, canInstallEditor: true }), true);
  assert.equal(isInteractiveEditorHost({ mode: undefined, hasUI: true, canInstallEditor: true }), true);

  assert.equal(isInteractiveEditorHost({ hasUI: false, canInstallEditor: true }), false);
  assert.equal(isInteractiveEditorHost({ hasUI: true, canInstallEditor: false }), false);
  assert.equal(isInteractiveEditorHost({ canInstallEditor: true }), false);
  assert.equal(isInteractiveEditorHost({}), false);

  // Only an exact boolean true counts; truthy proxies must not unlock the editor.
  assert.equal(isInteractiveEditorHost({ hasUI: 1, canInstallEditor: 1 }), false);
  assert.equal(isInteractiveEditorHost({ hasUI: "yes", canInstallEditor: true }), false);
});

test("non-string mode values fail closed instead of falling back", () => {
  assert.equal(isInteractiveEditorHost({ mode: 1, hasUI: true, canInstallEditor: true }), false);
  assert.equal(isInteractiveEditorHost({ mode: {}, hasUI: true, canInstallEditor: true }), false);
  // Only an omitted mode selects the fork fallback; a cleared field fails closed.
  assert.equal(isInteractiveEditorHost({ mode: null, hasUI: true, canInstallEditor: true }), false);
});

test("streamed responses require the host to expose streamSimple", () => {
  const noop = () => undefined;

  // Pi and prime-agent both expose the complete pair.
  assert.equal(hostSupportsStreamedResponses({ completeSimple: noop, streamSimple: noop }), true);

  // A host that maps only the completion API must use the completion path
  // instead of failing every request.
  assert.equal(hostSupportsStreamedResponses({ completeSimple: noop }), false);
  assert.equal(hostSupportsStreamedResponses({ completeSimple: noop, streamSimple: {} }), false);

  // Outside a host that maps the module at all, capability stays unknown and
  // the injected or lazily resolved implementation decides.
  assert.equal(hostSupportsStreamedResponses({}), true);
  assert.equal(hostSupportsStreamedResponses({ streamSimple: noop }), true);
});

test("terminal sanitization removes complete escape sequences and stray controls", () => {
  // Complete sequences disappear with their payload.
  assert.equal(sanitizeTerminalText("\u001B[31mred\u001B[0m"), "red");
  assert.equal(sanitizeTerminalText("\u001B]8;;https://evil.example\u0007link\u001B]8;;\u0007"), "link");
  assert.equal(sanitizeTerminalText("\u001B]52;c;cGF5bG9hZA==\u0007copy"), "copy");
  assert.equal(sanitizeTerminalText("\u001BPq#0;2;0;0;0\u001B\\dcs"), "dcs");

  // Bare introducers and other controls cannot survive either.
  assert.equal(sanitizeTerminalText("a\u001Bb"), "ab");
  assert.equal(sanitizeTerminalText("a\u009Bb"), "ab");
  assert.equal(sanitizeTerminalText("a\u0007b\u0000c\u007Fd"), "abcd");
  assert.equal(sanitizeTerminalText("first\rsecond"), "firstsecond");

  // Structure that legitimate multiline output relies on stays intact.
  assert.equal(sanitizeTerminalText("line\n\tindented"), "line\n\tindented");
  assert.equal(sanitizeTerminalText("plain diagnostic"), "plain diagnostic");

  // Malformed UTF-16 is repaired instead of being passed through.
  const repaired = sanitizeTerminalText("ok\uD800");
  assert.equal(repaired.includes("\uD800"), false);
  assert.ok(repaired.startsWith("ok"));
  assert.equal(sanitizeTerminalText("👍 done"), "👍 done");
});

test("an explicit autocomplete model stays distinguishable from the active model", () => {
  assert.deepEqual(parsePromptAutocompleteModelSelection(undefined), { kind: "active" });
  assert.deepEqual(parsePromptAutocompleteModelSelection(true), { kind: "active" });
  assert.deepEqual(parsePromptAutocompleteModelSelection("   "), { kind: "active" });
  // The flag ships this sentinel as its default.
  assert.deepEqual(parsePromptAutocompleteModelSelection(DEFAULT_PREFERRED_MODEL), { kind: "active" });
  assert.deepEqual(parsePromptAutocompleteModelSelection("Active"), { kind: "active" });

  assert.deepEqual(parsePromptAutocompleteModelSelection(" openai/GPT-5.4-Mini "), {
    kind: "dedicated",
    ref: { provider: "openai", id: "GPT-5.4-Mini" },
    raw: "openai/GPT-5.4-Mini",
  });

  // A malformed explicit value must not collapse into "no dedicated model".
  assert.deepEqual(parsePromptAutocompleteModelSelection("malformed"), {
    kind: "invalid",
    raw: "malformed",
  });
  assert.deepEqual(parsePromptAutocompleteModelSelection("/missing-provider"), {
    kind: "invalid",
    raw: "/missing-provider",
  });
});

test("a long malformed model value keeps its rejection marker", () => {
  const described = describePromptAutocompleteModelSelection({
    kind: "invalid",
    raw: "z".repeat(200),
  });

  assert.ok(described.endsWith("… (invalid)"), described.slice(-20));
  assert.ok(described.length < 100, `description is ${described.length} chars`);

  // The cut must not split an astral character.
  const astral = describePromptAutocompleteModelSelection({
    kind: "invalid",
    raw: "😀".repeat(100),
  });
  assert.equal(astral.isWellFormed(), true);
  assert.ok(astral.endsWith("… (invalid)"));

  // A value made only of invisible characters still has to be recognizable.
  assert.equal(
    describePromptAutocompleteModelSelection({ kind: "invalid", raw: "\u200B\u202E" }),
    "<unprintable> (invalid)",
  );
});

test("model selection descriptions are terminal-safe and mark invalid values", () => {
  assert.equal(describePromptAutocompleteModelSelection({ kind: "active" }), "current active model");
  assert.equal(
    describePromptAutocompleteModelSelection({
      kind: "dedicated",
      ref: { provider: "openai", id: "GPT-5.4-Mini" },
      raw: "openai/GPT-5.4-Mini",
    }),
    "openai/GPT-5.4-Mini",
  );
  assert.equal(
    describePromptAutocompleteModelSelection({ kind: "invalid", raw: "\u001B[31mbad\u001B[0m" }),
    "bad (invalid)",
  );
});

test("string control sequences are removed in both C1 and escaped form", () => {
  for (const opener of ["\u0090", "\u0098", "\u009D", "\u009E", "\u009F"]) {
    assert.equal(sanitizeTerminalText(`before${opener}payload\u009Cafter`), "beforeafter");
  }
  for (const opener of ["\u001BP", "\u001BX", "\u001B^", "\u001B_"]) {
    assert.equal(sanitizeTerminalText(`before${opener}payload\u001B\\after`), "beforeafter");
    assert.equal(sanitizeTerminalText(`before${opener}payload\u0007after`), "beforeafter");
  }

  // A terminal consumes an unterminated introducer to the end of the stream, so
  // the remainder is dropped here as well instead of becoming visible text.
  assert.equal(sanitizeTerminalText("kept\u001B_dropped tail"), "kept");
  assert.equal(sanitizeTerminalText("kept\u0090dropped tail"), "kept");

  // The discard stops at a line break: a bare C1 introducer is also what a
  // mis-decoded UTF-8 quote looks like, and the rest of a provider message must
  // not disappear because of mojibake.
  assert.equal(
    sanitizeTerminalText("rate limit for \u009Dgpt-4\nretry in 30s"),
    "rate limit for \nretry in 30s",
  );
  assert.equal(sanitizeTerminalText("keep\u001B_payload\ntail"), "keep\ntail");

  // The text that becomes visible again is still scrubbed, and deleting a
  // sequence must not let its neighbours re-form one.
  assert.equal(sanitizeTerminalText("a\u001B_payload\ntail\u001B[2Jx"), "a\ntailx");
  assert.equal(sanitizeTerminalText("\u001B\u009Dzap\u0007[2J"), "");
});

test("sanitization stays linear on hostile input", () => {
  // A lazy regex body backtracks quadratically on repeated unterminated
  // introducers; provider error text is not length-bounded.
  const hostile = "\u001B_".repeat(100_000);
  const started = process.hrtime.bigint();
  const sanitized = sanitizeTerminalText(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(sanitized, "");
  assert.ok(elapsedMs < 500, `sanitizing 200KB of introducers took ${elapsedMs.toFixed(1)}ms`);
});

test("text that would misrepresent itself is removed", () => {
  // A bidi override could make a rejected model identifier display as another.
  assert.equal(sanitizeTerminalText("safe \u202Elaever ton"), "safe laever ton");
  assert.equal(sanitizeTerminalText("open\u202Eai/x"), "openai/x");
  assert.equal(sanitizeTerminalText("open\u061Cai/x"), "openai/x");
  assert.equal(sanitizeTerminalText("a\u200Bb\u2066c\u2069d\uFEFFe"), "abcde");
  assert.equal(sanitizeTerminalText("x\u2061y\u180Ez"), "xyz");
  // Tag characters are invisible and the usual text-smuggling vector.
  assert.equal(sanitizeTerminalText("safe\u{E0064}\u{E0065}/model"), "safe/model");
  // Matching the Unicode properties instead of a list also covers soft hyphens,
  // Hangul fillers, annotation marks, and the rest of plane 14.
  assert.equal(sanitizeTerminalText("open\u00ADai/x"), "openai/x");
  assert.equal(
    sanitizeTerminalText("a\u034Fb\u2065c\u206Ad\uFFF9e\u115Ff\u{E0080}g"),
    "abcdefg",
  );

  // Separators become line breaks so multi-line errors stay readable.
  assert.equal(sanitizeTerminalText("first line\u2028second line"), "first line\nsecond line");

  // Joiners carry meaning in several scripts and in emoji sequences.
  assert.equal(sanitizeTerminalText("\u0645\u06CC\u200C\u062E"), "\u0645\u06CC\u200C\u062E");
  assert.equal(sanitizeTerminalText("👨\u200D👩"), "👨\u200D👩");
});

test("persisted settings parsing degrades malformed input to no decision", () => {
  assert.deepEqual(parsePromptAutocompletePersistedSettings(undefined), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings(""), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings("not json"), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings("[true]"), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings("null"), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"enabled":"yes"}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"enabled":true}'), { enabled: true });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"enabled":false,"extra":1}'), { enabled: false });
});

test("persisted settings serialization round-trips and drops unknown fields", () => {
  const serialized = serializePromptAutocompletePersistedSettings({ enabled: true });
  assert.deepEqual(parsePromptAutocompletePersistedSettings(serialized), { enabled: true });
  assert.ok(serialized.endsWith("\n"));

  const empty = serializePromptAutocompletePersistedSettings({});
  assert.deepEqual(parsePromptAutocompletePersistedSettings(empty), {});
});

test("enabled resolution ranks session over flag over saved over default", () => {
  assert.deepEqual(resolvePersistedEnabled(undefined, false, undefined), { enabled: false, source: "flag" });
  assert.deepEqual(resolvePersistedEnabled(undefined, false, true), { enabled: true, source: "saved" });
  assert.deepEqual(resolvePersistedEnabled(undefined, false, false), { enabled: false, source: "saved" });
  assert.deepEqual(resolvePersistedEnabled(undefined, true, false), { enabled: true, source: "flag" });
  assert.deepEqual(resolvePersistedEnabled(false, true, true), { enabled: false, source: "session" });
  assert.deepEqual(resolvePersistedEnabled(true, false, false), { enabled: true, source: "session" });
});

test("persisted min-chars parsing accepts only bounded integers", () => {
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"minPromptChars":0}'), { minPromptChars: 0 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"minPromptChars":500}'), { minPromptChars: 500 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"minPromptChars":501}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"minPromptChars":-1}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"minPromptChars":1.5}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"minPromptChars":"0"}'), {});
  assert.deepEqual(
    parsePromptAutocompletePersistedSettings('{"enabled":true,"minPromptChars":2}'),
    { enabled: true, minPromptChars: 2 },
  );
  const roundTrip = serializePromptAutocompletePersistedSettings({ enabled: true, minPromptChars: 0 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings(roundTrip), { enabled: true, minPromptChars: 0 });
});

test("numeric resolution ranks session over explicit flag over saved over default", () => {
  assert.deepEqual(resolvePersistedNumber(undefined, undefined, undefined, 1), { value: 1, source: "flag" });
  assert.deepEqual(resolvePersistedNumber(undefined, undefined, 0, 1), { value: 0, source: "saved" });
  assert.deepEqual(resolvePersistedNumber(undefined, 3, 0, 1), { value: 3, source: "flag" });
  assert.deepEqual(resolvePersistedNumber(2, 3, 0, 1), { value: 2, source: "session" });
});

test("explicit bounded int flag parsing treats default and invalid input as unset", () => {
  assert.equal(parseExplicitBoundedIntFlag(undefined, 1, 0, 500), undefined);
  assert.equal(parseExplicitBoundedIntFlag("1", 1, 0, 500), undefined);
  assert.equal(parseExplicitBoundedIntFlag("abc", 1, 0, 500), undefined);
  assert.equal(parseExplicitBoundedIntFlag("0", 1, 0, 500), 0);
  assert.equal(parseExplicitBoundedIntFlag("750", 1, 0, 500), 500);
});

test("slash-command integers reject malformed and out-of-range values instead of clamping", () => {
  assert.equal(parseStrictBoundedInt("0", DEBOUNCE_MS_MIN, DEBOUNCE_MS_MAX), 0);
  assert.equal(parseStrictBoundedInt("5000", DEBOUNCE_MS_MIN, DEBOUNCE_MS_MAX), 5_000);
  assert.equal(parseStrictBoundedInt("16", MAX_SUGGESTION_CHARS_MIN, MAX_SUGGESTION_CHARS_MAX), 16);
  assert.equal(parseStrictBoundedInt("5", MAX_ALTERNATIVES_MIN, MAX_ALTERNATIVES_MAX), 5);
  assert.equal(parseStrictBoundedInt(undefined, 0, 5), undefined);
  assert.equal(parseStrictBoundedInt("", 0, 5), undefined);
  assert.equal(parseStrictBoundedInt("abc", 0, 5), undefined);
  assert.equal(parseStrictBoundedInt("1.5", 0, 5), undefined);
  assert.equal(parseStrictBoundedInt("08", 0, 5000), undefined);
  assert.equal(parseStrictBoundedInt("5001", DEBOUNCE_MS_MIN, DEBOUNCE_MS_MAX), undefined);
  assert.equal(parseStrictBoundedInt("15", MAX_SUGGESTION_CHARS_MIN, MAX_SUGGESTION_CHARS_MAX), undefined);
  assert.equal(parseStrictBoundedInt("6", MAX_ALTERNATIVES_MIN, MAX_ALTERNATIVES_MAX), undefined);
});

test("persisted runtime knobs accept only bounded integers and valid model sentinels", () => {
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"debounceMs":0}'), { debounceMs: 0 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"debounceMs":5000}'), { debounceMs: 5_000 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"debounceMs":5001}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"maxSuggestionChars":16}'), { maxSuggestionChars: 16 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"maxSuggestionChars":15}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"maxAlternatives":5}'), { maxAlternatives: 5 });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"maxAlternatives":6}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"model":"active"}'), { model: "active" });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"model":" openai/GPT-5.4-Mini "}'), {
    model: "openai/GPT-5.4-Mini",
  });
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"model":"malformed"}'), {});
  assert.deepEqual(parsePromptAutocompletePersistedSettings('{"model":""}'), {});

  const roundTrip = serializePromptAutocompletePersistedSettings({
    enabled: true,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxSuggestionChars: DEFAULT_MAX_SUGGESTION_CHARS,
    maxAlternatives: DEFAULT_MAX_ALTERNATIVES,
    model: "openai/GPT-5.4-Mini",
  });
  assert.deepEqual(parsePromptAutocompletePersistedSettings(roundTrip), {
    enabled: true,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxSuggestionChars: DEFAULT_MAX_SUGGESTION_CHARS,
    maxAlternatives: DEFAULT_MAX_ALTERNATIVES,
    model: "openai/GPT-5.4-Mini",
  });
});

test("explicit model flags keep active as a sentinel and preserve mixed-case dedicated ids", () => {
  assert.equal(parseExplicitModelFlag(undefined), undefined);
  assert.equal(parseExplicitModelFlag(DEFAULT_PREFERRED_MODEL), undefined);
  assert.deepEqual(parseExplicitModelFlag("active"), { kind: "active" });
  assert.deepEqual(parseExplicitModelFlag("Active"), { kind: "active" });
  assert.deepEqual(parseExplicitModelFlag(" openai/GPT-5.4-Mini "), {
    kind: "dedicated",
    ref: { provider: "openai", id: "GPT-5.4-Mini" },
    raw: "openai/GPT-5.4-Mini",
  });
  assert.deepEqual(parseExplicitModelFlag("malformed"), { kind: "invalid", raw: "malformed" });

  assert.equal(persistableModelRaw({ kind: "active" }), "active");
  assert.equal(
    persistableModelRaw({ kind: "dedicated", ref: { provider: "openai", id: "GPT-5.4-Mini" }, raw: "openai/GPT-5.4-Mini" }),
    "openai/GPT-5.4-Mini",
  );
  assert.equal(persistableModelRaw({ kind: "invalid", raw: "nope" }), undefined);
  assert.deepEqual(parsePersistedModelRaw("active"), { kind: "active" });
  assert.equal(parsePersistedModelRaw(""), undefined);
  assert.equal(parsePersistedModelRaw("   "), undefined);
  assert.equal(parsePersistedModelRaw("malformed"), undefined);
});

test("model selection resolution ranks session over explicit flag over saved over default", () => {
  const dedicated = parsePromptAutocompleteModelSelection("openai/GPT-5.4-Mini");
  const saved = parsePromptAutocompleteModelSelection("anthropic/claude");
  assert.deepEqual(resolvePersistedModelSelection(undefined, undefined, undefined), {
    selection: { kind: "active" },
    source: "flag",
  });
  assert.deepEqual(resolvePersistedModelSelection(undefined, undefined, saved), {
    selection: saved,
    source: "saved",
  });
  assert.deepEqual(resolvePersistedModelSelection(undefined, dedicated, saved), {
    selection: dedicated,
    source: "flag",
  });
  assert.deepEqual(resolvePersistedModelSelection({ kind: "active" }, dedicated, saved), {
    selection: { kind: "active" },
    source: "session",
  });
});

test("prompt-autocomplete set persists remaining knobs through the settings store", () => {
  const source = readFileSync(new URL("../extensions/prompt-autocomplete/index.ts", import.meta.url), "utf8");
  assert.match(source, /handleSetCommand/);
  assert.match(source, /cancelScheduledRequest/);
  assert.match(source, /affectsRequestIdentity/);
  assert.doesNotMatch(source, /coalescedJoins/);
});

test("budget flags clamp while interactive budget values are rejected", () => {
  assert.equal(parsePromptAutocompleteBudgetFlag(undefined), undefined);
  assert.equal(parsePromptAutocompleteBudgetFlag("off"), undefined);
  assert.equal(parsePromptAutocompleteBudgetFlag("OFF"), undefined);
  assert.equal(parsePromptAutocompleteBudgetFlag(""), undefined);
  assert.equal(parsePromptAutocompleteBudgetFlag("nonsense"), undefined);
  assert.equal(parsePromptAutocompleteBudgetFlag("3"), 3);
  assert.equal(parsePromptAutocompleteBudgetFlag("0"), BUDGET_REQUESTS_MIN);
  assert.equal(parsePromptAutocompleteBudgetFlag("999999999"), BUDGET_REQUESTS_MAX);

  assert.deepEqual(parsePromptAutocompleteBudgetValue(undefined), { kind: "unset" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("  "), { kind: "unset" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("off"), { kind: "off" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("Off"), { kind: "off" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("3"), { kind: "limit", value: 3 });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("0"), { kind: "invalid" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("-1"), { kind: "invalid" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("1.5"), { kind: "invalid" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue("1e3"), { kind: "invalid" });
  assert.deepEqual(parsePromptAutocompleteBudgetValue(String(BUDGET_REQUESTS_MAX + 1)), { kind: "invalid" });
});

test("budget snapshots round-trip and reject foreign or malformed state", () => {
  const snapshot = buildPromptAutocompleteBudgetSnapshot(3, 2, "session-1");
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    physicalSessionId: "session-1",
    limit: 3,
    used: 2,
  });
  assert.deepEqual(parsePromptAutocompleteBudgetSnapshot(snapshot, "session-1"), { limit: 3, used: 2 });
  assert.equal(parsePromptAutocompleteBudgetSnapshot(snapshot, "session-2"), undefined);

  // An explicit off stays a real restored decision, not an absent one.
  const offSnapshot = buildPromptAutocompleteBudgetSnapshot("off", 4, "session-1");
  assert.equal(offSnapshot.limit, "off");
  assert.deepEqual(parsePromptAutocompleteBudgetSnapshot(offSnapshot, "session-1"), {
    limit: "off",
    used: 4,
  });

  assert.equal(parsePromptAutocompleteBudgetSnapshot(undefined, "session-1"), undefined);
  assert.equal(parsePromptAutocompleteBudgetSnapshot({ ...snapshot, schemaVersion: 2 }, "session-1"), undefined);
  assert.equal(parsePromptAutocompleteBudgetSnapshot({ ...snapshot, used: -1 }, "session-1"), undefined);
  assert.equal(parsePromptAutocompleteBudgetSnapshot({ ...snapshot, used: 1.5 }, "session-1"), undefined);
  assert.equal(parsePromptAutocompleteBudgetSnapshot({ ...snapshot, limit: 0 }, "session-1"), undefined);
  assert.equal(parsePromptAutocompleteBudgetSnapshot({ ...snapshot, limit: "nope" }, "session-1"), undefined);
});

test("budget restoration scans the whole session and never lets usage go backwards", () => {
  const entry = (physicalSessionId: string, used: number, limit: number | "off" = 3) => ({
    type: "custom",
    customType: PROMPT_AUTOCOMPLETE_BUDGET_ENTRY_TYPE,
    data: { schemaVersion: 1, physicalSessionId, limit, used },
  });

  const branch = [
    { type: "message", id: "m1" },
    entry("session-1", 1),
    entry("session-1", 2),
    { type: "custom", customType: "unrelated", data: { used: 99 } },
    entry("session-2", 7),
  ];

  assert.deepEqual(findPromptAutocompleteBudgetSnapshot(branch, "session-1"), { limit: 3, used: 2 });
  assert.deepEqual(findPromptAutocompleteBudgetSnapshot(branch, "session-2"), { limit: 3, used: 7 });
  assert.equal(findPromptAutocompleteBudgetSnapshot(branch, "session-3"), undefined);
  assert.equal(findPromptAutocompleteBudgetSnapshot([], "session-1"), undefined);

  // A snapshot from an abandoned branch still counts: the request was paid for.
  assert.deepEqual(
    findPromptAutocompleteBudgetSnapshot(
      [entry("session-1", 5), entry("session-1", 2)],
      "session-1",
    ),
    { limit: 3, used: 5 },
  );

  // The ceiling follows the last recorded decision, including an explicit off.
  assert.deepEqual(
    findPromptAutocompleteBudgetSnapshot(
      [entry("session-1", 2, 3), entry("session-1", 2, "off")],
      "session-1",
    ),
    { limit: "off", used: 2 },
  );
});

test("budget resolution ranks session over flag over restored value", () => {
  assert.deepEqual(resolvePromptAutocompleteBudgetLimit(undefined, undefined, undefined), {
    limit: undefined,
    source: "flag",
  });
  assert.deepEqual(resolvePromptAutocompleteBudgetLimit(undefined, undefined, 4), { limit: 4, source: "saved" });
  assert.deepEqual(resolvePromptAutocompleteBudgetLimit(undefined, 2, 4), { limit: 2, source: "flag" });
  assert.deepEqual(resolvePromptAutocompleteBudgetLimit(9, 2, 4), { limit: 9, source: "session" });
  // An explicit "off" is a decision, not an absent override.
  assert.deepEqual(resolvePromptAutocompleteBudgetLimit("off", 2, 4), { limit: undefined, source: "session" });
  // A restored "off" keeps its attribution instead of looking like no decision.
  assert.deepEqual(resolvePromptAutocompleteBudgetLimit(undefined, undefined, "off"), {
    limit: undefined,
    source: "saved",
  });
});
