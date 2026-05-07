import { createHash } from "node:crypto";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  appendDecisionHistory,
  AUTO_MODE_STATE_TYPE,
  buildAutoControllerSystemPrompt,
  buildAutoStartConfigFromFlags,
  buildAutoWorkerSystemPrompt,
  buildBlockedStopFollowUp,
  buildLatestAssistantMessageContext,
  buildLatestUserMessageContext,
  buildRecentConversationContext,
  buildResumePrompt,
  buildStartPrompt,
  decideAutoModeSessionStart,
  DEFAULT_AUTO_ITERATIONS,
  DEFAULT_CONTROLLER_FAILURE_LIMIT,
  DEFAULT_CONTROLLER_MODEL,
  DEFAULT_DECISION_HISTORY_LIMIT,
  DEFAULT_STATUS_GOAL_MAX_CHARS,
  DEFAULT_WORKER_FAILURE_LIMIT,
  describeAutoStopBlocker,
  evaluateAutoStopGuard,
  extractLatestAutoModeState,
  extractMessageText,
  parseAutoCommandArgs,
  parseControllerDecision,
  planAutoFollowUp,
  shouldAutoResumeOnSessionStart,
  shouldPreRunVerifyCommand,
  summarizeGoal,
  truncateControllerSummary,
  type AutoModeStateV2,
  type AutoStartConfig,
  type AutoStartConfigBuildSuccess,
  type AutoStopGuardResult,
  type ContinueDecision,
  type ControllerDecision,
} from "./core.ts";

const STATUS_KEY = "auto-mode";
const GIT_DIFF_TIMEOUT_MS = 120_000;
const VERIFY_COMMAND_TIMEOUT_MS = 600_000;
const COMMAND_USAGE =
  "Usage: /auto on [--iterations N] [--until \"completion gate\"] [--controller-model provider/model] [--verify \"cmd\"] [--assurance pragmatic|strict] <goal>";

const AUTO_CONTROLLER_SYSTEM_PROMPT = buildAutoControllerSystemPrompt();

interface GitSnapshot {
  isGitRepo: boolean;
  head?: string;
  status: string;
  changedFiles: string[];
  dirty: boolean;
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
  repoFingerprint: string;
}

interface VerifyCommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WorkerTurnSnapshot {
  assistantText: string;
  stopReason: string;
}

interface AutoRuntimeState {
  snapshot?: AutoModeStateV2;
  controllerBusy: boolean;
}

interface AutoModeDependencies {
  getGitSnapshot?: typeof getGitSnapshot;
  decideControllerAction?: typeof decideControllerAction;
  runVerifyCommand?: typeof runVerifyCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): number {
  return Date.now();
}

function makeRunId(): string {
  return `auto-${now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAutoEnabled(snapshot: AutoModeStateV2 | undefined): snapshot is AutoModeStateV2 {
  return !!snapshot?.enabled;
}

function isAutoRunning(snapshot: AutoModeStateV2 | undefined): snapshot is AutoModeStateV2 {
  return !!snapshot?.enabled && !snapshot.paused;
}

function setStatus(ctx: ExtensionContext | ExtensionCommandContext, snapshot: AutoModeStateV2 | undefined): void {
  if (!snapshot?.enabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const stateLabel = snapshot.paused ? "paused" : `${snapshot.currentIteration}/${snapshot.maxIterations}`;
  ctx.ui.setStatus(
    STATUS_KEY,
    `Auto ${snapshot.assuranceMode} ${stateLabel}: ${summarizeGoal(snapshot.goal, DEFAULT_STATUS_GOAL_MAX_CHARS)}`,
  );
}

function persistSnapshot(pi: ExtensionAPI, snapshot: AutoModeStateV2): void {
  pi.appendEntry(AUTO_MODE_STATE_TYPE, snapshot);
}

function restorePersistedSnapshot(ctx: ExtensionContext): AutoModeStateV2 | undefined {
  return extractLatestAutoModeState(ctx.sessionManager.getBranch());
}

function buildInitialControllerSummary(ctx: ExtensionContext, config: AutoStartConfig): string {
  const branch = ctx.sessionManager.getBranch();
  const latestUser = buildLatestUserMessageContext(branch);
  const latestAssistant = buildLatestAssistantMessageContext(branch);
  const recentConversation = buildRecentConversationContext(branch);
  const sections = [
    `Goal:\n${config.goal}`,
    config.untilPrompt ? `Completion gate:\n${config.untilPrompt}` : undefined,
    latestUser ? `Latest user context:\n${latestUser}` : undefined,
    latestAssistant ? `Latest assistant context:\n${latestAssistant}` : undefined,
    recentConversation ? `Recent conversation:\n${recentConversation}` : undefined,
  ].filter((value): value is string => !!value);

  return truncateControllerSummary(sections.join("\n\n"));
}

function buildInitialState(config: AutoStartConfig, summary: string): AutoModeStateV2 {
  return {
    version: 2,
    enabled: true,
    paused: false,
    runId: makeRunId(),
    goal: config.goal,
    untilPrompt: config.untilPrompt,
    mode: config.mode,
    maxIterations: config.maxIterations,
    currentIteration: 1,
    startedAt: now(),
    controllerModel: config.controllerModel,
    verifyCommand: config.verifyCommand,
    commitPolicy: config.commitPolicy,
    pushPolicy: config.pushPolicy,
    assuranceMode: config.assuranceMode,
    controllerSummary: summary,
    recentDecisions: [],
    consecutiveControllerFailures: 0,
    consecutiveWorkerFailures: 0,
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 0,
    resumePolicy: config.resumeOnSessionStart ? "restore-running" : "restore-paused",
  };
}

function getStartPrompt(snapshot: AutoModeStateV2): string {
  return buildStartPrompt({ goal: snapshot.goal });
}

function getResumePrompt(snapshot: AutoModeStateV2): string {
  return buildResumePrompt({
    goal: snapshot.goal,
    controllerSummary: snapshot.controllerSummary,
  });
}

function buildWorkerPromptSuffix(snapshot: AutoModeStateV2): string {
  return buildAutoWorkerSystemPrompt({
    goal: snapshot.goal,
    verifyCommand: snapshot.verifyCommand,
    commitPolicy: snapshot.commitPolicy,
    pushPolicy: snapshot.pushPolicy,
  });
}

function buildControllerDecisionHistoryText(snapshot: AutoModeStateV2): string {
  if (snapshot.recentDecisions.length === 0) {
    return "(none yet)";
  }

  return snapshot.recentDecisions
    .map((entry) => {
      const prompt = entry.nextPrompt ? `\nNext prompt: ${entry.nextPrompt}` : "";
      return `Iteration ${entry.iteration}: ${entry.action}\nReason: ${entry.reason}${prompt}`;
    })
    .join("\n\n");
}

function buildGitSnapshotText(gitSnapshot: GitSnapshot | undefined): string {
  if (!gitSnapshot) {
    return "Not a git repository or git state unavailable.";
  }

  return [
    `isGitRepo=${gitSnapshot.isGitRepo ? "yes" : "no"}`,
    gitSnapshot.head ? `head=${gitSnapshot.head}` : undefined,
    `dirty=${gitSnapshot.dirty ? "yes" : "no"}`,
    `has-upstream=${gitSnapshot.hasUpstream ? "yes" : "no"}`,
    gitSnapshot.ahead !== undefined ? `ahead=${gitSnapshot.ahead}` : undefined,
    gitSnapshot.behind !== undefined ? `behind=${gitSnapshot.behind}` : undefined,
    `changed-files=${gitSnapshot.changedFiles.length > 0 ? gitSnapshot.changedFiles.join(", ") : "(none)"}`,
    `status:\n${gitSnapshot.status}`,
  ]
    .filter((value): value is string => !!value)
    .join("\n");
}

function buildVerifyResultText(verifyResult: VerifyCommandResult | undefined): string {
  if (!verifyResult) {
    return "(no verification command result available)";
  }

  const stdout = verifyResult.stdout.trim() || "(no stdout)";
  const stderr = verifyResult.stderr.trim() || "(no stderr)";
  return [
    `command=${verifyResult.command}`,
    `ok=${verifyResult.ok ? "yes" : "no"}`,
    `exitCode=${verifyResult.exitCode}`,
    `stdout:\n${stdout}`,
    `stderr:\n${stderr}`,
  ].join("\n\n");
}

function buildControllerUserPrompt(
  snapshot: AutoModeStateV2,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): string {
  const sections = [
    `Goal:\n${snapshot.goal}`,
    snapshot.untilPrompt ? `Completion gate:\n${snapshot.untilPrompt}` : undefined,
    [
      `Assurance mode: ${snapshot.assuranceMode}`,
      `Iteration: ${snapshot.currentIteration}/${snapshot.maxIterations}`,
      `Commit policy: ${snapshot.commitPolicy}`,
      `Push policy: ${snapshot.pushPolicy}`,
      `Verification command configured: ${snapshot.verifyCommand ? snapshot.verifyCommand : "no"}`,
    ].join("\n"),
    `Controller summary:\n${snapshot.controllerSummary || "(empty)"}`,
    snapshot.recentDecisions.length > 0 ? `Recent controller decisions:\n${buildControllerDecisionHistoryText(snapshot)}` : undefined,
    snapshot.lastAutoPrompt ? `Last auto prompt sent to worker:\n${snapshot.lastAutoPrompt}` : undefined,
    `Latest worker result:\nStop reason: ${workerTurn.stopReason}\n\n${workerTurn.assistantText || "(no assistant text)"}`,
    `Git snapshot:\n${buildGitSnapshotText(gitSnapshot)}`,
    verifyResult ? `Verification command result:\n${buildVerifyResultText(verifyResult)}` : undefined,
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

function shouldTreatWorkerFailure(stopReason: string): boolean {
  return stopReason === "error" || stopReason === "aborted" || stopReason === "length";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeBashOutput(stdout: string, stderr: string, maxChars = 2_000): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
  if (!combined) return "(no output)";
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars - 1)}…`;
}

function buildGitRepoFingerprint(statusText: string, diffText: string): string {
  return createHash("sha256").update(statusText).update("\n---\n").update(diffText).digest("hex");
}

async function getGitSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitSnapshot | undefined> {
  const isRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (isRepo.code !== 0 || !isRepo.stdout.includes("true")) {
    return undefined;
  }

  const [head, status, upstream, diffAgainstHead] = await Promise.all([
    pi.exec("git", ["rev-parse", "HEAD"], { cwd }),
    pi.exec("git", ["status", "--short", "--branch"], { cwd }),
    pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd }),
    pi.exec("git", ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"], { cwd, timeout: GIT_DIFF_TIMEOUT_MS }),
  ]);

  let ahead: number | undefined;
  let behind: number | undefined;
  const hasUpstream = upstream.code === 0 && upstream.stdout.trim().length > 0;

  if (hasUpstream) {
    const divergence = await pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd });
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(divergence.stdout.trim());
    if (divergence.code === 0 && match) {
      behind = Number(match[1]);
      ahead = Number(match[2]);
    }
  }

  const statusText = status.stdout.trim() || "working tree clean";
  const changedFiles = statusText
    .split("\n")
    .slice(1)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const repoFingerprint = buildGitRepoFingerprint(statusText, diffAgainstHead.stdout || "");

  return {
    isGitRepo: true,
    head: head.code === 0 ? head.stdout.trim() : undefined,
    status: statusText,
    changedFiles,
    dirty: changedFiles.length > 0,
    hasUpstream,
    ahead,
    behind,
    repoFingerprint,
  };
}

async function runVerifyCommand(pi: ExtensionAPI, cwd: string, command: string): Promise<VerifyCommandResult> {
  const result = await pi.exec("bash", ["-lc", command], { cwd, timeout: VERIFY_COMMAND_TIMEOUT_MS });
  return {
    command,
    ok: result.code === 0,
    exitCode: result.code,
    stdout: summarizeBashOutput(result.stdout, ""),
    stderr: summarizeBashOutput("", result.stderr),
  };
}

function resolveControllerModel(snapshot: AutoModeStateV2, ctx: ExtensionContext): Model<Api> | undefined {
  const registry = ctx.modelRegistry;
  const explicit = snapshot.controllerModel;
  if (explicit) {
    const found = registry.find(explicit.provider, explicit.id);
    if (found && registry.hasConfiguredAuth(found)) {
      return found as Model<Api>;
    }
  }

  if (ctx.model && registry.hasConfiguredAuth(ctx.model)) {
    return ctx.model as Model<Api>;
  }

  return undefined;
}

async function completeControllerDecision(
  ctx: ExtensionContext,
  snapshot: AutoModeStateV2,
  userPrompt: string,
): Promise<ControllerDecision | undefined> {
  const model = resolveControllerModel(snapshot, ctx);
  if (!model) {
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return undefined;
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: userPrompt }],
    timestamp: now(),
  };

  const response = await complete(
    model,
    {
      systemPrompt: AUTO_CONTROLLER_SYSTEM_PROMPT,
      messages: [userMessage],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      reasoningEffort: "minimal",
    },
  );

  if (response.stopReason !== "stop") {
    return undefined;
  }

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return parseControllerDecision(text);
}

async function decideControllerAction(
  ctx: ExtensionContext,
  snapshot: AutoModeStateV2,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): Promise<ControllerDecision | undefined> {
  return completeControllerDecision(
    ctx,
    snapshot,
    buildControllerUserPrompt(snapshot, workerTurn, gitSnapshot, verifyResult),
  );
}

function updateNoChangeCounters(snapshot: AutoModeStateV2, gitSnapshot: GitSnapshot | undefined): void {
  const nextHead = gitSnapshot?.head;
  const nextFiles = gitSnapshot?.changedFiles ?? [];
  const nextFingerprint = gitSnapshot?.repoFingerprint;
  const previousHead = snapshot.lastSeenHead;
  const previousFingerprint = snapshot.lastSeenRepoFingerprint;

  const sameHead = previousHead !== undefined && previousHead === nextHead;
  const sameFingerprint = previousFingerprint !== undefined && previousFingerprint === nextFingerprint;

  if (sameHead && sameFingerprint) {
    snapshot.consecutiveNoChangeCount += 1;
  } else {
    snapshot.consecutiveNoChangeCount = 0;
  }

  snapshot.lastSeenHead = nextHead;
  snapshot.lastSeenChangedFiles = [...nextFiles];
  snapshot.lastSeenRepoFingerprint = nextFingerprint;
}

function recordControllerDecision(snapshot: AutoModeStateV2, decision: ControllerDecision): void {
  snapshot.lastControllerAt = now();
  snapshot.controllerSummary = truncateControllerSummary(decision.updatedSummary);
  snapshot.recentDecisions = appendDecisionHistory(
    snapshot.recentDecisions,
    {
      iteration: snapshot.currentIteration,
      action: decision.action,
      reason: decision.reason,
      nextPrompt: decision.action === "continue" ? decision.nextPrompt : undefined,
      timestamp: now(),
    },
    DEFAULT_DECISION_HISTORY_LIMIT,
  );
}

function getLastAssistantTurn(event: { messages?: unknown[] }): WorkerTurnSnapshot | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const assistantText = extractMessageText(message.content);
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "stop";
    return { assistantText, stopReason };
  }
  return undefined;
}

function pauseSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: AutoRuntimeState,
  reason: string,
  level: "info" | "warning" = "warning",
): void {
  const snapshot = runtime.snapshot;
  if (!snapshot) return;
  snapshot.paused = true;
  snapshot.lastStopReason = reason;
  persistSnapshot(pi, snapshot);
  setStatus(ctx, snapshot);
  ctx.ui.notify(`Auto-mode paused: ${reason}`, level);
}

function disableSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: AutoRuntimeState,
  reason: string,
  level: "info" | "warning" = "info",
): void {
  const snapshot = runtime.snapshot;
  if (!snapshot) return;
  snapshot.enabled = false;
  snapshot.paused = false;
  snapshot.lastStopReason = reason;
  persistSnapshot(pi, snapshot);
  setStatus(ctx, undefined);
  ctx.ui.notify(`Auto-mode stopped: ${reason}`, level);
}

function ensureModelAvailable(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
  if (!ctx.model) {
    return "No model selected";
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
    return `No configured auth for ${ctx.model.provider}/${ctx.model.id}`;
  }
  return undefined;
}

function notifyWarnings(ctx: ExtensionContext | ExtensionCommandContext, warnings: string[] | undefined): void {
  if (!warnings) return;
  for (const warning of warnings) {
    ctx.ui.notify(warning, "warning");
  }
}

async function startAutoMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: AutoRuntimeState,
  config: AutoStartConfig,
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Wait until idle before starting auto-mode.", "warning");
    return;
  }

  if (isAutoEnabled(runtime.snapshot)) {
    ctx.ui.notify("Auto-mode is already active. Use /auto off first.", "warning");
    return;
  }

  const modelError = ensureModelAvailable(ctx);
  if (modelError) {
    ctx.ui.notify(modelError, "error");
    return;
  }

  const summary = buildInitialControllerSummary(ctx as ExtensionContext, config);
  const snapshot = buildInitialState(config, summary);
  runtime.snapshot = snapshot;
  setStatus(ctx, snapshot);
  persistSnapshot(pi, snapshot);

  if (!pi.getSessionName()) {
    pi.setSessionName(`Auto: ${summarizeGoal(snapshot.goal, 56)}`);
  }

  const startPrompt = getStartPrompt(snapshot);
  snapshot.lastAutoPrompt = startPrompt;
  persistSnapshot(pi, snapshot);

  ctx.ui.notify(
    `Auto-mode started (${snapshot.mode}, ${snapshot.assuranceMode}, ${snapshot.currentIteration}/${snapshot.maxIterations})`,
    "info",
  );
  pi.sendUserMessage(startPrompt);
}

function restoreSnapshotOnSessionStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  eventReason: "startup" | "reload" | "new" | "resume" | "fork",
  autoResume: boolean,
): { resumed: boolean } {
  const restored = restorePersistedSnapshot(ctx);
  if (!restored) {
    runtime.snapshot = undefined;
    setStatus(ctx, undefined);
    return { resumed: false };
  }

  runtime.snapshot = restored;
  if (!restored.enabled) {
    setStatus(ctx, undefined);
    return { resumed: false };
  }

  const forcePausedForMigration = Array.isArray(restored.migrationWarnings) && restored.migrationWarnings.length > 0;
  notifyWarnings(ctx, restored.migrationWarnings);

  const shouldResume = forcePausedForMigration
    ? false
    : shouldAutoResumeOnSessionStart(eventReason, autoResume, restored.resumePolicy);
  const previousPaused = restored.paused;
  restored.paused = forcePausedForMigration ? true : !shouldResume;

  if (restored.paused) {
    ctx.ui.notify("Auto-mode state restored in paused mode. Use /auto resume to continue.", "info");
  } else {
    ctx.ui.notify(`Auto-mode restored and resumed (${restored.currentIteration}/${restored.maxIterations})`, "info");
  }

  if (restored.paused !== previousPaused) {
    persistSnapshot(pi, restored);
  }

  setStatus(ctx, restored);
  return { resumed: shouldResume };
}

async function resumeAutoMode(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: AutoRuntimeState): Promise<void> {
  const snapshot = runtime.snapshot;
  if (!snapshot?.enabled) {
    ctx.ui.notify("No active auto-mode run", "info");
    return;
  }

  if (!snapshot.paused) {
    ctx.ui.notify("Auto-mode is already running", "info");
    return;
  }

  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Wait until idle before resuming auto-mode.", "warning");
    return;
  }

  snapshot.paused = false;
  const resumePrompt = getResumePrompt(snapshot);
  snapshot.lastAutoPrompt = resumePrompt;
  persistSnapshot(pi, snapshot);
  setStatus(ctx, snapshot);
  ctx.ui.notify("Auto-mode resumed", "info");
  pi.sendUserMessage(resumePrompt);
}

function showAutoStatus(ctx: ExtensionCommandContext, snapshot: AutoModeStateV2 | undefined): void {
  if (!snapshot?.enabled) {
    ctx.ui.notify("No active auto-mode run", "info");
    return;
  }

  const lines = [
    `mode=${snapshot.mode}`,
    `assurance=${snapshot.assuranceMode}`,
    `paused=${snapshot.paused ? "yes" : "no"}`,
    `iteration=${snapshot.currentIteration}/${snapshot.maxIterations}`,
    `goal=${snapshot.goal}`,
    snapshot.untilPrompt ? `completion-gate=${snapshot.untilPrompt}` : undefined,
    snapshot.controllerModel
      ? `controller-model=${snapshot.controllerModel.provider}/${snapshot.controllerModel.id}`
      : `controller-model=${DEFAULT_CONTROLLER_MODEL} (default)`,
    snapshot.verifyCommand ? `verify=${snapshot.verifyCommand}` : undefined,
    `commit-policy=${snapshot.commitPolicy}`,
    `push-policy=${snapshot.pushPolicy}`,
    `controller-failures=${snapshot.consecutiveControllerFailures}`,
    `worker-failures=${snapshot.consecutiveWorkerFailures}`,
    `stagnation=${snapshot.consecutiveStagnationCount}`,
    `no-change=${snapshot.consecutiveNoChangeCount}`,
    snapshot.lastStopReason ? `last-stop-reason=${snapshot.lastStopReason}` : undefined,
  ]
    .filter((value): value is string => !!value)
    .join(" | ");

  ctx.ui.notify(lines, "info");
}

function showAutoSummary(ctx: ExtensionCommandContext, snapshot: AutoModeStateV2 | undefined): void {
  if (!snapshot?.enabled) {
    ctx.ui.notify("No active auto-mode run", "info");
    return;
  }

  ctx.ui.notify(snapshot.controllerSummary || "(controller summary is empty)", "info");
}

function buildFlagsFromPi(pi: ExtensionAPI) {
  return {
    goal: pi.getFlag("auto-goal"),
    iterations: pi.getFlag("auto-iterations"),
    until: pi.getFlag("auto-until"),
    controllerModel: pi.getFlag("auto-controller-model"),
    verify: pi.getFlag("auto-verify"),
    commitPolicy: pi.getFlag("auto-commit-policy"),
    pushPolicy: pi.getFlag("auto-push-policy"),
    assurance: pi.getFlag("auto-assurance"),
    resume: pi.getFlag("auto-resume"),
    completionPolicy: pi.getFlag("auto-completion-policy"),
    maxAdjacentContinuations: pi.getFlag("auto-max-adjacent-continuations"),
    allowControllerProbes: pi.getFlag("auto-allow-controller-probes"),
    workerReflection: pi.getFlag("auto-worker-reflection"),
  };
}

function buildBlockedStopDecision(
  snapshot: AutoModeStateV2,
  decision: Extract<ControllerDecision, { action: "stop" }>,
  stopGuard: AutoStopGuardResult,
): ContinueDecision {
  const blockerSummary = stopGuard.blockers
    .map((blocker) => describeAutoStopBlocker(blocker, snapshot.verifyCommand))
    .join("; ");
  const goalStillOpen = stopGuard.blockers.includes("goal-not-met") || stopGuard.blockers.includes("completion-gate-not-met");

  return {
    action: "continue",
    reason: `Stop blocked: ${blockerSummary}.`,
    updatedSummary: truncateControllerSummary(
      `Stop blocked. Remaining blockers: ${blockerSummary}. Previous stop reason: ${decision.reason}. ${decision.updatedSummary}`,
    ),
    goalStatus: goalStillOpen ? "in_progress" : decision.goalStatus === "met" ? "likely_met" : decision.goalStatus,
    completionGateMet: stopGuard.blockers.includes("completion-gate-not-met") ? false : decision.completionGateMet,
    nextPrompt: buildBlockedStopFollowUp({
      blockers: stopGuard.blockers,
      goal: snapshot.goal,
      untilPrompt: snapshot.untilPrompt,
      verifyCommand: snapshot.verifyCommand,
    }),
  };
}

function queueContinueLikeFollowUp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
  decision: ContinueDecision,
  options: {
    budgetPauseReason: string;
    notifyMessage: string;
    notifyLevel?: "info" | "warning";
  },
): void {
  const followUpPlan = planAutoFollowUp({
    nextPrompt: decision.nextPrompt,
    currentIteration: snapshot.currentIteration,
    maxIterations: snapshot.maxIterations,
    lastAutoPrompt: snapshot.lastAutoPrompt,
    consecutiveStagnationCount: snapshot.consecutiveStagnationCount,
    consecutiveNoChangeCount: snapshot.consecutiveNoChangeCount,
    budgetPauseReason: options.budgetPauseReason,
  });

  snapshot.consecutiveStagnationCount = followUpPlan.nextStagnationCount;

  if (followUpPlan.action === "pause") {
    pauseSnapshot(pi, ctx, runtime, followUpPlan.reason, options.notifyLevel ?? "warning");
    return;
  }

  snapshot.lastAutoPrompt = followUpPlan.nextPrompt;
  snapshot.currentIteration = followUpPlan.nextIteration;
  persistSnapshot(pi, snapshot);
  setStatus(ctx, snapshot);
  ctx.ui.notify(options.notifyMessage, options.notifyLevel ?? "info");
  pi.sendUserMessage(followUpPlan.nextPrompt);
}

export function createAutoModeExtension(deps: AutoModeDependencies = {}) {
  return function (pi: ExtensionAPI) {
    const runtime: AutoRuntimeState = {
      controllerBusy: false,
    };
    const getGitSnapshotImpl = deps.getGitSnapshot ?? getGitSnapshot;
    const decideControllerActionImpl = deps.decideControllerAction ?? decideControllerAction;
    const runVerifyCommandImpl = deps.runVerifyCommand ?? runVerifyCommand;

    pi.registerFlag("auto-goal", {
      description: "Start auto-mode with the given goal",
      type: "string",
    });
    pi.registerFlag("auto-iterations", {
      description: `Iteration limit for auto-mode (default ${DEFAULT_AUTO_ITERATIONS})`,
      type: "string",
    });
    pi.registerFlag("auto-until", {
      description: "Optional completion gate prompt for controller stop decisions",
      type: "string",
    });
    pi.registerFlag("auto-controller-model", {
      description: `Optional controller model in provider/model form (defaults to the ${DEFAULT_CONTROLLER_MODEL})`,
      type: "string",
    });
    pi.registerFlag("auto-verify", {
      description: "Optional verification command for near-stop checks, e.g. npm test",
      type: "string",
    });
    pi.registerFlag("auto-commit-policy", {
      description: "Commit policy: none | milestones | final-or-milestone",
      type: "string",
      default: "final-or-milestone",
    });
    pi.registerFlag("auto-push-policy", {
      description: "Push policy: never | if-upstream | final-or-milestone-if-upstream",
      type: "string",
      default: "final-or-milestone-if-upstream",
    });
    pi.registerFlag("auto-assurance", {
      description: "Assurance mode: pragmatic | strict",
      type: "string",
      default: "pragmatic",
    });
    pi.registerFlag("auto-resume", {
      description: "Resume a restored auto-mode run automatically on startup",
      type: "boolean",
      default: false,
    });
    pi.registerFlag("auto-completion-policy", {
      description: "Deprecated in auto-mode V2 and ignored",
      type: "string",
    });
    pi.registerFlag("auto-max-adjacent-continuations", {
      description: "Deprecated in auto-mode V2 and ignored",
      type: "string",
    });
    pi.registerFlag("auto-allow-controller-probes", {
      description: "Deprecated in auto-mode V2 and ignored",
      type: "boolean",
    });
    pi.registerFlag("auto-worker-reflection", {
      description: "Deprecated in auto-mode V2 and ignored",
      type: "boolean",
    });

    pi.registerCommand("auto", {
      description: "Autonomous improvement mode with a controller loop",
      handler: async (args, ctx) => {
        const parsed = parseAutoCommandArgs(args);
        if ("error" in parsed) {
          ctx.ui.notify(parsed.error, "warning");
          if (parsed.error.startsWith("Unknown /auto subcommand:")) {
            ctx.ui.notify(COMMAND_USAGE, "warning");
          }
          return;
        }

        switch (parsed.kind) {
          case "on":
            notifyWarnings(ctx, parsed.warnings);
            await startAutoMode(pi, ctx, runtime, parsed.config);
            return;
          case "status":
            showAutoStatus(ctx, runtime.snapshot);
            return;
          case "summary":
            showAutoSummary(ctx, runtime.snapshot);
            return;
          case "pause": {
            if (!isAutoEnabled(runtime.snapshot)) {
              ctx.ui.notify("No active auto-mode run", "info");
              return;
            }
            pauseSnapshot(pi, ctx, runtime, "paused by user", "info");
            if (!ctx.isIdle()) {
              ctx.abort();
            }
            return;
          }
          case "resume":
            await resumeAutoMode(pi, ctx, runtime);
            return;
          case "off": {
            if (!isAutoEnabled(runtime.snapshot)) {
              ctx.ui.notify("No active auto-mode run", "info");
              return;
            }
            disableSnapshot(pi, ctx, runtime, "stopped by user", "info");
            if (!ctx.isIdle()) {
              ctx.abort();
            }
            return;
          }
          case "nudge": {
            if (!isAutoEnabled(runtime.snapshot)) {
              ctx.ui.notify("No active auto-mode run", "info");
              return;
            }
            runtime.snapshot.controllerSummary = truncateControllerSummary(
              `${runtime.snapshot.controllerSummary}\n\nUser nudge: ${parsed.text}`,
            );
            persistSnapshot(pi, runtime.snapshot);
            ctx.ui.notify("Auto-mode nudge recorded", "info");
            if (ctx.isIdle() && !runtime.snapshot.paused) {
              pi.sendUserMessage(`Additional direction while continuing the same goal: ${parsed.text}`);
            } else if (!ctx.isIdle()) {
              pi.sendUserMessage(`Additional direction while continuing the same goal: ${parsed.text}`, {
                deliverAs: "followUp",
              });
            }
            return;
          }
        }
      },
    });

    pi.on("session_start", async (event, ctx) => {
      runtime.controllerBusy = false;

      const flags = buildFlagsFromPi(pi);
      const persistedSnapshot = restorePersistedSnapshot(ctx);
      const fromFlags = buildAutoStartConfigFromFlags(flags);
      const sessionStartDecision = decideAutoModeSessionStart({
        reason: event.reason,
        hasPersistedSnapshot: !!persistedSnapshot,
        autoStartConfigState: !fromFlags ? "none" : "error" in fromFlags ? "invalid" : "valid",
        autoStartError: fromFlags && "error" in fromFlags ? fromFlags.error : undefined,
        autoResumeFlag: flags.resume === true,
        persistedResumePolicy: persistedSnapshot?.resumePolicy,
      });

      if (sessionStartDecision.warning) {
        ctx.ui.notify(sessionStartDecision.warning, sessionStartDecision.action === "noop" ? "error" : "warning");
      }

      if (sessionStartDecision.action === "start-from-flags") {
        runtime.snapshot = undefined;
        setStatus(ctx, undefined);
        const success = fromFlags as AutoStartConfigBuildSuccess;
        notifyWarnings(ctx, success.warnings);
        await startAutoMode(pi, ctx, runtime, success.config);
        return;
      }

      if (sessionStartDecision.action === "restore") {
        const restoreResult = restoreSnapshotOnSessionStart(pi, ctx, runtime, event.reason, sessionStartDecision.autoResume);
        if (restoreResult.resumed && runtime.snapshot && ctx.isIdle()) {
          const resumePrompt = getResumePrompt(runtime.snapshot);
          runtime.snapshot.lastAutoPrompt = resumePrompt;
          persistSnapshot(pi, runtime.snapshot);
          pi.sendUserMessage(resumePrompt);
        }
        return;
      }

      runtime.snapshot = undefined;
      setStatus(ctx, undefined);
    });

    pi.on("before_agent_start", async (event) => {
      const snapshot = runtime.snapshot;
      if (!isAutoRunning(snapshot)) return;

      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildWorkerPromptSuffix(snapshot)}`,
      };
    });

    pi.on("agent_end", async (event, ctx) => {
      const snapshot = runtime.snapshot;
      if (!isAutoRunning(snapshot)) return;
      if (runtime.controllerBusy) return;

      const workerTurn = getLastAssistantTurn(event);
      if (!workerTurn) return;

      runtime.controllerBusy = true;

      try {
        snapshot.lastWorkerFinishedAt = now();

        if (shouldTreatWorkerFailure(workerTurn.stopReason)) {
          snapshot.consecutiveWorkerFailures += 1;
          persistSnapshot(pi, snapshot);
          if (snapshot.consecutiveWorkerFailures >= DEFAULT_WORKER_FAILURE_LIMIT) {
            pauseSnapshot(pi, ctx, runtime, `worker failed ${snapshot.consecutiveWorkerFailures} times in a row`);
            return;
          }
        } else {
          snapshot.consecutiveWorkerFailures = 0;
        }

        let gitSnapshot: GitSnapshot | undefined;
        try {
          gitSnapshot = await getGitSnapshotImpl(pi, ctx.cwd);
        } catch (error) {
          pauseSnapshot(pi, ctx, runtime, `git state unavailable: ${getErrorMessage(error)}`);
          return;
        }
        updateNoChangeCounters(snapshot, gitSnapshot);
        persistSnapshot(pi, snapshot);

        let verifyResult: VerifyCommandResult | undefined;
        if (shouldPreRunVerifyCommand({
          verifyCommandConfigured: !!snapshot.verifyCommand,
          stopReason: workerTurn.stopReason,
          currentIteration: snapshot.currentIteration,
          maxIterations: snapshot.maxIterations,
        }) && snapshot.verifyCommand) {
          try {
            verifyResult = await runVerifyCommandImpl(pi, ctx.cwd, snapshot.verifyCommand);
          } catch (error) {
            verifyResult = {
              command: snapshot.verifyCommand,
              ok: false,
              exitCode: -1,
              stdout: "",
              stderr: getErrorMessage(error),
            };
          }
        }

        let decision: ControllerDecision | undefined;
        try {
          decision = await decideControllerActionImpl(ctx, snapshot, workerTurn, gitSnapshot, verifyResult);
        } catch {
          decision = undefined;
        }

        if (!decision) {
          snapshot.consecutiveControllerFailures += 1;
          persistSnapshot(pi, snapshot);
          if (snapshot.consecutiveControllerFailures >= DEFAULT_CONTROLLER_FAILURE_LIMIT) {
            pauseSnapshot(pi, ctx, runtime, `controller failed ${snapshot.consecutiveControllerFailures} times in a row`);
          } else {
            ctx.ui.notify("Auto-mode controller was inconclusive; waiting for the next worker turn.", "warning");
          }
          return;
        }

        snapshot.consecutiveControllerFailures = 0;

        if (decision.action === "continue") {
          recordControllerDecision(snapshot, decision);
          queueContinueLikeFollowUp(pi, ctx, runtime, snapshot, decision, {
            budgetPauseReason: "iteration budget exhausted",
            notifyMessage: `Auto-mode continuing (${Math.min(snapshot.currentIteration + 1, snapshot.maxIterations)}/${snapshot.maxIterations})`,
            notifyLevel: "info",
          });
          return;
        }

        if (decision.action === "pause") {
          recordControllerDecision(snapshot, decision);
          pauseSnapshot(pi, ctx, runtime, decision.reason);
          return;
        }

        const stopGuard = evaluateAutoStopGuard({
          goalStatus: decision.goalStatus,
          requiresCompletionGate: !!snapshot.untilPrompt,
          completionGateMet: decision.completionGateMet,
          verifyCommandConfigured: !!snapshot.verifyCommand,
          verifyCommandPassed: snapshot.verifyCommand ? !!verifyResult?.ok : false,
          commitPolicy: snapshot.commitPolicy,
          pushPolicy: snapshot.pushPolicy,
          git: gitSnapshot
            ? {
                dirty: gitSnapshot.dirty,
                hasUpstream: gitSnapshot.hasUpstream,
                ahead: gitSnapshot.ahead,
                behind: gitSnapshot.behind,
              }
            : undefined,
        });

        if (!stopGuard.allowed) {
          const blockedDecision = buildBlockedStopDecision(snapshot, decision, stopGuard);
          recordControllerDecision(snapshot, blockedDecision);
          queueContinueLikeFollowUp(pi, ctx, runtime, snapshot, blockedDecision, {
            budgetPauseReason: `iteration budget exhausted before completion: ${decision.reason}`,
            notifyMessage: `Auto-mode finalization pass requested: ${blockedDecision.reason}`,
            notifyLevel: "warning",
          });
          return;
        }

        recordControllerDecision(snapshot, decision);
        persistSnapshot(pi, snapshot);
        disableSnapshot(pi, ctx, runtime, decision.finalMessage || decision.reason, decision.completionGateMet ? "info" : "warning");
      } finally {
        runtime.controllerBusy = false;
      }
    });
  };
}

export default createAutoModeExtension();
