import { completeSimple, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type EditorTheme, type KeyId, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import {
  buildLatestAssistantMessageContext,
  buildLatestUserMessageContext,
  buildRecentConversationContext,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_ALTERNATIVES,
  DEFAULT_MAX_SUGGESTION_CHARS,
  DEFAULT_MIN_PROMPT_CHARS,
  DEFAULT_PREFERRED_MODEL,
  extractNextSuggestionChunk,
  formatModelLabel,
  MAX_DRAFT_CONTEXT_CHARS,
  normalizePromptSuggestions,
  parseBoundedIntFlag,
  parseModelRef,
  PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
  truncateDraftTail,
  type ModelRef,
} from "./core.ts";

const GHOST_TEXT_STYLE = "\x1b[2m";
const GHOST_INDICATOR_STYLE = "\x1b[90m";
const RESET = "\x1b[0m";
const CURSOR_TOKEN = "\x1b[7m \x1b[0m";
const REQUEST_MAX_TOKENS = 192;
const FAILURE_COOLDOWN_MS = 5_000;
const REQUEST_CACHE_TTL_MS = 60_000;
const REQUEST_CACHE_MAX_ENTRIES = 128;
const WORD_ACCEPT_KEYS: readonly KeyId[] = ["ctrl+space", "ctrl+tab"];
const CYCLE_NEXT_KEYS: readonly KeyId[] = ["ctrl+.", "alt+]"];
const CYCLE_PREV_KEYS: readonly KeyId[] = ["ctrl+,", "alt+["];

interface PromptAutocompleteConfig {
  allowWhileStreaming: boolean;
  debug: boolean;
  debounceMs: number;
  minPromptChars: number;
  maxSuggestionChars: number;
  maxAlternatives: number;
  preferredModel?: ModelRef;
}

interface PromptAutocompleteCacheEntry {
  suggestions: string[];
  rawResponse?: string;
  error?: string;
  debugState?: string;
  expiresAt: number;
}

interface SuggestionRefreshOptions {
  clearExisting?: boolean;
  immediate?: boolean;
}

interface PromptAutocompleteSharedState {
  enabled: boolean;
  activationId: number;
  streaming: boolean;
  config: PromptAutocompleteConfig;
  currentModel?: Model<Api>;
  modelRegistry?: ExtensionContext["modelRegistry"];
  sessionManager?: ExtensionContext["sessionManager"];
  debugState: string;
  lastError?: string;
  lastRawResponse?: string;
  requestCache: Map<string, PromptAutocompleteCacheEntry>;
  inFlightRequests: Map<string, Promise<PromptAutocompleteCacheEntry>>;
  refreshEditor?: (options?: SuggestionRefreshOptions) => void;
  setStatusText?: (text: string | undefined) => void;
}

interface SuggestionRequest {
  activationId: number;
  draft: string;
  draftTail: string;
  model: Model<Api>;
  modelLabel: string;
  cacheKey: string;
  maxAlternatives: number;
  latestAssistantContext: string;
  latestUserContext: string;
  recentContext: string;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function matchesAnyKey(data: string, keys: readonly KeyId[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}

function formatPrimaryKey(keys: readonly KeyId[]): string {
  return keys[0] ?? "";
}

function resolveSuggestionModel(shared: PromptAutocompleteSharedState): Model<Api> | undefined {
  const registry = shared.modelRegistry;
  if (!registry) return undefined;

  if (shared.config.preferredModel) {
    const preferred = registry.find(shared.config.preferredModel.provider, shared.config.preferredModel.id);
    if (preferred && registry.hasConfiguredAuth(preferred)) {
      return preferred as Model<Api>;
    }
  }

  if (shared.currentModel && registry.hasConfiguredAuth(shared.currentModel)) {
    return shared.currentModel as Model<Api>;
  }

  return undefined;
}

function parseConfig(pi: ExtensionAPI): PromptAutocompleteConfig {
  return {
    allowWhileStreaming: pi.getFlag("prompt-autocomplete-while-streaming") === true,
    debug: pi.getFlag("prompt-autocomplete-debug") === true,
    debounceMs: parseBoundedIntFlag(pi.getFlag("prompt-autocomplete-debounce-ms"), DEFAULT_DEBOUNCE_MS, 0, 5_000),
    minPromptChars: parseBoundedIntFlag(pi.getFlag("prompt-autocomplete-min-chars"), DEFAULT_MIN_PROMPT_CHARS, 0, 500),
    maxSuggestionChars: parseBoundedIntFlag(
      pi.getFlag("prompt-autocomplete-max-chars"),
      DEFAULT_MAX_SUGGESTION_CHARS,
      16,
      1_000,
    ),
    maxAlternatives: parseBoundedIntFlag(
      pi.getFlag("prompt-autocomplete-max-alternatives"),
      DEFAULT_MAX_ALTERNATIVES,
      1,
      5,
    ),
    preferredModel: parseModelRef(pi.getFlag("prompt-autocomplete-model")),
  };
}

function truncateDebug(text: string, maxLength = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function updateDebugState(shared: PromptAutocompleteSharedState, state: string, details?: string): void {
  const nextState = details ? `${state}: ${truncateDebug(details)}` : state;
  shared.debugState = nextState;
  shared.setStatusText?.(shared.config.debug ? nextState : undefined);
}

function clearDebugUi(shared: PromptAutocompleteSharedState): void {
  shared.setStatusText?.(undefined);
}

function formatStatus(shared: PromptAutocompleteSharedState): string {
  pruneRequestCache(shared);
  const resolvedModel = resolveSuggestionModel(shared);
  const requestedModel = shared.config.preferredModel
    ? `${shared.config.preferredModel.provider}/${shared.config.preferredModel.id}`
    : "current model";

  return [
    `enabled=${shared.enabled ? "yes" : "no"}`,
    `model=${formatModelLabel(resolvedModel)}`,
    `requested-model=${requestedModel}`,
    `while-streaming=${shared.config.allowWhileStreaming ? "yes" : "no"}`,
    `debug=${shared.config.debug ? "yes" : "no"}`,
    `debounce=${shared.config.debounceMs}ms`,
    `min-chars=${shared.config.minPromptChars}`,
    `max-suggestion-chars=${shared.config.maxSuggestionChars}`,
    `max-alternatives=${shared.config.maxAlternatives}`,
    `cache-size=${shared.requestCache.size}`,
    `state=${shared.debugState || "idle"}`,
    shared.lastError ? `error=${truncateDebug(shared.lastError, 90)}` : undefined,
    shared.lastRawResponse ? `raw=${truncateDebug(shared.lastRawResponse, 90)}` : undefined,
    `keys=tab accept | ${formatPrimaryKey(WORD_ACCEPT_KEYS)} word | ${formatPrimaryKey(CYCLE_PREV_KEYS)}/${formatPrimaryKey(CYCLE_NEXT_KEYS)} cycle`,
  ]
    .filter((value): value is string => !!value)
    .join(" | ");
}

function shouldSkipPromptAutocomplete(text: string): boolean {
  const trimmedStart = text.trimStart();
  if (trimmedStart.startsWith("/") || trimmedStart.startsWith("!")) return true;

  const lastLine = text.split("\n").pop() ?? "";
  const textBeforeCursor = lastLine;

  if (/(?:^|[ \t])@(?:"[^"]*|[^\s]*)$/.test(textBeforeCursor)) return true;
  if (/(?:^|[ \t])(?:~\/|\.\.?\/|\/)[^\s]*$/.test(textBeforeCursor)) return true;

  return false;
}

function pruneRequestCache(shared: PromptAutocompleteSharedState): void {
  const now = Date.now();
  for (const [key, entry] of shared.requestCache) {
    if (entry.expiresAt <= now) {
      shared.requestCache.delete(key);
    }
  }

  while (shared.requestCache.size > REQUEST_CACHE_MAX_ENTRIES) {
    const oldestKey = shared.requestCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    shared.requestCache.delete(oldestKey);
  }
}

function getCachedRequest(
  shared: PromptAutocompleteSharedState,
  cacheKey: string,
): PromptAutocompleteCacheEntry | undefined {
  pruneRequestCache(shared);
  const entry = shared.requestCache.get(cacheKey);
  if (!entry) return undefined;

  shared.requestCache.delete(cacheKey);
  shared.requestCache.set(cacheKey, entry);
  return {
    ...entry,
    suggestions: [...entry.suggestions],
  };
}

function storeCachedRequest(
  shared: PromptAutocompleteSharedState,
  cacheKey: string,
  entry: Omit<PromptAutocompleteCacheEntry, "expiresAt">,
): PromptAutocompleteCacheEntry {
  const cachedEntry: PromptAutocompleteCacheEntry = {
    ...entry,
    suggestions: [...entry.suggestions],
    expiresAt: Date.now() + REQUEST_CACHE_TTL_MS,
  };

  shared.requestCache.delete(cacheKey);
  shared.requestCache.set(cacheKey, cachedEntry);
  pruneRequestCache(shared);
  return {
    ...cachedEntry,
    suggestions: [...cachedEntry.suggestions],
  };
}

class PromptAutocompleteEditor extends CustomEditor {
  private readonly shared: PromptAutocompleteSharedState;
  private readonly activationId: number;

  private suggestions: string[] = [];
  private suggestionIndex: number = 0;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private requestSeq = 0;
  private pendingRequestKey?: string;
  private abortController?: AbortController;
  private suspendedUntil = 0;
  private lastResolvedKey = "";
  private lastResolvedSuggestions: string[] = [];
  private dismissedKey?: string;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: any,
    shared: PromptAutocompleteSharedState,
    activationId: number,
  ) {
    super(tui, theme, keybindings);
    this.shared = shared;
    this.activationId = activationId;
  }

  override setText(text: string): void {
    super.setText(text);
    this.refreshSuggestion();
  }

  override insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(text);
    this.refreshSuggestion();
  }

  override handleInput(data: string): void {
    if (this.canDismissInlineSuggestion(data)) {
      this.dismissedKey = this.buildRequest()?.cacheKey;
      this.cancelPendingRequest();
      updateDebugState(this.shared, "dismissed", "Suggestion dismissed for current draft");
      this.setSuggestions([]);
      return;
    }

    if (this.canCycleSuggestions(data)) {
      this.cycleSuggestions(matchesAnyKey(data, CYCLE_NEXT_KEYS) ? 1 : -1);
      return;
    }

    if (this.canAcceptInlineSuggestionByWord(data)) {
      this.acceptInlineSuggestionByWord();
      return;
    }

    if (this.canAcceptInlineSuggestion(data)) {
      this.acceptInlineSuggestion();
      return;
    }

    const beforeText = this.getText();
    const beforeCursor = this.getCursor();
    const beforeAutocomplete = this.isShowingAutocomplete();

    super.handleInput(data);

    const afterText = this.getText();
    const afterCursor = this.getCursor();
    const afterAutocomplete = this.isShowingAutocomplete();

    const textChanged = beforeText !== afterText;
    const cursorChanged = beforeCursor.line !== afterCursor.line || beforeCursor.col !== afterCursor.col;
    const autocompleteChanged = beforeAutocomplete !== afterAutocomplete;

    if (textChanged || cursorChanged || autocompleteChanged || this.getActiveSuggestion()) {
      this.refreshSuggestion();
    }
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const activeSuggestion = this.getActiveSuggestion();
    if (!this.shouldRenderInlineSuggestion() || !activeSuggestion) {
      return lines;
    }

    const cursorLineIndex = lines.findIndex((line) => line.includes(CURSOR_TOKEN));
    if (cursorLineIndex === -1) return lines;

    const cursorLine = lines[cursorLineIndex]!;
    const cursorIndex = cursorLine.indexOf(CURSOR_TOKEN);
    if (cursorIndex === -1) return lines;

    const before = cursorLine.slice(0, cursorIndex);
    const after = cursorLine.slice(cursorIndex + CURSOR_TOKEN.length);
    const availableWidth = visibleWidth(after);
    if (availableWidth <= 0) return lines;

    const previewText = activeSuggestion.replace(/\n/g, " ⏎ ");
    const previewChars = Array.from(previewText);
    const firstPreviewChar = previewChars[0] ?? "";
    const absorbLeadingWhitespaceIntoCursor = /^[ \t]$/.test(firstPreviewChar);

    const cursorCell = absorbLeadingWhitespaceIntoCursor ? `\x1b[7m${firstPreviewChar}\x1b[0m` : CURSOR_TOKEN;
    const renderedPreviewText = absorbLeadingWhitespaceIntoCursor ? previewChars.slice(1).join("") : previewText;

    const indicator = this.suggestions.length > 1 ? `  ‹${this.suggestionIndex + 1}/${this.suggestions.length}›` : "";
    const indicatorWidth = indicator ? visibleWidth(indicator) : 0;
    const showIndicator = indicatorWidth > 0 && availableWidth >= indicatorWidth + 8;
    const textWidth = Math.max(0, availableWidth - (showIndicator ? indicatorWidth : 0));
    const truncatedText = textWidth > 0
      ? truncateToWidth(renderedPreviewText, textWidth, textWidth > 1 ? "…" : "")
      : "";
    const renderedIndicator = showIndicator ? indicator : "";
    const renderedWidth = visibleWidth(truncatedText) + (showIndicator ? indicatorWidth : 0);
    const padding = " ".repeat(Math.max(0, availableWidth - renderedWidth));

    lines[cursorLineIndex] =
      `${before}${cursorCell}` +
      `${truncatedText ? `${GHOST_TEXT_STYLE}${truncatedText}${RESET}` : ""}` +
      `${showIndicator ? `${GHOST_INDICATOR_STYLE}${renderedIndicator}${RESET}` : ""}${padding}`;
    return lines;
  }

  refreshFromExternalChange(options: SuggestionRefreshOptions = {}): void {
    this.refreshSuggestion({
      clearExisting: options.clearExisting ?? true,
      immediate: options.immediate ?? true,
    });
  }

  private getActiveSuggestion(): string | undefined {
    return this.suggestions[this.suggestionIndex];
  }

  private setSuggestions(nextSuggestions: string[]): void {
    const currentActive = this.getActiveSuggestion();
    let nextIndex = 0;

    if (currentActive) {
      const preservedIndex = nextSuggestions.indexOf(currentActive);
      if (preservedIndex !== -1) {
        nextIndex = preservedIndex;
      }
    }

    if (nextSuggestions.length === 0) {
      nextIndex = 0;
    } else if (nextIndex >= nextSuggestions.length) {
      nextIndex = 0;
    }

    if (arraysEqual(this.suggestions, nextSuggestions) && this.suggestionIndex === nextIndex) {
      return;
    }

    this.suggestions = [...nextSuggestions];
    this.suggestionIndex = nextIndex;

    if (nextSuggestions.length > 0) {
      updateDebugState(
        this.shared,
        "showing",
        `${nextSuggestions.length} suggestion(s), selected ${nextIndex + 1}/${nextSuggestions.length}`,
      );
    }

    this.tui.requestRender();
  }

  private cycleSuggestions(delta: 1 | -1): void {
    if (this.suggestions.length <= 1) return;
    const nextIndex = (this.suggestionIndex + delta + this.suggestions.length) % this.suggestions.length;
    if (nextIndex === this.suggestionIndex) return;
    this.suggestionIndex = nextIndex;
    this.dismissedKey = undefined;
    updateDebugState(this.shared, "cycled", `Now showing ${nextIndex + 1}/${this.suggestions.length}`);
    this.tui.requestRender();
  }

  private canDismissInlineSuggestion(data: string): boolean {
    return this.shouldRenderInlineSuggestion() && !!this.getActiveSuggestion() && matchesKey(data, "escape");
  }

  private canAcceptInlineSuggestion(data: string): boolean {
    return this.shouldRenderInlineSuggestion() && !!this.getActiveSuggestion() && matchesKey(data, "tab");
  }

  private canAcceptInlineSuggestionByWord(data: string): boolean {
    return this.shouldRenderInlineSuggestion() && !!this.getActiveSuggestion() && matchesAnyKey(data, WORD_ACCEPT_KEYS);
  }

  private canCycleSuggestions(data: string): boolean {
    if (!this.shouldRenderInlineSuggestion()) return false;
    if (this.suggestions.length <= 1) return false;
    return matchesAnyKey(data, CYCLE_NEXT_KEYS) || matchesAnyKey(data, CYCLE_PREV_KEYS);
  }

  private acceptInlineSuggestion(): void {
    const suggestion = this.getActiveSuggestion();
    if (!suggestion) return;

    this.cancelPendingRequest();
    this.dismissedKey = undefined;
    updateDebugState(this.shared, "accepted", "Accepted full suggestion");
    this.setSuggestions([]);
    super.insertTextAtCursor(suggestion);
    this.refreshSuggestion();
  }

  private acceptInlineSuggestionByWord(): void {
    const suggestion = this.getActiveSuggestion();
    if (!suggestion) return;

    const chunk = extractNextSuggestionChunk(suggestion) ?? suggestion;
    if (!chunk) return;

    this.cancelPendingRequest();
    this.dismissedKey = undefined;
    updateDebugState(this.shared, "accepted-word", `Accepted chunk: ${chunk}`);
    this.setSuggestions([]);
    super.insertTextAtCursor(chunk);
    this.refreshSuggestion();
  }

  private shouldRenderInlineSuggestion(): boolean {
    return (
      this.shared.enabled &&
      this.activationId === this.shared.activationId &&
      this.suggestions.length > 0 &&
      !this.isShowingAutocomplete() &&
      this.isCursorAtEndOfDraft()
    );
  }

  private isCursorAtEndOfDraft(): boolean {
    const lines = this.getLines();
    const cursor = this.getCursor();
    if (lines.length === 0) return false;
    if (cursor.line !== lines.length - 1) return false;
    return cursor.col === (lines[cursor.line]?.length ?? 0);
  }

  private getSuppressionReason(): string | undefined {
    if (!this.isCursorAtEndOfDraft()) return "Cursor is not at the end of the draft";
    if (!this.shared.config.allowWhileStreaming && this.shared.streaming) return "Waiting for the current agent turn to finish";
    if (Date.now() < this.suspendedUntil) return "In temporary cooldown after the last error";

    const model = resolveSuggestionModel(this.shared);
    if (!model) return "No usable autocomplete model with configured auth was found";

    const draft = this.getText();
    if (draft.trim().length < this.shared.config.minPromptChars) {
      return `Draft is shorter than min chars (${this.shared.config.minPromptChars})`;
    }
    if (shouldSkipPromptAutocomplete(draft)) {
      return "Draft looks like a slash command or path autocomplete context";
    }

    return undefined;
  }

  private refreshSuggestion(options: SuggestionRefreshOptions = {}): void {
    if (options.clearExisting) {
      this.cancelPendingRequest();
      this.setSuggestions([]);
    }

    if (!this.shared.enabled || this.activationId !== this.shared.activationId) {
      this.cancelPendingRequest();
      updateDebugState(this.shared, "inactive");
      this.setSuggestions([]);
      return;
    }

    if (this.isShowingAutocomplete()) {
      this.cancelPendingRequest();
      updateDebugState(this.shared, "paused", "Built-in autocomplete is active");
      this.setSuggestions([]);
      return;
    }

    const suppressionReason = this.getSuppressionReason();
    if (suppressionReason) {
      this.cancelPendingRequest();
      updateDebugState(this.shared, "waiting", suppressionReason);
      this.setSuggestions([]);
      return;
    }

    const request = this.buildRequest();
    if (!request) {
      this.cancelPendingRequest();
      updateDebugState(this.shared, "waiting", "No request could be built");
      this.setSuggestions([]);
      return;
    }

    if (request.cacheKey === this.dismissedKey) {
      this.cancelPendingRequest();
      updateDebugState(this.shared, "dismissed", "Suggestion dismissed for current draft");
      this.setSuggestions([]);
      return;
    }

    if (request.cacheKey === this.lastResolvedKey) {
      this.cancelPendingRequest();
      if (this.lastResolvedSuggestions.length === 0) {
        updateDebugState(this.shared, "no-suggestion", "Cached response had no usable suggestions");
      }
      this.setSuggestions(this.lastResolvedSuggestions);
      return;
    }

    const cachedEntry = getCachedRequest(this.shared, request.cacheKey);
    if (cachedEntry) {
      this.cancelPendingRequest();
      this.lastResolvedKey = request.cacheKey;
      this.lastResolvedSuggestions = cachedEntry.suggestions;
      this.shared.lastRawResponse = cachedEntry.rawResponse;
      this.shared.lastError = cachedEntry.error;
      if (cachedEntry.suggestions.length === 0) {
        updateDebugState(this.shared, "cache-hit", cachedEntry.debugState || "Cached no-suggestion result");
      }
      this.setSuggestions(cachedEntry.suggestions);
      return;
    }

    if (this.pendingRequestKey === request.cacheKey || this.shared.inFlightRequests.has(request.cacheKey)) {
      updateDebugState(this.shared, "requesting", `Awaiting cached in-flight request for ${request.modelLabel}`);
      return;
    }

    this.cancelPendingRequest();
    this.pendingRequestKey = request.cacheKey;

    const debounceMs = options.immediate ? 0 : this.shared.config.debounceMs;
    if (debounceMs <= 0) {
      updateDebugState(this.shared, "requesting", `Immediate request to ${request.modelLabel}`);
      void this.fetchSuggestion(request, ++this.requestSeq);
      return;
    }

    updateDebugState(this.shared, "debouncing", `${debounceMs}ms before request to ${request.modelLabel}`);
    const seq = ++this.requestSeq;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.fetchSuggestion(request, seq);
    }, debounceMs);
  }

  private buildRequest(): SuggestionRequest | undefined {
    if (this.getSuppressionReason()) return undefined;

    const model = resolveSuggestionModel(this.shared);
    if (!model) return undefined;

    const draft = this.getText();
    const branch = this.shared.sessionManager?.getBranch?.() ?? [];
    const latestAssistantContext = buildLatestAssistantMessageContext(branch);
    const latestUserContext = buildLatestUserMessageContext(branch);
    const recentContext = buildRecentConversationContext(branch);
    const draftTail = truncateDraftTail(draft, MAX_DRAFT_CONTEXT_CHARS);
    const modelLabel = formatModelLabel(model);
    const leafId = this.shared.sessionManager?.getLeafId?.() ?? "";

    return {
      activationId: this.activationId,
      draft,
      draftTail,
      model,
      modelLabel,
      cacheKey: `${leafId}|${modelLabel}|alts=${this.shared.config.maxAlternatives}|${draft}`,
      maxAlternatives: this.shared.config.maxAlternatives,
      latestAssistantContext,
      latestUserContext,
      recentContext,
    };
  }

  private async fetchSuggestion(request: SuggestionRequest, seq: number): Promise<void> {
    if (!this.isRequestStillCurrent(request, seq)) return;

    let inFlight = this.shared.inFlightRequests.get(request.cacheKey);
    if (!inFlight) {
      updateDebugState(this.shared, "requesting", `Requesting suggestions from ${request.modelLabel}`);
      inFlight = this.fetchSuggestionUncached(request);
      this.shared.inFlightRequests.set(request.cacheKey, inFlight);
    } else {
      updateDebugState(this.shared, "requesting", `Awaiting cached in-flight request for ${request.modelLabel}`);
    }

    try {
      const entry = await inFlight;
      if (!this.isRequestStillCurrent(request, seq)) {
        return;
      }

      this.lastResolvedKey = request.cacheKey;
      this.lastResolvedSuggestions = entry.suggestions;
      this.shared.lastRawResponse = entry.rawResponse;
      this.shared.lastError = entry.error;

      if (entry.suggestions.length === 0) {
        updateDebugState(this.shared, "no-suggestion", entry.debugState || "No usable suggestions");
      }
      if (request.cacheKey !== this.dismissedKey) {
        this.setSuggestions(entry.suggestions);
      }
    } catch (error) {
      if (this.isRequestStillCurrent(request, seq)) {
        this.suspendedUntil = Date.now() + FAILURE_COOLDOWN_MS;
        const message = error instanceof Error ? error.message : String(error);
        this.shared.lastError = message;
        updateDebugState(this.shared, "error", message);
        this.setSuggestions([]);
      }
    } finally {
      if (this.shared.inFlightRequests.get(request.cacheKey) === inFlight) {
        this.shared.inFlightRequests.delete(request.cacheKey);
      }
      if (this.pendingRequestKey === request.cacheKey) {
        this.pendingRequestKey = undefined;
      }
    }
  }

  private async fetchSuggestionUncached(request: SuggestionRequest): Promise<PromptAutocompleteCacheEntry> {
    if (!this.shared.modelRegistry) {
      throw new Error("No model registry available");
    }

    const auth = await this.shared.modelRegistry.getApiKeyAndHeaders(request.model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No API key for ${request.modelLabel}` : auth.error);
    }

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const sections: string[] = [];
      if (request.latestAssistantContext) {
        sections.push(`Latest assistant message (primary context):\n${request.latestAssistantContext}`);
      }
      if (request.latestUserContext) {
        sections.push(`Latest user message:\n${request.latestUserContext}`);
      }
      if (request.recentContext) {
        sections.push(`Recent conversation summary:\n${request.recentContext}`);
      }

      if (request.draft.length === 0) {
        sections.push(
          "Current draft is empty. Suggest the best full next prompts the user could send now.",
        );
      } else if (request.draftTail.length < request.draft.length) {
        sections.push(
          `Current draft tail (the real draft is longer; the cursor is at the end of the full draft):\n${request.draftTail}`,
        );
      } else {
        sections.push(`Current draft (cursor at end):\n${request.draft}`);
      }

      sections.push(
        `Return up to ${request.maxAlternatives} ranked alternatives as JSON with shape {\"completions\":[...]}.`,
      );
      sections.push(
        request.draft.length === 0
          ? "Each item should be a complete next prompt, not a continuation fragment."
          : "Each item should be only the continuation to insert at the cursor.",
      );

      const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: sections.join("\n\n") }],
        timestamp: Date.now(),
      };

      const response = await completeSimple(
        request.model,
        {
          systemPrompt: PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
          messages: [userMessage],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: controller.signal,
          maxTokens: REQUEST_MAX_TOKENS,
          maxRetryDelayMs: 2_000,
        },
      );

      const contentTypes = response.content.map((block) => block.type).join(", ") || "(none)";
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");

      const responseError = response.errorMessage?.trim();
      const rawResponse = text || responseError || `[types=${contentTypes}; stopReason=${response.stopReason}]`;

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(responseError || `Provider returned stopReason=${response.stopReason}`);
      }

      const normalized = normalizePromptSuggestions(
        request.draft,
        text,
        this.shared.config.maxSuggestionChars,
        request.maxAlternatives,
      );

      const debugState =
        normalized.length === 0
          ? text || `No text blocks returned (types: ${contentTypes}; stopReason: ${response.stopReason})`
          : `${normalized.length} suggestion(s) ready`;

      return storeCachedRequest(this.shared, request.cacheKey, {
        suggestions: normalized,
        rawResponse,
        debugState,
      });
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  private isRequestStillCurrent(request: SuggestionRequest, seq: number): boolean {
    if (!this.shared.enabled) return false;
    if (this.activationId !== this.shared.activationId) return false;
    if (seq !== this.requestSeq) return false;
    if (request.activationId !== this.activationId) return false;
    if (!this.isCursorAtEndOfDraft()) return false;
    if (this.getText() !== request.draft) return false;
    if (this.isShowingAutocomplete()) return false;

    const currentModel = resolveSuggestionModel(this.shared);
    return formatModelLabel(currentModel) === request.modelLabel;
  }

  private cancelPendingRequest(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.abortController?.abort();
    this.abortController = undefined;
    this.pendingRequestKey = undefined;
  }
}

function mountEditor(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.activationId += 1;
  const activationId = shared.activationId;
  shared.setStatusText = (text) => {
    ctx.ui.setWidget(
      "prompt-autocomplete-debug",
      shared.config.debug && text ? [`PA ${text}`] : undefined,
      { placement: "belowEditor" },
    );
  };
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = new PromptAutocompleteEditor(tui, theme, keybindings, shared, activationId);
    shared.refreshEditor = (options) => {
      if (activationId !== shared.activationId) return;
      editor.refreshFromExternalChange(options);
    };
    return editor;
  });
  updateDebugState(shared, "mounted", "Editor extension attached");
}

function unmountEditor(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.activationId += 1;
  ctx.ui.setEditorComponent(undefined);
  clearDebugUi(shared);
  shared.refreshEditor = undefined;
  shared.setStatusText = undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("prompt-autocomplete", {
    description: "Enable inline AI prompt autocomplete in the editor",
    type: "boolean",
    default: true,
  });
  pi.registerFlag("prompt-autocomplete-model", {
    description: "Provider/model for prompt autocomplete, e.g. openai/gpt-5.4-mini",
    type: "string",
    default: DEFAULT_PREFERRED_MODEL,
  });
  pi.registerFlag("prompt-autocomplete-while-streaming", {
    description: "Allow prompt autocomplete while the main agent is still working",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("prompt-autocomplete-debug", {
    description: "Show prompt autocomplete debug state below the editor",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("prompt-autocomplete-debounce-ms", {
    description: "Debounce in ms before requesting a prompt completion",
    type: "string",
    default: String(DEFAULT_DEBOUNCE_MS),
  });
  pi.registerFlag("prompt-autocomplete-min-chars", {
    description: "Minimum prompt length before autocomplete activates",
    type: "string",
    default: String(DEFAULT_MIN_PROMPT_CHARS),
  });
  pi.registerFlag("prompt-autocomplete-max-chars", {
    description: "Maximum characters to accept from one prompt completion",
    type: "string",
    default: String(DEFAULT_MAX_SUGGESTION_CHARS),
  });
  pi.registerFlag("prompt-autocomplete-max-alternatives", {
    description: "Maximum number of inline suggestion alternatives to keep (1-5)",
    type: "string",
    default: String(DEFAULT_MAX_ALTERNATIVES),
  });

  const shared: PromptAutocompleteSharedState = {
    enabled: false,
    activationId: 0,
    streaming: false,
    config: parseConfig(pi),
    debugState: "idle",
    requestCache: new Map(),
    inFlightRequests: new Map(),
  };

  pi.on("session_start", async () => {
    shared.enabled = pi.getFlag("prompt-autocomplete") === true;
    shared.config = parseConfig(pi);
    shared.lastError = undefined;
    shared.lastRawResponse = undefined;
    shared.requestCache.clear();
    shared.inFlightRequests.clear();
    shared.debugState = shared.enabled ? "configured" : "disabled";
  });

  pi.on("session_start", async (_event, ctx) => {
    shared.currentModel = ctx.model as Model<Api> | undefined;
    shared.modelRegistry = ctx.modelRegistry;
    shared.sessionManager = ctx.sessionManager;
    shared.streaming = false;

    if (!ctx.hasUI) return;
    if (!shared.enabled) return;

    mountEditor(ctx, shared);
  });

  pi.on("model_select", async (event, ctx) => {
    shared.currentModel = event.model as Model<Api>;
    shared.modelRegistry = ctx.modelRegistry;
    if (shared.enabled) {
      updateDebugState(shared, "model-changed", formatModelLabel(event.model as Model<Api>));
      shared.refreshEditor?.({ clearExisting: true, immediate: true });
    }
  });

  pi.on("agent_start", async () => {
    shared.streaming = true;
    if (shared.enabled && !shared.config.allowWhileStreaming) {
      updateDebugState(shared, "waiting", "Main agent is still working");
      shared.refreshEditor?.({ clearExisting: true, immediate: true });
    }
  });

  pi.on("agent_end", async () => {
    shared.streaming = false;
    if (shared.enabled) {
      updateDebugState(shared, "ready", "Agent finished; autocomplete can request suggestions again");
      shared.refreshEditor?.({ clearExisting: true, immediate: true });
    }
  });

  pi.registerCommand("prompt-autocomplete", {
    description: "Enable, disable, or inspect inline prompt autocomplete",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("prompt-autocomplete requires interactive mode", "warning");
        return;
      }

      const command = args.trim().toLowerCase();

      if (!command || command === "status") {
        ctx.ui.notify(formatStatus(shared), "info");
        return;
      }

      if (command === "debug-on") {
        shared.config.debug = true;
        updateDebugState(shared, shared.debugState || "ready");
        ctx.ui.notify("Prompt autocomplete debug display enabled", "info");
        return;
      }

      if (command === "debug-off") {
        shared.config.debug = false;
        clearDebugUi(shared);
        ctx.ui.notify("Prompt autocomplete debug display disabled", "info");
        return;
      }

      if (command === "debug-toggle") {
        shared.config.debug = !shared.config.debug;
        if (shared.config.debug) {
          updateDebugState(shared, shared.debugState || "ready");
          ctx.ui.notify("Prompt autocomplete debug display enabled", "info");
        } else {
          clearDebugUi(shared);
          ctx.ui.notify("Prompt autocomplete debug display disabled", "info");
        }
        return;
      }

      if (command === "on") {
        if (shared.enabled) {
          ctx.ui.notify(`Prompt autocomplete already enabled (${formatStatus(shared)})`, "info");
          return;
        }

        shared.enabled = true;
        mountEditor(ctx, shared);

        const resolvedModel = resolveSuggestionModel(shared);
        if (resolvedModel) {
          ctx.ui.notify(
            `Prompt autocomplete enabled. Tab accepts all, ${formatPrimaryKey(WORD_ACCEPT_KEYS)} accepts one word, ${formatPrimaryKey(CYCLE_PREV_KEYS)}/${formatPrimaryKey(CYCLE_NEXT_KEYS)} cycle alternatives. Model: ${formatModelLabel(resolvedModel)}`,
            "info",
          );
        } else {
          ctx.ui.notify(
            "Prompt autocomplete enabled, but no usable model/auth is configured yet. Select a model or configure auth first.",
            "warning",
          );
        }
        return;
      }

      if (command === "off") {
        if (!shared.enabled) {
          ctx.ui.notify("Prompt autocomplete is already disabled", "info");
          return;
        }

        shared.enabled = false;
        unmountEditor(ctx, shared);
        ctx.ui.notify("Prompt autocomplete disabled", "info");
        return;
      }

      if (command === "toggle") {
        if (shared.enabled) {
          shared.enabled = false;
          unmountEditor(ctx, shared);
          ctx.ui.notify("Prompt autocomplete disabled", "info");
        } else {
          shared.enabled = true;
          mountEditor(ctx, shared);
          ctx.ui.notify(
            `Prompt autocomplete enabled. Tab accepts all, ${formatPrimaryKey(WORD_ACCEPT_KEYS)} accepts one word, ${formatPrimaryKey(CYCLE_PREV_KEYS)}/${formatPrimaryKey(CYCLE_NEXT_KEYS)} cycle alternatives.`,
            "info",
          );
        }
        return;
      }

      ctx.ui.notify(
        "Usage: /prompt-autocomplete [on|off|toggle|status|debug-on|debug-off|debug-toggle]",
        "warning",
      );
    },
  });
}
