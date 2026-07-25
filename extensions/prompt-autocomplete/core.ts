import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";

const TEMPLATE_VARIABLE_PATTERN = /(?<!\\)\{\{\s*([A-Z0-9_]+)\s*(?:\|\s*([\s\S]*?))?\s*\}\}/g;
const ESCAPED_TEMPLATE_VARIABLE_PATTERN = /\\(\{\{\s*[A-Z0-9_]+\s*(?:\|\s*[\s\S]*?)?\s*\}\})/g;
const PROMPT_AUTOCOMPLETE_RESPONSE_KEY = "completions";

export function normalizeTemplateText(template: string): string {
  return template.replace(/\r\n/g, "\n").trim();
}

export function renderMiniTemplate(template: string, variables: Record<string, string>): string {
  const missingVariables = new Set<string>();

  const rendered = template.replace(
    TEMPLATE_VARIABLE_PATTERN,
    (_match, rawName: string, rawFallback: string | undefined) => {
      const name = String(rawName);
      const value = variables[name];
      if (typeof value === "string") {
        return value;
      }

      if (typeof rawFallback === "string") {
        return rawFallback.trim();
      }

      missingVariables.add(name);
      return `{{${name}}}`;
    },
  );

  if (missingVariables.size > 0) {
    throw new Error(`Missing template variable(s): ${[...missingVariables].sort().join(", ")}`);
  }

  return rendered.replace(ESCAPED_TEMPLATE_VARIABLE_PATTERN, "$1");
}

export const PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT_TEMPLATE_VARIABLES = {
  RESPONSE_KEY: PROMPT_AUTOCOMPLETE_RESPONSE_KEY,
  RESPONSE_EXAMPLE: JSON.stringify({ [PROMPT_AUTOCOMPLETE_RESPONSE_KEY]: ["suggestion 1", "suggestion 2"] }),
  EMPTY_RESPONSE_EXAMPLE: JSON.stringify({ [PROMPT_AUTOCOMPLETE_RESPONSE_KEY]: [] }),
} as const;

export const PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT = renderMiniTemplate(
  normalizeTemplateText(
    readFileSync(
      new URL("./system-prompt.template.md", import.meta.url),
      "utf8",
    ),
  ),
  PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT_TEMPLATE_VARIABLES,
);

export const DEFAULT_PREFERRED_MODEL = "current active model";
export const DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED = false;
export const DEFAULT_DEBOUNCE_MS = 350;
export const DEFAULT_MIN_PROMPT_CHARS = 1;
export const DEFAULT_MAX_SUGGESTION_CHARS = 160;
export const DEFAULT_MAX_ALTERNATIVES = 3;
export const MAX_DRAFT_CONTEXT_CHARS = 2_000;
export const MAX_CONTEXT_MESSAGES = 6;
export const MAX_CONTEXT_MESSAGE_CHARS = 600;
export const MAX_LATEST_ASSISTANT_MESSAGE_CHARS = 3_000;
export const MAX_LATEST_USER_MESSAGE_CHARS = 1_200;
// Scale the completion budget with the requested alternatives so a JSON array of
// several short suggestions cannot be truncated mid-string (which would break parsing).
export const MIN_REQUEST_MAX_TOKENS = 192;
export const MAX_REQUEST_MAX_TOKENS = 1_024;

export interface ModelRef {
  provider: string;
  id: string;
}

export interface PromptAutocompleteCacheIdentity {
  leafId: string;
  modelLabel: string;
  maxAlternatives: number;
  maxSuggestionChars: number;
  draft: string;
  latestAssistantContext: string;
  latestUserContext: string;
  recentContext: string;
}

export function buildPromptAutocompleteCacheKey(identity: PromptAutocompleteCacheIdentity): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  return `${identity.modelLabel}|${digest}`;
}

export class ExpiringLruCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(ttlMs: number, maxEntries: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  get(key: string, options: { bypass?: boolean } = {}): T | undefined {
    if (options.bypass) return undefined;

    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.prune();
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

export class SequenceOwnedSlot<T extends { seq: number }> {
  private value?: T;

  get current(): T | undefined {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
  }

  clearIfOwned(seq: number): boolean {
    if (this.value?.seq !== seq) return false;
    this.value = undefined;
    return true;
  }

  take(): T | undefined {
    const value = this.value;
    this.value = undefined;
    return value;
  }
}

export interface CoalescedRequestEntry<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: Set<string>;
  settled: boolean;
}

export interface CoalescedRequestSubscription<T> {
  promise: Promise<T>;
  created: boolean;
  release: () => void;
  subscriberCount: () => number;
}

export interface OwnerRefCounter {
  activate: (owner: string) => boolean;
  deactivate: (owner: string) => boolean;
  clear: () => boolean;
  has: (owner: string) => boolean;
  size: () => number;
}

export function createOwnerRefCounter(): OwnerRefCounter {
  const owners = new Set<string>();

  return {
    activate: (owner) => {
      const wasEmpty = owners.size === 0;
      owners.add(owner);
      return wasEmpty && owners.size > 0;
    },
    deactivate: (owner) => {
      const deleted = owners.delete(owner);
      return deleted && owners.size === 0;
    },
    clear: () => {
      const hadOwners = owners.size > 0;
      owners.clear();
      return hadOwners;
    },
    has: (owner) => owners.has(owner),
    size: () => owners.size,
  };
}

export function acquireCoalescedRequest<T>(
  inFlightRequests: Map<string, CoalescedRequestEntry<T>>,
  key: string,
  subscriberId: string,
  start: (signal: AbortSignal) => Promise<T>,
): CoalescedRequestSubscription<T> {
  let entry = inFlightRequests.get(key);
  let created = false;

  if (!entry) {
    const controller = new AbortController();
    const subscribers = new Set<string>();
    let runStart: () => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      runStart = () => {
        try {
          Promise.resolve(start(controller.signal)).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      };
    });
    let entryForFinally: CoalescedRequestEntry<T> | undefined;
    const settledPromise = promise.finally(() => {
      if (!entryForFinally) return;
      entryForFinally.settled = true;
      if (inFlightRequests.get(key) === entryForFinally) {
        inFlightRequests.delete(key);
      }
    });
    const nextEntry: CoalescedRequestEntry<T> = {
      controller,
      subscribers,
      settled: false,
      promise: settledPromise,
    };
    entryForFinally = nextEntry;

    entry = nextEntry;
    inFlightRequests.set(key, entry);
    created = true;
    // Start only after the entry is visible in the map, so synchronous start
    // failures still settle through the shared promise and clean up the map.
    runStart();
  }

  entry.subscribers.add(subscriberId);
  let released = false;

  return {
    promise: entry.promise,
    created,
    subscriberCount: () => entry.subscribers.size,
    release: () => {
      // Idempotent because callers may release during cancellation and again in
      // their async finally block after the shared promise settles.
      if (released) return;
      released = true;

      const current = inFlightRequests.get(key);
      if (current !== entry) return;

      current.subscribers.delete(subscriberId);
      if (current.subscribers.size === 0 && !current.settled) {
        current.controller.abort();
        inFlightRequests.delete(key);
      }
    },
  };
}

export function cancelAllCoalescedRequests<T>(inFlightRequests: Map<string, CoalescedRequestEntry<T>>): void {
  for (const entry of inFlightRequests.values()) {
    if (!entry.settled) {
      entry.controller.abort();
    }
  }
  inFlightRequests.clear();
}

/**
 * Session-scoped autocomplete accounting.
 *
 * Counters are deliberately in-memory and per-session: they exist so a user can
 * answer "what did autocomplete cost me", not to build a usage history.
 *
 * Token counts come from the provider. The cost figure does not: pi derives it
 * locally by multiplying those tokens with its own model price table
 * (`calculateCost` in @earendil-works/pi-ai), so it is an estimate that can
 * disagree with an actual invoice. Naming reflects that.
 */
export interface PromptAutocompleteUsageStats {
  /** Provider calls actually issued, including calls that later failed. */
  providerRequests: number;
  /** Issued calls that produced no usable suggestions because of an error or abort. */
  failedRequests: number;
  /** Requests served from the local cache without contacting a provider. */
  cacheHits: number;
  /** Responses that carried token counts. Totals are partial when this is below providerRequests. */
  tokenReports: number;
  /** Responses that carried a cost figure. */
  costReports: number;
  totalTokens: number;
  /** Locally estimated cost, summed from pi's model price table. */
  estimatedCost: number;
}

/** Shape of the usage report this module consumes. Every field is optional at runtime. */
export interface ProviderUsageReport {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export function createPromptAutocompleteUsageStats(): PromptAutocompleteUsageStats {
  return {
    providerRequests: 0,
    failedRequests: 0,
    cacheHits: 0,
    tokenReports: 0,
    costReports: 0,
    totalTokens: 0,
    estimatedCost: 0,
  };
}

interface NumericField {
  /** Whether the field carried a usable number. Zero counts; malformed does not. */
  present: boolean;
  value: number;
}

const MISSING_FIELD: NumericField = { present: false, value: 0 };

/**
 * Read one numeric field exactly once, without trusting the object.
 *
 * The usage object is plain data in practice, but a throwing getter must not be
 * able to turn accounting into a failed suggestion, and a side-effecting getter
 * must not be able to report one value to the total and another to the
 * completeness check. Zero is a legitimate report; negative and non-finite
 * values are malformed and count as missing.
 */
function readNumericField(source: Record<string, unknown> | undefined, key: string): NumericField {
  if (!source) return MISSING_FIELD;

  let value: unknown;
  try {
    value = source[key];
  } catch {
    return MISSING_FIELD;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return MISSING_FIELD;
  return { present: true, value };
}

function readCostRecord(usage: Record<string, unknown>): Record<string, unknown> | undefined {
  let cost: unknown;
  try {
    cost = usage.cost;
  } catch {
    return undefined;
  }

  return typeof cost === "object" && cost !== null ? (cost as Record<string, unknown>) : undefined;
}

/**
 * Fold one usage report into the session totals.
 *
 * Providers disagree about which fields they populate, so each field is
 * optional. Token and cost reports are counted separately because a response
 * can carry tokens without a cost figure. An explicit total wins over the
 * component fields; otherwise the components are summed, including cached
 * tokens, which are billed as well.
 */
export function recordProviderUsage(stats: PromptAutocompleteUsageStats, usage: unknown): void {
  if (typeof usage !== "object" || usage === null) return;

  const report = usage as Record<string, unknown>;
  const costRecord = readCostRecord(report);

  const reportedTotal = readNumericField(report, "totalTokens");
  const components = [
    readNumericField(report, "input"),
    readNumericField(report, "output"),
    readNumericField(report, "cacheRead"),
    readNumericField(report, "cacheWrite"),
  ];
  const cost = readNumericField(costRecord, "total");

  const hasTokenReport = reportedTotal.present || components.some((field) => field.present);
  if (!hasTokenReport && !cost.present) return;

  if (hasTokenReport) stats.tokenReports += 1;
  if (cost.present) stats.costReports += 1;

  stats.totalTokens += reportedTotal.present
    ? reportedTotal.value
    : components.reduce((sum, field) => sum + field.value, 0);
  stats.estimatedCost += cost.value;
}

function formatEstimatedCost(cost: number): string {
  if (cost <= 0) return "$0";
  // Autocomplete requests are cheap; a real cost must never render as $0.
  if (cost < 0.00001) return "<$0.00001";
  return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`;
}

/**
 * Render session accounting for the status line.
 *
 * Cost is labelled as an estimate because pi derives it from a local price
 * table rather than from the provider. Totals are marked partial when some
 * responses reported nothing, so silence is never shown as a cheaper request.
 */
export function formatUsageStats(stats: PromptAutocompleteUsageStats): string {
  const segments = [`${stats.providerRequests} req`, `${stats.cacheHits} cached`];

  if (stats.failedRequests > 0) {
    segments.push(`${stats.failedRequests} failed`);
  }

  const tokensPartial = stats.tokenReports < stats.providerRequests;
  const costPartial = stats.costReports < stats.providerRequests;
  segments.push(`${stats.totalTokens} tok${tokensPartial ? "+" : ""}`);
  segments.push(`~${formatEstimatedCost(stats.estimatedCost)} est${costPartial ? "+" : ""}`);

  return segments.join(", ");
}

/**
 * Runtime overrides set by slash commands.
 *
 * These outrank CLI flags for the lifetime of the process. An unset field means
 * "defer to the flag", which is what lets a new session pick up a changed flag
 * while still honouring an explicit in-session decision.
 */
export interface PromptAutocompleteRuntimeOverrides {
  enabled?: boolean;
  allowWhileStreaming?: boolean;
  debug?: boolean;
}

export type PromptAutocompleteSettingSource = "flag" | "session";

export function resolveOverride<T>(override: T | undefined, flagValue: T): T {
  return override ?? flagValue;
}

export function describeSettingSource(override: unknown): PromptAutocompleteSettingSource {
  return override === undefined ? "flag" : "session";
}

interface SuggestionPayload {
  completions?: unknown;
  suggestions?: unknown;
  alternatives?: unknown;
  items?: unknown;
  completion?: unknown;
  suggestion?: unknown;
  text?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimAndCollapse(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function truncateWithForcedEllipsis(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 5) return truncateWithEllipsis(text, maxChars);

  const separator = "\n…\n";
  const remaining = maxChars - separator.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${separator}${text.slice(-tail)}`;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return text;
  }

  const withoutOpening = trimmed.replace(/^```[^\n]*\n?/, "");
  return withoutOpening.replace(/\n?```\s*$/, "");
}

function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return text;

  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ];

  for (const [start, end] of pairs) {
    if (trimmed.startsWith(start) && trimmed.endsWith(end)) {
      return trimmed.slice(1, -1);
    }
  }

  return text;
}

function stripRepeatedDraftPrefix(draft: string, suggestion: string): string {
  if (!draft) return suggestion;

  if (suggestion.startsWith(draft)) {
    return suggestion.slice(draft.length);
  }

  const horizontallyTrimmedSuggestion = suggestion.replace(/^[ \t]+/, "");
  if (horizontallyTrimmedSuggestion.startsWith(draft)) {
    return horizontallyTrimmedSuggestion.slice(draft.length);
  }

  return suggestion;
}

function getTrailingWordFragment(text: string): string {
  return /([\p{L}\p{M}\p{N}_]+)$/u.exec(text)?.[1] ?? "";
}

function startsWithCaseInsensitivePrefix(text: string, prefix: string): boolean {
  if (text.length < prefix.length) return false;
  return text.slice(0, prefix.length).toLocaleLowerCase() === prefix.toLocaleLowerCase();
}

function stripRepeatedCurrentWordPrefix(draft: string, suggestion: string): string {
  const currentWord = getTrailingWordFragment(draft);
  if (!currentWord) return suggestion;

  // If the model returns the expanded current word instead of only the suffix
  // (e.g. draft "Schrei" -> suggestion "Schreibe ..."), keep only the text
  // that is still missing at the cursor. This prevents accepting the suggestion
  // from duplicating or separating the partially typed word.
  const horizontallyTrimmedSuggestion = suggestion.replace(/^[ \t]+/, "");
  if (startsWithCaseInsensitivePrefix(horizontallyTrimmedSuggestion, currentWord)) {
    return horizontallyTrimmedSuggestion.slice(currentWord.length);
  }

  return suggestion;
}

function normalizeLeadingBoundarySpacing(draft: string, suggestion: string): string {
  if (!suggestion) return suggestion;

  const lastChar = draft.slice(-1);
  if (!lastChar) return suggestion.replace(/^[ \t]+/, "");

  // If the draft already ends with a horizontal whitespace, do not keep another
  // leading horizontal whitespace from the suggestion.
  if (/[ \t]/.test(lastChar)) {
    return suggestion.replace(/^[ \t]+/, "");
  }

  // If the model starts with multiple spaces/tabs even though the draft does not
  // end with whitespace, collapse them to a single separating space.
  if (/^[ \t]+/.test(suggestion)) {
    return ` ${suggestion.trimStart()}`;
  }

  return suggestion;
}

function maybePrefixSpace(draft: string, suggestion: string): string {
  if (!suggestion) return suggestion;
  if (/^\s/.test(suggestion)) return suggestion;

  const lastChar = draft.slice(-1);
  if (!lastChar) return suggestion;

  if (/\s/.test(lastChar)) return suggestion;
  if (/[({\["'`/\\-]/.test(lastChar)) return suggestion;
  if (/^[,.;:!?)}\]]/.test(suggestion)) return suggestion;

  // Do not infer a missing word boundary between two word characters. The
  // cursor may be inside a partially typed word ("Schrei" + "be ..."), and
  // adding a space would corrupt the accepted completion. For word-to-word
  // continuations we rely on the model-provided leading whitespace instead.
  if (/[A-Za-z0-9]/.test(lastChar) && /^[A-Za-z0-9]/.test(suggestion)) {
    return suggestion;
  }

  if (/[A-Za-z0-9\])]/.test(lastChar) && /^[([{"']/.test(suggestion)) {
    return ` ${suggestion}`;
  }

  if (/[\])]/.test(lastChar) && /^[A-Za-z0-9([{"']/.test(suggestion)) {
    return ` ${suggestion}`;
  }

  if (/[,:;]/.test(lastChar) && !/^\s/.test(suggestion)) {
    return ` ${suggestion}`;
  }

  return suggestion;
}

function getJsonCandidates(text: string): string[] {
  const stripped = stripCodeFences(text).trim();
  const candidates = new Set<string>();

  if (stripped) {
    candidates.add(stripped);
  }

  const objectStart = stripped.indexOf("{");
  const objectEnd = stripped.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    candidates.add(stripped.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = stripped.indexOf("[");
  const arrayEnd = stripped.lastIndexOf("]");
  // Only salvage a bracketed substring as a standalone JSON array when it is not
  // nested inside an object-shaped payload. Otherwise an incomplete object such
  // as {"items":["metadata"],"completions":["good","trunc can parse the
  // completed inner items array before the structured truncation salvage runs.
  if (
    arrayStart !== -1
    && arrayEnd !== -1
    && arrayEnd > arrayStart
    && (objectStart === -1 || arrayStart < objectStart)
  ) {
    candidates.add(stripped.slice(arrayStart, arrayEnd + 1));
  }

  return [...candidates];
}

const SUGGESTION_ARRAY_KEYS = ["completions", "suggestions", "alternatives", "items"] as const;
const SUGGESTION_ARRAY_KEY_PATTERN = /"(?:completions|suggestions|alternatives|items)"\s*:\s*\[/;
const JSON_CODE_FENCE_PATTERN = /```\s*(?:json)?[\s\S]*?(?:\{|\[)/i;

type SuggestionArrayKey = typeof SUGGESTION_ARRAY_KEYS[number];

interface JsonStringLiteral {
  value: string;
  end: number;
}

interface JsonSkipResult {
  end: number;
  complete: boolean;
}

function hasJsonPayloadIndicator(text: string): boolean {
  const stripped = stripCodeFences(text).trim();
  return (
    stripped.startsWith("{")
    || stripped.startsWith("[")
    || SUGGESTION_ARRAY_KEY_PATTERN.test(text)
    || JSON_CODE_FENCE_PATTERN.test(text)
  );
}

function skipJsonWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function readJsonStringLiteral(text: string, startIndex: number): JsonStringLiteral | undefined {
  if (text[startIndex] !== '"') return undefined;

  let i = startIndex + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === '"') {
      try {
        const parsed = JSON.parse(text.slice(startIndex, i + 1)) as unknown;
        return typeof parsed === "string" ? { value: parsed, end: i + 1 } : undefined;
      } catch {
        return undefined;
      }
    }
    i += 1;
  }

  return undefined;
}

function skipJsonStringLiteral(text: string, startIndex: number): JsonSkipResult {
  if (text[startIndex] !== '"') return { end: startIndex, complete: false };

  let i = startIndex + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === '"') {
      return { end: i + 1, complete: true };
    }
    i += 1;
  }

  return { end: text.length, complete: false };
}

function skipJsonValue(text: string, startIndex: number): JsonSkipResult {
  let i = skipJsonWhitespace(text, startIndex);
  if (i >= text.length) return { end: i, complete: false };

  if (text[i] === '"') {
    return skipJsonStringLiteral(text, i);
  }

  if (text[i] === "{" || text[i] === "[") {
    const stack = [text[i] === "{" ? "}" : "]"];
    i += 1;

    while (i < text.length) {
      const char = text[i];
      if (char === '"') {
        const skipped = skipJsonStringLiteral(text, i);
        if (!skipped.complete) return skipped;
        i = skipped.end;
        continue;
      }
      if (char === "{") {
        stack.push("}");
        i += 1;
        continue;
      }
      if (char === "[") {
        stack.push("]");
        i += 1;
        continue;
      }
      if (char === stack[stack.length - 1]) {
        stack.pop();
        i += 1;
        if (stack.length === 0) return { end: i, complete: true };
        continue;
      }
      i += 1;
    }

    return { end: text.length, complete: false };
  }

  while (i < text.length && !/[,}\]]/.test(text[i])) i += 1;
  return { end: i, complete: i > startIndex };
}

function scanTopLevelJsonStringArrayElements(text: string, startIndex: number): string[] {
  const results: string[] = [];
  let i = startIndex;

  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    const char = text[i];
    if (char === "]") break;
    if (char === ",") {
      i += 1;
      continue;
    }

    if (char === '"') {
      const literal = readJsonStringLiteral(text, i);
      // Truncated or invalid top-level string: discard it instead of leaking it.
      if (!literal) break;
      results.push(literal.value);
      i = literal.end;
    } else {
      const skipped = skipJsonValue(text, i);
      if (!skipped.complete || skipped.end <= i) break;
      i = skipped.end;
    }

    i = skipJsonWhitespace(text, i);
    if (text[i] === ",") i += 1;
  }

  return results;
}

function extractPrioritizedSalvagedSuggestions(
  text: string,
  starts: Partial<Record<SuggestionArrayKey, number>>,
): string[] | undefined {
  let sawSuggestionArray = false;

  for (const key of SUGGESTION_ARRAY_KEYS) {
    const start = starts[key];
    if (typeof start !== "number") continue;
    sawSuggestionArray = true;

    const suggestions = scanTopLevelJsonStringArrayElements(text, start);
    if (suggestions.length > 0) return suggestions;
  }

  return sawSuggestionArray ? [] : undefined;
}

function findTopLevelSuggestionArrayStartsInObject(
  text: string,
  objectStartIndex: number,
): Partial<Record<SuggestionArrayKey, number>> {
  const starts: Partial<Record<SuggestionArrayKey, number>> = {};
  let i = objectStartIndex + 1;

  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "}") break;
    if (text[i] !== '"') {
      const skipped = skipJsonValue(text, i);
      if (!skipped.complete || skipped.end <= i) break;
      i = skipped.end;
      continue;
    }

    const keyLiteral = readJsonStringLiteral(text, i);
    if (!keyLiteral) break;
    i = skipJsonWhitespace(text, keyLiteral.end);
    if (text[i] !== ":") {
      i = keyLiteral.end;
      continue;
    }

    i = skipJsonWhitespace(text, i + 1);
    const key = keyLiteral.value as SuggestionArrayKey;
    if (
      text[i] === "["
      && (SUGGESTION_ARRAY_KEYS as readonly string[]).includes(keyLiteral.value)
      && starts[key] === undefined
    ) {
      starts[key] = i + 1;
    }

    const skipped = skipJsonValue(text, i);
    if (!skipped.complete || skipped.end <= i) break;
    i = skipped.end;
  }

  return starts;
}

function salvageTruncatedJsonSuggestions(text: string): string[] {
  const stripped = stripCodeFences(text).trim();

  if (stripped.startsWith("[")) {
    return scanTopLevelJsonStringArrayElements(stripped, 1);
  }

  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] !== "{") {
      i += 1;
      continue;
    }

    const starts = findTopLevelSuggestionArrayStartsInObject(stripped, i);
    const suggestions = extractPrioritizedSalvagedSuggestions(stripped, starts);
    if (suggestions !== undefined) return suggestions;

    const skipped = skipJsonValue(stripped, i);
    i = skipped.complete && skipped.end > i ? skipped.end : i + 1;
  }

  return [];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function extractJsonSuggestions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return toStringArray(value);
  }

  if (!isRecord(value)) {
    return [];
  }

  const payload = value as SuggestionPayload;
  const arrayKeys = [payload.completions, payload.suggestions, payload.alternatives, payload.items];
  for (const candidate of arrayKeys) {
    const strings = toStringArray(candidate);
    if (strings.length > 0) return strings;
  }

  const scalarKeys = [payload.completion, payload.suggestion, payload.text];
  for (const candidate of scalarKeys) {
    if (typeof candidate === "string") {
      return [candidate];
    }
  }

  return [];
}

function parseSuggestionResponse(rawResponse: string): string[] {
  for (const candidate of getJsonCandidates(rawResponse)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const suggestions = extractJsonSuggestions(parsed);
      if (suggestions.length > 0) {
        return suggestions;
      }

      if (Array.isArray(parsed) && parsed.length === 0) {
        return [];
      }

      if (isRecord(parsed) && Array.isArray((parsed as SuggestionPayload).completions)) {
        return [];
      }
    } catch {
      continue;
    }
  }

  // The response looks like a structured JSON payload but could not be parsed,
  // typically because the completion was truncated mid-string (stopReason
  // "length"). Salvage the complete entries instead of leaking raw JSON into
  // the editor as ghost text.
  if (hasJsonPayloadIndicator(rawResponse)) {
    return salvageTruncatedJsonSuggestions(rawResponse);
  }

  return rawResponse.trim() ? [rawResponse] : [];
}

export function parseModelRef(value: boolean | string | undefined): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }

  return {
    provider: trimmed.slice(0, slashIndex),
    id: trimmed.slice(slashIndex + 1),
  };
}

export function parseBoundedIntFlag(
  value: boolean | string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function computeRequestMaxTokens(maxAlternatives: number, maxSuggestionChars: number): number {
  // Rough chars→tokens estimate per suggestion plus JSON quoting/comma overhead,
  // and a fixed wrapper budget for the surrounding {"completions":[...]} envelope.
  const tokensPerSuggestion = Math.ceil(maxSuggestionChars / 3) + 8;
  const estimated = 24 + maxAlternatives * tokensPerSuggestion;
  return Math.max(MIN_REQUEST_MAX_TOKENS, Math.min(MAX_REQUEST_MAX_TOKENS, estimated));
}

export function extractMessageText(content: unknown, maxChars = Number.POSITIVE_INFINITY): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return Number.isFinite(maxChars) ? truncateMiddle(trimmed, maxChars) : trimmed;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  let remaining = maxChars;
  let truncated = false;

  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text;

    if (Number.isFinite(maxChars)) {
      const separatorLength = parts.length > 0 ? 1 : 0;
      if (remaining <= separatorLength) {
        truncated = true;
        break;
      }

      const availableForText = Math.max(0, remaining - separatorLength);
      if (text.length > availableForText) {
        parts.push(text.slice(0, availableForText));
        truncated = true;
        break;
      }

      remaining -= separatorLength + text.length;
    }

    parts.push(text);
  }

  const joined = parts.join("\n").trim();
  if (!Number.isFinite(maxChars)) return joined;
  return truncated ? truncateWithForcedEllipsis(joined, maxChars) : joined;
}

export function buildRecentConversationContext(
  branch: unknown[],
  maxMessages = MAX_CONTEXT_MESSAGES,
  maxCharsPerMessage = MAX_CONTEXT_MESSAGE_CHARS,
): string {
  const collected: string[] = [];

  for (let i = branch.length - 1; i >= 0 && collected.length < maxMessages; i -= 1) {
    const entry = branch[i];
    if (!isRecord(entry) || entry.type !== "message") continue;

    const message = entry.message;
    if (!isRecord(message)) continue;

    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractMessageText(message.content, maxCharsPerMessage * 4);
    if (!text) continue;

    const prefix = role === "user" ? "User" : "Assistant";
    const normalized = truncateWithEllipsis(trimAndCollapse(text), maxCharsPerMessage);
    collected.push(`${prefix}: ${normalized}`);
  }

  return collected.reverse().join("\n\n");
}

function buildLatestRoleMessageContext(
  branch: unknown[],
  role: "user" | "assistant",
  maxChars: number,
): string {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (!isRecord(entry) || entry.type !== "message") continue;

    const message = entry.message;
    if (!isRecord(message) || message.role !== role) continue;

    const text = extractMessageText(message.content, maxChars * 2);
    if (!text) continue;

    return truncateMiddle(text.trim(), maxChars);
  }

  return "";
}

export function buildLatestAssistantMessageContext(
  branch: unknown[],
  maxChars = MAX_LATEST_ASSISTANT_MESSAGE_CHARS,
): string {
  return buildLatestRoleMessageContext(branch, "assistant", maxChars);
}

export function buildLatestUserMessageContext(
  branch: unknown[],
  maxChars = MAX_LATEST_USER_MESSAGE_CHARS,
): string {
  return buildLatestRoleMessageContext(branch, "user", maxChars);
}

export function truncateDraftTail(draft: string, maxChars = MAX_DRAFT_CONTEXT_CHARS): string {
  if (draft.length <= maxChars) return draft;
  return draft.slice(-maxChars);
}

export function shouldSkipPromptAutocomplete(text: string): boolean {
  const trimmedStart = text.trimStart();
  if (trimmedStart.startsWith("/") || trimmedStart.startsWith("!")) return true;

  const lastNewline = text.lastIndexOf("\n");
  const textBeforeCursor = lastNewline === -1 ? text : text.slice(lastNewline + 1);

  if (/(?:^|[ \t])[@#](?:"[^"]*|[^\s]*)$/.test(textBeforeCursor)) return true;
  if (/(?:^|[ \t])(?:~\/|\.\.?\/|\/)[^\s]*$/.test(textBeforeCursor)) return true;

  return false;
}

export function normalizePromptSuggestion(
  draft: string,
  rawSuggestion: string,
  maxChars = DEFAULT_MAX_SUGGESTION_CHARS,
): string | undefined {
  let suggestion = rawSuggestion.replace(/\r/g, "");
  if (!suggestion.trim()) return undefined;
  if (/^<NO_COMPLETION>$/i.test(suggestion.trim())) return undefined;

  suggestion = stripCodeFences(suggestion);
  suggestion = suggestion.replace(/^(?:continuation|completion|suggestion)\s*:\s*/i, "");
  suggestion = stripWrappingQuotes(suggestion);
  suggestion = stripRepeatedDraftPrefix(draft, suggestion);
  suggestion = suggestion.replace(/^\u200b+/, "");
  suggestion = suggestion.replace(/\t/g, "    ");
  suggestion = stripRepeatedCurrentWordPrefix(draft, suggestion);
  suggestion = suggestion.trimEnd();

  if (!suggestion.trim()) return undefined;

  suggestion = normalizeLeadingBoundarySpacing(draft, suggestion);
  suggestion = maybePrefixSpace(draft, suggestion);
  suggestion = truncateWithEllipsis(suggestion, maxChars);

  if (!suggestion.trim()) return undefined;
  return suggestion;
}

export function normalizePromptSuggestions(
  draft: string,
  rawResponse: string,
  maxChars = DEFAULT_MAX_SUGGESTION_CHARS,
  maxAlternatives = DEFAULT_MAX_ALTERNATIVES,
): string[] {
  const rawSuggestions = parseSuggestionResponse(rawResponse);
  const normalized: string[] = [];

  for (const rawSuggestion of rawSuggestions) {
    const suggestion = normalizePromptSuggestion(draft, rawSuggestion, maxChars);
    if (!suggestion) continue;
    if (normalized.includes(suggestion)) continue;
    normalized.push(suggestion);
    if (normalized.length >= maxAlternatives) break;
  }

  return normalized;
}

export function extractNextSuggestionChunk(suggestion: string): string | undefined {
  if (!suggestion) return undefined;

  const match = /^(\s*)(\S+)(\s*)/s.exec(suggestion);
  if (!match) {
    return suggestion;
  }

  const leading = match[1] ?? "";
  const token = match[2] ?? "";
  const trailing = match[3] ?? "";

  let keptTrailing = "";
  if (trailing.startsWith("\n")) {
    const indent = /^\n([ \t]*)/.exec(trailing)?.[1] ?? "";
    keptTrailing = `\n${indent}`;
  } else if (/^[ \t]+/.test(trailing)) {
    keptTrailing = /^[ \t]+/.exec(trailing)?.[0] ?? "";
  }

  return `${leading}${token}${keptTrailing}`;
}

export function formatModelLabel(model: Model<Api> | undefined): string {
  if (!model) return "none";
  return `${model.provider}/${model.id}`;
}
