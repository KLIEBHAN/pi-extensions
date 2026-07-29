import {
  completeSimple,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type EditorTheme, type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
  acquireCoalescedRequest,
  buildLatestAssistantMessageContext,
  buildLatestUserMessageContext,
  buildPromptAutocompleteCacheKey,
  buildRecentConversationContext,
  cancelAllCoalescedRequests,
  computeRequestMaxTokens,
  createOwnerRefCounter,
  createPromptAutocompleteUsageStats,
  describeSettingSource,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_ALTERNATIVES,
  DEFAULT_MAX_SUGGESTION_CHARS,
  DEFAULT_MIN_PROMPT_CHARS,
  DEFAULT_PREFERRED_MODEL,
  DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED,
  DEFAULT_STREAM_RESPONSES,
  ExpiringLruCache,
  extractNextSuggestionChunk,
  formatModelLabel,
  formatUsageStats,
  MAX_DRAFT_CONTEXT_CHARS,
  normalizePromptSuggestions,
  parseBoundedIntFlag,
  parseModelRef,
  parsePartialPromptSuggestion,
  PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
  recordProviderUsage,
  resolveOverride,
  SequenceOwnedSlot,
  shouldSkipPromptAutocomplete,
  truncateDraftTail,
  type CoalescedRequestEntry,
  type CoalescedRequestSubscription,
  type ModelRef,
  type PromptAutocompleteRuntimeOverrides,
  type PromptAutocompleteUsageStats,
} from "./core.ts";

const GHOST_TEXT_STYLE = "\x1b[2m";
const GHOST_INDICATOR_STYLE = "\x1b[90m";
const RESET = "\x1b[0m";
const CURSOR_TOKEN = "\x1b[7m \x1b[0m";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const SPINNER_LABEL = "Generating suggestion";
// Inline autocomplete should fail fast instead of inheriting long provider retry/timeout defaults.
const REQUEST_TIMEOUT_MS = 8_000;
// A compliant provider emits its terminal aborted message immediately, which
// lets accounting retain any usage. These local bounds keep a custom provider
// that ignores both signal and timeout from pinning a consumer forever.
const STREAM_ABORT_DRAIN_TIMEOUT_MS = 250;
const STREAM_HARD_TIMEOUT_GRACE_MS = 500;
const REQUEST_MAX_RETRIES = 0;
const REQUEST_MAX_RETRY_DELAY_MS = 2_000;
// Brief cooldown avoids hammering providers after transient auth/network failures while keeping the UI responsive.
const FAILURE_COOLDOWN_MS = 5_000;
const REQUEST_CACHE_TTL_MS = 60_000;
const REQUEST_CACHE_MAX_ENTRIES = 128;
// Keymap audit vs. pi defaults (packages/tui/src/keybindings.ts +
// packages/coding-agent/src/core/keybindings.ts): none of the keys below are bound
// by pi's default keymap, so the editor can safely own them — including the
// broadened `ctrl+.`/`alt+]` one-shot trigger, which shadows no base action. The
// only nearby defaults are `ctrl+]` (jumpForward) and `ctrl+alt+]` (jumpBackward),
// both distinct from our `alt+]`.
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
  streamResponses: boolean;
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
}

interface SuggestionRefreshOptions {
  clearExisting?: boolean;
  immediate?: boolean;
  // Manual one-shot trigger: bypasses the streaming gate and error cooldown so the
  // user can force a single suggestion while the main agent is still working.
  manual?: boolean;
}

type EditorFactory = Exclude<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0], undefined>;

interface EditorMountState {
  previousFactory: EditorFactory | undefined;
  installedFactory: EditorFactory;
}

type CompleteSimpleFunction = typeof completeSimple;
type StreamSimpleFunction = typeof streamSimple;

export interface PromptAutocompleteDependencies {
  completeSimple?: CompleteSimpleFunction;
  streamSimple?: StreamSimpleFunction;
  now?: () => number;
}

interface PromptAutocompleteSharedState {
  enabled: boolean;
  activationId: number;
  agentStreaming: boolean;
  config: PromptAutocompleteConfig;
  /** Slash-command decisions that outrank flags for the lifetime of the process. */
  runtimeOverrides: PromptAutocompleteRuntimeOverrides;
  /** Session-scoped request accounting; reset together with the cache. */
  usageStats: PromptAutocompleteUsageStats;
  currentModel?: Model<Api>;
  modelRegistry?: ExtensionContext["modelRegistry"];
  sessionManager?: ExtensionContext["sessionManager"];
  completeSimple: CompleteSimpleFunction;
  streamSimple?: StreamSimpleFunction;
  now: () => number;
  debugState: string;
  editorMount?: EditorMountState;
  editorBlockedReason?: string;
  lastError?: string;
  lastRawResponse?: string;
  requestCache: ExpiringLruCache<PromptAutocompleteCacheEntry>;
  inFlightRequests: Map<string, CoalescedRequestEntry<PromptAutocompleteCacheEntry, string>>;
  ownsEditor?: () => boolean;
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
  maxSuggestionChars: number;
  useStreaming: boolean;
  latestAssistantContext: string;
  latestUserContext: string;
  recentContext: string;
}

interface PendingSuggestionRequest {
  key: string;
  seq: number;
  spinnerOwner: string;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function consumeAssistantStream(
  stream: AssistantMessageEventStream,
  signal: AbortSignal,
  abortProvider: () => void,
  onPartial: (message: AssistantMessage) => void,
): Promise<AssistantMessage> {
  const iterator = stream[Symbol.asyncIterator]();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbortDrain: ((error: Error) => void) | undefined;
  let terminal: AssistantMessage | undefined;

  const hardDeadline = new Promise<never>((_resolve, reject) => {
    hardTimer = setTimeout(() => {
      // `timeoutMs` is provider-owned. Abort the actual request signal as a
      // second line of defence for providers that respect cancellation but
      // accidentally ignore their timeout option.
      abortProvider();
      reject(new Error("Provider stream exceeded the local response deadline"));
    }, REQUEST_TIMEOUT_MS + STREAM_HARD_TIMEOUT_GRACE_MS);
  });
  const abortDeadline = new Promise<never>((_resolve, reject) => {
    rejectAbortDrain = reject;
  });
  const beginAbortDrain = () => {
    if (abortTimer) return;
    abortTimer = setTimeout(
      () => rejectAbortDrain?.(new Error("Provider stream did not terminate after cancellation")),
      STREAM_ABORT_DRAIN_TIMEOUT_MS,
    );
  };
  signal.addEventListener("abort", beginAbortDrain, { once: true });
  if (signal.aborted) beginAbortDrain();

  try {
    while (!terminal) {
      const next = await Promise.race([iterator.next(), hardDeadline, abortDeadline]);
      if (next.done) {
        throw new Error("Provider stream ended without a terminal event");
      }

      const event = next.value;
      if (event.type === "done") {
        terminal = event.message;
      } else if (event.type === "error") {
        terminal = event.error;
      } else if (event.type === "text_delta" || event.type === "text_end") {
        onPartial(event.partial);
      }
    }
    return terminal;
  } finally {
    signal.removeEventListener("abort", beginAbortDrain);
    if (hardTimer) clearTimeout(hardTimer);
    if (abortTimer) clearTimeout(abortTimer);
    if (!terminal) {
      // Do not await a non-compliant iterator's return path. The provider already
      // has an aborted signal; this merely gives a cooperative iterator a chance
      // to release local resources while allowing our request promise to settle.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
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

function parseOnOffFlag(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(normalized)) return true;
  if (["off", "false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

function parseConfig(pi: ExtensionAPI): PromptAutocompleteConfig {
  return {
    allowWhileStreaming: pi.getFlag("prompt-autocomplete-while-streaming") === true,
    streamResponses: parseOnOffFlag(pi.getFlag("prompt-autocomplete-stream"), DEFAULT_STREAM_RESPONSES),
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

/**
 * Recompute enablement and config from flags, then re-apply runtime overrides.
 *
 * Called on every session start. Without the override layer a new session would
 * silently discard `/prompt-autocomplete on`, `while-streaming`, and `debug-*`
 * decisions and revert to the flags the process happened to start with.
 */
function applyEffectiveConfig(pi: ExtensionAPI, shared: PromptAutocompleteSharedState): void {
  const flagEnabled = pi.getFlag("prompt-autocomplete") === true;
  const flagConfig = parseConfig(pi);

  shared.enabled = resolveOverride(shared.runtimeOverrides.enabled, flagEnabled);
  shared.config = {
    ...flagConfig,
    allowWhileStreaming: resolveOverride(
      shared.runtimeOverrides.allowWhileStreaming,
      flagConfig.allowWhileStreaming,
    ),
    streamResponses: resolveOverride(shared.runtimeOverrides.streamResponses, flagConfig.streamResponses),
    debug: resolveOverride(shared.runtimeOverrides.debug, flagConfig.debug),
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
  const resolvedModel = resolveSuggestionModel(shared);
  const editorState = shared.editorMount
    ? shared.ownsEditor?.()
      ? "mounted"
      : "ownership-lost"
    : shared.editorBlockedReason
      ? "blocked"
      : "unmounted";
  const requestedModel = shared.config.preferredModel
    ? `${shared.config.preferredModel.provider}/${shared.config.preferredModel.id}`
    : "current active model";

  return [
    `enabled=${shared.enabled ? "yes" : "no"}(${describeSettingSource(shared.runtimeOverrides.enabled)})`,
    `editor=${editorState}`,
    shared.editorBlockedReason ? `editor-blocked=${truncateDebug(shared.editorBlockedReason, 90)}` : undefined,
    `model=${formatModelLabel(resolvedModel)}`,
    `requested-model=${requestedModel}`,
    `while-streaming=${shared.config.allowWhileStreaming ? "yes" : "no"}(${describeSettingSource(shared.runtimeOverrides.allowWhileStreaming)})`,
    `stream=${shared.config.streamResponses ? "yes" : "no"}(${describeSettingSource(shared.runtimeOverrides.streamResponses)})`,
    `request-path=${shared.config.streamResponses && shared.streamSimple ? "stream" : shared.config.streamResponses ? "complete-compat" : "complete"}`,
    `debug=${shared.config.debug ? "yes" : "no"}(${describeSettingSource(shared.runtimeOverrides.debug)})`,
    `debounce=${shared.config.debounceMs}ms`,
    `min-chars=${shared.config.minPromptChars}`,
    `max-suggestion-chars=${shared.config.maxSuggestionChars}`,
    `max-alternatives=${shared.config.maxAlternatives}`,
    `cache-size=${shared.requestCache.size}`,
    `usage=${formatUsageStats(shared.usageStats)}`,
    `state=${shared.debugState || "idle"}`,
    shared.lastError ? `error=${truncateDebug(shared.lastError, 90)}` : undefined,
    shared.lastRawResponse ? `raw=${truncateDebug(shared.lastRawResponse, 90)}` : undefined,
    `keys=tab accept | ${formatPrimaryKey(WORD_ACCEPT_KEYS)} word | ${formatPrimaryKey(CYCLE_PREV_KEYS)}/${formatPrimaryKey(CYCLE_NEXT_KEYS)} cycle | ${formatPrimaryKey(CYCLE_NEXT_KEYS)} force one-shot`,
  ]
    .filter((value): value is string => !!value)
    .join(" | ");
}

function getCachedRequest(
  shared: PromptAutocompleteSharedState,
  cacheKey: string,
  options: { bypass?: boolean } = {},
): PromptAutocompleteCacheEntry | undefined {
  const entry = shared.requestCache.get(cacheKey, options);
  return entry ? { ...entry, suggestions: [...entry.suggestions] } : undefined;
}

function storeCachedRequest(
  shared: PromptAutocompleteSharedState,
  cacheKey: string,
  entry: PromptAutocompleteCacheEntry,
): PromptAutocompleteCacheEntry {
  const cachedEntry = { ...entry, suggestions: [...entry.suggestions] };
  shared.requestCache.set(cacheKey, cachedEntry);
  return { ...cachedEntry, suggestions: [...cachedEntry.suggestions] };
}

class PromptAutocompleteEditor extends CustomEditor {
  private readonly shared: PromptAutocompleteSharedState;
  private readonly activationId: number;
  private readonly appKeybindings: KeybindingsManager;

  private suggestions: string[] = [];
  private suggestionIndex: number = 0;
  private suggestionsProvisional = false;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private requestSeq = 0;
  private readonly pendingRequests = new SequenceOwnedSlot<PendingSuggestionRequest>();
  private activeRequestSubscription?: CoalescedRequestSubscription<PromptAutocompleteCacheEntry>;
  // One owner token per editor instance; the mount-level refcounter keeps the
  // shared spinner alive until every active owner has released it.
  private activeSpinnerOwner?: string;
  private suspendedUntil = 0;
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
    this.appKeybindings = keybindings;
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

  private setSuggestions(
    nextSuggestions: string[],
    options: { provisional?: boolean } = {},
  ): void {
    const provisional = options.provisional ?? false;
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

    if (
      arraysEqual(this.suggestions, nextSuggestions)
      && this.suggestionIndex === nextIndex
      && this.suggestionsProvisional === provisional
    ) {
      return;
    }

    this.suggestions = [...nextSuggestions];
    this.suggestionIndex = nextIndex;
    this.suggestionsProvisional = nextSuggestions.length > 0 && provisional;

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

    if (NAVIGATION_ACTIONS.some((action) => this.appKeybindings.matches(data, action))) {
      return {
        state: "navigated",
        details: "Suggestion cleared during editor navigation",
      };
    }

    if (EDIT_ACTIONS.some((action) => this.appKeybindings.matches(data, action))) {
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

    const wasProvisional = this.suggestionsProvisional;
    this.dismissedKey = undefined;
    this.clearInlineSuggestion("accepted", wasProvisional ? "Accepted streamed partial suggestion" : "Accepted full suggestion");
    super.insertTextAtCursor(suggestion);
    // A provisional accept is explicit cancellation of the request. Starting a
    // fresh paid request immediately would turn one Tab press into two calls.
    if (!wasProvisional) this.refreshSuggestion();
  }

  private acceptInlineSuggestionByWord(): void {
    const suggestion = this.getActiveSuggestion();
    if (!suggestion) return;

    const chunk = extractNextSuggestionChunk(suggestion) ?? suggestion;
    if (!chunk) return;

    const wasProvisional = this.suggestionsProvisional;
    this.dismissedKey = undefined;
    this.clearInlineSuggestion("accepted-word", `Accepted chunk: ${chunk}`);
    super.insertTextAtCursor(chunk);
    if (!wasProvisional) this.refreshSuggestion();
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
      if (!this.shared.config.allowWhileStreaming && this.shared.agentStreaming) {
        return "Waiting for the current agent turn to finish";
      }
      if (this.shared.now() < this.suspendedUntil) return "In temporary cooldown after the last error";
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

    if (!this.shared.ownsEditor?.()) {
      this.cancelPendingRequest();
      this.shared.editorBlockedReason = "Another extension replaced the prompt-autocomplete editor";
      updateDebugState(this.shared, "ownership-lost", this.shared.editorBlockedReason);
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

    if (!options.manual && request.cacheKey === this.dismissedKey) {
      this.cancelPendingRequest();
      updateDebugState(this.shared, "dismissed", "Suggestion dismissed for current draft");
      this.setSuggestions([]);
      return;
    }

    const cachedEntry = getCachedRequest(this.shared, request.cacheKey, { bypass: options.manual });
    if (cachedEntry) {
      this.shared.usageStats.cacheHits += 1;
      this.cancelPendingRequest();
      this.shared.lastRawResponse = cachedEntry.rawResponse;
      this.shared.lastError = cachedEntry.error;
      if (cachedEntry.suggestions.length === 0) {
        updateDebugState(this.shared, "cache-hit", cachedEntry.debugState || "Cached no-suggestion result");
      }
      this.setSuggestions(cachedEntry.suggestions);
      return;
    }

    if (this.pendingRequests.current?.key === request.cacheKey) {
      updateDebugState(this.shared, "requesting", `Awaiting pending request for ${request.modelLabel}`);
      return;
    }

    const shouldJoinInFlight = this.shared.inFlightRequests.has(request.cacheKey);
    this.cancelPendingRequest();

    const seq = ++this.requestSeq;
    const spinnerOwner = this.makeSpinnerOwner(request, seq);
    this.pendingRequests.set({ key: request.cacheKey, seq, spinnerOwner });
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
      cacheKey: buildPromptAutocompleteCacheKey({
        leafId,
        modelLabel,
        maxAlternatives: this.shared.config.maxAlternatives,
        maxSuggestionChars: this.shared.config.maxSuggestionChars,
        draft,
        latestAssistantContext,
        latestUserContext,
        recentContext,
      }),
      maxAlternatives: this.shared.config.maxAlternatives,
      maxSuggestionChars: this.shared.config.maxSuggestionChars,
      useStreaming: this.shared.config.streamResponses && !!this.shared.streamSimple,
      latestAssistantContext,
      latestUserContext,
      recentContext,
    };
  }

  private async fetchSuggestion(request: SuggestionRequest, seq: number, spinnerOwner: string): Promise<void> {
    if (!this.isRequestStillCurrent(request, seq)) {
      this.clearPendingRequestIfOwned(seq);
      this.deactivateSpinner(spinnerOwner);
      return;
    }

    const subscriberId = this.makeRequestSubscriberId(seq);
    const subscription = acquireCoalescedRequest(
      this.shared.inFlightRequests,
      request.cacheKey,
      subscriberId,
      (signal, publish) => this.fetchSuggestionUncached(request, signal, publish),
      (suggestion) => this.showStreamedSuggestion(request, seq, spinnerOwner, suggestion),
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
        this.suspendedUntil = this.shared.now() + FAILURE_COOLDOWN_MS;
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
      this.clearPendingRequestIfOwned(seq);
      this.deactivateSpinner(spinnerOwner);
    }
  }

  private showStreamedSuggestion(
    request: SuggestionRequest,
    seq: number,
    spinnerOwner: string,
    suggestion: string,
  ): void {
    if (!this.isRequestStillCurrent(request, seq)) return;
    if (request.cacheKey === this.dismissedKey) return;

    const current = this.getActiveSuggestion();
    // Progress is strictly monotonic. If a provider revises earlier text, keep
    // the last honest preview and let the terminal response replace it.
    if (current && (!suggestion.startsWith(current) || suggestion.length <= current.length)) return;

    this.setSuggestions([suggestion], { provisional: true });
    this.deactivateSpinner(spinnerOwner);
  }

  private async fetchSuggestionUncached(
    request: SuggestionRequest,
    signal: AbortSignal,
    publish: (suggestion: string) => void,
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

    const stats = this.shared.usageStats;
    stats.providerRequests += 1;

    const context = {
      systemPrompt: PROMPT_AUTOCOMPLETE_SYSTEM_PROMPT,
      messages: [userMessage],
    };
    const requestOptions = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: computeRequestMaxTokens(request.maxAlternatives, request.maxSuggestionChars),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: REQUEST_MAX_RETRIES,
      maxRetryDelayMs: REQUEST_MAX_RETRY_DELAY_MS,
    };

    let response: AssistantMessage;
    try {
      if (request.useStreaming && this.shared.streamSimple) {
        const hardDeadlineController = new AbortController();
        const streamSignal = AbortSignal.any([signal, hardDeadlineController.signal]);
        const stream = this.shared.streamSimple(request.model, context, {
          ...requestOptions,
          signal: streamSignal,
        });
        let lastPublished = "";

        // Exactly one consumer receives the terminal message. Partial text is
        // fanned out through coalescing; after UI cancellation the callback is
        // gone, but the bounded drain can still retain terminal usage.
        response = await consumeAssistantStream(stream, streamSignal, () => hardDeadlineController.abort(), (partial) => {
          // `partial` is cumulative. Appending delta plus text_end.content would
          // duplicate the completed block on providers that emit both.
          const partialText = extractAssistantText(partial);
          const suggestion = parsePartialPromptSuggestion(request.draft, partialText, request.maxSuggestionChars);
          if (!suggestion || suggestion === lastPublished) return;
          if (lastPublished && !suggestion.startsWith(lastPublished)) return;
          lastPublished = suggestion;
          publish(suggestion);
        });
      } else {
        response = await this.shared.completeSimple(request.model, context, requestOptions);
      }
    } catch (error) {
      stats.failedRequests += 1;
      throw error;
    }

    // Tokens spent on a failed or aborted response are still spent, so usage is
    // recorded before the stop-reason check rejects the request.
    recordProviderUsage(stats, response.usage);

    const contentTypes = response.content.map((block) => block.type).join(", ") || "(none)";
    const text = extractAssistantText(response);

    const responseError = response.errorMessage?.trim();
    const rawResponse = text || responseError || `[types=${contentTypes}; stopReason=${response.stopReason}]`;

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      stats.failedRequests += 1;
      throw new Error(responseError || `Provider returned stopReason=${response.stopReason}`);
    }
    if (signal.aborted) {
      stats.failedRequests += 1;
      throw new Error("Request was aborted");
    }

    const normalized = normalizePromptSuggestions(
      request.draft,
      text,
      request.maxSuggestionChars,
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
    if (!this.shared.ownsEditor?.()) return false;
    if (this.activationId !== this.shared.activationId) return false;
    if (seq !== this.requestSeq) return false;
    if (request.activationId !== this.activationId) return false;
    if (!this.isCursorAtEndOfDraft()) return false;
    if (this.getText() !== request.draft) return false;
    if (this.isShowingAutocomplete()) return false;

    const currentRequest = this.buildRequest();
    return currentRequest?.cacheKey === request.cacheKey;
  }

  cancelActiveRequest(): void {
    this.cancelPendingRequest();
    this.setSuggestions([]);
  }

  private clearPendingRequestIfOwned(seq: number): void {
    this.pendingRequests.clearIfOwned(seq);
  }

  private cancelPendingRequest(): void {
    this.requestSeq += 1;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    const pending = this.pendingRequests.take();
    const subscription = this.activeRequestSubscription;
    this.activeRequestSubscription = undefined;
    subscription?.release();
    this.deactivateSpinner(pending?.spinnerOwner);
  }
}

function releaseEditorRuntime(shared: PromptAutocompleteSharedState): void {
  shared.cancelActiveRequest?.();
  shared.activationId += 1;
  cancelAllCoalescedRequests(shared.inFlightRequests);
  shared.clearSpinner?.();
  clearDebugUi(shared);
  shared.refreshEditor = undefined;
  shared.cancelActiveRequest = undefined;
  shared.setStatusText = undefined;
  shared.setSpinnerActive = undefined;
  shared.clearSpinner = undefined;
  shared.ownsEditor = undefined;
}

function mountEditor(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): boolean {
  if (ctx.mode !== "tui") return false;

  if (shared.editorMount) {
    if (shared.ownsEditor?.()) return true;
    releaseEditorRuntime(shared);
    shared.editorMount = undefined;
  }

  const previousFactory = ctx.ui.getEditorComponent();
  if (previousFactory) {
    const reason = "Another custom editor is already active; prompt autocomplete did not replace it";
    const shouldNotify = shared.editorBlockedReason !== reason;
    shared.editorBlockedReason = reason;
    updateDebugState(shared, "blocked-custom-editor", reason);
    if (shouldNotify) ctx.ui.notify(reason, "warning");
    return false;
  }

  shared.editorBlockedReason = undefined;
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
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
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

  const installedFactory: EditorFactory = (tui, theme, keybindings) => {
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
  };

  shared.editorMount = { previousFactory, installedFactory };
  shared.ownsEditor = () => ctx.ui.getEditorComponent() === installedFactory;

  try {
    ctx.ui.setEditorComponent(installedFactory);
  } catch (error) {
    releaseEditorRuntime(shared);
    shared.editorMount = undefined;
    throw error;
  }

  updateDebugState(shared, "mounted", "Editor extension attached");
  return true;
}

function unmountEditor(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  const mount = shared.editorMount;
  const shouldRestore = ctx.mode === "tui" && !!mount && ctx.ui.getEditorComponent() === mount.installedFactory;

  releaseEditorRuntime(shared);
  shared.editorMount = undefined;
  shared.editorBlockedReason = undefined;

  if (shouldRestore && mount) {
    ctx.ui.setEditorComponent(mount.previousFactory);
  }
}

function resetSharedForSession(pi: ExtensionAPI, shared: PromptAutocompleteSharedState): void {
  shared.cancelActiveRequest?.();
  shared.cancelActiveRequest = undefined;
  applyEffectiveConfig(pi, shared);
  shared.usageStats = createPromptAutocompleteUsageStats();
  shared.editorMount = undefined;
  shared.editorBlockedReason = undefined;
  shared.ownsEditor = undefined;
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
  shared.agentStreaming = false;
}

function refreshEditorImmediately(shared: PromptAutocompleteSharedState, state: string, details: string): void {
  updateDebugState(shared, state, details);
  shared.refreshEditor?.({ clearExisting: true, immediate: true });
}

function setDebugDisplay(shared: PromptAutocompleteSharedState, enabled: boolean): void {
  shared.config.debug = enabled;
  shared.runtimeOverrides.debug = enabled;
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
  shared.runtimeOverrides.allowWhileStreaming = next;
  ctx.ui.notify(`Prompt autocomplete while-streaming ${next ? "enabled" : "disabled"}`, "info");

  if (shared.enabled) {
    // Only label it "waiting" when disabling actually suppresses right now (agent
    // streaming); otherwise the refresh below requests suggestions immediately.
    const willSuppress = !next && shared.agentStreaming;
    refreshEditorImmediately(shared, willSuppress ? "waiting" : "ready", `While-streaming ${next ? "enabled" : "disabled"}`);
  }
}

function setStreamResponses(
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
    next = !shared.config.streamResponses;
  } else {
    ctx.ui.notify("Usage: /prompt-autocomplete stream [on|off|toggle]", "warning");
    return;
  }

  const changed = shared.config.streamResponses !== next;
  shared.config.streamResponses = next;
  shared.runtimeOverrides.streamResponses = next;
  const path = next && shared.streamSimple ? "streaming" : next ? "completion compatibility" : "completion";
  ctx.ui.notify(
    `Prompt autocomplete response streaming ${next ? "enabled" : "disabled"} (${path} path)${changed ? "; applies to next request" : ""}`,
    "info",
  );

  if (shared.enabled && changed) {
    // Presentation changes must not silently buy a replacement request. Cancel
    // active work and clear provisional text; the next edit or manual trigger
    // uses the selected path.
    shared.cancelActiveRequest?.();
    updateDebugState(shared, "ready", `Response streaming ${next ? "enabled" : "disabled"}; waiting for next request`);
  }
}

function enablePromptAutocomplete(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): boolean {
  shared.enabled = true;
  shared.runtimeOverrides.enabled = true;
  return mountEditor(ctx, shared);
}

function disablePromptAutocomplete(ctx: ExtensionContext, shared: PromptAutocompleteSharedState): void {
  shared.enabled = false;
  shared.runtimeOverrides.enabled = false;
  unmountEditor(ctx, shared);
  shared.requestCache.clear();
  shared.lastRawResponse = undefined;
  shared.lastError = undefined;
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
  const privacyNotice = "Requests send the current draft and recent conversation context to the selected model and may incur provider usage.";

  if (options.includeModel) {
    if (resolvedModel) {
      ctx.ui.notify(
        `Prompt autocomplete enabled. ${keyHint} Model: ${formatModelLabel(resolvedModel)} ${privacyNotice}`,
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

  ctx.ui.notify(`Prompt autocomplete enabled. ${keyHint} ${privacyNotice}`, "info");
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
      if (shared.enabled && shared.ownsEditor?.()) {
        // Already in the requested state, but the user still expressed intent:
        // record it so a later session does not fall back to the flag.
        shared.runtimeOverrides.enabled = true;
        ctx.ui.notify(`Prompt autocomplete already enabled (${formatStatus(shared)})`, "info");
        return;
      }

      if (enablePromptAutocomplete(ctx, shared)) {
        notifyPromptAutocompleteEnabled(ctx, shared, { includeModel: true });
      }
    },
    off: () => {
      if (!shared.enabled) {
        shared.runtimeOverrides.enabled = false;
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

      if (enablePromptAutocomplete(ctx, shared)) {
        notifyPromptAutocompleteEnabled(ctx, shared, { includeModel: false });
      }
    },
  };
}

export function createPromptAutocompleteExtension(
  dependencies: PromptAutocompleteDependencies = {},
): (pi: ExtensionAPI) => void {
  const completeSimpleImpl = dependencies.completeSimple ?? completeSimple;
  // Existing deterministic harnesses inject only completeSimple. Never let such
  // a harness fall through to the real network-capable stream implementation.
  const streamSimpleImpl = dependencies.streamSimple ?? (dependencies.completeSimple ? undefined : streamSimple);
  const now = dependencies.now ?? Date.now;

  return function promptAutocompleteExtension(pi: ExtensionAPI): void {
  pi.registerFlag("prompt-autocomplete", {
    description: "Enable inline AI prompt autocomplete in the editor",
    type: "boolean",
    default: DEFAULT_PROMPT_AUTOCOMPLETE_ENABLED,
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
  pi.registerFlag("prompt-autocomplete-stream", {
    description: "Render streamed response progress as ghost text (on|off)",
    // Pi's boolean extension flags can only be switched on. A string flag is
    // required so a feature that defaults on can still be disabled at startup.
    type: "string",
    default: DEFAULT_STREAM_RESPONSES ? "on" : "off",
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
    agentStreaming: false,
    config: parseConfig(pi),
    runtimeOverrides: {},
    usageStats: createPromptAutocompleteUsageStats(),
    completeSimple: completeSimpleImpl,
    streamSimple: streamSimpleImpl,
    now,
    debugState: "idle",
    requestCache: new ExpiringLruCache(REQUEST_CACHE_TTL_MS, REQUEST_CACHE_MAX_ENTRIES, now),
    inFlightRequests: new Map(),
  };

  pi.on("session_start", async (_event, ctx) => {
    if (shared.editorMount) {
      unmountEditor(ctx, shared);
    }
    resetSharedForSession(pi, shared);
    bindRuntimeContext(ctx, shared);

    if (ctx.mode !== "tui" || !shared.enabled) return;
    mountEditor(ctx, shared);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Teardown, not a user decision: leave runtimeOverrides untouched.
    shared.enabled = false;
    shared.cancelActiveRequest?.();
    shared.requestCache.clear();
    cancelAllCoalescedRequests(shared.inFlightRequests);
    unmountEditor(ctx, shared);
  });

  pi.on("model_select", async (event, ctx) => {
    shared.currentModel = event.model as Model<Api>;
    shared.modelRegistry = ctx.modelRegistry;
    if (!shared.enabled) return;
    refreshEditorImmediately(shared, "model-changed", formatModelLabel(event.model as Model<Api>));
  });

  pi.on("session_tree", async (_event, ctx) => {
    shared.sessionManager = ctx.sessionManager;
    if (!shared.enabled) return;
    refreshEditorImmediately(shared, "context-changed", "Conversation branch changed");
  });

  pi.on("agent_start", async () => {
    shared.agentStreaming = true;
    if (!shared.enabled || shared.config.allowWhileStreaming) return;
    refreshEditorImmediately(shared, "waiting", "Main agent is still working");
  });

  pi.on("agent_end", async () => {
    shared.agentStreaming = false;
    if (!shared.enabled) return;
    refreshEditorImmediately(shared, "ready", "Agent finished; autocomplete can request suggestions again");
  });

  pi.registerCommand("prompt-autocomplete", {
    description: "Enable, disable, or inspect inline prompt autocomplete",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("prompt-autocomplete requires interactive TUI mode", "warning");
        return;
      }

      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const command = parts[0] || "status";

      if (command === "while-streaming") {
        setWhileStreaming(ctx, shared, parts[1]);
        return;
      }
      if (command === "stream") {
        setStreamResponses(ctx, shared, parts[1]);
        return;
      }

      const handlers = createPromptAutocompleteCommandHandlers(ctx, shared);
      const handler = handlers[command];

      if (handler) {
        handler();
        return;
      }

      ctx.ui.notify(
        "Usage: /prompt-autocomplete [on|off|toggle|status|stream on|off|toggle|while-streaming on|off|toggle|debug-on|debug-off|debug-toggle]",
        "warning",
      );
    },
  });
  };
}

export default createPromptAutocompleteExtension();
