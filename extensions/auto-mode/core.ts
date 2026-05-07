import { readFileSync } from "node:fs";

export const AUTO_MODE_STATE_TYPE = "auto-mode-state";
export const DEFAULT_CONTROLLER_MODEL = "active worker model";
export const DEFAULT_AUTO_ITERATIONS = 8;
export const DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS = 12;
export const DEFAULT_MAX_ITERATIONS_LIMIT = 1_000;
export const DEFAULT_CONTROLLER_FAILURE_LIMIT = 2;
export const DEFAULT_WORKER_FAILURE_LIMIT = 2;
export const DEFAULT_STAGNATION_LIMIT = 3;
export const DEFAULT_NO_CHANGE_LIMIT = 3;
export const DEFAULT_DECISION_HISTORY_LIMIT = 5;
export const DEFAULT_CONTROLLER_SUMMARY_MAX_CHARS = 2_500;
export const DEFAULT_STATUS_GOAL_MAX_CHARS = 42;

export type AutoMode = "iterations" | "until" | "hybrid";
export type AssuranceMode = "pragmatic" | "strict";
export type GoalStatus = "in_progress" | "likely_met" | "met" | "blocked" | "stalled";
export type CommitPolicy = "none" | "milestones" | "final-or-milestone";
export type PushPolicy = "never" | "if-upstream" | "final-or-milestone-if-upstream";
export type ResumePolicy = "restore-paused" | "restore-running";
export type AutoCommandKind = "on" | "status" | "pause" | "resume" | "off" | "summary" | "nudge";
export type AutoSessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

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
  assuranceMode: AssuranceMode;
  resumeOnSessionStart: boolean;
}

export interface AutoWorkerPromptInput {
  goal: string;
  verifyCommand?: string;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
}

export interface AutoDecisionLogEntry {
  iteration: number;
  action: ControllerAction;
  reason: string;
  nextPrompt?: string;
  timestamp: number;
}

export interface AutoModeStateV2 {
  version: 2;
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
  assuranceMode: AssuranceMode;
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
  lastSeenRepoFingerprint?: string;
  resumePolicy: ResumePolicy;
  migrationWarnings?: string[];
}

export interface AutoModeStateV1Like {
  version: 1;
  enabled?: unknown;
  paused?: unknown;
  runId?: unknown;
  goal?: unknown;
  untilPrompt?: unknown;
  mode?: unknown;
  maxIterations?: unknown;
  currentIteration?: unknown;
  startedAt?: unknown;
  lastControllerAt?: unknown;
  lastWorkerFinishedAt?: unknown;
  controllerModel?: unknown;
  verifyCommand?: unknown;
  commitPolicy?: unknown;
  pushPolicy?: unknown;
  completionPolicy?: unknown;
  phase?: unknown;
  adjacentContinuationCount?: unknown;
  maxAdjacentContinuations?: unknown;
  allowControllerProbes?: unknown;
  workerReflectionEnabled?: unknown;
  workerReflectionUsed?: unknown;
  controllerSummary?: unknown;
  recentDecisions?: unknown;
  lastAutoPrompt?: unknown;
  lastStopReason?: unknown;
  consecutiveControllerFailures?: unknown;
  consecutiveWorkerFailures?: unknown;
  consecutiveStagnationCount?: unknown;
  consecutiveNoChangeCount?: unknown;
  lastSeenHead?: unknown;
  lastSeenChangedFiles?: unknown;
  lastSeenRepoFingerprint?: unknown;
  resumePolicy?: unknown;
}

export type AutoModeState = AutoModeStateV2;

export type AutoCommandParseResult =
  | { kind: "on"; config: AutoStartConfig; warnings: string[] }
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
  assurance?: boolean | string;
  resume?: boolean | string;
  completionPolicy?: boolean | string;
  maxAdjacentContinuations?: boolean | string;
  allowControllerProbes?: boolean | string;
  workerReflection?: boolean | string;
}

export interface AutoStartConfigBuildSuccess {
  config: AutoStartConfig;
  warnings: string[];
}

export type AutoStartConfigBuildResult = AutoStartConfigBuildSuccess | { error: string } | undefined;

export interface VerifyPreflightInput {
  verifyCommandConfigured: boolean;
  stopReason: string;
  currentIteration: number;
  maxIterations: number;
}

export interface StartPromptInput {
  goal: string;
}

export interface ResumePromptInput {
  goal: string;
  controllerSummary: string;
}

export interface SessionStartDecisionInput {
  reason: AutoSessionStartReason;
  hasPersistedSnapshot: boolean;
  autoStartConfigState: "valid" | "invalid" | "none";
  autoStartError?: string;
  autoResumeFlag: boolean;
  persistedResumePolicy?: ResumePolicy;
}

export interface SessionStartDecision {
  action: "start-from-flags" | "restore" | "noop";
  autoResume: boolean;
  warning?: string;
}

export interface AutoModeCustomEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

export interface AutoStopGuardGitState {
  dirty: boolean;
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
}

export interface AutoStopGuardInput {
  goalStatus: GoalStatus;
  requiresCompletionGate: boolean;
  completionGateMet: boolean;
  verifyCommandConfigured: boolean;
  verifyCommandPassed: boolean;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
  git?: AutoStopGuardGitState;
}

export type AutoStopBlocker =
  | "goal-not-met"
  | "completion-gate-not-met"
  | "verification-failed"
  | "commit-required"
  | "push-required"
  | "sync-required";

export interface AutoStopGuardResult {
  allowed: boolean;
  blockers: AutoStopBlocker[];
}

export interface BlockedStopFollowUpInput {
  blockers: AutoStopBlocker[];
  goal: string;
  untilPrompt?: string;
  verifyCommand?: string;
}

export interface AutoFollowUpPlanInput {
  nextPrompt: string;
  currentIteration: number;
  maxIterations: number;
  lastAutoPrompt?: string;
  consecutiveStagnationCount: number;
  consecutiveNoChangeCount: number;
  budgetPauseReason: string;
  stagnationPauseReason?: string;
  noChangePauseReason?: string;
  stagnationLimit?: number;
  noChangeLimit?: number;
}

export type AutoFollowUpPlan =
  | {
      action: "send";
      nextPrompt: string;
      nextIteration: number;
      nextStagnationCount: number;
    }
  | {
      action: "pause";
      reason: string;
      nextStagnationCount: number;
    };

interface BaseControllerDecision {
  action: ControllerAction;
  reason: string;
  updatedSummary: string;
  goalStatus: GoalStatus;
  completionGateMet: boolean;
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

export type ControllerAction = "continue" | "stop" | "pause";
export type ControllerDecision = ContinueDecision | StopDecision | PauseDecision;

interface ParsedControllerPayload {
  action?: unknown;
  reason?: unknown;
  updatedSummary?: unknown;
  summary?: unknown;
  goalStatus?: unknown;
  completionGateMet?: unknown;
  qualityGoalMet?: unknown;
  nextPrompt?: unknown;
  prompt?: unknown;
  finalMessage?: unknown;
}

const TEMPLATE_VARIABLE_PATTERN = /(?<!\\)\{\{\s*([A-Z0-9_]+)\s*(?:\|\s*([\s\S]*?))?\s*\}\}/g;
const ESCAPED_TEMPLATE_VARIABLE_PATTERN = /\\(\{\{\s*[A-Z0-9_]+\s*(?:\|\s*[\s\S]*?)?\s*\}\})/g;
const SECTIONED_PROMPT_TEMPLATE_PATTERN = /<!--\s*prompt:([a-z0-9-]+)\s*-->\n?([\s\S]*?)\n?<!--\s*\/prompt:\1\s*-->/g;
const AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTION_NAMES = ["worker", "controller"] as const;

type AutoModeSystemPromptTemplateSectionName = typeof AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTION_NAMES[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function parseSectionedPromptTemplate(template: string): Record<string, string> {
  const normalizedTemplate = normalizeTemplateText(template);
  const sections: Record<string, string> = {};

  for (const match of normalizedTemplate.matchAll(SECTIONED_PROMPT_TEMPLATE_PATTERN)) {
    const sectionName = match[1];
    const sectionBody = match[2];
    if (!sectionName || !sectionBody) continue;
    if (sections[sectionName]) {
      throw new Error(`Duplicate prompt template section: ${sectionName}`);
    }
    sections[sectionName] = normalizeTemplateText(sectionBody);
  }

  return sections;
}

function loadAutoModeSystemPromptTemplateSections(template: string): Record<AutoModeSystemPromptTemplateSectionName, string> {
  const parsedSections = parseSectionedPromptTemplate(template);
  const missingSections = AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTION_NAMES.filter((sectionName) => !parsedSections[sectionName]);
  if (missingSections.length > 0) {
    throw new Error(`Missing auto-mode prompt template section(s): ${missingSections.join(", ")}`);
  }

  return Object.fromEntries(
    AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTION_NAMES.map((sectionName) => [sectionName, parsedSections[sectionName]!]),
  ) as Record<AutoModeSystemPromptTemplateSectionName, string>;
}

export const AUTO_MODE_SYSTEM_PROMPT_TEMPLATE = normalizeTemplateText(
  readFileSync(
    new URL("./system-prompt.template.md", import.meta.url),
    "utf8",
  ),
);

export const AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS = loadAutoModeSystemPromptTemplateSections(AUTO_MODE_SYSTEM_PROMPT_TEMPLATE);

export function buildAutoWorkerSystemPromptTemplateVariables(input: AutoWorkerPromptInput): Record<string, string> {
  return {
    VERIFY_RULE: input.verifyCommand
      ? `run this verification command before you stop: ${input.verifyCommand}`
      : "run the most relevant local verification before you stop and mention the concrete result",
    COMMIT_POLICY: input.commitPolicy,
    PUSH_POLICY: input.pushPolicy,
    GOAL: input.goal,
  };
}

function renderAutoModeSystemPromptTemplateSection(
  sectionName: AutoModeSystemPromptTemplateSectionName,
  variables: Record<string, string> = {},
): string {
  return renderMiniTemplate(AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTIONS[sectionName], variables);
}

function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
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

function isAssuranceMode(value: string): value is AssuranceMode {
  return value === "pragmatic" || value === "strict";
}

function isResumePolicy(value: unknown): value is ResumePolicy {
  return value === "restore-paused" || value === "restore-running";
}

function isAutoModeStateV2(value: unknown): value is AutoModeStateV2 {
  if (!isRecord(value)) return false;
  return (
    value.version === 2
    && typeof value.goal === "string"
    && typeof value.enabled === "boolean"
    && typeof value.paused === "boolean"
    && typeof value.currentIteration === "number"
    && typeof value.maxIterations === "number"
  );
}

function isAutoModeStateV1Like(value: unknown): value is AutoModeStateV1Like {
  if (!isRecord(value)) return false;
  return (
    value.version === 1
    && typeof value.goal === "string"
    && typeof value.enabled === "boolean"
    && typeof value.paused === "boolean"
    && typeof value.currentIteration === "number"
    && typeof value.maxIterations === "number"
  );
}

function hydrateAutoModeStateV2(snapshot: AutoModeStateV2): AutoModeStateV2 {
  return {
    ...snapshot,
    assuranceMode: snapshot.assuranceMode === "strict" ? "strict" : "pragmatic",
    recentDecisions: Array.isArray(snapshot.recentDecisions) ? snapshot.recentDecisions.filter(isRecentDecisionLogEntry) : [],
    migrationWarnings: Array.isArray(snapshot.migrationWarnings)
      ? snapshot.migrationWarnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
      : undefined,
  };
}

function isRecentDecisionLogEntry(value: unknown): value is AutoDecisionLogEntry {
  return isRecord(value)
    && typeof value.iteration === "number"
    && typeof value.action === "string"
    && typeof value.reason === "string"
    && (value.nextPrompt === undefined || typeof value.nextPrompt === "string")
    && typeof value.timestamp === "number";
}

function migrateLegacyState(snapshot: AutoModeStateV1Like): AutoModeStateV2 {
  const warnings = ["Restored a legacy auto-mode V1 state under V2 semantics."];

  if (snapshot.completionPolicy === "continue-similar" || snapshot.phase === "adjacent") {
    warnings.push("Legacy adjacent-continuation behavior is deprecated and this run was restored in paused mode.");
  }
  if (snapshot.workerReflectionEnabled === true || snapshot.workerReflectionUsed === true) {
    warnings.push("Legacy worker-reflection behavior is deprecated and this run was restored in paused mode.");
  }
  if (snapshot.allowControllerProbes === true || snapshot.allowControllerProbes === false) {
    warnings.push("Legacy controller probe behavior is no longer used in auto-mode V2.");
  }

  return {
    version: 2,
    enabled: snapshot.enabled === true,
    paused: snapshot.paused === true,
    runId: typeof snapshot.runId === "string" ? snapshot.runId : `auto-migrated-${Date.now()}`,
    goal: typeof snapshot.goal === "string" ? snapshot.goal : "",
    untilPrompt: typeof snapshot.untilPrompt === "string" ? snapshot.untilPrompt : undefined,
    mode: snapshot.mode === "hybrid" || snapshot.mode === "until" ? snapshot.mode : "iterations",
    maxIterations: typeof snapshot.maxIterations === "number" ? snapshot.maxIterations : DEFAULT_AUTO_ITERATIONS,
    currentIteration: typeof snapshot.currentIteration === "number" ? snapshot.currentIteration : 1,
    startedAt: typeof snapshot.startedAt === "number" ? snapshot.startedAt : Date.now(),
    lastControllerAt: typeof snapshot.lastControllerAt === "number" ? snapshot.lastControllerAt : undefined,
    lastWorkerFinishedAt: typeof snapshot.lastWorkerFinishedAt === "number" ? snapshot.lastWorkerFinishedAt : undefined,
    controllerModel: isModelRef(snapshot.controllerModel) ? snapshot.controllerModel : undefined,
    verifyCommand: typeof snapshot.verifyCommand === "string" ? snapshot.verifyCommand : undefined,
    commitPolicy: typeof snapshot.commitPolicy === "string" && isCommitPolicy(snapshot.commitPolicy) ? snapshot.commitPolicy : "final-or-milestone",
    pushPolicy: typeof snapshot.pushPolicy === "string" && isPushPolicy(snapshot.pushPolicy) ? snapshot.pushPolicy : "final-or-milestone-if-upstream",
    assuranceMode: "pragmatic",
    controllerSummary: typeof snapshot.controllerSummary === "string" ? snapshot.controllerSummary : "",
    recentDecisions: Array.isArray(snapshot.recentDecisions) ? snapshot.recentDecisions.filter(isRecentDecisionLogEntry) : [],
    lastAutoPrompt: typeof snapshot.lastAutoPrompt === "string" ? snapshot.lastAutoPrompt : undefined,
    lastStopReason: typeof snapshot.lastStopReason === "string" ? snapshot.lastStopReason : undefined,
    consecutiveControllerFailures:
      typeof snapshot.consecutiveControllerFailures === "number" ? snapshot.consecutiveControllerFailures : 0,
    consecutiveWorkerFailures:
      typeof snapshot.consecutiveWorkerFailures === "number" ? snapshot.consecutiveWorkerFailures : 0,
    consecutiveStagnationCount:
      typeof snapshot.consecutiveStagnationCount === "number" ? snapshot.consecutiveStagnationCount : 0,
    consecutiveNoChangeCount:
      typeof snapshot.consecutiveNoChangeCount === "number" ? snapshot.consecutiveNoChangeCount : 0,
    lastSeenHead: typeof snapshot.lastSeenHead === "string" ? snapshot.lastSeenHead : undefined,
    lastSeenChangedFiles: Array.isArray(snapshot.lastSeenChangedFiles)
      ? snapshot.lastSeenChangedFiles.filter((value): value is string => typeof value === "string")
      : undefined,
    lastSeenRepoFingerprint: typeof snapshot.lastSeenRepoFingerprint === "string" ? snapshot.lastSeenRepoFingerprint : undefined,
    resumePolicy: isResumePolicy(snapshot.resumePolicy) ? snapshot.resumePolicy : "restore-paused",
    migrationWarnings: warnings,
  };
}

export function extractLatestAutoModeState(entries: unknown[]): AutoModeStateV2 | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as AutoModeCustomEntryLike | undefined;
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType !== AUTO_MODE_STATE_TYPE) continue;
    if (isAutoModeStateV2(entry.data)) {
      return hydrateAutoModeStateV2(entry.data);
    }
    if (isAutoModeStateV1Like(entry.data)) {
      return migrateLegacyState(entry.data);
    }
  }
  return undefined;
}

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return "…";
  return `${text.slice(0, maxLength - 1)}…`;
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 5) return truncateWithEllipsis(text, maxLength);

  const separator = "\n…\n";
  const remaining = maxLength - separator.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${separator}${text.slice(-tail)}`;
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

function resolveAutoMode(iterations: number | undefined, untilPrompt: string | undefined): { mode: AutoMode; maxIterations: number } {
  if (untilPrompt && iterations) {
    return { mode: "hybrid", maxIterations: iterations };
  }
  if (untilPrompt) {
    return { mode: "until", maxIterations: DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS };
  }
  return { mode: "iterations", maxIterations: iterations ?? DEFAULT_AUTO_ITERATIONS };
}

function pushDeprecatedWarning(warnings: string[], flag: string): void {
  warnings.push(`${flag} is deprecated in auto-mode V2 and is ignored.`);
}

function parseAssuranceMode(value: string | undefined): AssuranceMode | undefined {
  if (!value) return undefined;
  return isAssuranceMode(value) ? value : undefined;
}

function parseOnConfigFromTokens(tokens: string[]): AutoCommandParseResult {
  let iterations: number | undefined;
  let untilPrompt: string | undefined;
  let controllerModel: ModelRef | undefined;
  let verifyCommand: string | undefined;
  let commitPolicy: CommitPolicy = "final-or-milestone";
  let pushPolicy: PushPolicy = "final-or-milestone-if-upstream";
  let assuranceMode: AssuranceMode = "pragmatic";
  const warnings: string[] = [];
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

    if (token === "--assurance") {
      const value = tokens[index + 1];
      const parsed = value ? parseAssuranceMode(value) : undefined;
      if (!parsed) {
        return { error: "--assurance must be one of: pragmatic, strict" };
      }
      assuranceMode = parsed;
      index += 1;
      continue;
    }

    if (token === "--completion-policy") {
      pushDeprecatedWarning(warnings, "--completion-policy");
      if (tokens[index + 1] && !tokens[index + 1]!.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    if (token === "--max-adjacent-continuations") {
      pushDeprecatedWarning(warnings, "--max-adjacent-continuations");
      if (tokens[index + 1] && !tokens[index + 1]!.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    if (token === "--no-controller-probes") {
      pushDeprecatedWarning(warnings, "--no-controller-probes");
      continue;
    }

    if (token === "--worker-reflection") {
      pushDeprecatedWarning(warnings, "--worker-reflection");
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

  if (assuranceMode === "strict" && !verifyCommand) {
    return { error: "--assurance strict requires --verify <cmd>" };
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
      assuranceMode,
      resumeOnSessionStart: false,
    },
    warnings,
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

export function buildAutoStartConfigFromFlags(flags: AutoFlagValues): AutoStartConfigBuildResult {
  if (typeof flags.goal !== "string") return undefined;
  const goal = flags.goal.trim();
  if (!goal) {
    return { error: "--auto-goal must be a non-empty string" };
  }

  const warnings: string[] = [];
  const iterationsFlag = parseStringFlag(flags.iterations);
  const untilPrompt = parseStringFlag(flags.until);
  const controllerModelFlag = parseStringFlag(flags.controllerModel);
  const verifyCommand = parseStringFlag(flags.verify);
  const commitPolicyFlag = parseStringFlag(flags.commitPolicy);
  const pushPolicyFlag = parseStringFlag(flags.pushPolicy);
  const assuranceFlag = parseStringFlag(flags.assurance);

  if (flags.completionPolicy !== undefined) pushDeprecatedWarning(warnings, "--auto-completion-policy");
  if (flags.maxAdjacentContinuations !== undefined) pushDeprecatedWarning(warnings, "--auto-max-adjacent-continuations");
  if (flags.allowControllerProbes !== undefined) pushDeprecatedWarning(warnings, "--auto-allow-controller-probes");
  if (flags.workerReflection !== undefined) pushDeprecatedWarning(warnings, "--auto-worker-reflection");

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

  let assuranceMode: AssuranceMode = "pragmatic";
  if (assuranceFlag) {
    if (!isAssuranceMode(assuranceFlag)) {
      return { error: "--auto-assurance must be one of: pragmatic, strict" };
    }
    assuranceMode = assuranceFlag;
  }

  if (assuranceMode === "strict" && !verifyCommand) {
    return { error: "--auto-assurance strict requires --auto-verify <cmd>" };
  }

  const { mode, maxIterations } = resolveAutoMode(iterations, untilPrompt);
  return {
    config: {
      goal,
      untilPrompt,
      mode,
      maxIterations,
      controllerModel,
      verifyCommand,
      commitPolicy,
      pushPolicy,
      assuranceMode,
      resumeOnSessionStart: parseBooleanFlag(flags.resume, false),
    },
    warnings,
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
      const completionGateMet =
        typeof parsed.completionGateMet === "boolean"
          ? parsed.completionGateMet
          : typeof parsed.qualityGoalMet === "boolean"
            ? parsed.qualityGoalMet
            : undefined;

      if (!action || !reason || !updatedSummary || !goalStatus || completionGateMet === undefined) {
        continue;
      }

      if (action === "continue") {
        const nextPrompt =
          typeof parsed.nextPrompt === "string"
            ? parsed.nextPrompt.trim()
            : typeof parsed.prompt === "string"
              ? parsed.prompt.trim()
              : "";
        if (!nextPrompt) continue;
        return {
          action: "continue",
          reason,
          updatedSummary,
          goalStatus,
          completionGateMet,
          nextPrompt,
        };
      }

      if (action === "stop") {
        return {
          action: "stop",
          reason,
          updatedSummary,
          goalStatus,
          completionGateMet,
          finalMessage: typeof parsed.finalMessage === "string" ? parsed.finalMessage.trim() || undefined : undefined,
        };
      }

      if (action === "pause") {
        return {
          action: "pause",
          reason,
          updatedSummary,
          goalStatus,
          completionGateMet,
        };
      }
    } catch {
      continue;
    }
  }

  return undefined;
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
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (text.length > remaining) {
        parts.push(text.slice(0, remaining));
        truncated = true;
        break;
      }
      remaining -= text.length + 1;
    }
    parts.push(text);
  }

  const joined = parts.join("\n").trim();
  if (!Number.isFinite(maxChars)) return joined;
  return truncated ? truncateMiddle(joined, maxChars) : joined;
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

    const text = extractMessageText(message.content, maxCharsPerMessage * 4);
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

    const text = extractMessageText(message.content, maxChars * 2);
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

export function summarizeGoal(goal: string, maxLength = DEFAULT_STATUS_GOAL_MAX_CHARS): string {
  return truncateWithEllipsis(collapseWhitespace(goal), maxLength);
}

export function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function areAutoPromptsEquivalent(previousPrompt: string | undefined, nextPrompt: string | undefined): boolean {
  if (!previousPrompt || !nextPrompt) return false;
  return normalizeComparableText(previousPrompt) === normalizeComparableText(nextPrompt);
}

export function shouldPreRunVerifyCommand(input: VerifyPreflightInput): boolean {
  if (!input.verifyCommandConfigured) return false;
  if (input.stopReason === "stop") return true;
  return input.currentIteration >= input.maxIterations;
}

export function shouldAutoResumeOnSessionStart(
  reason: AutoSessionStartReason,
  autoResumeFlag: boolean,
  resumePolicy: ResumePolicy,
): boolean {
  return reason === "startup" && (autoResumeFlag || resumePolicy === "restore-running");
}

export function buildStartPrompt(input: StartPromptInput): string {
  return input.goal.trim();
}

export function buildResumePrompt(input: ResumePromptInput): string {
  const sections = [
    "Resume the active goal from the current repository state.",
    `Goal: ${input.goal}`,
    input.controllerSummary ? `Controller summary:\n${input.controllerSummary}` : undefined,
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

export function buildAutoWorkerSystemPrompt(input: AutoWorkerPromptInput): string {
  return renderAutoModeSystemPromptTemplateSection(
    "worker",
    buildAutoWorkerSystemPromptTemplateVariables(input),
  );
}

export function buildAutoControllerSystemPrompt(): string {
  return renderAutoModeSystemPromptTemplateSection("controller");
}

export function evaluateAutoStopGuard(input: AutoStopGuardInput): AutoStopGuardResult {
  const blockers: AutoStopBlocker[] = [];

  if (input.goalStatus !== "met") {
    blockers.push("goal-not-met");
  }

  if (input.requiresCompletionGate && !input.completionGateMet) {
    blockers.push("completion-gate-not-met");
  }

  if (input.verifyCommandConfigured && !input.verifyCommandPassed) {
    blockers.push("verification-failed");
  }

  if (input.git) {
    if (input.commitPolicy !== "none" && input.git.dirty) {
      blockers.push("commit-required");
    }
    if (input.pushPolicy !== "never" && input.git.hasUpstream && (input.git.ahead ?? 0) > 0) {
      blockers.push("push-required");
    }
    if (input.pushPolicy !== "never" && input.git.hasUpstream && (input.git.behind ?? 0) > 0) {
      blockers.push("sync-required");
    }
  }

  return {
    allowed: blockers.length === 0,
    blockers,
  };
}

export function describeAutoStopBlocker(blocker: AutoStopBlocker, verifyCommand: string | undefined): string {
  switch (blocker) {
    case "goal-not-met":
      return "the active goal is not yet verified as met";
    case "completion-gate-not-met":
      return "the completion gate is not yet verified as met";
    case "verification-failed":
      return verifyCommand
        ? `the verification command is still failing (${verifyCommand})`
        : "verification is still failing";
    case "commit-required":
      return "a final commit is still required";
    case "push-required":
      return "a push to upstream is still required";
    case "sync-required":
      return "the branch is not yet synchronized with upstream";
  }
}

export function buildBlockedStopFollowUp(input: BlockedStopFollowUpInput): string {
  const orderedBlockers: AutoStopBlocker[] = [
    "goal-not-met",
    "completion-gate-not-met",
    "verification-failed",
    "commit-required",
    "sync-required",
    "push-required",
  ];

  const actions: string[] = [];
  for (const blocker of orderedBlockers) {
    if (!input.blockers.includes(blocker)) continue;

    if (blocker === "goal-not-met") {
      actions.push("Inspect the current state, close the highest-value remaining gap toward the goal, and then reassess.");
      continue;
    }

    if (blocker === "completion-gate-not-met") {
      actions.push(input.untilPrompt
        ? `Satisfy this completion gate before stopping: ${input.untilPrompt}`
        : "Satisfy the remaining completion gate requirement before stopping.");
      continue;
    }

    if (blocker === "verification-failed") {
      actions.push(input.verifyCommand
        ? `Run ${input.verifyCommand} until it passes, then report the exact passing result.`
        : "Run the relevant verification until it passes, then report the exact passing result.");
      continue;
    }

    if (blocker === "commit-required") {
      actions.push("Create the final atomic commit and confirm the working tree is clean.");
      continue;
    }

    if (blocker === "sync-required") {
      actions.push("Bring the current branch back in sync with upstream before stopping.");
      continue;
    }

    if (blocker === "push-required") {
      actions.push("Push the current branch to upstream and confirm it is in sync.");
    }
  }

  return actions.join(" ");
}

export function planAutoFollowUp(input: AutoFollowUpPlanInput): AutoFollowUpPlan {
  if (input.currentIteration >= input.maxIterations) {
    return {
      action: "pause",
      reason: input.budgetPauseReason,
      nextStagnationCount: input.consecutiveStagnationCount,
    };
  }

  const nextStagnationCount = areAutoPromptsEquivalent(input.lastAutoPrompt, input.nextPrompt)
    ? input.consecutiveStagnationCount + 1
    : 0;

  if (nextStagnationCount >= (input.stagnationLimit ?? DEFAULT_STAGNATION_LIMIT)) {
    return {
      action: "pause",
      reason: input.stagnationPauseReason ?? "controller produced the same next prompt repeatedly",
      nextStagnationCount,
    };
  }

  if (input.consecutiveNoChangeCount >= (input.noChangeLimit ?? DEFAULT_NO_CHANGE_LIMIT)) {
    return {
      action: "pause",
      reason: input.noChangePauseReason ?? "repository state has not changed across several iterations",
      nextStagnationCount,
    };
  }

  return {
    action: "send",
    nextPrompt: input.nextPrompt,
    nextIteration: input.currentIteration + 1,
    nextStagnationCount,
  };
}

export function decideAutoModeSessionStart(input: SessionStartDecisionInput): SessionStartDecision {
  const autoResume = shouldAutoResumeOnSessionStart(
    input.reason,
    input.autoResumeFlag,
    input.persistedResumePolicy ?? "restore-paused",
  );

  if (input.reason === "startup" && input.autoStartConfigState === "valid") {
    return { action: "start-from-flags", autoResume: false };
  }

  if (input.hasPersistedSnapshot) {
    return {
      action: "restore",
      autoResume,
      warning: input.autoStartConfigState === "invalid" ? input.autoStartError : undefined,
    };
  }

  if (input.autoStartConfigState === "invalid") {
    return {
      action: "noop",
      autoResume: false,
      warning: input.autoStartError,
    };
  }

  return { action: "noop", autoResume: false };
}
