import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { KeyId, KeybindingsConfig } from "@earendil-works/pi-tui";

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
/** Bound for the latest compaction summary; the middle is elided so goal and next steps survive. */
export const MAX_COMPACTION_SUMMARY_CHARS = 1_500;
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
  compactionSummaryContext: string;
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

/** What an Escape dismissal is bound to besides the draft. */
export interface PromptAutocompleteDismissalContextIdentity {
  conversationId: string;
  /** `provider/id` of the requested model, whether or not it can serve a request right now. */
  requestedModel: string;
  maxAlternatives: number;
  maxSuggestionChars: number;
}

/**
 * Context identity of an Escape dismissal.
 *
 * Unlike the prefix context key it needs no resolved, authenticated model, so a
 * refresh can compare it before any gate: switching to a model that cannot
 * serve a request still ends the dismissal.
 */
export function buildPromptAutocompleteDismissalContext(
  identity: PromptAutocompleteDismissalContextIdentity,
): string {
  return JSON.stringify([
    identity.conversationId,
    identity.requestedModel,
    identity.maxAlternatives,
    identity.maxSuggestionChars,
  ]);
}

/**
 * Whether an Escape dismissal still covers this draft in this context.
 *
 * A non-empty dismissed draft covers every draft that extends it. An empty one
 * covers only the empty draft, because every draft extends "".
 */
export function promptAutocompleteDismissalCovers(
  dismissal: { draft: string; context: string },
  draft: string,
  context: string,
): boolean {
  if (dismissal.context !== context) return false;
  return dismissal.draft.length === 0 ? draft.length === 0 : draft.startsWith(dismissal.draft);
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
  /** Keys per configurable action; invalid key names are dropped on load. */
  keys?: PromptAutocompleteKeySettings;
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
  const keys = readPersistedKeys(record.keys);
  if (keys) settings.keys = keys;
  return settings;
}

/** Saved keys per configurable action, keeping only names in Pi's key grammar. */
function readPersistedKeys(value: unknown): PromptAutocompleteKeySettings | undefined {
  if (!isRecord(value)) return undefined;
  const keys: PromptAutocompleteKeySettings = {};
  for (const action of PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS) {
    const entry = value[action];
    if (!Array.isArray(entry)) continue;
    keys[action] = entry.flatMap((raw) => {
      const key = typeof raw === "string" ? parsePromptAutocompleteKeyId(raw) : undefined;
      return key ? [key] : [];
    });
  }
  return Object.keys(keys).length > 0 ? keys : undefined;
}

/**
 * Apply a settings decision to the in-memory settings.
 *
 * `keys` merges per action, and an action set to `undefined` returns to its
 * default keys.
 */
export function applyPromptAutocompleteSettingsPatch(
  settings: PromptAutocompletePersistedSettings,
  patch: Partial<PromptAutocompletePersistedSettings>,
): PromptAutocompletePersistedSettings {
  const next = { ...settings, ...patch };
  if (patch.keys) next.keys = mergeKeySettings(settings.keys ?? {}, patch.keys);
  if (next.keys === undefined) delete next.keys;
  return next;
}

function mergeKeySettings(
  current: PromptAutocompleteKeySettings,
  patch: PromptAutocompleteKeySettings,
): PromptAutocompleteKeySettings | undefined {
  const merged: PromptAutocompleteKeySettings = { ...current, ...patch };
  for (const action of PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS) {
    if (merged[action] === undefined) delete merged[action];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Write one settings decision into the current settings file text.
 *
 * The file is re-read right before every save, so a decision another Pi
 * process saved in the meantime survives; only the decision itself changes.
 * Fields this version does not know, such as a newer version's settings, stay
 * as they are. Invalid values in the patch are not written.
 */
export function mergePromptAutocompleteSettingsText(
  currentText: string | undefined,
  patch: Partial<PromptAutocompletePersistedSettings>,
): string {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = currentText ? JSON.parse(currentText) : {};
    if (isRecord(parsed)) current = parsed;
  } catch {
    // An unreadable file is replaced by the decision, as on first save.
  }
  const { keys: patchKeys, ...scalars } = patch;
  const next: Record<string, unknown> = { ...current, ...toPersistedPayload(scalars) };
  if (patchKeys) {
    // Other actions, including ones this version does not know, stay as written.
    const keys: Record<string, unknown> = isRecord(current.keys) ? { ...current.keys } : {};
    const valid = toPersistedPayload({ keys: patchKeys }).keys ?? {};
    for (const action of PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS) {
      if (!(action in patchKeys)) continue;
      const value = valid[action];
      if (value === undefined) delete keys[action];
      else keys[action] = value;
    }
    if (Object.keys(keys).length > 0) next.keys = keys;
    else delete next.keys;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

export function serializePromptAutocompletePersistedSettings(
  settings: PromptAutocompletePersistedSettings,
): string {
  return `${JSON.stringify(toPersistedPayload(settings), null, 2)}\n`;
}

/** The valid decisions in `settings`, as they are written to the file. */
function toPersistedPayload(settings: PromptAutocompletePersistedSettings): PromptAutocompletePersistedSettings {
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
  if (settings.keys) {
    const keys: PromptAutocompleteKeySettings = {};
    for (const action of PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS) {
      const entry = settings.keys[action];
      if (entry) keys[action] = entry.filter((key) => parsePromptAutocompleteKeyId(key) === key);
    }
    if (Object.keys(keys).length > 0) payload.keys = keys;
  }
  return payload;
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

/**
 * Model-visible conversation entries, in the shape the context builders read.
 *
 * Pi 1.x builds model context from a session projection that applies
 * `context_edit` entries and compaction: an edit can omit an earlier message or
 * replace its content, for example to redact it. Autocomplete must not send
 * what the model itself no longer sees, so its context comes from that
 * projection. Message entries contribute their messages, as with the raw
 * branch. A compaction contributes only its summary text, as a
 * `compaction_summary` entry, because the projection replaced the summarized
 * messages with it; the compaction's system checkpoint is never taken. A
 * malformed projection yields no conversation context rather than raw entries.
 */
export function projectAutocompleteContextEntries(projection: unknown): unknown[] {
  if (!isRecord(projection) || !Array.isArray(projection.entries)) return [];
  const entries: unknown[] = [];
  for (const projected of projection.entries) {
    if (!isRecord(projected) || !isRecord(projected.sourceEntry) || !Array.isArray(projected.messages)) continue;
    const source = projected.sourceEntry;
    if (source.type === "compaction") {
      for (const message of projected.messages) {
        if (isRecord(message) && message.role === "compactionSummary" && typeof message.summary === "string") {
          entries.push({ type: "compaction_summary", id: source.id, summary: message.summary });
        }
      }
      continue;
    }
    if (source.type !== "message") continue;
    for (const message of projected.messages) {
      entries.push({ type: "message", id: source.id, message });
    }
  }
  return entries;
}

/**
 * The newest compaction summary among projected context entries, bounded with
 * the middle elided. Raw branches never carry `compaction_summary` entries, so
 * hosts without a projection send no summary: they still see the summarized
 * messages themselves.
 */
export function buildCompactionSummaryContext(
  entries: unknown[],
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "compaction_summary" || typeof entry.summary !== "string") continue;
    const summary = entry.summary.trim();
    if (summary) return truncateMiddle(summary, maxChars);
  }
  return "";
}

export function truncateDraftTail(draft: string, maxChars = MAX_DRAFT_CONTEXT_CHARS): string {
  if (draft.length <= maxChars) return draft;
  return draft.slice(-maxChars);
}

/**
 * Everything one autocomplete request transmits, derived from the draft and
 * the conversation branch.
 *
 * The provider request and `/prompt-autocomplete inspect` consume the same
 * snapshot and render it with the same function, so the local preview cannot
 * drift from what is sent. Credentials and headers are never part of it.
 */
export interface PromptAutocompleteRequestSnapshot {
  draft: string;
  /** The transmitted part of the draft: its last MAX_DRAFT_CONTEXT_CHARS characters. */
  draftTail: string;
  latestAssistantContext: string;
  latestUserContext: string;
  recentContext: string;
  /** Newest compaction summary the model sees; empty without one or without a host projection. */
  compactionSummaryContext: string;
  maxAlternatives: number;
  maxSuggestionChars: number;
}

export function buildPromptAutocompleteRequestSnapshot(input: {
  draft: string;
  branch: unknown[];
  maxAlternatives: number;
  maxSuggestionChars: number;
}): PromptAutocompleteRequestSnapshot {
  return {
    draft: input.draft,
    draftTail: truncateDraftTail(input.draft, MAX_DRAFT_CONTEXT_CHARS),
    latestAssistantContext: buildLatestAssistantMessageContext(input.branch),
    latestUserContext: buildLatestUserMessageContext(input.branch),
    recentContext: buildRecentConversationContext(input.branch),
    compactionSummaryContext: buildCompactionSummaryContext(input.branch),
    maxAlternatives: input.maxAlternatives,
    maxSuggestionChars: input.maxSuggestionChars,
  };
}

/**
 * Render the single user message a request sends.
 *
 * Kept separate from the snapshot so the keystroke path only gathers context;
 * the message text is produced when a provider request is actually created,
 * or when inspection asks for it.
 */
export function renderPromptAutocompleteUserText(snapshot: PromptAutocompleteRequestSnapshot): string {
  const sections: string[] = [];
  if (snapshot.latestAssistantContext) {
    sections.push(`Latest assistant message (primary context):\n${snapshot.latestAssistantContext}`);
  }
  if (snapshot.latestUserContext) {
    sections.push(`Latest user message:\n${snapshot.latestUserContext}`);
  }
  if (snapshot.recentContext) {
    sections.push(`Recent conversation summary:\n${snapshot.recentContext}`);
  }
  if (snapshot.compactionSummaryContext) {
    sections.push(`Earlier conversation summary (compacted background):\n${snapshot.compactionSummaryContext}`);
  }

  if (snapshot.draft.length === 0) {
    sections.push("Current draft is empty.");
    sections.push(
      [
        `Task: propose up to ${snapshot.maxAlternatives} ranked full next prompts the user could send now.`,
        "Each item must be a complete next prompt, not a continuation fragment.",
        "Suggest the prompt most likely to move the overall project forward.",
        "Prefer 3-10 words when possible.",
      ].join("\n"),
    );
  } else {
    if (snapshot.draftTail.length < snapshot.draft.length) {
      sections.push(
        `Current draft tail (the real draft is longer; the cursor is at the end of the full draft):\n${snapshot.draftTail}`,
      );
    } else {
      sections.push(`Current draft (cursor at end):\n${snapshot.draft}`);
    }

    sections.push(
      [
        `Task: propose up to ${snapshot.maxAlternatives} ranked continuations to insert at the cursor.`,
        "Each item must be only the text after the cursor; never restate text the user already typed.",
        "If the draft ends inside a partially typed word, complete that word directly without a leading space.",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
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

/**
 * The suggestion up to and including its first line break, or all of it when
 * it has one line; accepting it leaves the cursor at the start of the next line.
 */
export function extractSuggestionLine(suggestion: string): string {
  const lineBreak = suggestion.indexOf("\n");
  return lineBreak < 0 ? suggestion : suggestion.slice(0, lineBreak + 1);
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

/** One argument completion, in the shape Pi's slash-command autocomplete expects. */
export interface PromptAutocompleteCommandCompletion {
  /**
   * The full argument text after `/prompt-autocomplete `. Pi replaces the whole
   * argument span with it, so nested forms carry every token. A trailing space
   * leaves the cursor where the user types a value.
   */
  value: string;
  label: string;
  description: string;
}

interface PromptAutocompleteCommandSpec<Name extends string> {
  name: Name;
  /** Placeholder after the name in the usage text, if the command takes an argument. */
  usage?: string;
  /** Reports state only, so it may run on hosts without an interactive editor. */
  readOnly: boolean;
  /** The name alone is a complete submission: it reports, toggles, or previews. */
  bareComplete: boolean;
  completions: readonly PromptAutocompleteCommandCompletion[];
}

function commandSpec<Name extends string>(
  name: Name,
  description: string,
  options: {
    usage?: string;
    readOnly?: boolean;
    /** Fixed argument choices, each offered as a complete form. */
    choices?: readonly (readonly [choice: string, description: string])[];
    /** A free value: offered as the name and a space, labeled with this placeholder. */
    valuePlaceholder?: string;
    /** Arguments are optional; without choices or a value the name alone is the only form. */
    bareComplete?: boolean;
  } = {},
): PromptAutocompleteCommandSpec<Name> {
  const completions: PromptAutocompleteCommandCompletion[] = [];
  const takesArgument = !!options.choices || !!options.valuePlaceholder;
  if (!takesArgument) completions.push({ value: name, label: name, description });
  for (const [choice, choiceDescription] of options.choices ?? []) {
    completions.push({ value: `${name} ${choice}`, label: `${name} ${choice}`, description: choiceDescription });
  }
  if (options.valuePlaceholder) {
    completions.push({ value: `${name} `, label: `${name} ${options.valuePlaceholder}`, description });
  }
  return {
    name,
    usage: options.usage,
    readOnly: options.readOnly ?? false,
    bareComplete: !takesArgument || (options.bareComplete ?? false),
    completions,
  };
}

/**
 * Keys accepted by `/prompt-autocomplete set`. Numeric keys carry their bounds,
 * which both validation and the usage text use. `bareReports` marks a key that
 * reports its value when submitted without one, so it is a complete command.
 */
export const PROMPT_AUTOCOMPLETE_SET_KEYS = [
  { key: "debounce-ms", min: DEBOUNCE_MS_MIN, max: DEBOUNCE_MS_MAX, description: "Delay before an automatic request, in milliseconds" },
  { key: "min-chars", min: MIN_PROMPT_CHARS_MIN, max: MIN_PROMPT_CHARS_MAX, bareReports: true, description: "Minimum draft length for automatic suggestions" },
  { key: "max-chars", min: MAX_SUGGESTION_CHARS_MIN, max: MAX_SUGGESTION_CHARS_MAX, description: "Maximum characters per suggestion" },
  { key: "max-alternatives", min: MAX_ALTERNATIVES_MIN, max: MAX_ALTERNATIVES_MAX, description: "Maximum alternatives per request" },
  { key: "model", description: "Model for autocomplete requests" },
  { key: "key", description: "Keys for a Prompt Autocomplete action" },
] as const;

export type PromptAutocompleteSetKey = (typeof PROMPT_AUTOCOMPLETE_SET_KEYS)[number]["key"];

/** Usage placeholder of one set key, e.g. `<0-5000>`. */
export function formatSetKeyPlaceholder(spec: (typeof PROMPT_AUTOCOMPLETE_SET_KEYS)[number]): string {
  if ("min" in spec) return `<${spec.min}-${spec.max}>`;
  return spec.key === "key" ? "<action> <key...|default|none>" : "<provider/model|active>";
}

const SET_COMPLETIONS: readonly PromptAutocompleteCommandCompletion[] = PROMPT_AUTOCOMPLETE_SET_KEYS.flatMap((spec) => [
  ...(spec.key === "model"
    ? [{ value: "set model active", label: "set model active", description: "Follow the session model" }]
    : []),
  {
    value: `set ${spec.key} `,
    // `active` has its own entry above, so the model label leaves it out and
    // fits Pi's 30-column label space.
    label: `set ${spec.key} ${"min" in spec ? formatSetKeyPlaceholder(spec) : spec.key === "key" ? "<action> <keys>" : "<provider/model>"}`,
    description: spec.description,
  },
]);


const ON_OFF_TOGGLE = (subject: string) => [
  ["on", `Turn ${subject} on`],
  ["off", `Turn ${subject} off`],
  ["toggle", `Switch ${subject}`],
] as const;

/**
 * Prompt Autocomplete's key actions: command name for `set key`, label for
 * hints, and default keys, the first of which hints show.
 *
 * `accept` and `dismiss` take `tab` and `escape` only while ghost text is
 * visible and are fixed. The configurable actions act only on input that Pi
 * leaves free, so a user's Pi keymap or a Pi default on the same key wins.
 */
export const PROMPT_AUTOCOMPLETE_KEY_ACTIONS = {
  accept: { command: "accept", keys: ["tab"] },
  acceptWord: { command: "accept-word", keys: ["ctrl+space", "ctrl+tab"] },
  acceptLine: { command: "accept-line", keys: [] },
  /** Also the manual one-shot trigger when no suggestion is shown. */
  cycleNext: { command: "cycle-next", keys: ["ctrl+.", "alt+]"] },
  cyclePrev: { command: "cycle-prev", keys: ["ctrl+,", "alt+["] },
  dismiss: { command: "dismiss", keys: ["escape"] },
} as const satisfies Record<string, { command: string; keys: readonly KeyId[] }>;

export type PromptAutocompleteKeyAction = keyof typeof PROMPT_AUTOCOMPLETE_KEY_ACTIONS;

/** Actions whose keys `set key` changes, in resolution order. */
export const PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS = [
  "acceptWord",
  "acceptLine",
  "cycleNext",
  "cyclePrev",
] as const satisfies readonly PromptAutocompleteKeyAction[];

export type PromptAutocompleteConfigurableKeyAction = (typeof PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS)[number];

/** Saved keys per configurable action; an empty list unbinds the action. */
export type PromptAutocompleteKeySettings = Partial<Record<PromptAutocompleteConfigurableKeyAction, KeyId[]>>;

export function findConfigurableKeyAction(command: string): PromptAutocompleteConfigurableKeyAction | undefined {
  return PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS.find(
    (action) => PROMPT_AUTOCOMPLETE_KEY_ACTIONS[action].command === command,
  );
}

const KEY_MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const KEY_NAME_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };
/** US-layout symbols that Shift produces; Pi matches both spellings of such a key. */
const SHIFTED_SYMBOLS: Record<string, string> = {
  "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", ",": "<", ".": ">", "/": "?",
};
/** Key ids that legacy terminals encode as the same bytes as another key id. */
const LEGACY_EQUIVALENT_KEYS: Record<string, string> = {
  "ctrl+i": "tab",
  "ctrl+[": "escape",
  "ctrl+m": "enter",
  "ctrl+h": "backspace",
  "ctrl+_": "ctrl+-",
};
/**
 * Pi's named keys, the values of pi-tui's `Key` (a test keeps them equal).
 * Listed here because importing pi-tui at runtime would stop this module from
 * loading where `Intl.Segmenter` is missing.
 */
export const PI_KEY_NAMES: readonly string[] = [
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end",
  "pageUp", "pageDown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")",
  "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
];
/** Pi's key names by lowercase spelling (`pageup` → `pageUp`). */
const PI_KEY_NAMES_BY_LOWERCASE = new Map(PI_KEY_NAMES.map((name) => [name.toLowerCase(), name] as const));

/** Modifiers and base key of a key id; `ctrl++` keeps its `+` key. */
function splitKeyId(key: string): { modifiers: Set<string>; base: string } {
  let rest = key.toLowerCase();
  const modifiers = new Set<string>();
  for (let matched = true; matched;) {
    matched = false;
    for (const modifier of KEY_MODIFIER_ORDER) {
      if (rest.startsWith(`${modifier}+`) && rest.length > modifier.length + 1) {
        modifiers.add(modifier);
        rest = rest.slice(modifier.length + 1);
        matched = true;
      }
    }
  }
  const base = KEY_NAME_ALIASES[rest] ?? rest;
  // `ctrl+shift+=` and `ctrl++` name the same keypress.
  const shifted = modifiers.has("shift") ? SHIFTED_SYMBOLS[base] : undefined;
  if (!shifted) return { modifiers, base };
  modifiers.delete("shift");
  return { modifiers, base: shifted };
}

/**
 * Comparable form of a key id: lowercase, modifiers in a fixed order, Pi's key
 * name aliases resolved, Shift plus a symbol folded into the shifted symbol,
 * and legacy byte-equivalent keys folded together.
 */
export function canonicalKeyId(key: string): string {
  const normalized = normalizeKeyId(key);
  return LEGACY_EQUIVALENT_KEYS[normalized] ?? normalized;
}

/** `canonicalKeyId` without folding legacy byte equivalents. */
function normalizeKeyId(key: string): string {
  const { modifiers, base } = splitKeyId(key);
  return [...KEY_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), base].join("+");
}

/** Pi's spelling of a key id in its documented grammar, or undefined. */
function spellKeyId(raw: string): string | undefined {
  let rest = raw.trim().toLowerCase();
  const modifiers: string[] = [];
  for (;;) {
    const modifier = KEY_MODIFIER_ORDER.find(
      (candidate) => rest.startsWith(`${candidate}+`) && rest.length > candidate.length + 1,
    );
    if (!modifier) break;
    if (modifiers.includes(modifier)) return undefined;
    modifiers.push(modifier);
    rest = rest.slice(modifier.length + 1);
  }
  const base = /^[a-z0-9]$/.test(rest) ? rest : PI_KEY_NAMES_BY_LOWERCASE.get(rest);
  return base === undefined ? undefined : [...modifiers, base].join("+");
}

function isKeyId(value: string): value is KeyId {
  return spellKeyId(value) === value;
}

/**
 * Parse a key in Pi's documented grammar (`ctrl+shift+x`, `alt+]`, `f5`):
 * modifiers `ctrl`, `shift`, `alt`, `super` at most once each, then a letter,
 * digit, or one of Pi's key names. Case-insensitive; returns Pi's spelling.
 */
export function parsePromptAutocompleteKeyId(raw: string): KeyId | undefined {
  const spelled = spellKeyId(raw);
  return spelled !== undefined && isKeyId(spelled) ? spelled : undefined;
}

const RESERVED_KEYS = new Set(["tab", "escape", "enter", "backspace"]);
const EDITOR_HARD_CODED_KEYS = new Set(["shift+space", "shift+backspace", "shift+delete", "shift+enter"]);

/**
 * Why a key cannot be a Prompt Autocomplete key, or undefined if it can.
 *
 * Tab, Escape, Enter, and Backspace (also as their legacy aliases such as
 * `ctrl+i`), the keys Pi's editor handles outside its keymap, keys that type
 * text, and keys Pi's matcher never recognizes (Escape or F1–F12 with a
 * modifier) would never reach the action, or would take text away.
 */
export function describeUnusablePromptAutocompleteKey(key: string): string | undefined {
  const canonical = canonicalKeyId(key);
  if (RESERVED_KEYS.has(canonical)) {
    return LEGACY_EQUIVALENT_KEYS[normalizeKeyId(key)] ? `${key} is the same input as ${canonical}` : `${key} is reserved`;
  }
  if (EDITOR_HARD_CODED_KEYS.has(canonical)) return `Pi's editor handles ${key}`;
  const { modifiers, base } = splitKeyId(key);
  if (modifiers.size > 0 && (base === "escape" || /^f([1-9]|1[0-2])$/.test(base))) {
    return `Pi does not recognize ${key}`;
  }
  const typesText = [...modifiers].every((modifier) => modifier === "shift")
    && (base.length === 1 || base === "space");
  return typesText ? `${key} types text` : undefined;
}

/** Effective Prompt Autocomplete keys, where each came from, and what was dropped. */
export interface PromptAutocompleteKeymap {
  keys: Record<PromptAutocompleteKeyAction, readonly KeyId[]>;
  sources: Record<PromptAutocompleteConfigurableKeyAction, "default" | "saved">;
  /** Saved keys that cannot be used, with the reason. */
  ignored: string[];
}

/** Every action with its effective keys and their source, in hint order. */
export function listPromptAutocompleteKeys(
  keymap: PromptAutocompleteKeymap,
): Array<{ command: string; keys: readonly KeyId[]; source: "default" | "saved" | "fixed" }> {
  const fixed = (action: "accept" | "dismiss") => ({
    command: PROMPT_AUTOCOMPLETE_KEY_ACTIONS[action].command,
    keys: keymap.keys[action],
    source: "fixed" as const,
  });
  return [
    fixed("accept"),
    ...PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS.map((action) => ({
      command: PROMPT_AUTOCOMPLETE_KEY_ACTIONS[action].command,
      keys: keymap.keys[action],
      source: keymap.sources[action],
    })),
    fixed("dismiss"),
  ];
}

/**
 * Resolve saved keys over the defaults.
 *
 * A key that cannot be used, or that an earlier action already has (fixed
 * actions first, then the configurable ones in table order), is dropped, so
 * one keypress always means one action.
 */
export function resolvePromptAutocompleteKeymap(saved: PromptAutocompleteKeySettings = {}): PromptAutocompleteKeymap {
  const { accept, dismiss } = PROMPT_AUTOCOMPLETE_KEY_ACTIONS;
  const owners = new Map<string, PromptAutocompleteKeyAction>();
  for (const key of accept.keys) owners.set(canonicalKeyId(key), "accept");
  for (const key of dismiss.keys) owners.set(canonicalKeyId(key), "dismiss");
  const configurable: Record<PromptAutocompleteConfigurableKeyAction, KeyId[]> = {
    acceptWord: [],
    acceptLine: [],
    cycleNext: [],
    cyclePrev: [],
  };
  const sources: PromptAutocompleteKeymap["sources"] = {
    acceptWord: "default",
    acceptLine: "default",
    cycleNext: "default",
    cyclePrev: "default",
  };
  const ignored: string[] = [];
  for (const action of PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS) {
    const configured = saved[action];
    if (configured) sources[action] = "saved";
    for (const key of configured ?? PROMPT_AUTOCOMPLETE_KEY_ACTIONS[action].keys) {
      const canonical = canonicalKeyId(key);
      const owner = owners.get(canonical);
      if (owner === action) continue;
      const reason = describeUnusablePromptAutocompleteKey(key)
        ?? (owner ? `${key} already ${PROMPT_AUTOCOMPLETE_KEY_ACTIONS[owner].command}` : undefined);
      if (reason) {
        ignored.push(reason);
        continue;
      }
      owners.set(canonical, action);
      configurable[action].push(key);
    }
  }
  return { keys: { ...configurable, accept: accept.keys, dismiss: dismiss.keys }, sources, ignored };
}

/**
 * Pi actions whose resolved keys look like `key`.
 *
 * For diagnostics only. The editor decides at input time with Pi's own
 * matcher, so a miss here can hide a warning but never let a key act on input
 * that Pi uses.
 */
export function findPiKeyConflicts(key: string, resolvedBindings: KeybindingsConfig): string[] {
  const wanted = canonicalKeyId(key);
  const conflicts: string[] = [];
  for (const [action, keys] of Object.entries(resolvedBindings)) {
    if (keys === undefined) continue;
    if ((Array.isArray(keys) ? keys : [keys]).some((bound) => canonicalKeyId(bound) === wanted)) {
      conflicts.push(action);
    }
  }
  return conflicts;
}

/** `set key` forms, offered once `set key ` is typed so `set ` stays short. */
const SET_KEY_COMPLETIONS: readonly PromptAutocompleteCommandCompletion[] = PROMPT_AUTOCOMPLETE_CONFIGURABLE_KEY_ACTIONS
  .flatMap((action) => {
    const { command } = PROMPT_AUTOCOMPLETE_KEY_ACTIONS[action];
    return [
      { value: `set key ${command} `, label: `set key ${command} <keys>`, description: "Space-separated keys" },
      { value: `set key ${command} default`, label: `set key ${command} default`, description: "Restore the default keys" },
      { value: `set key ${command} none`, label: `set key ${command} none`, description: "Unbind the action" },
    ];
  });

/**
 * The `/prompt-autocomplete` grammar: the single source for dispatch, usage
 * text, and argument completion. Order is the order of the usage text.
 */
export const PROMPT_AUTOCOMPLETE_COMMANDS = [
  commandSpec("on", "Enable inline suggestions and save the decision"),
  commandSpec("off", "Disable inline suggestions and save the decision"),
  commandSpec("toggle", "Switch inline suggestions on or off"),
  commandSpec("status", "Show configuration and request state", { readOnly: true }),
  commandSpec("stats", "Show session requests, cache hits, tokens, and cost", { readOnly: true }),
  commandSpec("inspect", "Preview locally what a request would send", { usage: "[draft]", readOnly: true }),
  commandSpec("min-chars", "Set and save the minimum draft length", {
    usage: "<n>",
    valuePlaceholder: `<${MIN_PROMPT_CHARS_MIN}-${MIN_PROMPT_CHARS_MAX}>`,
    bareComplete: true,
  }),
  commandSpec("budget", "Cap provider requests for this session", {
    usage: "<n|off>",
    choices: [["off", "Remove the session request ceiling"]],
    valuePlaceholder: `<${BUDGET_REQUESTS_MIN}-${BUDGET_REQUESTS_MAX}>`,
    bareComplete: true,
  }),
  {
    ...commandSpec("set", "Show runtime knobs", { usage: "<key> [value]", bareComplete: true }),
    completions: SET_COMPLETIONS,
  },
  commandSpec("keys", "Show the key for every action", { readOnly: true }),
  commandSpec("stream", "Toggle streamed response previews", {
    usage: "on|off|toggle",
    choices: ON_OFF_TOGGLE("streamed previews"),
    bareComplete: true,
  }),
  commandSpec("while-streaming", "Toggle suggestions while the agent works", {
    usage: "on|off|toggle",
    choices: ON_OFF_TOGGLE("suggestions while the agent works"),
    bareComplete: true,
  }),
  commandSpec("debug-on", "Show the debug status line"),
  commandSpec("debug-off", "Hide the debug status line"),
  commandSpec("debug-toggle", "Switch the debug status line"),
] as const;

export type PromptAutocompleteCommandName = (typeof PROMPT_AUTOCOMPLETE_COMMANDS)[number]["name"];

export function findPromptAutocompleteCommand(
  name: string,
): (typeof PROMPT_AUTOCOMPLETE_COMMANDS)[number] | undefined {
  return PROMPT_AUTOCOMPLETE_COMMANDS.find((spec) => spec.name === name);
}

export function findPromptAutocompleteSetKey(
  key: string,
): (typeof PROMPT_AUTOCOMPLETE_SET_KEYS)[number] | undefined {
  return PROMPT_AUTOCOMPLETE_SET_KEYS.find((spec) => spec.key === key);
}

export const PROMPT_AUTOCOMPLETE_USAGE = `Usage: /prompt-autocomplete [${PROMPT_AUTOCOMPLETE_COMMANDS.map((spec) =>
  spec.usage ? `${spec.name} ${spec.usage}` : spec.name
).join("|")}]`;

export const PROMPT_AUTOCOMPLETE_SET_USAGE = `Usage: /prompt-autocomplete set [${PROMPT_AUTOCOMPLETE_SET_KEYS.map((spec) =>
  `${spec.key} ${formatSetKeyPlaceholder(spec)}`
).join("|")}]`;

const ALL_COMMAND_COMPLETIONS: readonly PromptAutocompleteCommandCompletion[] = PROMPT_AUTOCOMPLETE_COMMANDS.flatMap(
  (spec) => spec.completions,
);

/**
 * Argument texts that are complete submissions on their own. Typing one of
 * these exactly must not open the menu: while it is open, Enter applies a
 * completion instead of submitting, so `stats` would need Enter twice.
 */
const COMPLETE_ARGUMENTS: ReadonlySet<string> = new Set([
  ...PROMPT_AUTOCOMPLETE_COMMANDS.filter((spec) => spec.bareComplete).map((spec) => spec.name),
  ...PROMPT_AUTOCOMPLETE_SET_KEYS.filter((spec) => "bareReports" in spec).map((spec) => `set ${spec.key}`),
  ...[...ALL_COMMAND_COMPLETIONS, ...SET_KEY_COMPLETIONS]
    .map((completion) => completion.value)
    .filter((value) => !value.endsWith(" ")),
]);

/**
 * Complete the argument span of `/prompt-autocomplete`.
 *
 * Purely local and synchronous: forms that strictly extend the typed text,
 * matched case-insensitively with whitespace collapsed, in grammar order.
 * Returns null when nothing matches or when the typed text is already a
 * complete submission, so Enter keeps submitting it.
 */
export function completePromptAutocompleteArguments(
  argumentPrefix: string,
): PromptAutocompleteCommandCompletion[] | null {
  const typed = argumentPrefix.trimStart().replace(/\s+/g, " ").toLowerCase();
  if (COMPLETE_ARGUMENTS.has(typed)) return null;
  const matches = (typed.startsWith("set key ") ? SET_KEY_COMPLETIONS : ALL_COMMAND_COMPLETIONS)
    .filter((completion) => completion.value.length > typed.length && completion.value.startsWith(typed))
    .map((completion) => ({ ...completion }));
  return matches.length > 0 ? matches : null;
}
