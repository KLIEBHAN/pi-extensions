import { readFileSync } from "node:fs";
import type { Api, Model } from "@mariozechner/pi-ai";

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
export const DEFAULT_DEBOUNCE_MS = 350;
export const DEFAULT_MIN_PROMPT_CHARS = 0;
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
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    candidates.add(stripped.slice(arrayStart, arrayEnd + 1));
  }

  return [...candidates];
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
