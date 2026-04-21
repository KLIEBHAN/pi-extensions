import { readFileSync } from "node:fs";

export const AUTO_MODE_STATE_TYPE = "auto-mode-state";
export const DEFAULT_CONTROLLER_MODEL = "active worker model";
export const DEFAULT_AUTO_ITERATIONS = 8;
export const DEFAULT_AUTO_UNTIL_SAFETY_ITERATIONS = 12;
export const DEFAULT_MAX_ADJACENT_CONTINUATIONS = 1;
export const DEFAULT_MAX_ITERATIONS_LIMIT = 1_000;
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
export type CompletionPolicy = "stop" | "continue-similar";
export type AutoPhase = "primary" | "adjacent";
export type CommitRecommendation = "none" | "milestone" | "finalize";
export type ProbeKind = "git_status" | "git_diff_names" | "git_head" | "verify_command";
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
  maxAdjacentContinuations: number;
  controllerModel?: ModelRef;
  verifyCommand?: string;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
  completionPolicy: CompletionPolicy;
  allowControllerProbes: boolean;
  resumeOnSessionStart: boolean;
}

export interface AutoWorkerPromptInput {
  goal: string;
  verifyCommand?: string;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
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
  workerAssistantText: string;
  commitPolicy: CommitPolicy;
  pushPolicy: PushPolicy;
  git?: AutoStopGuardGitState;
}

export type AutoStopBlocker =
  | "goal-not-met"
  | "completion-gate-not-met"
  | "verification-missing"
  | "verification-failed"
  | "commit-required"
  | "push-required"
  | "sync-required";

export interface AutoStopGuardResult {
  allowed: boolean;
  blockers: AutoStopBlocker[];
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

export interface AutoStopOverrideDecisionInput {
  decision: StopDecision;
  stopGuard: AutoStopGuardResult;
  verifyCommand?: string;
}

export interface AutoStopOverrideRefinementInput {
  fallbackDecision: ContinueDecision;
  controllerDecision?: ControllerDecision;
}

export type AutoStopOverrideFollowUpDecision = ContinueDecision | PauseDecision;

export interface AutoContinueRepetitionRefinementInput {
  repeatedDecision: ContinueDecision;
  controllerDecision?: ControllerDecision;
}

export type AutoContinueRepetitionFollowUpDecision = ContinueDecision | PauseDecision;

export interface AutoContinueProgressInput {
  completionPolicy: CompletionPolicy;
  phase: AutoPhase;
  goalStatus: GoalStatus;
  currentIteration: number;
  updatedSummary: string;
  adjacentContinuationTriggered: boolean;
  primaryGoalVerifiedAtIteration?: number;
  adjacentContinuationCount: number;
  primaryGoalCompletionSummary?: string;
}

export interface AutoContinueProgressState {
  phase: AutoPhase;
  primaryGoalVerifiedAtIteration?: number;
  adjacentContinuationCount: number;
  primaryGoalCompletionSummary?: string;
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
  completionPolicy: CompletionPolicy;
  phase: AutoPhase;
  primaryGoalVerifiedAtIteration?: number;
  adjacentContinuationCount: number;
  maxAdjacentContinuations: number;
  primaryGoalCompletionSummary?: string;
  allowControllerProbes: boolean;
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
  completionPolicy?: boolean | string;
  maxAdjacentContinuations?: boolean | string;
  allowControllerProbes?: boolean | string;
  resume?: boolean | string;
}

export interface VerifyPreflightInput {
  verifyCommandConfigured: boolean;
  stopReason: string;
  assistantText: string;
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

interface BaseControllerDecision {
  action: ControllerAction;
  reason: string;
  updatedSummary: string;
  goalStatus: GoalStatus;
  completionGateMet: boolean;
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
  completionGateMet?: unknown;
  qualityGoalMet?: unknown;
  progressPercent?: unknown;
  commitRecommendation?: unknown;
  nextPrompt?: unknown;
  prompt?: unknown;
  finalMessage?: unknown;
  probe?: unknown;
}

const TEMPLATE_VARIABLE_PATTERN = /(?<!\\)\{\{\s*([A-Z0-9_]+)\s*(?:\|\s*([\s\S]*?))?\s*\}\}/g;
const ESCAPED_TEMPLATE_VARIABLE_PATTERN = /\\(\{\{\s*[A-Z0-9_]+\s*(?:\|\s*[\s\S]*?)?\s*\}\})/g;
const SECTIONED_PROMPT_TEMPLATE_PATTERN = /<!--\s*prompt:([a-z0-9-]+)\s*-->\n?([\s\S]*?)\n?<!--\s*\/prompt:\1\s*-->/g;
const AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTION_NAMES = [
  "worker",
  "controller",
  "controller-adjacent-continuation",
  "controller-stop-override",
  "controller-continue-repetition",
] as const;

export type AutoModeSystemPromptTemplateSectionName = typeof AUTO_MODE_SYSTEM_PROMPT_TEMPLATE_SECTION_NAMES[number];

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
      ? `Before concluding, run this verification command: ${input.verifyCommand}`
      : "Before concluding, run the most relevant available verification.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAutoModeStateV1(value: unknown): value is AutoModeStateV1 {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.goal === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.paused === "boolean" &&
    typeof value.currentIteration === "number" &&
    typeof value.maxIterations === "number"
  );
}

export function hydrateAutoModeState(snapshot: AutoModeStateV1): AutoModeStateV1 {
  return {
    ...snapshot,
    completionPolicy: snapshot.completionPolicy === "continue-similar" ? "continue-similar" : "stop",
    phase: snapshot.phase === "adjacent" ? "adjacent" : "primary",
    adjacentContinuationCount: typeof snapshot.adjacentContinuationCount === "number" ? snapshot.adjacentContinuationCount : 0,
    maxAdjacentContinuations:
      typeof snapshot.maxAdjacentContinuations === "number" ? snapshot.maxAdjacentContinuations : DEFAULT_MAX_ADJACENT_CONTINUATIONS,
    primaryGoalVerifiedAtIteration:
      typeof snapshot.primaryGoalVerifiedAtIteration === "number" ? snapshot.primaryGoalVerifiedAtIteration : undefined,
    primaryGoalCompletionSummary:
      typeof snapshot.primaryGoalCompletionSummary === "string" ? snapshot.primaryGoalCompletionSummary : undefined,
  };
}

export function extractLatestAutoModeState(entries: unknown[]): AutoModeStateV1 | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as AutoModeCustomEntryLike | undefined;
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType !== AUTO_MODE_STATE_TYPE) continue;
    if (!isAutoModeStateV1(entry.data)) continue;
    return hydrateAutoModeState(entry.data);
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
    `Resume the active goal from the current repository state.`,
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

export function buildAutoControllerAdjacentContinuationSystemPrompt(): string {
  return renderAutoModeSystemPromptTemplateSection("controller-adjacent-continuation");
}

export function buildAutoControllerStopOverrideSystemPrompt(): string {
  return renderAutoModeSystemPromptTemplateSection("controller-stop-override");
}

export function buildAutoControllerContinueRepetitionSystemPrompt(): string {
  return renderAutoModeSystemPromptTemplateSection("controller-continue-repetition");
}

export function hasConcreteVerificationEvidence(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized) return false;

  const blockingPatterns = [
    /\b(todo|follow up|follow-up|remaining work|still need|still needs|not verified|unverified|not run|did not run|didn t run)\b/,
    /\b(need to|needs to|manual step|manual follow up|manual follow-up|pending|maybe|should work|should now work|probably)\b/,
    /\b(cannot verify|can t verify|unable to verify|could not verify|waiting for|blocked)\b/,
    /\b(failed|failing|failure|does not pass|do not pass|not passing|broke|broken|errors remain|error remains)\b/,
    /\b(nicht verifiziert|nicht validiert|nicht nachgewiesen|nicht geprüft|nicht gepruft|nicht getestet|nicht ausgeführt|nicht ausgefuhrt|nicht gelaufen|noch nicht)\b/,
    /\b(kann nicht verifizieren|konnte nicht verifizieren|konnte nicht prüfen|konnte nicht prufen|warte auf|blockiert)\b/,
    /\b(fehlgeschlagen|fehlschlug|fehlerhaft|nicht bestanden|nicht erfolgreich|fehler bleiben|fehler verbleiben)\b/,
  ];
  if (blockingPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const verificationPatterns = [
    /\bverified\b/,
    /\bvalidated\b/,
    /\bmanual(ly)? verified\b/,
    /\bverification passed\b/,
    /\b(all tests pass|tests pass|test suite passes)\b/,
    /\b(lint passes|checks pass|all checks pass)\b/,
    /\b(build passes|build succeeded|build succeeds)\b/,
    /\b(smoke test passed|manual test passed)\b/,
    /\b(verifiziert|validiert)\b/,
    /\b(verifikation|verifizierung|prüfung|prüfungen|prufung|prufungen)\b.*\b(nachgewiesen|bestätigt|bestatigt|erfolgreich)\b/,
    /\b(alle tests bestanden|tests bestanden|test suite bestanden)\b/,
    /\b(alle checks bestanden|checks bestanden|alle checks erfolgreich|checks erfolgreich)\b/,
    /\b(build erfolgreich|erfolgreich kompiliert|kompiliert erfolgreich|fehlerfrei durch)\b/,
  ];
  if (verificationPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const hasVerificationContext = /\b(verification|verified|validated|tests?|checks?|build|lint|typecheck|working tree|verifikation|verifizierung|verifiziert|validiert|tests?|checks?|build|lint|typecheck|nachgewiesen|bestatigt|fehlerfrei)\b/.test(normalized);
  const hasPassingIndicator = /\b(exit code 0|exit 0|all checks passed|compiled successfully|tests? \d+ passed|test suites? \d+ passed|alle checks bestanden|tests? \d+ bestanden|fehlerfrei)\b/.test(normalized);
  const hasRepoCleanIndicator = /\b(working tree clean|ahead 0 behind 0|keine codeänderungen|keine codeanderungen|arbeitsbaum sauber|working tree sauber)\b/.test(normalized);

  return (hasVerificationContext && hasPassingIndicator) || (hasRepoCleanIndicator && (hasVerificationContext || hasPassingIndicator));
}

export function evaluateAutoStopGuard(input: AutoStopGuardInput): AutoStopGuardResult {
  const blockers: AutoStopBlocker[] = [];

  if (input.goalStatus !== "met") {
    blockers.push("goal-not-met");
  }

  if (input.requiresCompletionGate && !input.completionGateMet) {
    blockers.push("completion-gate-not-met");
  }

  if (input.verifyCommandConfigured) {
    if (!input.verifyCommandPassed) {
      blockers.push("verification-failed");
    }
  } else if (!hasConcreteVerificationEvidence(input.workerAssistantText)) {
    blockers.push("verification-missing");
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
    case "verification-missing":
      return "verification evidence is still missing";
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

function buildStopOverridePrompt(blockers: AutoStopBlocker[], verifyCommand: string | undefined): string {
  if (blockers.includes("goal-not-met")) {
    return "Do not conclude yet. The active goal is not yet verified as fully met. Inspect the current repository state, identify the highest-value remaining gap, close it, and verify the result before considering completion.";
  }

  if (blockers.includes("completion-gate-not-met")) {
    return "Do not conclude yet. The completion gate is not yet verified as met. Focus on the remaining gate gap, run the most relevant verification for it, and only then consider the task complete.";
  }

  if (blockers.includes("verification-failed")) {
    return verifyCommand
      ? `Do not conclude yet. The configured verification command failed (${verifyCommand}). Fix the remaining issues, rerun the verification command until it passes, and only then consider the task complete.`
      : "Do not conclude yet. Verification is still failing. Fix the remaining issues, rerun the relevant verification until it passes, and only then consider the task complete.";
  }

  const actions: string[] = [];
  if (blockers.includes("verification-missing")) {
    actions.push("Run the most relevant available verification from the current repository state, summarize the concrete passing evidence, and only then consider the task complete.");
  }
  if (blockers.includes("commit-required")) {
    actions.push("Create an atomic commit for the completed work.");
  }
  if (blockers.includes("push-required")) {
    actions.push("Push the current branch so it is in sync with upstream.");
  }
  if (blockers.includes("sync-required")) {
    actions.push("Bring the branch back in sync with upstream before stopping.");
  }

  return actions.join(" ");
}

export function buildAutoStopOverrideDecision(input: AutoStopOverrideDecisionInput): ContinueDecision | undefined {
  if (input.stopGuard.allowed) {
    return undefined;
  }

  const blockerSummary = input.stopGuard.blockers.map((blocker) => describeAutoStopBlocker(blocker, input.verifyCommand)).join("; ");
  const hasGoalGap = input.stopGuard.blockers.includes("goal-not-met") || input.stopGuard.blockers.includes("completion-gate-not-met");
  const hasFinalizationOnlyBlockers = input.stopGuard.blockers.every(
    (blocker) => blocker === "verification-missing" || blocker === "commit-required" || blocker === "push-required" || blocker === "sync-required",
  );

  return {
    action: "continue",
    reason: `Stop overridden: ${blockerSummary}.`,
    updatedSummary: truncateControllerSummary(
      `Stop overridden. Remaining blockers: ${blockerSummary}. Previous stop reason: ${input.decision.reason}. ${input.decision.updatedSummary}`,
    ),
    goalStatus: hasGoalGap ? "in_progress" : hasFinalizationOnlyBlockers ? "likely_met" : input.decision.goalStatus,
    completionGateMet: input.stopGuard.blockers.includes("completion-gate-not-met") ? false : input.decision.completionGateMet,
    progressPercent: Math.min(input.decision.progressPercent, hasGoalGap ? 95 : 99),
    commitRecommendation: input.stopGuard.blockers.includes("commit-required") || input.stopGuard.blockers.includes("push-required") || input.stopGuard.blockers.includes("sync-required")
      ? "finalize"
      : input.decision.commitRecommendation,
    nextPrompt: buildStopOverridePrompt(input.stopGuard.blockers, input.verifyCommand),
  };
}

export function applyControllerStopOverrideRefinement(input: AutoStopOverrideRefinementInput): AutoStopOverrideFollowUpDecision {
  const decision = input.controllerDecision;
  if (!decision) {
    return input.fallbackDecision;
  }

  if (decision.action === "pause") {
    return {
      action: "pause",
      reason: `${input.fallbackDecision.reason} Controller requested pause instead of another repeated follow-up: ${decision.reason}`,
      updatedSummary: truncateControllerSummary(
        `${input.fallbackDecision.updatedSummary}\n\nController refinement requested a pause: ${decision.updatedSummary}`,
      ),
      goalStatus: decision.goalStatus === "blocked" || decision.goalStatus === "stalled" ? decision.goalStatus : input.fallbackDecision.goalStatus,
      completionGateMet: input.fallbackDecision.completionGateMet && decision.completionGateMet,
      progressPercent: Math.min(input.fallbackDecision.progressPercent, decision.progressPercent),
      commitRecommendation: input.fallbackDecision.commitRecommendation,
    };
  }

  if (decision.action !== "continue") {
    return input.fallbackDecision;
  }

  const nextPrompt = decision.nextPrompt.trim();
  if (!nextPrompt) {
    return input.fallbackDecision;
  }

  return {
    ...input.fallbackDecision,
    updatedSummary: truncateControllerSummary(
      `${input.fallbackDecision.updatedSummary}\n\nController refinement: ${decision.updatedSummary}`,
    ),
    nextPrompt,
  };
}

export function applyControllerContinueRepetitionRefinement(
  input: AutoContinueRepetitionRefinementInput,
): AutoContinueRepetitionFollowUpDecision {
  const decision = input.controllerDecision;
  if (!decision) {
    return input.repeatedDecision;
  }

  if (decision.action === "pause") {
    return {
      action: "pause",
      reason: `${input.repeatedDecision.reason} Controller requested pause instead of another repeated continue prompt: ${decision.reason}`,
      updatedSummary: truncateControllerSummary(
        `${input.repeatedDecision.updatedSummary}\n\nController repetition refinement requested a pause: ${decision.updatedSummary}`,
      ),
      goalStatus: decision.goalStatus === "blocked" || decision.goalStatus === "stalled" ? decision.goalStatus : input.repeatedDecision.goalStatus,
      completionGateMet: input.repeatedDecision.completionGateMet && decision.completionGateMet,
      progressPercent: Math.min(input.repeatedDecision.progressPercent, decision.progressPercent),
      commitRecommendation: input.repeatedDecision.commitRecommendation,
    };
  }

  if (decision.action !== "continue") {
    return input.repeatedDecision;
  }

  const nextPrompt = decision.nextPrompt.trim();
  if (!nextPrompt) {
    return input.repeatedDecision;
  }

  return {
    ...input.repeatedDecision,
    updatedSummary: truncateControllerSummary(
      `${input.repeatedDecision.updatedSummary}\n\nController repetition refinement: ${decision.updatedSummary}`,
    ),
    nextPrompt,
  };
}

export function shouldAttemptAutoAdjacentContinuation(input: {
  completionPolicy: CompletionPolicy;
  goalStatus: GoalStatus;
  currentIteration: number;
  maxIterations: number;
  adjacentContinuationCount: number;
  maxAdjacentContinuations: number;
}): boolean {
  return input.completionPolicy === "continue-similar"
    && input.goalStatus === "met"
    && input.currentIteration < input.maxIterations
    && input.adjacentContinuationCount < input.maxAdjacentContinuations;
}

export function deriveAutoContinueProgressState(input: AutoContinueProgressInput): AutoContinueProgressState {
  const preservedState = {
    primaryGoalVerifiedAtIteration: input.primaryGoalVerifiedAtIteration,
    primaryGoalCompletionSummary: input.primaryGoalCompletionSummary,
  };

  if (input.completionPolicy !== "continue-similar") {
    return {
      phase: "primary",
      adjacentContinuationCount: 0,
      ...preservedState,
    };
  }

  if (input.adjacentContinuationTriggered) {
    if (input.goalStatus !== "met") {
      return {
        phase: "primary",
        adjacentContinuationCount: 0,
        ...preservedState,
      };
    }

    return {
      phase: "adjacent",
      primaryGoalVerifiedAtIteration: input.primaryGoalVerifiedAtIteration ?? input.currentIteration,
      adjacentContinuationCount: input.phase === "adjacent" ? input.adjacentContinuationCount + 1 : 1,
      primaryGoalCompletionSummary: input.primaryGoalCompletionSummary ?? truncateControllerSummary(input.updatedSummary),
    };
  }

  if (input.phase === "adjacent" && input.goalStatus !== "met") {
    return {
      phase: "primary",
      adjacentContinuationCount: 0,
      ...preservedState,
    };
  }

  return {
    phase: input.phase,
    adjacentContinuationCount: input.phase === "adjacent" ? input.adjacentContinuationCount : 0,
    ...preservedState,
  };
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

function isCommitPolicy(value: string): value is CommitPolicy {
  return value === "none" || value === "milestones" || value === "final-or-milestone";
}

function isPushPolicy(value: string): value is PushPolicy {
  return value === "never" || value === "if-upstream" || value === "final-or-milestone-if-upstream";
}

function isCompletionPolicy(value: string): value is CompletionPolicy {
  return value === "stop" || value === "continue-similar";
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
  let completionPolicy: CompletionPolicy = "stop";
  let maxAdjacentContinuations = DEFAULT_MAX_ADJACENT_CONTINUATIONS;
  let allowControllerProbes = true;
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

    if (token === "--completion-policy") {
      const value = tokens[index + 1];
      if (!value || !isCompletionPolicy(value)) {
        return { error: "--completion-policy must be one of: stop, continue-similar" };
      }
      completionPolicy = value;
      index += 1;
      continue;
    }

    if (token === "--max-adjacent-continuations") {
      const value = tokens[index + 1];
      const parsed = value ? parsePositiveInteger(value) : undefined;
      if (!parsed) {
        return { error: `--max-adjacent-continuations must be an integer between 1 and ${DEFAULT_MAX_ITERATIONS_LIMIT}` };
      }
      maxAdjacentContinuations = parsed;
      index += 1;
      continue;
    }

    if (token === "--no-controller-probes") {
      allowControllerProbes = false;
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
      completionPolicy,
      maxAdjacentContinuations,
      allowControllerProbes,
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
  const completionPolicyFlag = parseStringFlag(flags.completionPolicy);
  const maxAdjacentContinuationsFlag = parseStringFlag(flags.maxAdjacentContinuations);

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

  let completionPolicy: CompletionPolicy = "stop";
  if (completionPolicyFlag) {
    if (!isCompletionPolicy(completionPolicyFlag)) {
      return { error: "--auto-completion-policy must be one of: stop, continue-similar" };
    }
    completionPolicy = completionPolicyFlag;
  }

  let maxAdjacentContinuations = DEFAULT_MAX_ADJACENT_CONTINUATIONS;
  if (maxAdjacentContinuationsFlag) {
    const parsed = parsePositiveInteger(maxAdjacentContinuationsFlag);
    if (!parsed) {
      return { error: `--auto-max-adjacent-continuations must be an integer between 1 and ${DEFAULT_MAX_ITERATIONS_LIMIT}` };
    }
    maxAdjacentContinuations = parsed;
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
    completionPolicy,
    maxAdjacentContinuations,
    allowControllerProbes: parseBooleanFlag(flags.allowControllerProbes, true),
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
      const completionGateMet =
        typeof parsed.completionGateMet === "boolean"
          ? parsed.completionGateMet
          : typeof parsed.qualityGoalMet === "boolean"
            ? parsed.qualityGoalMet
            : undefined;
      const progressRaw = typeof parsed.progressPercent === "number" ? parsed.progressPercent : undefined;
      const commitRecommendation = typeof parsed.commitRecommendation === "string" && isCommitRecommendation(parsed.commitRecommendation)
        ? parsed.commitRecommendation
        : undefined;

      if (!action || !reason || !updatedSummary || !goalStatus || completionGateMet === undefined || progressRaw === undefined || !commitRecommendation) {
        continue;
      }

      const progressPercent = Math.max(0, Math.min(100, Math.round(progressRaw)));
      const base = {
        action: action as ControllerAction,
        reason,
        updatedSummary,
        goalStatus,
        completionGateMet,
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
