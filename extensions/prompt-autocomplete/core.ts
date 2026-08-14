import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";

const TEMPLATE_VARIABLE_PATTERN = /(?<!\\)\{\{\s*([A-Z0-9_]+)\s*(?:\|\s*([\s\S]*?))?\s*\}\}/g;
const ESCAPED_TEMPLATE_VARIABLE_PATTERN = /\\(\{\{\s*[A-Z0-9_]+\s*(?:\|\s*[\s\S]*?)?\s*\}\})/g;
const PROMPT_AUTOCOMPLETE_RESPONSE_KEY = "completions";
/** Model references are short; a longer flag value is never displayed in full. */
const MAX_RAW_MODEL_CHARS = 512;
/** DCS, SOS, OSC, PM, and APC introducers in their C1 form. */
const C1_STRING_SEQUENCE_OPENERS = new Set(["\u0090", "\u0098", "\u009D", "\u009E", "\u009F"]);
/** The same introducers in their ESC-prefixed form. */
const ESCAPED_STRING_SEQUENCE_OPENERS = new Set(["P", "X", "^", "_"]);
/**
 * Format and default-ignorable characters.
 *
 * They cannot change terminal state, but they can make a diagnostic display
 * text that differs from its actual content, which defeats the purpose of
 * naming a rejected model or a failing provider. Both Unicode properties are
 * matched instead of an explicit list, because an enumeration misses soft
 * hyphens, Hangul fillers, annotation marks, and most of plane 14.
 *
 * Zero-width joiner and non-joiner are deliberately kept: they carry meaning in
 * Arabic, Persian, and Indic scripts and in emoji sequences, and they cannot
 * reorder text.
 */
const DECEPTIVE_FORMAT_CHARACTERS = /[^\P{Cf}\u200C\u200D]|[^\P{Default_Ignorable_Code_Point}\u200C\u200D]/gu;
/** Line and paragraph separators; a line break keeps the text readable. */
const UNICODE_LINE_SEPARATORS = /[\u2028\u2029]/g;

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
export const DEFAULT_STREAM_RESPONSES = true;
export const DEFAULT_DEBOUNCE_MS = 350;
export const DEBOUNCE_MS_MIN = 0;
export const DEBOUNCE_MS_MAX = 5_000;
export const DEFAULT_MIN_PROMPT_CHARS = 1;
export const MIN_PROMPT_CHARS_MIN = 0;
export const MIN_PROMPT_CHARS_MAX = 500;
export const DEFAULT_MAX_SUGGESTION_CHARS = 160;
export const MAX_SUGGESTION_CHARS_MIN = 16;
export const MAX_SUGGESTION_CHARS_MAX = 1_000;
export const DEFAULT_MAX_ALTERNATIVES = 3;
export const MAX_ALTERNATIVES_MIN = 1;
export const MAX_ALTERNATIVES_MAX = 5;
/** Provider-request ceiling bounds; `off` (no ceiling) is the default. */
export const BUDGET_REQUESTS_MIN = 1;
export const BUDGET_REQUESTS_MAX = 100_000;
export const DEFAULT_BUDGET_REQUESTS_FLAG = "off";
/** Custom-entry customType carrying versioned budget snapshots. */
export const PROMPT_AUTOCOMPLETE_BUDGET_ENTRY_TYPE = "prompt-autocomplete-stats";
export const PROMPT_AUTOCOMPLETE_BUDGET_SCHEMA_VERSION = 1;
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
  conversationId: string;
  modelLabel: string;
  maxAlternatives: number;
  maxSuggestionChars: number;
  draft: string;
  latestAssistantContext: string;
  latestUserContext: string;
  recentContext: string;
}

/** Session entries that advance the raw leaf without changing autocomplete context. */
const AUTOCOMPLETE_METADATA_ENTRY_TYPES = new Set(["custom", "label", "session_info"]);

export function isAutocompleteMetadataEntry(entry: unknown): boolean {
  return isRecord(entry)
    && typeof entry.type === "string"
    && AUTOCOMPLETE_METADATA_ENTRY_TYPES.has(entry.type);
}

/**
 * Newest branch entry that affects transmitted autocomplete context.
 *
 * Custom, label, and session-info entries are skipped because they are excluded
 * from model context. Entries without an id are skipped so a host that omits
 * ids can still fall back to the raw leaf. `custom_message` is kept: it is
 * included in LLM context even though today's context builders only read
 * `type === "message"`.
 */
export function resolveAutocompleteConversationId(
  branch: unknown[],
  fallbackId = "",
): string {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (isAutocompleteMetadataEntry(entry)) continue;
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    return entry.id;
  }
  return fallbackId;
}

export type PromptAutocompletePrefixContextIdentity = Omit<PromptAutocompleteCacheIdentity, "draft">;

function hashPromptAutocompleteIdentity(identity: object): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function buildPromptAutocompleteCacheKey(identity: PromptAutocompleteCacheIdentity): string {
  return `${identity.modelLabel}|${hashPromptAutocompleteIdentity(identity)}`;
}

/** Identify every request discriminator except the evolving prompt draft. */
export function buildPromptAutocompletePrefixContextKey(
  identity: PromptAutocompletePrefixContextIdentity,
): string {
  return `${identity.modelLabel}|prefix|${hashPromptAutocompleteIdentity(identity)}`;
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

  set(key: string, value: T, options: { expiresAt?: number } = {}): void {
    const now = this.now();
    const expiresAt = options.expiresAt ?? now + this.ttlMs;
    this.entries.delete(key);
    if (expiresAt <= now) return;
    this.entries.set(key, { value, expiresAt });
    this.prune();
  }

  getExpiration(key: string): number | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.expiresAt;
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

export interface CoalescedRequestEntry<T, P = never> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: Set<symbol>;
  progressSubscribers: Map<symbol, (progress: P) => void>;
  latestProgress?: P;
  hasProgress: boolean;
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

export function acquireCoalescedRequest<T, P = never>(
  inFlightRequests: Map<string, CoalescedRequestEntry<T, P>>,
  key: string,
  subscriberId: string,
  start: (signal: AbortSignal, publish: (progress: P) => void) => Promise<T>,
  onProgress?: (progress: P) => void,
): CoalescedRequestSubscription<T> {
  let entry = inFlightRequests.get(key);
  let created = false;
  let runStart: (() => void) | undefined;

  if (!entry) {
    const controller = new AbortController();
    const subscribers = new Set<symbol>();
    const progressSubscribers = new Map<symbol, (progress: P) => void>();
    const promise = new Promise<T>((resolve, reject) => {
      runStart = () => {
        try {
          Promise.resolve(
            start(controller.signal, (progress) => {
              if (!entry) return;
              entry.latestProgress = progress;
              entry.hasProgress = true;
              // Snapshot the callbacks so one subscriber may release itself
              // without skipping another subscriber. A UI callback must never
              // turn a successful provider request into a failed shared request.
              for (const callback of [...entry.progressSubscribers.values()]) {
                try {
                  callback(progress);
                } catch {
                  // Subscriber failures are isolated from the shared request.
                }
              }
            }),
          ).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      };
    });
    let entryForFinally: CoalescedRequestEntry<T, P> | undefined;
    const settledPromise = promise.finally(() => {
      if (!entryForFinally) return;
      entryForFinally.settled = true;
      if (inFlightRequests.get(key) === entryForFinally) {
        inFlightRequests.delete(key);
      }
    });
    const nextEntry: CoalescedRequestEntry<T, P> = {
      controller,
      subscribers,
      progressSubscribers,
      hasProgress: false,
      settled: false,
      promise: settledPromise,
    };
    entryForFinally = nextEntry;

    entry = nextEntry;
    inFlightRequests.set(key, entry);
    created = true;
  }

  // A symbol makes subscriptions collision-proof even if two editor instances
  // happen to produce the same human-readable activation/sequence label.
  const subscriberToken = Symbol(subscriberId);
  entry.subscribers.add(subscriberToken);
  if (onProgress) {
    entry.progressSubscribers.set(subscriberToken, onProgress);
    if (entry.hasProgress) {
      try {
        onProgress(entry.latestProgress as P);
      } catch {
        // Replay has the same isolation contract as live progress.
      }
    }
  }

  // Start only after the first subscriber is registered, so synchronous
  // progress cannot race past it. The entry is already visible for coalescing.
  runStart?.();

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

      entry?.subscribers.delete(subscriberToken);
      entry?.progressSubscribers.delete(subscriberToken);

      const current = inFlightRequests.get(key);
      if (current !== entry) return;
      if (current.subscribers.size === 0 && !current.settled) {
        current.controller.abort();
        inFlightRequests.delete(key);
      }
    },
  };
}

export function cancelAllCoalescedRequests<T, P>(inFlightRequests: Map<string, CoalescedRequestEntry<T, P>>): void {
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
  /** Cache hits obtained by consuming a prefix of a previous suggestion. */
  prefixReuseHits: number;
  /** Active ghost-text suggestions offered to the editor. */
  suggestionsOffered: number;
  /** Full-suggestion accept actions, including visible streamed partials. */
  fullAccepts: number;
  /** Word/chunk accept actions, including visible streamed partials. */
  chunkAccepts: number;
  /** Provider calls with a measured completion or rejection latency. */
  latencySamples: number;
  /** Sum used to derive mean provider latency without retaining request history. */
  totalLatencyMs: number;
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
    prefixReuseHits: 0,
    suggestionsOffered: 0,
    fullAccepts: 0,
    chunkAccepts: 0,
    latencySamples: 0,
    totalLatencyMs: 0,
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

export function recordProviderLatency(stats: PromptAutocompleteUsageStats, elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  stats.latencySamples += 1;
  stats.totalLatencyMs += elapsedMs;
}

function formatUsageTotals(stats: PromptAutocompleteUsageStats): string {
  const tokensPartial = stats.tokenReports < stats.providerRequests;
  const costPartial = stats.costReports < stats.providerRequests;
  return [
    `${stats.totalTokens} tok${tokensPartial ? "+" : ""}`,
    `~${formatEstimatedCost(stats.estimatedCost)} est${costPartial ? "+" : ""}`,
  ].join(", ");
}

function formatDetailedUsageTotals(stats: PromptAutocompleteUsageStats): string {
  const tokensPartial = stats.tokenReports < stats.providerRequests;
  const costPartial = stats.costReports < stats.providerRequests;
  const tokenUnit = stats.totalTokens === 1 ? "token" : "tokens";
  return [
    `${stats.totalTokens} ${tokenUnit}${tokensPartial ? "+" : ""}`,
    `estimated cost ~${formatEstimatedCost(stats.estimatedCost)}${costPartial ? "+" : ""}`,
  ].join(", ");
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

  segments.push(formatUsageTotals(stats));
  return segments.join(", ");
}

/** Render the reachable, user-facing metrics for the current session. */
export function formatPromptAutocompleteStats(stats: PromptAutocompleteUsageStats): string {
  const exactCacheHits = Math.max(0, stats.cacheHits - stats.prefixReuseHits);
  const accepts = stats.fullAccepts + stats.chunkAccepts;
  const meanLatency = stats.latencySamples > 0
    ? `${Math.round(stats.totalLatencyMs / stats.latencySamples)} ms (${stats.latencySamples} sample${stats.latencySamples === 1 ? "" : "s"})`
    : "n/a";

  return [
    "Prompt Autocomplete — current session",
    `Requests: ${stats.providerRequests} issued, ${stats.failedRequests} failed`,
    `Cache: ${stats.cacheHits} hits (${exactCacheHits} exact, ${stats.prefixReuseHits} prefix)`,
    `Suggestions: ${stats.suggestionsOffered} offered, ${accepts} accepted (${stats.fullAccepts} full, ${stats.chunkAccepts} word/chunk)`,
    `Usage: ${formatDetailedUsageTotals(stats)}`,
    `Mean provider latency: ${meanLatency}`,
  ].join("\n");
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
  streamResponses?: boolean;
  debug?: boolean;
  minPromptChars?: number;
  debounceMs?: number;
  maxSuggestionChars?: number;
  maxAlternatives?: number;
  modelSelection?: PromptAutocompleteModelSelection;
  /** Session request ceiling; `"off"` is an explicit decision, not unset. */
  budgetLimit?: PromptAutocompleteBudgetSetting;
}

export type PromptAutocompleteSettingSource = "flag" | "saved" | "session";

export function resolveOverride<T>(override: T | undefined, flagValue: T): T {
  return override ?? flagValue;
}

export function describeSettingSource(override: unknown): PromptAutocompleteSettingSource {
  return override === undefined ? "flag" : "session";
}

/**
 * Settings persisted across processes.
 *
 * Explicit `/prompt-autocomplete on|off`, `min-chars`, and `set` decisions are
 * stored. An absent field defers to the CLI flag, so an empty or missing file
 * behaves exactly like no persisted decision. The file stores nothing but these
 * decisions: no conversation, cache, or stats.
 */
export interface PromptAutocompletePersistedSettings {
  enabled?: boolean;
  minPromptChars?: number;
  debounceMs?: number;
  maxSuggestionChars?: number;
  maxAlternatives?: number;
  /** Raw dedicated model, or `active` for the session model. Invalid values are dropped on load. */
  model?: string;
}

/**
 * Parse persisted settings text defensively.
 *
 * The file is user-editable, so anything malformed — invalid JSON, a non-object
 * payload, or a non-boolean `enabled` — degrades to "no persisted decision"
 * instead of failing extension activation.
 */
export function parsePromptAutocompletePersistedSettings(
  text: string | undefined,
): PromptAutocompletePersistedSettings {
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const settings: PromptAutocompletePersistedSettings = {};
  if (typeof record.enabled === "boolean") settings.enabled = record.enabled;
  const minPromptChars = readPersistedBoundedInt(record, "minPromptChars", MIN_PROMPT_CHARS_MIN, MIN_PROMPT_CHARS_MAX);
  if (minPromptChars !== undefined) settings.minPromptChars = minPromptChars;
  const debounceMs = readPersistedBoundedInt(record, "debounceMs", DEBOUNCE_MS_MIN, DEBOUNCE_MS_MAX);
  if (debounceMs !== undefined) settings.debounceMs = debounceMs;
  const maxSuggestionChars = readPersistedBoundedInt(
    record,
    "maxSuggestionChars",
    MAX_SUGGESTION_CHARS_MIN,
    MAX_SUGGESTION_CHARS_MAX,
  );
  if (maxSuggestionChars !== undefined) settings.maxSuggestionChars = maxSuggestionChars;
  const maxAlternatives = readPersistedBoundedInt(
    record,
    "maxAlternatives",
    MAX_ALTERNATIVES_MIN,
    MAX_ALTERNATIVES_MAX,
  );
  if (maxAlternatives !== undefined) settings.maxAlternatives = maxAlternatives;
  if (typeof record.model === "string") {
    const model = parsePersistedModelRaw(record.model);
    if (model !== undefined) settings.model = persistableModelRaw(model);
  }
  return settings;
}

export function serializePromptAutocompletePersistedSettings(
  settings: PromptAutocompletePersistedSettings,
): string {
  const payload: PromptAutocompletePersistedSettings = {};
  if (typeof settings.enabled === "boolean") payload.enabled = settings.enabled;
  if (
    typeof settings.minPromptChars === "number"
    && Number.isInteger(settings.minPromptChars)
    && settings.minPromptChars >= MIN_PROMPT_CHARS_MIN
    && settings.minPromptChars <= MIN_PROMPT_CHARS_MAX
  ) {
    payload.minPromptChars = settings.minPromptChars;
  }
  if (
    typeof settings.debounceMs === "number"
    && Number.isInteger(settings.debounceMs)
    && settings.debounceMs >= DEBOUNCE_MS_MIN
    && settings.debounceMs <= DEBOUNCE_MS_MAX
  ) {
    payload.debounceMs = settings.debounceMs;
  }
  if (
    typeof settings.maxSuggestionChars === "number"
    && Number.isInteger(settings.maxSuggestionChars)
    && settings.maxSuggestionChars >= MAX_SUGGESTION_CHARS_MIN
    && settings.maxSuggestionChars <= MAX_SUGGESTION_CHARS_MAX
  ) {
    payload.maxSuggestionChars = settings.maxSuggestionChars;
  }
  if (
    typeof settings.maxAlternatives === "number"
    && Number.isInteger(settings.maxAlternatives)
    && settings.maxAlternatives >= MAX_ALTERNATIVES_MIN
    && settings.maxAlternatives <= MAX_ALTERNATIVES_MAX
  ) {
    payload.maxAlternatives = settings.maxAlternatives;
  }
  const model = parsePersistedModelRaw(settings.model);
  if (model !== undefined) payload.model = persistableModelRaw(model);
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function readPersistedBoundedInt(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/**
 * Resolve the effective enabled state and its attribution.
 *
 * Precedence: an in-session slash-command decision outranks everything; an
 * explicit CLI flag outranks the persisted decision because it is scoped to
 * this invocation; the persisted decision outranks the built-in default.
 * pi's boolean extension flags can only be switched on, so `flagEnabled` is
 * true exactly when the flag was passed explicitly.
 */
export function resolvePersistedEnabled(
  override: boolean | undefined,
  flagEnabled: boolean,
  saved: boolean | undefined,
): { enabled: boolean; source: PromptAutocompleteSettingSource } {
  if (override !== undefined) return { enabled: override, source: "session" };
  if (flagEnabled) return { enabled: true, source: "flag" };
  if (saved !== undefined) return { enabled: saved, source: "saved" };
  return { enabled: false, source: "flag" };
}

/**
 * Resolve a numeric setting with the same precedence as the enabled decision:
 * an in-session slash-command value outranks an explicitly passed flag, which
 * outranks the persisted value, which outranks the built-in default.
 */
export function resolvePersistedNumber(
  override: number | undefined,
  explicitFlag: number | undefined,
  saved: number | undefined,
  fallback: number,
): { value: number; source: PromptAutocompleteSettingSource } {
  if (override !== undefined) return { value: override, source: "session" };
  if (explicitFlag !== undefined) return { value: explicitFlag, source: "flag" };
  if (saved !== undefined) return { value: saved, source: "saved" };
  return { value: fallback, source: "flag" };
}

/**
 * Parse an integer flag as an explicit user decision.
 *
 * pi pre-fills string flags with their registered default, so a value equal to
 * the default is indistinguishable from an unset flag and yields undefined,
 * deferring to the persisted setting. Invalid input also yields undefined so a
 * typo cannot silently outrank a saved value.
 */
export function parseExplicitBoundedIntFlag(
  value: boolean | string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return undefined;
  const bounded = Math.max(min, Math.min(max, parsed));
  return bounded === defaultValue ? undefined : bounded;
}

/**
 * Parse a slash-command integer. Out-of-range and malformed values are rejected
 * rather than clamped, so the user sees the valid range instead of a silent
 * substitution.
 */
export function parseStrictBoundedInt(
  value: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== trimmed) return undefined;
  if (parsed < min || parsed > max) return undefined;
  return parsed;
}

/**
 * An explicit `--prompt-autocomplete-model` value, or undefined when the flag
 * still holds its registered default. `active` is an explicit sentinel and is
 * not treated as unset.
 */
export function parseExplicitModelFlag(
  value: boolean | string | undefined,
): PromptAutocompleteModelSelection | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === DEFAULT_PREFERRED_MODEL) return undefined;
  return parsePromptAutocompleteModelSelection(trimmed);
}

export function persistableModelRaw(selection: PromptAutocompleteModelSelection): string | undefined {
  if (selection.kind === "active") return "active";
  if (selection.kind === "dedicated") return selection.raw;
  return undefined;
}

export function parsePersistedModelRaw(value: string | undefined): PromptAutocompleteModelSelection | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // An empty field is "no decision", not an explicit request for the session model.
  if (!trimmed) return undefined;
  const selection = parsePromptAutocompleteModelSelection(trimmed);
  return selection.kind === "invalid" ? undefined : selection;
}

export function resolvePersistedModelSelection(
  override: PromptAutocompleteModelSelection | undefined,
  explicitFlag: PromptAutocompleteModelSelection | undefined,
  saved: PromptAutocompleteModelSelection | undefined,
): { selection: PromptAutocompleteModelSelection; source: PromptAutocompleteSettingSource } {
  if (override !== undefined) return { selection: override, source: "session" };
  if (explicitFlag !== undefined) return { selection: explicitFlag, source: "flag" };
  if (saved !== undefined) return { selection: saved, source: "saved" };
  return { selection: { kind: "active" }, source: "flag" };
}

/**
 * Session-scoped provider-request ceiling.
 *
 * The limit is the effective ceiling (`undefined` means off) and `used` counts
 * every provider invocation reserved in the current physical session,
 * including failed and aborted ones, and including invocations made while the
 * ceiling was off. Cache hits and in-flight joins never reserve.
 */
export interface PromptAutocompleteBudgetState {
  limit?: number;
  used: number;
}

export type PromptAutocompleteBudgetSetting = number | "off";

/** A restored snapshot always carries a real decision, including an explicit `off`. */
export interface PromptAutocompleteBudgetSnapshotState {
  limit: PromptAutocompleteBudgetSetting;
  used: number;
}

/**
 * Parse the `--prompt-autocomplete-max-requests` flag. Flags clamp: invalid
 * input and the registered default (`off`) fall back to "no explicit flag",
 * which defers to the session-restored value.
 */
export function parsePromptAutocompleteBudgetFlag(
  value: boolean | string | undefined,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === DEFAULT_BUDGET_REQUESTS_FLAG) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== trimmed) return undefined;
  return Math.min(BUDGET_REQUESTS_MAX, Math.max(BUDGET_REQUESTS_MIN, parsed));
}

/** Result of parsing an interactive `budget` argument. */
export type ParsedPromptAutocompleteBudgetValue =
  | { kind: "limit"; value: number }
  | { kind: "off" }
  | { kind: "unset" }
  | { kind: "invalid" };

/**
 * Parse `/prompt-autocomplete budget <n|off>`. Interactive values are rejected
 * rather than clamped so the user sees the valid range.
 */
export function parsePromptAutocompleteBudgetValue(value: string | undefined): ParsedPromptAutocompleteBudgetValue {
  if (value === undefined || !value.trim()) return { kind: "unset" };
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === DEFAULT_BUDGET_REQUESTS_FLAG) return { kind: "off" };
  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < BUDGET_REQUESTS_MIN || parsed > BUDGET_REQUESTS_MAX) return { kind: "invalid" };
  return { kind: "limit", value: parsed };
}

/** Durable snapshot of the session budget, appended as a non-LLM custom entry. */
export interface PromptAutocompleteBudgetSnapshot {
  schemaVersion: number;
  physicalSessionId: string;
  limit: PromptAutocompleteBudgetSetting;
  used: number;
}

export function buildPromptAutocompleteBudgetSnapshot(
  limit: PromptAutocompleteBudgetSetting,
  used: number,
  physicalSessionId: string,
): PromptAutocompleteBudgetSnapshot {
  return {
    schemaVersion: PROMPT_AUTOCOMPLETE_BUDGET_SCHEMA_VERSION,
    physicalSessionId,
    limit,
    used,
  };
}

/**
 * Parse a persisted snapshot. Unknown schema versions, foreign physical
 * sessions, and malformed fields degrade to `undefined` (fresh budget).
 */
export function parsePromptAutocompleteBudgetSnapshot(
  data: unknown,
  physicalSessionId: string,
): PromptAutocompleteBudgetSnapshotState | undefined {
  if (!isRecord(data)) return undefined;
  if (data.schemaVersion !== PROMPT_AUTOCOMPLETE_BUDGET_SCHEMA_VERSION) return undefined;
  if (data.physicalSessionId !== physicalSessionId) return undefined;
  const limit: PromptAutocompleteBudgetSetting | undefined = data.limit === "off"
    ? "off"
    : typeof data.limit === "number" && Number.isInteger(data.limit)
      && data.limit >= BUDGET_REQUESTS_MIN && data.limit <= BUDGET_REQUESTS_MAX
      ? data.limit
      : undefined;
  if (limit === undefined) return undefined;
  if (typeof data.used !== "number" || !Number.isInteger(data.used) || data.used < 0) return undefined;
  return { limit, used: data.used };
}

/**
 * Restore this physical session's budget from its own entries.
 *
 * Scans every entry of the session, not just the current leaf path: a request
 * paid for on a branch the user later left was still paid for, so switching
 * branches must not hand out a fresh allowance. Usage is therefore restored
 * monotonically (the highest observed count), while the ceiling is the last
 * recorded decision.
 */
export function findPromptAutocompleteBudgetSnapshot(
  entries: unknown[],
  physicalSessionId: string,
): PromptAutocompleteBudgetSnapshotState | undefined {
  let restored: PromptAutocompleteBudgetSnapshotState | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom") continue;
    if (entry.customType !== PROMPT_AUTOCOMPLETE_BUDGET_ENTRY_TYPE) continue;
    const snapshot = parsePromptAutocompleteBudgetSnapshot(entry.data, physicalSessionId);
    if (!snapshot) continue;
    restored = {
      limit: snapshot.limit,
      used: Math.max(restored?.used ?? 0, snapshot.used),
    };
  }
  return restored;
}

/**
 * Thrown by a request producer that cannot reserve budget. This is not a
 * provider failure: it must not enter the failure cooldown or failure stats.
 */
export class PromptAutocompleteBudgetExhaustedError extends Error {
  constructor(limit: number, used: number) {
    super(`Session request budget exhausted (${used}/${limit} provider requests used)`);
    this.name = "PromptAutocompleteBudgetExhaustedError";
  }
}

/**
 * Resolve the effective request ceiling and its attribution. An explicit
 * `budget off` override outranks flag and saved values; the registered flag
 * default is indistinguishable from not passing the flag.
 */
export function resolvePromptAutocompleteBudgetLimit(
  override: PromptAutocompleteBudgetSetting | undefined,
  explicitFlag: number | undefined,
  saved: PromptAutocompleteBudgetSetting | undefined,
): { limit?: number; source: PromptAutocompleteSettingSource } {
  if (override !== undefined) {
    return { limit: override === "off" ? undefined : override, source: "session" };
  }
  if (explicitFlag !== undefined) return { limit: explicitFlag, source: "flag" };
  if (saved !== undefined) return { limit: saved === "off" ? undefined : saved, source: "saved" };
  return { limit: undefined, source: "flag" };
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

function stripUnsafeTerminalControls(text: string): string {
  // Keep tab/newline because multiline suggestions intentionally support both.
  // Everything else in C0/C1 can alter terminal state (ESC/CSI/OSC), move the
  // cursor, or hide text and must never reach the renderer.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function truncateAtFirstUnpairedSurrogate(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        index += 1;
        continue;
      }
      return text.slice(0, index);
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      return text.slice(0, index);
    }
  }
  return text;
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

interface StreamingJsonString {
  value: string;
  complete: boolean;
}

/** Decode only the complete part of an unterminated JSON string literal. */
function readStreamingJsonString(text: string, startIndex: number): StreamingJsonString | undefined {
  if (text[startIndex] !== '"') return undefined;

  const complete = readJsonStringLiteral(text, startIndex);
  if (complete) return { value: complete.value, complete: true };

  let safeEnd = startIndex + 1;
  let i = safeEnd;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') break;
    if (char === "\\") {
      const escaped = text[i + 1];
      if (escaped === undefined) break;
      if (escaped === "u") {
        const digits = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) break;
        i += 6;
        safeEnd = i;
        continue;
      }
      if (!/["\\/bfnrt]/.test(escaped)) break;
      i += 2;
      safeEnd = i;
      continue;
    }
    // Raw control characters are invalid inside JSON strings. Do not turn a
    // malformed response into editor text just because the stream is partial.
    if (char.charCodeAt(0) < 0x20) break;
    i += 1;
    safeEnd = i;
  }

  try {
    const parsed = JSON.parse(`${text.slice(startIndex, safeEnd)}"`) as unknown;
    if (typeof parsed !== "string") return undefined;
    // A provider chunk may split a UTF-16 surrogate pair. Truncate at the first
    // unmatched half even when more decoded characters follow it.
    const value = truncateAtFirstUnpairedSurrogate(parsed);
    return { value, complete: false };
  } catch {
    return undefined;
  }
}

function readFirstStreamingArrayString(text: string, startIndex: number): StreamingJsonString | undefined {
  let i = startIndex;
  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "]") return undefined;
    if (text[i] === '"') return readStreamingJsonString(text, i);

    const skipped = skipJsonValue(text, i);
    if (!skipped.complete || skipped.end <= i) return undefined;
    i = skipped.end;
  }
  return undefined;
}

function findFirstStreamingSuggestion(text: string): StreamingJsonString | undefined {
  const stripped = stripCodeFences(text).trim();
  if (stripped.startsWith("[")) {
    return readFirstStreamingArrayString(stripped, 1);
  }

  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] !== "{") {
      i += 1;
      continue;
    }

    const starts = findTopLevelSuggestionArrayStartsInObject(stripped, i);
    for (const key of SUGGESTION_ARRAY_KEYS) {
      const start = starts[key];
      if (typeof start !== "number") continue;
      return readFirstStreamingArrayString(stripped, start);
    }

    const skipped = skipJsonValue(stripped, i);
    i = skipped.complete && skipped.end > i ? skipped.end : i + 1;
  }

  return undefined;
}

const STREAMING_GRAPHEME_SEGMENTER = (() => {
  if (typeof Intl.Segmenter !== "function") return undefined;
  try {
    return new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    return undefined;
  }
})();

function dropLastGrapheme(text: string): string {
  if (!STREAMING_GRAPHEME_SEGMENTER) {
    // Safety over partial UX on minimal-ICU builds: without a grapheme
    // segmenter we cannot prove that a ZWJ/combining sequence is complete.
    return "";
  }
  const segments = [...STREAMING_GRAPHEME_SEGMENTER.segment(text)];
  const last = segments.at(-1);
  return last ? text.slice(0, last.index) : "";
}

function truncateSuggestionAtGraphemeBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  if (maxChars === 1) return "…";

  if (!STREAMING_GRAPHEME_SEGMENTER) {
    // Do not guess a UTF-16/code-point boundary on minimal-ICU builds. A single
    // ellipsis is bounded and cannot split an unknown grapheme cluster.
    return "…";
  }

  const available = maxChars - 1;
  let end = 0;
  for (const segment of STREAMING_GRAPHEME_SEGMENTER.segment(text)) {
    const nextEnd = segment.index + segment.segment.length;
    if (nextEnd > available) break;
    end = nextEnd;
  }
  return `${text.slice(0, end)}…`;
}

function completedStreamingPrefix(text: string): string {
  const safe = dropLastGrapheme(text);
  if (!safe) return "";

  // Any whitespace-delimited language advances only after a full chunk. This
  // covers accented Latin text as well as ASCII and avoids treating one accent
  // as evidence that the unfinished word is a no-space script.
  let boundaryEnd = 0;
  for (const match of safe.matchAll(/\S\s+/gu)) {
    boundaryEnd = (match.index ?? 0) + match[0].length;
  }
  if (boundaryEnd > 0) return safe.slice(0, boundaryEnd);
  if (/\s/u.test(safe)) return "";

  // Scripts that conventionally omit spaces can still advance one complete
  // grapheme behind. Require the whole prefix to be made from those scripts or
  // symbols, so an emoji followed by a partial Latin word does not leak it.
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\p{Regional_Indicator}\p{M}\p{P}\p{S}\u200D]+$/u.test(safe)
    ? safe
    : "";
}

function unresolvedNormalizationPrefix(draft: string, suggestion: string): boolean {
  const trimmedStart = suggestion.replace(/^[ \t]+/, "");
  const comparable = trimmedStart.trimEnd();
  if (!comparable) return true;

  // The final normalizer removes repeated draft/current-word prefixes. Wait
  // until the model has emitted enough text for that transformation to settle.
  if (draft.toLocaleLowerCase().startsWith(comparable.toLocaleLowerCase())) return true;
  const currentWord = getTrailingWordFragment(draft);
  if (currentWord.toLocaleLowerCase().startsWith(comparable.toLocaleLowerCase())) return true;

  // Wrapping quotes, fences, and labels are removed only once their closing
  // syntax arrives. Publishing them early would force the ghost text to shrink.
  if (/^["'`]/.test(trimmedStart)) return true;
  if (/^(?:continuation|completion|suggestion)\s*:?[ \t]*$/i.test(trimmedStart)) return true;
  return false;
}

/**
 * Parse the first model suggestion from an in-progress JSON response.
 *
 * Only structured suggestion arrays are eligible, so partial JSON/prose can
 * never leak into the editor. Incomplete strings are held one grapheme behind;
 * ASCII text additionally waits for a completed whitespace-delimited chunk.
 */
export function parsePartialPromptSuggestion(
  draft: string,
  rawResponse: string,
  maxChars = DEFAULT_MAX_SUGGESTION_CHARS,
): string | undefined {
  const parsed = findFirstStreamingSuggestion(rawResponse);
  if (!parsed) return undefined;

  const candidate = parsed.complete ? parsed.value : completedStreamingPrefix(parsed.value);
  if (!candidate || (!parsed.complete && unresolvedNormalizationPrefix(draft, candidate))) {
    return undefined;
  }

  return normalizePromptSuggestion(draft, candidate, maxChars);
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

/**
 * Make untrusted text safe to render in a terminal.
 *
 * Provider errors, raw responses, model identifiers taken from CLI flags, and
 * host diagnostics all end up in notifications and widgets whose renderer keeps
 * ANSI escapes intact. Sanitizing happens in three steps because no single one
 * is sufficient: malformed UTF-16 is repaired first so later passes cannot split
 * a surrogate pair, complete VT sequences (CSI, OSC, DCS) are removed next so
 * their payload disappears with the introducer, and any remaining C0/C1 control
 * is dropped so a bare ESC or C1 introducer cannot start a new sequence.
 *
 * Tabs and newlines survive; callers that need a single line collapse whitespace
 * afterwards.
 */
export function sanitizeTerminalText(text: string): string {
  const wellFormed = typeof (text as { toWellFormed?: () => string }).toWellFormed === "function"
    ? text.toWellFormed()
    : truncateAtFirstUnpairedSurrogate(text);
  return stripVTControlCharacters(removeStringControlSequences(wellFormed))
    // Everything except tab and newline goes, including carriage return, which a
    // terminal would otherwise use to overwrite the line that was already drawn.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
    // Separators become real line breaks instead of disappearing, so a
    // multi-line provider error does not end up with its words glued together.
    .replace(UNICODE_LINE_SEPARATORS, "\n")
    .replace(DECEPTIVE_FORMAT_CHARACTERS, "");
}

/**
 * Drop DCS, SOS, PM, and APC sequences including their payload.
 *
 * `stripVTControlCharacters` leaves these string sequences behind, and a
 * terminal consumes everything up to the string terminator, so an unterminated
 * introducer discards the remainder here as well. The discard stops at a line
 * break: a C1 introducer is also what a mis-decoded UTF-8 quote looks like, and
 * losing the rest of a provider message to mojibake would hide the diagnostic
 * this text exists for.
 *
 * This is a single forward scan rather than a regex: a pattern with a lazy body
 * backtracks quadratically when an input carries many unterminated introducers,
 * and provider error text is not length-bounded.
 */
function removeStringControlSequences(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;
    const isC1Opener = C1_STRING_SEQUENCE_OPENERS.has(char);
    const isEscapedOpener = char === "\u001B" && ESCAPED_STRING_SEQUENCE_OPENERS.has(text[index + 1] ?? "");
    if (!isC1Opener && !isEscapedOpener) {
      result += char;
      index += 1;
      continue;
    }

    index += isC1Opener ? 1 : 2;
    while (index < text.length) {
      const candidate = text[index] as string;
      if (candidate === "\u0007" || candidate === "\u009C") {
        index += 1;
        break;
      }
      if (candidate === "\u001B" && text[index + 1] === "\\") {
        index += 2;
        break;
      }
      if (candidate === "\n") break;
      index += 1;
    }
  }

  return result;
}

/** Which model an autocomplete request may use. */
export type PromptAutocompleteModelSelection =
  | { kind: "active" }
  | { kind: "dedicated"; ref: ModelRef; raw: string }
  | { kind: "invalid"; raw: string };

/**
 * Classify the `--prompt-autocomplete-model` value.
 *
 * An explicit but unusable value must stay distinguishable from "no dedicated
 * model requested". Collapsing both into `undefined` is what allows a malformed
 * value to silently send the draft and conversation context to the active
 * model, which may belong to a different provider than the user asked for.
 */
export function parsePromptAutocompleteModelSelection(
  value: boolean | string | undefined,
): PromptAutocompleteModelSelection {
  if (typeof value !== "string") return { kind: "active" };
  const trimmed = value.trim();
  if (!trimmed) return { kind: "active" };
  // The flag ships the sentinel default `DEFAULT_PREFERRED_MODEL`, and `active`
  // is the explicit way to ask for the session model.
  const normalized = trimmed.toLowerCase();
  if (normalized === DEFAULT_PREFERRED_MODEL || normalized === "active") return { kind: "active" };

  const ref = parseModelRef(trimmed);
  // Preserve the raw value: model identifiers are case-sensitive and the user
  // needs to recognize what was rejected.
  return ref ? { kind: "dedicated", ref, raw: trimmed } : { kind: "invalid", raw: trimmed };
}

/** Human-readable, terminal-safe description of the requested model. */
export function describePromptAutocompleteModelSelection(
  selection: PromptAutocompleteModelSelection,
  maxRawChars = 78,
): string {
  if (selection.kind === "active") return "current active model";
  // This runs on the request path, so the value is capped before sanitizing
  // rather than only afterwards.
  const capped = selection.raw.length > MAX_RAW_MODEL_CHARS
    ? truncateAtFirstUnpairedSurrogate(selection.raw.slice(0, MAX_RAW_MODEL_CHARS))
    : selection.raw;
  const raw = trimAndCollapse(sanitizeTerminalText(capped));
  // A value made only of invisible characters would otherwise be reported as an
  // empty string, leaving nothing to recognize.
  if (!raw) return selection.kind === "dedicated" ? "<unprintable>" : "<unprintable> (invalid)";
  // Truncate the raw value only, so a long malformed value cannot push the
  // rejection marker out of the message and read as a plausible model name.
  const bounded = raw.length > maxRawChars
    ? `${truncateAtFirstUnpairedSurrogate(raw.slice(0, maxRawChars - 1))}…`
    : raw;
  return selection.kind === "dedicated" ? bounded : `${bounded} (invalid)`;
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
  let suggestion = stripUnsafeTerminalControls(truncateAtFirstUnpairedSurrogate(rawSuggestion)).replace(/\r/g, "");
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
  suggestion = truncateSuggestionAtGraphemeBoundary(suggestion, maxChars);

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

export interface PromptAutocompletePrefixReuseResult {
  /** Suggestions normalized for the extended draft. */
  suggestions: string[];
  /** Original cached suggestions, parallel to `suggestions`, for selection continuity. */
  origins: string[];
}

function isSafeConsumedSuggestionPrefix(
  cachedDraft: string,
  suggestion: string,
  consumedLength: number,
): boolean {
  if (consumedLength <= 0 || consumedLength > suggestion.length) return false;

  const target = cachedDraft + suggestion;
  const boundary = cachedDraft.length + consumedLength;
  if (!STREAMING_GRAPHEME_SEGMENTER) {
    // Minimal-ICU fallback: accept only a newly consumed ASCII prefix that is
    // not followed by a combining/variation/joining code point. For richer
    // text, decline reuse rather than guess across the draft/suggestion seam.
    const consumed = suggestion.slice(0, consumedLength);
    const remainder = suggestion.slice(consumedLength);
    return /^[\x00-\x7F]*$/.test(consumed) && !/^[\p{M}\u200D]/u.test(remainder);
  }

  if (boundary === target.length) return true;
  // `containing` asks ICU for the segment at the seam without materializing or
  // walking every grapheme in an arbitrarily long draft.
  return STREAMING_GRAPHEME_SEGMENTER.segment(target).containing(boundary)?.index === boundary;
}

/**
 * Reuse terminal cached suggestions when the draft only consumed their prefix.
 *
 * Matching is deliberately exact and forward-only. Cached origins have already
 * passed the production normalizer; slicing them directly preserves the target
 * exactly. Re-running model-response heuristics on a suffix could delete a
 * legitimate repeated word or alter punctuation/indentation.
 */
export function reusePromptAutocompleteSuggestions(
  cachedDraft: string,
  currentDraft: string,
  cachedSuggestions: readonly string[],
  maxChars = DEFAULT_MAX_SUGGESTION_CHARS,
  maxAlternatives = DEFAULT_MAX_ALTERNATIVES,
): PromptAutocompletePrefixReuseResult | undefined {
  if (currentDraft.length <= cachedDraft.length || !currentDraft.startsWith(cachedDraft)) {
    return undefined;
  }

  const consumed = currentDraft.slice(cachedDraft.length);
  const suggestions: string[] = [];
  const origins: string[] = [];

  for (const origin of cachedSuggestions) {
    if (!origin.startsWith(consumed)) continue;
    if (!isSafeConsumedSuggestionPrefix(cachedDraft, origin, consumed.length)) continue;

    const suggestion = truncateSuggestionAtGraphemeBoundary(origin.slice(consumed.length), maxChars);
    if (!suggestion.trim() || suggestions.includes(suggestion)) continue;

    suggestions.push(suggestion);
    origins.push(origin);
    if (suggestions.length >= maxAlternatives) break;
  }

  return suggestions.length > 0 ? { suggestions, origins } : undefined;
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

/**
 * Host capabilities needed to decide whether an interactive editor slot exists.
 *
 * Pi exposes `ExtensionContext.mode`. Forks of the Pi extension API (for
 * example prime-agent, which is based on an older API revision) ship
 * `hasUI` without `mode`.
 */
export interface EditorHostCapabilities {
  /** `ExtensionContext.mode` when the host provides it. */
  mode?: unknown;
  /** `ExtensionContext.hasUI` when the host provides it. */
  hasUI?: unknown;
  /** Whether the host exposes a usable custom-editor slot. */
  canInstallEditor?: unknown;
}

/**
 * Decide whether the host runs an interactive terminal editor.
 *
 * A host that reports `mode` is authoritative: only `"tui"` may own the editor,
 * so `rpc`, `json`, and `print` stay excluded exactly as before. Only a host
 * that omits `mode` entirely is treated as a forked API revision, and then only
 * when it reports UI availability *and* exposes the custom-editor slot. Any
 * other reported value, including `null`, fails closed.
 *
 * Capabilities alone cannot prove that a host really installs custom editors:
 * some forks expose a no-op editor slot in headless front-ends. The caller must
 * still verify the installation after mounting.
 */
export function isInteractiveEditorHost(host: EditorHostCapabilities): boolean {
  if (typeof host.mode === "string") return host.mode === "tui";
  if (host.mode !== undefined) return false;
  return host.hasUI === true && host.canInstallEditor === true;
}

/**
 * Whether streamed responses can be requested from the host's pi-ai module.
 *
 * A host that exposes the simple completion API without `streamSimple` must use
 * the completion path instead of failing every request. When the module exposes
 * neither function the extension is not running inside a host that maps them,
 * so streaming support stays unknown and is reported only once a request runs.
 */
export function hostSupportsStreamedResponses(api: {
  completeSimple?: unknown;
  streamSimple?: unknown;
}): boolean {
  if (typeof api.streamSimple === "function") return true;
  return typeof api.completeSimple !== "function";
}
