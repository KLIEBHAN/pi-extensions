import { completeSimple, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type EditorTheme, type KeyId, type TUI, visibleWidth } from "@mariozechner/pi-tui";
import {
  acquireCoalescedRequest,
  buildLatestAssistantMessageContext,
  buildLatestUserMessageContext,
  buildRecentConversationContext,
  cancelAllCoalescedRequests,
  createOwnerRefCounter,
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
  shouldSkipPromptAutocomplete,
  truncateDraftTail,
  type CoalescedRequestEntry,
  type CoalescedRequestSubscription,
  type ModelRef,
} from "./core.ts";

const GHOST_TEXT_STYLE = "\x1b[2m";
const GHOST_INDICATOR_STYLE = "\x1b[90m";
const RESET = "\x1b[0m";
const CURSOR_TOKEN = "\x1b[7m \x1b[0m";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const SPINNER_LABEL = "Generating suggestion";
// Scale the completion budget with the requested alternatives so a JSON array of
// several short suggestions cannot be truncated mid-string (which would break parsing).
const MIN_REQUEST_MAX_TOKENS = 192;
const MAX_REQUEST_MAX_TOKENS = 1_024;
// Inline autocomplete should fail fast instead of inheriting long provider retry/timeout defaults.
const REQUEST_TIMEOUT_MS = 8_000;
const REQUEST_MAX_RETRIES = 0;
const REQUEST_MAX_RETRY_DELAY_MS = 2_000;
// Brief cooldown avoids hammering providers after transient auth/network failures while keeping the UI responsive.
const FAILURE_COOLDOWN_MS = 5_000;
const REQUEST_CACHE_TTL_MS = 60_000;
const REQUEST_CACHE_MAX_ENTRIES = 128;
const WORD_ACCEPT_KEYS: readonly KeyId[] = ["ctrl+space", "ctrl+tab"];
const CYCLE_NEXT_KEYS: readonly KeyId[] = ["ctrl+.", "alt+]"];
const CYCLE_PREV_KEYS: readonly KeyId[] = ["ctrl+,", "alt+["];
const NAVIGATION_ACTIONS = [
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.jumpForward",
  "tui.editor.jumpBackward",
  "tui.editor.pageUp",
  "tui.editor.pageDown",
] as const;
const EDIT_ACTIONS = [
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.undo",
  "tui.input.newLine",
  "app.clear",
] as const;

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
  // Manual one-shot trigger: bypasses the streaming gate and error cooldown so the
  // user can force a single suggestion while the main agent is still working.
  manual?: boolean;
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
  inFlightRequests: Map<string, CoalescedRequestEntry<PromptAutocompleteCacheEntry>>;
  refreshEditor?: (options?: SuggestionRefreshOptions) => void;
  cancelActiveRequest?: () => void;
  setStatusText?: (text: string | undefined) => void;
  setSpinnerActive?: (owner: string, active: boolean) => void;
  clearSpinner?: () => void;
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

function computeRequestMaxTokens(maxAlternatives: number, maxSuggestionChars: number): number {
  // Rough chars→tokens estimate per suggestion plus JSON quoting/comma overhead,
  // and a fixed wrapper budget for the surrounding {"completions":[...]} envelope.
  const tokensPerSuggestion = Math.ceil(maxSuggestionChars / 3) + 8;
  const estimated = 24 + maxAlternatives * tokensPerSuggestion;
  return Math.max(MIN_REQUEST_MAX_TOKENS, Math.min(MAX_REQUEST_MAX_TOKENS, estimated));
}

function hashText(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x811c9dc5 ^ text.length;

  for (let i = 0; i < text.length; i += 1) {
    const codeUnit = text.charCodeAt(i);
    first = Math.imul(first ^ codeUnit, 0x01000193) >>> 0;
    second = Math.imul(second ^ codeUnit, 0x01000193) >>> 0;
  }

  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
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
    : "current active model";

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
  const entry = shared.requestCache.get(cacheKey);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    shared.requestCache.delete(cacheKey);
    return undefined;
  }

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
  private readonly keybindings: KeybindingsManager;

  private suggestions: string[] = [];
  private suggestionIndex: number = 0;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private requestSeq = 0;
  private pendingRequestKey?: string;
  private activeRequestSubscription?: CoalescedRequestSubscription<PromptAutocompleteCacheEntry>;
  // One owner token per editor instance; the mount-level refcounter keeps the
  // shared spinner alive until every active owner has released it.
  private activeSpinnerOwner?: string;
  private suspendedUntil = 0;
  private lastResolvedKey = "";
  private lastResolvedSuggestions: string[] = [];
  private dismissedKey?: string;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    shared: PromptAutocompleteSharedState,
    activationId: number,
  ) {
    super(tui, theme, keybindings);
    this.shared = shared;
    this.activationId = activationId;
    this.keybindings = keybindings;
  }

  override setText(text: string): void {
    super.setText(text);
    this.refreshSuggestion({ clearExisting: true });
  }

  override insertTextAtCursor(text: string): void {
    super.insertTextAtCursor(text);
    this.refreshSuggestion({ clearExisting: true });
  }

  override handleInput(data: string): void {
    if (this.canDismissInlineSuggestion(data)) {
      this.dismissedKey = this.buildRequest()?.cacheKey;
      this.clearInlineSuggestion("dismissed", "Suggestion dismissed for current draft");
      return;
    }

    if (this.canCycleSuggestions(data)) {
      this.cycleSuggestions(matchesAnyKey(data, CYCLE_NEXT_KEYS) ? 1 : -1);
      return;
    }

    if (this.canTriggerManualSuggestion(data)) {
      this.triggerManualSuggestion();
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

    this.clearInlineSuggestionForUserIntent(data);

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

    if (textChanged || cursorChanged || autocompleteChanged) {
      this.refreshSuggestion({ clearExisting: true });
      return;
    }

    if (this.getActiveSuggestion()) {
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

  private makeRequestSubscriberId(seq: number): string {
    return `${this.activationId}:${seq}`;
  }

  private makeSpinnerOwner(request: SuggestionRequest, seq: number): string {
    return `${this.activationId}:${seq}:${request.cacheKey}`;
  }

  private activateSpinner(owner: string): void {
    if (this.activeSpinnerOwner && this.activeSpinnerOwner !== owner) {
      this.shared.setSpinnerActive?.(this.activeSpinnerOwner, false);
    }

    this.activeSpinnerOwner = owner;
    this.shared.setSpinnerActive?.(owner, true);
  }

  private deactivateSpinner(owner = this.activeSpinnerOwner): void {
    if (!owner) return;
    this.shared.setSpinnerActive?.(owner, false);
    if (this.activeSpinnerOwner === owner) {
      this.activeSpinnerOwner = undefined;
    }
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

  // Fires only when CYCLE_NEXT (ctrl+.) is pressed and there is nothing to cycle
  // through, so the same key both advances alternatives and forces a one-shot
  // suggestion (e.g. while the agent is streaming and while-streaming is off).
  private canTriggerManualSuggestion(data: string): boolean {
    if (!this.shared.enabled || this.activationId !== this.shared.activationId) return false;
    if (this.isShowingAutocomplete()) return false;
    return matchesAnyKey(data, CYCLE_NEXT_KEYS);
  }

  private triggerManualSuggestion(): void {
    // refreshSuggestion immediately sets its own debug state, so we only clear any
    // standing dismissal here and let the refresh report the real outcome.
    this.dismissedKey = undefined;
    this.refreshSuggestion({ clearExisting: true, immediate: true, manual: true });
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

  private clearInlineSuggestion(state: string, details: string): void {
    this.cancelPendingRequest();
    updateDebugState(this.shared, state, details);
    this.setSuggestions([]);
  }

  private clearInlineSuggestionForUserIntent(data: string): boolean {
    const clearReason = this.getInlineSuggestionClearReason(data);
    if (!clearReason) return false;
    this.clearInlineSuggestion(clearReason.state, clearReason.details);
    return true;
  }

  private getInlineSuggestionClearReason(data: string): { state: string; details: string } | undefined {
    if (!this.getActiveSuggestion()) return undefined;

    if (NAVIGATION_ACTIONS.some((action) => this.keybindings.matches(data, action))) {
      return {
        state: "navigated",
        details: "Suggestion cleared during editor navigation",
      };
    }

    if (EDIT_ACTIONS.some((action) => this.keybindings.matches(data, action))) {
      return {
        state: "editing",
        details: "Suggestion cleared before editor edit command",
      };
    }

    return undefined;
  }

  private acceptInlineSuggestion(): void {
    const suggestion = this.getActiveSuggestion();
    if (!suggestion) return;

    this.dismissedKey = undefined;
    this.clearInlineSuggestion("accepted", "Accepted full suggestion");
    super.insertTextAtCursor(suggestion);
    this.refreshSuggestion();
  }

  private acceptInlineSuggestionByWord(): void {
    const suggestion = this.getActiveSuggestion();
    if (!suggestion) return;

    const chunk = extractNextSuggestionChunk(suggestion) ?? suggestion;
    if (!chunk) return;

    this.dismissedKey = undefined;
    this.clearInlineSuggestion("accepted-word", `Accepted chunk: ${chunk}`);
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

  private getSuppressionReason(options: { manual?: boolean } = {}): string | undefined {
    if (!this.isCursorAtEndOfDraft()) return "Cursor is not at the end of the draft";
    // A manual one-shot trigger deliberately ignores the noise-reduction gates
    // (streaming gate, post-error cooldown, min-chars). Model/auth and slash/path
    // checks still apply because those can never produce a useful suggestion.
    if (!options.manual) {
      if (!this.shared.config.allowWhileStreaming && this.shared.streaming) {
        return "Waiting for the current agent turn to finish";
      }
      if (Date.now() < this.suspendedUntil) return "In temporary cooldown after the last error";
    }

    const model = resolveSuggestionModel(this.shared);
    if (!model) return "No usable autocomplete model with configured auth was found";

    const draft = this.getText();
    if (!options.manual && draft.trim().length < this.shared.config.minPromptChars) {
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

    const suppressionReason = this.getSuppressionReason({ manual: options.manual });
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

    if (this.pendingRequestKey === request.cacheKey) {
      updateDebugState(this.shared, "requesting", `Awaiting pending request for ${request.modelLabel}`);
      return;
    }

    const shouldJoinInFlight = this.shared.inFlightRequests.has(request.cacheKey);
    this.cancelPendingRequest();

    const seq = ++this.requestSeq;
    const spinnerOwner = this.makeSpinnerOwner(request, seq);
    this.pendingRequestKey = request.cacheKey;
    this.activateSpinner(spinnerOwner);

    const debounceMs = shouldJoinInFlight || options.immediate ? 0 : this.shared.config.debounceMs;
    if (debounceMs <= 0) {
      updateDebugState(
        this.shared,
        "requesting",
        shouldJoinInFlight
          ? `Joining in-flight request for ${request.modelLabel}`
          : `Immediate request to ${request.modelLabel}`,
      );
      void this.fetchSuggestion(request, seq, spinnerOwner);
      return;
    }

    updateDebugState(this.shared, "debouncing", `${debounceMs}ms before request to ${request.modelLabel}`);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.fetchSuggestion(request, seq, spinnerOwner);
    }, debounceMs);
  }

  private buildRequest(): SuggestionRequest | undefined {
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
      cacheKey: `${leafId}|${modelLabel}|alts=${this.shared.config.maxAlternatives}|len=${draft.length}|sha=${hashText(draft)}`,
      maxAlternatives: this.shared.config.maxAlternatives,
      latestAssistantContext,
      latestUserContext,
      recentContext,
    };
  }

  private async fetchSuggestion(request: SuggestionRequest, seq: number, spinnerOwner: string): Promise<void> {
    if (!this.isRequestStillCurrent(request, seq)) {
      if (this.pendingRequestKey === request.cacheKey) {
        this.pendingRequestKey = undefined;
      }
      this.deactivateSpinner(spinnerOwner);
      return;
    }

    const subscriberId = this.makeRequestSubscriberId(seq);
    const subscription = acquireCoalescedRequest(
      this.shared.inFlightRequests,
      request.cacheKey,
      subscriberId,
      (signal) => this.fetchSuggestionUncached(request, signal),
    );

    this.activeRequestSubscription = subscription;
    updateDebugState(
      this.shared,
      "requesting",
      subscription.created
        ? `Requesting suggestions from ${request.modelLabel}`
        : `Awaiting shared in-flight request for ${request.modelLabel}`,
    );

    try {
      const entry = await subscription.promise;
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
      subscription.release();
      if (this.activeRequestSubscription === subscription) {
        this.activeRequestSubscription = undefined;
      }
      if (this.pendingRequestKey === request.cacheKey) {
        this.pendingRequestKey = undefined;
      }
      this.deactivateSpinner(spinnerOwner);
    }
  }

  private async fetchSuggestionUncached(
    request: SuggestionRequest,
    signal: AbortSignal,
  ): Promise<PromptAutocompleteCacheEntry> {
    if (!this.shared.modelRegistry) {
      throw new Error("No model registry available");
    }

    const auth = await this.shared.modelRegistry.getApiKeyAndHeaders(request.model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No API key for ${request.modelLabel}` : auth.error);
    }
    if (signal.aborted) {
      throw new Error("Request was aborted");
    }

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
      sections.push("Current draft is empty.");
      sections.push(
        [
          `Task: propose up to ${request.maxAlternatives} ranked full next prompts the user could send now.`,
          "Each item must be a complete next prompt, not a continuation fragment.",
          "Suggest the prompt most likely to move the overall project forward.",
          "Prefer 3-10 words when possible.",
        ].join("\n"),
      );
    } else {
      if (request.draftTail.length < request.draft.length) {
        sections.push(
          `Current draft tail (the real draft is longer; the cursor is at the end of the full draft):\n${request.draftTail}`,
        );
      } else {
        sections.push(`Current draft (cursor at end):\n${request.draft}`);
      }

      sections.push(
        [
          `Task: propose up to ${request.maxAlternatives} ranked continuations to insert at the cursor.`,
          "Each item must be only the text after the cursor; never restate text the user already typed.",
          "If the draft ends inside a partially typed word, complete that word directly without a leading space.",
        ].join("\n"),
      );
    }

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
        signal,
        maxTokens: computeRequestMaxTokens(request.maxAlternatives, this.shared.config.maxSuggestionChars),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRetries: REQUEST_MAX_RETRIES,
        maxRetryDelayMs: REQUEST_MAX_RETRY_DELAY_MS,
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
    if (signal.aborted) {
      throw new Error("Request was aborted");
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

  cancelActiveRequest(): void {
    this.cancelPendingRequest();
    this.setSuggestions([]);
  }

  private cancelPendingRequest(): void {
    this.requestSeq += 1;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.activeRequestSubscription?.release();
    this.activeRequestSubscription = undefined;
    this.pendingRequestKey = undefined;
    this.deactivateSpinner();
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

  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  // Mount-scoped owner refcount: multiple request subscribers can share one
  // spinner, while clearSpinner resets all ownership during unmount/remount.
  const spinnerOwners = createOwnerRefCounter();
  const renderSpinner = () => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    ctx.ui.setWidget(
      "prompt-autocomplete-spinner",
      [`${GHOST_INDICATOR_STYLE}${frame} ${SPINNER_LABEL}…${RESET}`],
      { placement: "belowEditor" },
    );
  };
  const clearSpinnerWidget = () => {
    ctx.ui.setWidget("prompt-autocomplete-spinner", undefined, { placement: "belowEditor" });
  };
  const stopSpinnerTimer = () => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    clearSpinnerWidget();
  };
  shared.setSpinnerActive = (owner, active) => {
    if (active) {
      spinnerOwners.activate(owner);
      if (spinnerTimer) return;
      spinnerFrame = 0;
      renderSpinner();
      spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        renderSpinner();
      }, SPINNER_INTERVAL_MS);
      return;
    }

    if (!spinnerOwners.deactivate(owner)) return;
    stopSpinnerTimer();
  };
  shared.clearSpinner = () => {
    spinnerOwners.clear();
    stopSpinnerTimer();
  };

  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = new PromptAutocompleteEditor(tui, theme, keybindings, shared, activationId);
    shared.refreshEditor = (options) => {
      if (activationId !== shared.activationId) return;
      editor.refreshFromExternalChange(options);
    };
    shared.cancelActiveRequest = () => {
      if (activationId !== shared.activationId) return;
      editor.cancelActiveRequest();
    };
    return editor;
  });
  updateDebugState(shared, "mounted", "Editor extension attached");
}

function unmountEditor(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.cancelActiveRequest?.();
  shared.activationId += 1;
  shared.clearSpinner?.();
  ctx.ui.setEditorComponent(undefined);
  clearDebugUi(shared);
  shared.refreshEditor = undefined;
  shared.cancelActiveRequest = undefined;
  shared.setStatusText = undefined;
  shared.setSpinnerActive = undefined;
  shared.clearSpinner = undefined;
}

function resetSharedForSession(pi: ExtensionAPI, shared: PromptAutocompleteSharedState): void {
  shared.cancelActiveRequest?.();
  shared.cancelActiveRequest = undefined;
  shared.enabled = pi.getFlag("prompt-autocomplete") === true;
  shared.config = parseConfig(pi);
  shared.lastError = undefined;
  shared.lastRawResponse = undefined;
  shared.requestCache.clear();
  cancelAllCoalescedRequests(shared.inFlightRequests);
  shared.debugState = shared.enabled ? "configured" : "disabled";
}

function bindRuntimeContext(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.currentModel = ctx.model as Model<Api> | undefined;
  shared.modelRegistry = ctx.modelRegistry;
  shared.sessionManager = ctx.sessionManager;
  shared.streaming = false;
}

function refreshEditorImmediately(shared: PromptAutocompleteSharedState, state: string, details: string): void {
  updateDebugState(shared, state, details);
  shared.refreshEditor?.({ clearExisting: true, immediate: true });
}

function setDebugDisplay(shared: PromptAutocompleteSharedState, enabled: boolean): void {
  shared.config.debug = enabled;
  if (enabled) {
    updateDebugState(shared, shared.debugState || "ready");
  } else {
    clearDebugUi(shared);
  }
}

function setWhileStreaming(
  ctx: ExtensionContext,
  shared: PromptAutocompleteSharedState,
  arg: string | undefined,
): void {
  let next: boolean;
  if (arg === "on") {
    next = true;
  } else if (arg === "off") {
    next = false;
  } else if (arg === undefined || arg === "toggle") {
    next = !shared.config.allowWhileStreaming;
  } else {
    ctx.ui.notify("Usage: /prompt-autocomplete while-streaming [on|off|toggle]", "warning");
    return;
  }

  shared.config.allowWhileStreaming = next;
  ctx.ui.notify(`Prompt autocomplete while-streaming ${next ? "enabled" : "disabled"}`, "info");

  if (shared.enabled) {
    // Only label it "waiting" when disabling actually suppresses right now (agent
    // streaming); otherwise the refresh below requests suggestions immediately.
    const willSuppress = !next && shared.streaming;
    refreshEditorImmediately(shared, willSuppress ? "waiting" : "ready", `While-streaming ${next ? "enabled" : "disabled"}`);
  }
}

function enablePromptAutocomplete(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.enabled = true;
  mountEditor(ctx, shared);
}

function disablePromptAutocomplete(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.enabled = false;
  unmountEditor(ctx, shared);
}

function notifyPromptAutocompleteEnabled(
  ctx: ExtensionContext,
  shared: PromptAutocompleteSharedState,
  options: { includeModel: boolean },
): void {
  const keyHint =
    `Tab accepts all, ${formatPrimaryKey(WORD_ACCEPT_KEYS)} accepts one word, ` +
    `${formatPrimaryKey(CYCLE_PREV_KEYS)}/${formatPrimaryKey(CYCLE_NEXT_KEYS)} cycle alternatives, ` +
    `${formatPrimaryKey(CYCLE_NEXT_KEYS)} also forces a one-shot suggestion when none is shown (even while the agent works).`;
  const resolvedModel = resolveSuggestionModel(shared);

  if (options.includeModel) {
    if (resolvedModel) {
      ctx.ui.notify(`Prompt autocomplete enabled. ${keyHint} Model: ${formatModelLabel(resolvedModel)}`, "info");
    } else {
      ctx.ui.notify(
        "Prompt autocomplete enabled, but no usable model/auth is configured yet. Select a model or configure auth first.",
        "warning",
      );
    }
    return;
  }

  ctx.ui.notify(`Prompt autocomplete enabled. ${keyHint}`, "info");
}

function createPromptAutocompleteCommandHandlers(
  ctx: ExtensionContext,
  shared: PromptAutocompleteSharedState,
): Record<string, () => void> {
  return {
    status: () => {
      ctx.ui.notify(formatStatus(shared), "info");
    },
    "debug-on": () => {
      setDebugDisplay(shared, true);
      ctx.ui.notify("Prompt autocomplete debug display enabled", "info");
    },
    "debug-off": () => {
      setDebugDisplay(shared, false);
      ctx.ui.notify("Prompt autocomplete debug display disabled", "info");
    },
    "debug-toggle": () => {
      const nextDebugEnabled = !shared.config.debug;
      setDebugDisplay(shared, nextDebugEnabled);
      ctx.ui.notify(
        nextDebugEnabled
          ? "Prompt autocomplete debug display enabled"
          : "Prompt autocomplete debug display disabled",
        "info",
      );
    },
    on: () => {
      if (shared.enabled) {
        ctx.ui.notify(`Prompt autocomplete already enabled (${formatStatus(shared)})`, "info");
        return;
      }

      enablePromptAutocomplete(ctx, shared);
      notifyPromptAutocompleteEnabled(ctx, shared, { includeModel: true });
    },
    off: () => {
      if (!shared.enabled) {
        ctx.ui.notify("Prompt autocomplete is already disabled", "info");
        return;
      }

      disablePromptAutocomplete(ctx, shared);
      ctx.ui.notify("Prompt autocomplete disabled", "info");
    },
    toggle: () => {
      if (shared.enabled) {
        disablePromptAutocomplete(ctx, shared);
        ctx.ui.notify("Prompt autocomplete disabled", "info");
        return;
      }

      enablePromptAutocomplete(ctx, shared);
      notifyPromptAutocompleteEnabled(ctx, shared, { includeModel: false });
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("prompt-autocomplete", {
    description: "Enable inline AI prompt autocomplete in the editor",
    type: "boolean",
    default: true,
  });
  pi.registerFlag("prompt-autocomplete-model", {
    description: "Optional provider/model override for prompt autocomplete, e.g. openai/gpt-5.4-mini",
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

  pi.on("session_start", async (_event, ctx) => {
    resetSharedForSession(pi, shared);
    bindRuntimeContext(ctx, shared);

    if (!ctx.hasUI || !shared.enabled) return;
    mountEditor(ctx, shared);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shared.enabled = false;
    shared.cancelActiveRequest?.();
    shared.requestCache.clear();
    cancelAllCoalescedRequests(shared.inFlightRequests);
    if (ctx.hasUI) {
      unmountEditor(ctx, shared);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    shared.currentModel = event.model as Model<Api>;
    shared.modelRegistry = ctx.modelRegistry;
    if (!shared.enabled) return;
    refreshEditorImmediately(shared, "model-changed", formatModelLabel(event.model as Model<Api>));
  });

  pi.on("agent_start", async () => {
    shared.streaming = true;
    if (!shared.enabled || shared.config.allowWhileStreaming) return;
    refreshEditorImmediately(shared, "waiting", "Main agent is still working");
  });

  pi.on("agent_end", async () => {
    shared.streaming = false;
    if (!shared.enabled) return;
    refreshEditorImmediately(shared, "ready", "Agent finished; autocomplete can request suggestions again");
  });

  pi.registerCommand("prompt-autocomplete", {
    description: "Enable, disable, or inspect inline prompt autocomplete",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("prompt-autocomplete requires interactive mode", "warning");
        return;
      }

      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const command = parts[0] || "status";

      if (command === "while-streaming") {
        setWhileStreaming(ctx, shared, parts[1]);
        return;
      }

      const handlers = createPromptAutocompleteCommandHandlers(ctx, shared);
      const handler = handlers[command];

      if (handler) {
        handler();
        return;
      }

      ctx.ui.notify(
        "Usage: /prompt-autocomplete [on|off|toggle|status|while-streaming on|off|toggle|debug-on|debug-off|debug-toggle]",
        "warning",
      );
    },
  });
}
