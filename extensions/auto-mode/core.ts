export const AUTO_MODE_STATE_TYPE = "auto-mode-state";
export const DEFAULT_CONTROLLER_MODEL = "openai/gpt-5.4-mini";
export const DEFAULT_AUTO_ITERATIONS = 8;
export const DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS = 12;
export const DEFAULT_MAX_ITERATIONS_LIMIT = 1_000;
export const DEFAULT_MAX_WALL_CLOCK_MINUTES = 60;
export const DEFAULT_CONTROLLER_FAILURE_LIMIT = 2;
export const DEFAULT_WORKER_FAILURE_LIMIT = 2;
export const DEFAULT_STAGNATION_LIMIT = 3;
export const DEFAULT_NO_CHANGE_LIMIT = 3;
export const DEFAULT_DECISION_HISTORY_LIMIT = 5;
export const DEFAULT_CONTROLLER_SUMMARY_MAX_CHARS = 2_500;
export const DEFAULT_STATUS_GOAL_MAX_CHARS = 42;

export type AutoMode = "iterations" | "until" | "hybrid";
export type GoalStatus = "in_progress" | "likely_met" | "met" | "blocked" | "stalled";
export type CommitPolicy = "none" | "milestones" | "final-or-milestone";
export type PushPolicy = "never" | "if-upstream" | "final-or-milestone-if-upstream";
export type CommitRecommendation = "none" | "milestone" | "finalize";
export type ProbeKind = "git_status" | "git_diff_names" | "git_head" | "verify_command";
export type ResumePolicy = "restore-paused" | "restore-running";
export type AutoCommandKind = "on" | "status" | "pause" | "resume" | "off" | "summary" | "nudge";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface AutoStartConfig {
  goal: string;
  untilPrompt?: string;
  mode: AutoMode;
  maxIterations: number;
  controllerModel?: ModelRef;
  verifyCommand?: string;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
  allowControllerProbes: boolean;
  maxWallClockMinutes: number;
  resumeOnSessionStart: boolean;
}

export interface AutoDecisionLogEntry {
  iteration: number;
  action: ControllerAction;
  reason: string;
  nextPrompt?: string;
  timestamp: number;
}

export interface AutoModeStateV1 {
  version: 1;
  enabled: boolean;
  paused: boolean;
  runId: string;
  goal: string;
  untilPrompt?: string;
  mode: AutoMode;
  maxIterations: number;
  currentIteration: number;
  startedAt: number;
  lastControllerAt?: number;
  lastWorkerFinishedAt?: number;
  controllerModel?: ModelRef;
  verifyCommand?: string;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
  allowControllerProbes: boolean;
  maxWallClockMinutes: number;
  controllerSummary: string;
  recentDecisions: AutoDecisionLogEntry[];
  lastAutoPrompt?: string;
  lastStopReason?: string;
  consecutiveControllerFailures: number;
  consecutiveWorkerFailures: number;
  consecutiveStagnationCount: number;
  consecutiveNoChangeCount: number;
  lastSeenHead?: string;
  lastSeenChangedFiles?: string[];
  resumePolicy: ResumePolicy;
}

export type AutoCommandParseResult =
  | { kind: "on"; config: AutoStartConfig }
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "off" }
  | { kind: "summary" }
  | { kind: "nudge"; text: string }
  | { error: string };

export interface AutoFlagValues {
  goal?: boolean | string;
  iterations?: boolean | string;
  until?: boolean | string;
  controllerModel?: boolean | string;
  verify?: boolean | string;
  commitPolicy?: boolean | string;
  pushPolicy?: boolean | string;
  allowControllerProbes?: boolean | string;
  resume?: boolean | string;
  maxWallClockMinutes?: boolean | string;
}

export interface VerifyPreflightInput {
  verifyCommandConfigured: boolean;
  stopReason: string;
  assistantText: string;
  currentIteration: number;
  maxIterations: number;
}

interface BaseControllerDecision {
  action: ControllerAction;
  reason: string;
  updatedSummary: string;
  goalStatus: GoalStatus;
  qualityGoalMet: boolean;
  progressPercent: number;
  commitRecommendation: CommitRecommendation;
}

export interface ContinueDecision extends BaseControllerDecision {
  action: "continue";
  nextPrompt: string;
}

export interface StopDecision extends BaseControllerDecision {
  action: "stop";
  finalMessage?: string;
}

export interface PauseDecision extends BaseControllerDecision {
  action: "pause";
}

export interface ProbeDecision extends BaseControllerDecision {
  action: "probe";
  probe: {
    kind: ProbeKind;
  };
}

export type ControllerAction = "continue" | "stop" | "pause" | "probe";
export type ControllerDecision = ContinueDecision | StopDecision | PauseDecision | ProbeDecision;

interface ParsedControllerPayload {
  action?: unknown;
  reason?: unknown;
  updatedSummary?: unknown;
  summary?: unknown;
  goalStatus?: unknown;
  qualityGoalMet?: unknown;
  progressPercent?: unknown;
  commitRecommendation?: unknown;
  nextPrompt?: unknown;
  prompt?: unknown;
  finalMessage?: unknown;
  probe?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return "…";
  return `${text.slice(0, maxLength - 1)}…`;
}

function tokenizeArgs(input: string): string[] | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (const char of trimmed) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escape) {
    current += "\\";
  }

  if (quote) {
    return { error: "Unterminated quoted string" };
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function parseStringFlag(value: boolean | string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanFlag(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

export function parseModelRef(value: boolean | string | undefined): ModelRef | undefined {
  const trimmed = parseStringFlag(value);
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

export function parsePositiveInteger(value: string, max = DEFAULT_MAX_ITERATIONS_LIMIT): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) return undefined;
  return parsed;
}

export function summarizeGoal(goal: string, maxLength = DEFAULT_STATUS_GOAL_MAX_CHARS): string {
  return truncateWithEllipsis(collapseWhitespace(goal), maxLength);
}

export function normalizeComparableText(text: string): string {
  return collapseWhitespace(text).toLowerCase();
}

export function looksLikeCompletionClaim(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized) return false;

  const blockingPatterns = [
    /\b(todo|follow-up|follow up|remaining work|still need|still needs|not done|not complete)\b/,
    /\b(need to|needs to|should still|left to do|manual step|manual follow-up|please confirm)\b/,
    /\b(cannot|can't|unable to|blocked|waiting for)\b/,
    /\?$/,
  ];
  if (blockingPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const positivePatterns = [
    /\b(done|completed|finished|implemented|resolved|fixed|verified|ready)\b/,
    /\b(all tests pass|tests pass|test suite passes|verification passed)\b/,
    /\b(committed and pushed|pushed successfully|work is complete)\b/,
  ];
  return positivePatterns.some((pattern) => pattern.test(normalized));
}

export function shouldPreRunVerifyCommand(input: VerifyPreflightInput): boolean {
  if (!input.verifyCommandConfigured) return false;
  if (input.stopReason !== "stop") return false;
  if (input.currentIteration >= input.maxIterations) return true;
  return looksLikeCompletionClaim(input.assistantText);
}

function isCommitPolicy(value: string): value is CommitPolicy {
  return value === "none" || value === "milestones" || value === "final-or-milestone";
}

function isPushPolicy(value: string): value is PushPolicy {
  return value === "never" || value === "if-upstream" || value === "final-or-milestone-if-upstream";
}

function isGoalStatus(value: string): value is GoalStatus {
  return value === "in_progress" || value === "likely_met" || value === "met" || value === "blocked" || value === "stalled";
}

function isCommitRecommendation(value: string): value is CommitRecommendation {
  return value === "none" || value === "milestone" || value === "finalize";
}

function isProbeKind(value: string): value is ProbeKind {
  return value === "git_status" || value === "git_diff_names" || value === "git_head" || value === "verify_command";
}

function resolveAutoMode(iterations: number | undefined, untilPrompt: string | undefined): { mode: AutoMode; maxIterations: number } {
  if (untilPrompt && iterations) {
    return { mode: "hybrid", maxIterations: iterations };
  }
  if (untilPrompt) {
    return { mode: "until", maxIterations: DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS };
  }
  return { mode: "iterations", maxIterations: iterations ?? DEFAULT_AUTO_ITERATIONS };
}

function parseOnConfigFromTokens(tokens: string[]): AutoCommandParseResult {
  let iterations: number | undefined;
  let untilPrompt: string | undefined;
  let controllerModel: ModelRef | undefined;
  let verifyCommand: string | undefined;
  let commitPolicy: CommitPolicy = "final-or-milestone";
  let pushPolicy: PushPolicy = "final-or-milestone-if-upstream";
  let allowControllerProbes = true;
  let maxWallClockMinutes = DEFAULT_MAX_WALL_CLOCK_MINUTES;
  const goalTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token === "--iterations") {
      const value = tokens[index + 1];
      const parsed = value ? parsePositiveInteger(value) : undefined;
      if (!parsed) {
        return { error: `--iterations must be an integer between 1 and ${DEFAULT_MAX_ITERATIONS_LIMIT}` };
      }
      iterations = parsed;
      index += 1;
      continue;
    }

    if (token === "--until") {
      const value = tokens[index + 1];
      if (!value?.trim()) {
        return { error: "--until requires a non-empty value" };
      }
      untilPrompt = value.trim();
      index += 1;
      continue;
    }

    if (token === "--controller-model") {
      const value = tokens[index + 1];
      const parsed = value ? parseModelRef(value) : undefined;
      if (!parsed) {
        return { error: "--controller-model must be in provider/model form" };
      }
      controllerModel = parsed;
      index += 1;
      continue;
    }

    if (token === "--verify") {
      const value = tokens[index + 1];
      if (!value?.trim()) {
        return { error: "--verify requires a non-empty value" };
      }
      verifyCommand = value.trim();
      index += 1;
      continue;
    }

    if (token === "--commit-policy") {
      const value = tokens[index + 1];
      if (!value || !isCommitPolicy(value)) {
        return { error: "--commit-policy must be one of: none, milestones, final-or-milestone" };
      }
      commitPolicy = value;
      index += 1;
      continue;
    }

    if (token === "--push-policy") {
      const value = tokens[index + 1];
      if (!value || !isPushPolicy(value)) {
        return { error: "--push-policy must be one of: never, if-upstream, final-or-milestone-if-upstream" };
      }
      pushPolicy = value;
      index += 1;
      continue;
    }

    if (token === "--no-controller-probes") {
      allowControllerProbes = false;
      continue;
    }

    if (token === "--max-wall-clock-minutes") {
      const value = tokens[index + 1];
      const parsed = value ? parsePositiveInteger(value, 24 * 60) : undefined;
      if (!parsed) {
        return { error: "--max-wall-clock-minutes must be an integer between 1 and 1440" };
      }
      maxWallClockMinutes = parsed;
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      return { error: `Unknown flag: ${token}` };
    }

    goalTokens.push(...tokens.slice(index));
    break;
  }

  const goal = goalTokens.join(" ").trim();
  if (!goal) {
    return { error: "Usage: /auto on [flags] <goal>" };
  }

  const { mode, maxIterations } = resolveAutoMode(iterations, untilPrompt);
  return {
    kind: "on",
    config: {
      goal,
      untilPrompt,
      mode,
      maxIterations,
      controllerModel,
      verifyCommand,
      commitPolicy,
      pushPolicy,
      allowControllerProbes,
      maxWallClockMinutes,
      resumeOnSessionStart: false,
    },
  };
}

export function parseAutoCommandArgs(args: string): AutoCommandParseResult {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "Usage: /auto <on|off|pause|resume|status|summary|nudge>" };
  }

  const firstWhitespace = trimmed.search(/\s/);
  const command = (firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace)).toLowerCase();
  const rest = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1).trim();

  switch (command) {
    case "status":
      return { kind: "status" };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "off":
      return { kind: "off" };
    case "summary":
      return { kind: "summary" };
    case "nudge":
      return rest ? { kind: "nudge", text: rest } : { error: "Usage: /auto nudge <instruction>" };
    case "on": {
      const tokenized = tokenizeArgs(rest);
      if (!Array.isArray(tokenized)) {
        return { error: tokenized.error };
      }
      return parseOnConfigFromTokens(tokenized);
    }
    default:
      return { error: `Unknown /auto subcommand: ${command}` };
  }
}

export function buildAutoStartConfigFromFlags(flags: AutoFlagValues): AutoStartConfig | { error: string } | undefined {
  if (typeof flags.goal !== "string") return undefined;
  const goal = flags.goal.trim();
  if (!goal) {
    return { error: "--auto-goal must be a non-empty string" };
  }

  const iterationsFlag = parseStringFlag(flags.iterations);
  const untilPrompt = parseStringFlag(flags.until);
  const controllerModelFlag = parseStringFlag(flags.controllerModel);
  const verifyCommand = parseStringFlag(flags.verify);
  const commitPolicyFlag = parseStringFlag(flags.commitPolicy);
  const pushPolicyFlag = parseStringFlag(flags.pushPolicy);
  const maxWallClockFlag = parseStringFlag(flags.maxWallClockMinutes);

  const iterations = iterationsFlag ? parsePositiveInteger(iterationsFlag) : undefined;
  if (iterationsFlag && !iterations) {
    return { error: `--auto-iterations must be an integer between 1 and ${DEFAULT_MAX_ITERATIONS_LIMIT}` };
  }

  const controllerModel = controllerModelFlag ? parseModelRef(controllerModelFlag) : undefined;
  if (controllerModelFlag && !controllerModel) {
    return { error: "--auto-controller-model must be in provider/model form" };
  }

  let commitPolicy: CommitPolicy = "final-or-milestone";
  if (commitPolicyFlag) {
    if (!isCommitPolicy(commitPolicyFlag)) {
      return { error: "--auto-commit-policy must be one of: none, milestones, final-or-milestone" };
    }
    commitPolicy = commitPolicyFlag;
  }

  let pushPolicy: PushPolicy = "final-or-milestone-if-upstream";
  if (pushPolicyFlag) {
    if (!isPushPolicy(pushPolicyFlag)) {
      return { error: "--auto-push-policy must be one of: never, if-upstream, final-or-milestone-if-upstream" };
    }
    pushPolicy = pushPolicyFlag;
  }

  let maxWallClockMinutes = DEFAULT_MAX_WALL_CLOCK_MINUTES;
  if (maxWallClockFlag) {
    const parsed = parsePositiveInteger(maxWallClockFlag, 24 * 60);
    if (!parsed) {
      return { error: "--auto-max-wall-clock-minutes must be an integer between 1 and 1440" };
    }
    maxWallClockMinutes = parsed;
  }

  const { mode, maxIterations } = resolveAutoMode(iterations, untilPrompt);
  return {
    goal,
    untilPrompt,
    mode,
    maxIterations,
    controllerModel,
    verifyCommand,
    commitPolicy,
    pushPolicy,
    allowControllerProbes: parseBooleanFlag(flags.allowControllerProbes, true),
    maxWallClockMinutes,
    resumeOnSessionStart: parseBooleanFlag(flags.resume, false),
  };
}

function getJsonCandidates(rawText: string): string[] {
  const text = rawText.trim();
  if (!text) return [];

  const candidates = new Set<string>();
  candidates.add(text);

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.add(text.slice(firstBrace, lastBrace + 1));
  }

  return [...candidates];
}

export function parseControllerDecision(rawText: string): ControllerDecision | undefined {
  for (const candidate of getJsonCandidates(rawText)) {
    try {
      const parsed = JSON.parse(candidate) as ParsedControllerPayload;
      if (!isRecord(parsed)) continue;

      const action = typeof parsed.action === "string" ? parsed.action : undefined;
      const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : undefined;
      const updatedSummary =
        typeof parsed.updatedSummary === "string"
          ? parsed.updatedSummary.trim()
          : typeof parsed.summary === "string"
            ? parsed.summary.trim()
            : undefined;
      const goalStatus = typeof parsed.goalStatus === "string" && isGoalStatus(parsed.goalStatus)
        ? parsed.goalStatus
        : undefined;
      const qualityGoalMet = typeof parsed.qualityGoalMet === "boolean" ? parsed.qualityGoalMet : undefined;
      const progressRaw = typeof parsed.progressPercent === "number" ? parsed.progressPercent : undefined;
      const commitRecommendation = typeof parsed.commitRecommendation === "string" && isCommitRecommendation(parsed.commitRecommendation)
        ? parsed.commitRecommendation
        : undefined;

      if (!action || !reason || !updatedSummary || !goalStatus || qualityGoalMet === undefined || progressRaw === undefined || !commitRecommendation) {
        continue;
      }

      const progressPercent = Math.max(0, Math.min(100, Math.round(progressRaw)));
      const base = {
        action: action as ControllerAction,
        reason,
        updatedSummary,
        goalStatus,
        qualityGoalMet,
        progressPercent,
        commitRecommendation,
      };

      if (action === "continue") {
        const nextPrompt =
          typeof parsed.nextPrompt === "string"
            ? parsed.nextPrompt.trim()
            : typeof parsed.prompt === "string"
              ? parsed.prompt.trim()
              : "";
        if (!nextPrompt) continue;
        return {
          ...base,
          action: "continue",
          nextPrompt,
        };
      }

      if (action === "stop") {
        return {
          ...base,
          action: "stop",
          finalMessage: typeof parsed.finalMessage === "string" ? parsed.finalMessage.trim() || undefined : undefined,
        };
      }

      if (action === "pause") {
        return {
          ...base,
          action: "pause",
        };
      }

      if (action === "probe") {
        const probe = isRecord(parsed.probe) ? parsed.probe : undefined;
        const kind = probe && typeof probe.kind === "string" && isProbeKind(probe.kind) ? probe.kind : undefined;
        if (!kind) continue;
        return {
          ...base,
          action: "probe",
          probe: { kind },
        };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is { type?: unknown; text?: unknown } => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function buildRecentConversationContext(branch: unknown[], maxMessages = 8, maxCharsPerMessage = 400): string {
  const collected: string[] = [];

  for (let index = branch.length - 1; index >= 0 && collected.length < maxMessages; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractMessageText(message.content);
    if (!text) continue;

    const prefix = role === "user" ? "User" : "Assistant";
    collected.push(`${prefix}: ${truncateWithEllipsis(collapseWhitespace(text), maxCharsPerMessage)}`);
  }

  return collected.reverse().join("\n\n");
}

function buildLatestRoleMessageContext(branch: unknown[], role: "user" | "assistant", maxChars: number): string {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== role) continue;

    const text = extractMessageText(message.content);
    if (!text) continue;
    return truncateWithEllipsis(text, maxChars);
  }

  return "";
}

export function buildLatestAssistantMessageContext(branch: unknown[], maxChars = 1_600): string {
  return buildLatestRoleMessageContext(branch, "assistant", maxChars);
}

export function buildLatestUserMessageContext(branch: unknown[], maxChars = 1_200): string {
  return buildLatestRoleMessageContext(branch, "user", maxChars);
}

export function appendDecisionHistory(
  history: AutoDecisionLogEntry[],
  entry: AutoDecisionLogEntry,
  maxItems = DEFAULT_DECISION_HISTORY_LIMIT,
): AutoDecisionLogEntry[] {
  return [...history, entry].slice(-maxItems);
}

export function truncateControllerSummary(summary: string, maxChars = DEFAULT_CONTROLLER_SUMMARY_MAX_CHARS): string {
  const normalized = summary.trim();
  if (!normalized) return "";
  return truncateWithEllipsis(normalized, maxChars);
}
