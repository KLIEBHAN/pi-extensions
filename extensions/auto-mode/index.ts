import { createHash } from "node:crypto";
import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  appendDecisionHistory,
  applyControllerStopOverrideRefinement,
  AUTO_MODE_STATE_TYPE,
  buildAutoControllerAdjacentContinuationSystemPrompt,
  buildAutoControllerStopOverrideSystemPrompt,
  buildAutoControllerSystemPrompt,
  buildAutoStartConfigFromFlags,
  buildAutoStopOverrideDecision,
  buildAutoWorkerSystemPrompt,
  buildLatestAssistantMessageContext,
  buildLatestUserMessageContext,
  buildRecentConversationContext,
  buildResumePrompt,
  buildStartPrompt,
  decideAutoModeSessionStart,
  deriveAutoContinueProgressState,
  DEFAULT_AUTO_ITERATIONS,
  DEFAULT_CONTROLLER_FAILURE_LIMIT,
  DEFAULT_CONTROLLER_MODEL,
  DEFAULT_DECISION_HISTORY_LIMIT,
  DEFAULT_MAX_WALL_CLOCK_MINUTES,
  DEFAULT_STATUS_GOAL_MAX_CHARS,
  DEFAULT_WORKER_FAILURE_LIMIT,
  describeAutoStopBlocker,
  evaluateAutoStopGuard,
  extractLatestAutoModeState,
  extractMessageText,
  shouldAttemptAutoAdjacentContinuation,
  parseAutoCommandArgs,
  parseControllerDecision,
  planAutoFollowUp,
  shouldAutoResumeOnSessionStart,
  shouldPreRunVerifyCommand,
  summarizeGoal,
  truncateControllerSummary,
  type AutoModeStateV1,
  type AutoStartConfig,
  type AutoStopGuardResult,
  type ContinueDecision,
  type ControllerDecision,
  type ProbeKind,
} from "./core.ts";

const STATUS_KEY = "auto-mode";
const PROBE_LIMIT_PER_CYCLE = 1;
const COMMAND_USAGE =
  "Usage: /auto on [--iterations N] [--until \"completion gate\"] [--controller-model provider/model] [--verify \"cmd\"] [--completion-policy stop|continue-similar] <goal>";

const AUTO_CONTROLLER_SYSTEM_PROMPT = buildAutoControllerSystemPrompt();
const AUTO_CONTROLLER_ADJACENT_CONTINUATION_SYSTEM_PROMPT = buildAutoControllerAdjacentContinuationSystemPrompt();
const AUTO_CONTROLLER_STOP_OVERRIDE_SYSTEM_PROMPT = buildAutoControllerStopOverrideSystemPrompt();

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

interface ProbeResult {
  kind: ProbeKind;
  ok: boolean;
  output: string;
}

interface WorkerTurnSnapshot {
  assistantText: string;
  stopReason: string;
}

interface AutoRuntimeState {
  snapshot?: AutoModeStateV1;
  controllerBusy: boolean;
}

interface AutoModeDependencies {
  getGitSnapshot?: typeof getGitSnapshot;
  decideControllerAction?: typeof decideControllerAction;
  getStopOverrideDecision?: typeof getStopOverrideDecision;
  getAdjacentContinuationDecision?: typeof getAdjacentContinuationDecision;
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

function isAutoEnabled(snapshot: AutoModeStateV1 | undefined): snapshot is AutoModeStateV1 {
  return !!snapshot?.enabled;
}

function isAutoRunning(snapshot: AutoModeStateV1 | undefined): snapshot is AutoModeStateV1 {
  return !!snapshot?.enabled && !snapshot.paused;
}

function setStatus(ctx: ExtensionContext | ExtensionCommandContext, snapshot: AutoModeStateV1 | undefined): void {
  if (!snapshot?.enabled) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const stateLabel = snapshot.paused ? "paused" : `${snapshot.currentIteration}/${snapshot.maxIterations}`;
  ctx.ui.setStatus(STATUS_KEY, `Auto ${stateLabel}: ${summarizeGoal(snapshot.goal, DEFAULT_STATUS_GOAL_MAX_CHARS)}`);
}

function persistSnapshot(pi: ExtensionAPI, snapshot: AutoModeStateV1): void {
  pi.appendEntry(AUTO_MODE_STATE_TYPE, snapshot);
}

function restorePersistedSnapshot(ctx: ExtensionContext): AutoModeStateV1 | undefined {
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

function buildInitialState(config: AutoStartConfig, summary: string): AutoModeStateV1 {
  return {
    version: 1,
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
    completionPolicy: config.completionPolicy,
    phase: "primary",
    adjacentContinuationCount: 0,
    allowControllerProbes: config.allowControllerProbes,
    maxWallClockMinutes: config.maxWallClockMinutes,
    controllerSummary: summary,
    recentDecisions: [],
    consecutiveControllerFailures: 0,
    consecutiveWorkerFailures: 0,
    consecutiveStagnationCount: 0,
    consecutiveNoChangeCount: 0,
    resumePolicy: config.resumeOnSessionStart ? "restore-running" : "restore-paused",
  };
}

function getStartPrompt(snapshot: AutoModeStateV1): string {
  return buildStartPrompt({
    goal: snapshot.goal,
  });
}

function getResumePrompt(snapshot: AutoModeStateV1): string {
  return buildResumePrompt({
    goal: snapshot.goal,
    controllerSummary: snapshot.controllerSummary,
  });
}

function buildWorkerPromptSuffix(snapshot: AutoModeStateV1): string {
  return buildAutoWorkerSystemPrompt({
    goal: snapshot.goal,
    verifyCommand: snapshot.verifyCommand,
    commitPolicy: snapshot.commitPolicy,
    pushPolicy: snapshot.pushPolicy,
  });
}

function buildControllerDecisionHistoryText(snapshot: AutoModeStateV1): string {
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

function buildProbeResultText(probeResult: ProbeResult | undefined): string | undefined {
  if (!probeResult) return undefined;
  return [`kind=${probeResult.kind}`, `ok=${probeResult.ok ? "yes" : "no"}`, `output:\n${probeResult.output}`].join("\n\n");
}

function buildControllerUserPrompt(
  snapshot: AutoModeStateV1,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
  probeResult: ProbeResult | undefined,
): string {
  const remainingIterations = Math.max(0, snapshot.maxIterations - snapshot.currentIteration);
  const sections = [
    `Goal:\n${snapshot.goal}`,
    snapshot.untilPrompt ? `Completion gate:\n${snapshot.untilPrompt}` : undefined,
    [
      `Mode: ${snapshot.mode}`,
      `Completion policy: ${snapshot.completionPolicy}`,
      `Phase: ${snapshot.phase}`,
      `Current iteration: ${snapshot.currentIteration}/${snapshot.maxIterations}`,
      `Remaining iterations after this turn: ${remainingIterations}`,
      `Primary goal verified at iteration: ${snapshot.primaryGoalVerifiedAtIteration ?? "no"}`,
      `Adjacent continuation count: ${snapshot.adjacentContinuationCount}`,
      `Commit policy: ${snapshot.commitPolicy}`,
      `Push policy: ${snapshot.pushPolicy}`,
      `Controller probes allowed: ${snapshot.allowControllerProbes ? "yes" : "no"}`,
      `Verification command configured: ${snapshot.verifyCommand ? snapshot.verifyCommand : "no"}`,
    ].join("\n"),
    `Controller summary:\n${snapshot.controllerSummary || "(empty)"}`,
    snapshot.primaryGoalCompletionSummary ? `Primary goal completion summary:\n${snapshot.primaryGoalCompletionSummary}` : undefined,
    `Recent controller decisions:\n${buildControllerDecisionHistoryText(snapshot)}`,
    snapshot.lastAutoPrompt ? `Last auto prompt sent to worker:\n${snapshot.lastAutoPrompt}` : undefined,
    `Latest worker result:\nStop reason: ${workerTurn.stopReason}\n\n${workerTurn.assistantText || "(no assistant text)"}`,
    `Git snapshot:\n${buildGitSnapshotText(gitSnapshot)}`,
    verifyResult ? `Verification command result:\n${buildVerifyResultText(verifyResult)}` : undefined,
    probeResult ? `Fresh probe result:\n${buildProbeResultText(probeResult)}` : undefined,
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

function shouldTreatWorkerFailure(stopReason: string): boolean {
  return stopReason === "error" || stopReason === "aborted" || stopReason === "length";
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
    pi.exec("git", ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"], { cwd, timeout: 120 }),
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
  const result = await pi.exec("bash", ["-lc", command], { cwd, timeout: 600 });
  return {
    command,
    ok: result.code === 0,
    exitCode: result.code,
    stdout: summarizeBashOutput(result.stdout, ""),
    stderr: summarizeBashOutput("", result.stderr),
  };
}

async function executeProbe(pi: ExtensionAPI, ctx: ExtensionContext, snapshot: AutoModeStateV1, kind: ProbeKind): Promise<ProbeResult> {
  switch (kind) {
    case "git_status": {
      const gitSnapshot = await getGitSnapshot(pi, ctx.cwd);
      return {
        kind,
        ok: !!gitSnapshot,
        output: buildGitSnapshotText(gitSnapshot),
      };
    }
    case "git_diff_names": {
      const gitSnapshot = await getGitSnapshot(pi, ctx.cwd);
      return {
        kind,
        ok: !!gitSnapshot,
        output: gitSnapshot?.changedFiles.join("\n") || "(no changed files or not a git repository)",
      };
    }
    case "git_head": {
      const gitSnapshot = await getGitSnapshot(pi, ctx.cwd);
      return {
        kind,
        ok: !!gitSnapshot?.head,
        output: gitSnapshot?.head || "(no git HEAD available)",
      };
    }
    case "verify_command": {
      if (!snapshot.verifyCommand) {
        return {
          kind,
          ok: false,
          output: "No verify command is configured.",
        };
      }
      const verify = await runVerifyCommand(pi, ctx.cwd, snapshot.verifyCommand);
      return {
        kind,
        ok: verify.ok,
        output: buildVerifyResultText(verify),
      };
    }
  }
}

function resolveControllerModel(snapshot: AutoModeStateV1, ctx: ExtensionContext): Model<Api> | undefined {
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
  snapshot: AutoModeStateV1,
  systemPrompt: string,
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
      systemPrompt,
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

async function callController(
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
  probeResult?: ProbeResult,
): Promise<ControllerDecision | undefined> {
  return completeControllerDecision(
    ctx,
    snapshot,
    AUTO_CONTROLLER_SYSTEM_PROMPT,
    buildControllerUserPrompt(snapshot, workerTurn, gitSnapshot, verifyResult, probeResult),
  );
}

async function decideControllerAction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): Promise<ControllerDecision | undefined> {
  let decision = await callController(ctx, snapshot, workerTurn, gitSnapshot, verifyResult);
  if (!decision) {
    return undefined;
  }

  if (decision.action !== "probe") {
    return decision;
  }

  if (!snapshot.allowControllerProbes) {
    return {
      action: "pause",
      reason: "Controller requested a probe, but probes are disabled.",
      updatedSummary: decision.updatedSummary,
      goalStatus: "blocked",
      completionGateMet: false,
      progressPercent: decision.progressPercent,
      commitRecommendation: decision.commitRecommendation,
    };
  }

  let probeRounds = 0;
  while (decision.action === "probe" && probeRounds < PROBE_LIMIT_PER_CYCLE) {
    const probeResult = await executeProbe(pi, ctx, snapshot, decision.probe.kind);
    probeRounds += 1;
    decision = await callController(ctx, snapshot, workerTurn, gitSnapshot, verifyResult, probeResult);
    if (!decision) {
      return undefined;
    }
  }

  if (decision.action === "probe") {
    return {
      action: "pause",
      reason: "Controller requested repeated probes in one cycle.",
      updatedSummary: decision.updatedSummary,
      goalStatus: "blocked",
      completionGateMet: false,
      progressPercent: decision.progressPercent,
      commitRecommendation: decision.commitRecommendation,
    };
  }

  return decision;
}

function updateNoChangeCounters(snapshot: AutoModeStateV1, gitSnapshot: GitSnapshot | undefined): void {
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

function applyContinueDecisionProgress(snapshot: AutoModeStateV1, decision: ContinueDecision): void {
  const nextProgress = deriveAutoContinueProgressState({
    completionPolicy: snapshot.completionPolicy,
    phase: snapshot.phase,
    goalStatus: decision.goalStatus,
    currentIteration: snapshot.currentIteration,
    updatedSummary: decision.updatedSummary,
    primaryGoalVerifiedAtIteration: snapshot.primaryGoalVerifiedAtIteration,
    adjacentContinuationCount: snapshot.adjacentContinuationCount,
    primaryGoalCompletionSummary: snapshot.primaryGoalCompletionSummary,
  });

  snapshot.phase = nextProgress.phase;
  snapshot.primaryGoalVerifiedAtIteration = nextProgress.primaryGoalVerifiedAtIteration;
  snapshot.adjacentContinuationCount = nextProgress.adjacentContinuationCount;
  snapshot.primaryGoalCompletionSummary = nextProgress.primaryGoalCompletionSummary;
}

function recordControllerDecision(snapshot: AutoModeStateV1, decision: ControllerDecision): void {
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

function augmentContinuePrompt(
  decision: ContinueDecision,
  snapshot: AutoModeStateV1,
  gitSnapshot: GitSnapshot | undefined,
): string {
  const additions: string[] = [];

  if (decision.commitRecommendation === "milestone" && snapshot.commitPolicy !== "none" && gitSnapshot?.dirty) {
    additions.push("If the current changes already form a coherent milestone, make an atomic commit before moving on.");
    if (snapshot.pushPolicy !== "never" && gitSnapshot.hasUpstream) {
      additions.push("If you make a milestone commit and the current branch has an upstream, push it as well.");
    }
  }

  if (additions.length === 0) {
    return decision.nextPrompt;
  }

  return `${decision.nextPrompt}\n\n${additions.join(" ")}`;
}

function buildStopOverrideControllerUserPrompt(
  snapshot: AutoModeStateV1,
  workerTurn: WorkerTurnSnapshot,
  blockedStop: Extract<ControllerDecision, { action: "stop" }>,
  stopGuard: AutoStopGuardResult,
  fallbackDecision: ContinueDecision,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): string {
  const blockerLines = stopGuard.blockers.map((blocker) => `- ${describeAutoStopBlocker(blocker, snapshot.verifyCommand)}`).join("\n");
  const sections = [
    "A runtime guard rejected the proposed stop decision.",
    `Blocked stop reason:\n${blockedStop.reason}`,
    `Blocked stop summary:\n${blockedStop.updatedSummary}`,
    `Runtime stop blockers:\n${blockerLines}`,
    snapshot.lastAutoPrompt ? `Previous auto prompt sent to the worker:\n${snapshot.lastAutoPrompt}` : undefined,
    `Fallback follow-up prompt if you cannot improve it:\n${fallbackDecision.nextPrompt}`,
    `Current controller summary:\n${snapshot.controllerSummary || "(empty)"}`,
    `Latest worker result:\nStop reason: ${workerTurn.stopReason}\n\n${workerTurn.assistantText || "(no assistant text)"}`,
    `Git snapshot:\n${buildGitSnapshotText(gitSnapshot)}`,
    verifyResult ? `Verification command result:\n${buildVerifyResultText(verifyResult)}` : undefined,
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

function buildAdjacentContinuationControllerUserPrompt(
  snapshot: AutoModeStateV1,
  verifiedStop: Extract<ControllerDecision, { action: "stop" }>,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): string {
  const remainingIterations = Math.max(0, snapshot.maxIterations - snapshot.currentIteration);
  const sections = [
    "The primary goal appears verified complete and a normal stop would be allowed.",
    `Completion policy: ${snapshot.completionPolicy}`,
    `Current phase: ${snapshot.phase}`,
    `Current iteration: ${snapshot.currentIteration}/${snapshot.maxIterations}`,
    `Remaining iterations after this turn: ${remainingIterations}`,
    `Adjacent continuation count so far: ${snapshot.adjacentContinuationCount}`,
    `Proposed stop reason:\n${verifiedStop.reason}`,
    `Proposed stop summary:\n${verifiedStop.updatedSummary}`,
    snapshot.primaryGoalCompletionSummary ? `Primary goal completion summary:\n${snapshot.primaryGoalCompletionSummary}` : undefined,
    snapshot.lastAutoPrompt ? `Previous auto prompt sent to the worker:\n${snapshot.lastAutoPrompt}` : undefined,
    `Latest worker result:\nStop reason: ${workerTurn.stopReason}\n\n${workerTurn.assistantText || "(no assistant text)"}`,
    `Git snapshot:\n${buildGitSnapshotText(gitSnapshot)}`,
    verifyResult ? `Verification command result:\n${buildVerifyResultText(verifyResult)}` : undefined,
    "If you continue, choose one bounded adjacent optimization that stays close to the same subsystem, changed files, or problem class.",
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

async function getAdjacentContinuationDecision(
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  decision: Extract<ControllerDecision, { action: "stop" }>,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): Promise<Exclude<ControllerDecision, Extract<ControllerDecision, { action: "probe" }>> | undefined> {
  const controllerDecision = await completeControllerDecision(
    ctx,
    snapshot,
    AUTO_CONTROLLER_ADJACENT_CONTINUATION_SYSTEM_PROMPT,
    buildAdjacentContinuationControllerUserPrompt(snapshot, decision, workerTurn, gitSnapshot, verifyResult),
  );
  if (!controllerDecision || controllerDecision.action === "probe") {
    return undefined;
  }
  return controllerDecision;
}

async function getStopOverrideDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  decision: Extract<ControllerDecision, { action: "stop" }>,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult?: VerifyCommandResult,
): Promise<Exclude<ControllerDecision, Extract<ControllerDecision, { action: "stop" | "probe" }>> | undefined> {
  const resolvedVerifyResult = verifyResult ?? (
    snapshot.verifyCommand
      ? await runVerifyCommand(pi, ctx.cwd, snapshot.verifyCommand)
      : undefined
  );
  const stopGuard = evaluateAutoStopGuard({
    goalStatus: decision.goalStatus,
    requiresCompletionGate: !!snapshot.untilPrompt,
    completionGateMet: decision.completionGateMet,
    verifyCommandConfigured: !!snapshot.verifyCommand,
    verifyCommandPassed: snapshot.verifyCommand ? !!resolvedVerifyResult?.ok : false,
    workerAssistantText: workerTurn.assistantText,
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

  const fallbackDecision = buildAutoStopOverrideDecision({
    decision,
    stopGuard,
    verifyCommand: snapshot.verifyCommand,
  });
  if (!fallbackDecision) {
    return undefined;
  }

  const controllerRefinement = await completeControllerDecision(
    ctx,
    snapshot,
    AUTO_CONTROLLER_STOP_OVERRIDE_SYSTEM_PROMPT,
    buildStopOverrideControllerUserPrompt(snapshot, workerTurn, decision, stopGuard, fallbackDecision, gitSnapshot, resolvedVerifyResult),
  );

  return applyControllerStopOverrideRefinement({
    fallbackDecision,
    controllerDecision: controllerRefinement,
  });
}

function queueContinueLikeFollowUp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV1,
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

function isWallClockBudgetExceeded(snapshot: AutoModeStateV1): boolean {
  const elapsedMs = now() - snapshot.startedAt;
  return elapsedMs >= snapshot.maxWallClockMinutes * 60_000;
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

  const summary = buildInitialControllerSummary(ctx, config as AutoStartConfig);
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

  ctx.ui.notify(`Auto-mode started (${snapshot.mode}, ${snapshot.currentIteration}/${snapshot.maxIterations})`, "info");
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

  const shouldResume = shouldAutoResumeOnSessionStart(eventReason, autoResume, restored.resumePolicy);
  const previousPaused = restored.paused;
  restored.paused = !shouldResume;

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

function showAutoStatus(ctx: ExtensionCommandContext, snapshot: AutoModeStateV1 | undefined): void {
  if (!snapshot?.enabled) {
    ctx.ui.notify("No active auto-mode run", "info");
    return;
  }

  const lines = [
    `mode=${snapshot.mode}`,
    `completion-policy=${snapshot.completionPolicy}`,
    `phase=${snapshot.phase}`,
    `paused=${snapshot.paused ? "yes" : "no"}`,
    `iteration=${snapshot.currentIteration}/${snapshot.maxIterations}`,
    `goal=${snapshot.goal}`,
    snapshot.untilPrompt ? `completion-gate=${snapshot.untilPrompt}` : undefined,
    snapshot.controllerModel ? `controller-model=${snapshot.controllerModel.provider}/${snapshot.controllerModel.id}` : `controller-model=${DEFAULT_CONTROLLER_MODEL} (default)`,
    snapshot.verifyCommand ? `verify=${snapshot.verifyCommand}` : undefined,
    `commit-policy=${snapshot.commitPolicy}`,
    `push-policy=${snapshot.pushPolicy}`,
    `adjacent-count=${snapshot.adjacentContinuationCount}`,
    snapshot.primaryGoalVerifiedAtIteration !== undefined ? `primary-verified-at=${snapshot.primaryGoalVerifiedAtIteration}` : undefined,
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

function showAutoSummary(ctx: ExtensionCommandContext, snapshot: AutoModeStateV1 | undefined): void {
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
    completionPolicy: pi.getFlag("auto-completion-policy"),
    allowControllerProbes: pi.getFlag("auto-allow-controller-probes"),
    resume: pi.getFlag("auto-resume"),
    maxWallClockMinutes: pi.getFlag("auto-max-wall-clock-minutes"),
  };
}

export function createAutoModeExtension(deps: AutoModeDependencies = {}) {
  return function (pi: ExtensionAPI) {
    const runtime: AutoRuntimeState = {
      controllerBusy: false,
    };
    const getGitSnapshotImpl = deps.getGitSnapshot ?? getGitSnapshot;
    const decideControllerActionImpl = deps.decideControllerAction ?? decideControllerAction;
    const getStopOverrideDecisionImpl = deps.getStopOverrideDecision ?? getStopOverrideDecision;
    const getAdjacentContinuationDecisionImpl = deps.getAdjacentContinuationDecision ?? getAdjacentContinuationDecision;

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
    description: "Optional verification command for candidate-stop checks, e.g. npm test",
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
  pi.registerFlag("auto-completion-policy", {
    description: "Completion policy: stop | continue-similar",
    type: "string",
    default: "stop",
  });
  pi.registerFlag("auto-allow-controller-probes", {
    description: "Allow the controller to request a limited read-only repository probe",
    type: "boolean",
    default: true,
  });
  pi.registerFlag("auto-resume", {
    description: "Resume a restored auto-mode run automatically on startup",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("auto-max-wall-clock-minutes", {
    description: `Wall-clock safety limit for one auto-mode run (default ${DEFAULT_MAX_WALL_CLOCK_MINUTES})`,
    type: "string",
    default: String(DEFAULT_MAX_WALL_CLOCK_MINUTES),
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
      await startAutoMode(pi, ctx, runtime, fromFlags as AutoStartConfig);
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

      if (isWallClockBudgetExceeded(snapshot)) {
        pauseSnapshot(pi, ctx, runtime, `wall-clock limit of ${snapshot.maxWallClockMinutes} minutes reached`);
        return;
      }

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

      const gitSnapshot = await getGitSnapshotImpl(pi, ctx.cwd);
      updateNoChangeCounters(snapshot, gitSnapshot);
      persistSnapshot(pi, snapshot);

      const verifyResult = shouldPreRunVerifyCommand({
        verifyCommandConfigured: !!snapshot.verifyCommand,
        stopReason: workerTurn.stopReason,
        assistantText: workerTurn.assistantText,
        currentIteration: snapshot.currentIteration,
        maxIterations: snapshot.maxIterations,
      }) && snapshot.verifyCommand
        ? await runVerifyCommand(pi, ctx.cwd, snapshot.verifyCommand)
        : undefined;

      const decision = await decideControllerActionImpl(pi, ctx, snapshot, workerTurn, gitSnapshot, verifyResult);

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
        const nextPrompt = augmentContinuePrompt(decision, snapshot, gitSnapshot);
        const effectiveDecision: ContinueDecision = {
          ...decision,
          nextPrompt,
        };
        applyContinueDecisionProgress(snapshot, effectiveDecision);
        recordControllerDecision(snapshot, effectiveDecision);
        queueContinueLikeFollowUp(pi, ctx, runtime, snapshot, effectiveDecision, {
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

      if (decision.action === "stop") {
        const overrideDecision = await getStopOverrideDecisionImpl(pi, ctx, snapshot, decision, workerTurn, gitSnapshot, verifyResult);
        if (overrideDecision) {
          if (overrideDecision.action === "pause") {
            recordControllerDecision(snapshot, overrideDecision);
            pauseSnapshot(pi, ctx, runtime, overrideDecision.reason, "warning");
            return;
          }

          const effectiveOverrideDecision: ContinueDecision = {
            ...overrideDecision,
            nextPrompt: augmentContinuePrompt(overrideDecision, snapshot, gitSnapshot),
          };
          applyContinueDecisionProgress(snapshot, effectiveOverrideDecision);
          recordControllerDecision(snapshot, effectiveOverrideDecision);
          queueContinueLikeFollowUp(pi, ctx, runtime, snapshot, effectiveOverrideDecision, {
            budgetPauseReason: `iteration budget exhausted before verified completion: ${decision.reason}`,
            notifyMessage: `Auto-mode finalization pass requested: ${effectiveOverrideDecision.reason}`,
            notifyLevel: "warning",
          });
          return;
        }

        if (shouldAttemptAutoAdjacentContinuation({
          completionPolicy: snapshot.completionPolicy,
          goalStatus: decision.goalStatus,
          currentIteration: snapshot.currentIteration,
          maxIterations: snapshot.maxIterations,
        })) {
          const adjacentDecision = await getAdjacentContinuationDecisionImpl(ctx, snapshot, decision, workerTurn, gitSnapshot, verifyResult);
          if (adjacentDecision?.action === "continue") {
            const effectiveAdjacentDecision: ContinueDecision = {
              ...adjacentDecision,
              nextPrompt: augmentContinuePrompt(adjacentDecision, snapshot, gitSnapshot),
            };
            applyContinueDecisionProgress(snapshot, effectiveAdjacentDecision);
            recordControllerDecision(snapshot, effectiveAdjacentDecision);
            queueContinueLikeFollowUp(pi, ctx, runtime, snapshot, effectiveAdjacentDecision, {
              budgetPauseReason: `iteration budget exhausted after verified completion: ${decision.reason}`,
              notifyMessage: `Auto-mode exploring adjacent optimization (${Math.min(snapshot.currentIteration + 1, snapshot.maxIterations)}/${snapshot.maxIterations})`,
              notifyLevel: "info",
            });
            return;
          }

          if (adjacentDecision?.action === "pause") {
            recordControllerDecision(snapshot, adjacentDecision);
            pauseSnapshot(pi, ctx, runtime, adjacentDecision.reason, "warning");
            return;
          }

          if (adjacentDecision?.action === "stop") {
            recordControllerDecision(snapshot, adjacentDecision);
            persistSnapshot(pi, snapshot);
            disableSnapshot(pi, ctx, runtime, adjacentDecision.finalMessage || adjacentDecision.reason, adjacentDecision.completionGateMet ? "info" : "warning");
            return;
          }
        }

        recordControllerDecision(snapshot, decision);
        persistSnapshot(pi, snapshot);
        disableSnapshot(pi, ctx, runtime, decision.finalMessage || decision.reason, decision.completionGateMet ? "info" : "warning");
      }
    } finally {
      runtime.controllerBusy = false;
    }
  });
  };
}

export default createAutoModeExtension();
