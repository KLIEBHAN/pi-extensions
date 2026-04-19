import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  appendDecisionHistory,
  AUTO_MODE_STATE_TYPE,
  buildAutoStartConfigFromFlags,
  buildAutoWorkerSystemPrompt,
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
  DEFAULT_MAX_WALL_CLOCK_MINUTES,
  DEFAULT_NO_CHANGE_LIMIT,
  DEFAULT_STAGNATION_LIMIT,
  DEFAULT_STATUS_GOAL_MAX_CHARS,
  DEFAULT_WORKER_FAILURE_LIMIT,
  extractLatestAutoModeState,
  extractMessageText,
  normalizeComparableText,
  parseAutoCommandArgs,
  parseControllerDecision,
  parseModelRef,
  shouldAutoResumeOnSessionStart,
  shouldPreRunVerifyCommand,
  summarizeGoal,
  truncateControllerSummary,
  type AutoModeStateV1,
  type AutoStartConfig,
  type ContinueDecision,
  type ControllerDecision,
  type ProbeKind,
} from "./core.ts";

const STATUS_KEY = "auto-mode";
const PROBE_LIMIT_PER_CYCLE = 1;
const COMMAND_USAGE =
  "Usage: /auto on [--iterations N] [--until \"goal\"] [--controller-model provider/model] [--verify \"cmd\"] <goal>";

const AUTO_CONTROLLER_SYSTEM_PROMPT = `You are the controller for an autonomous coding loop.

Your job is to decide the single best next action for the worker assistant.

Output requirements:
- Return ONLY valid JSON.
- Use exactly one of these actions: continue, stop, pause, probe.
- If action=continue, include nextPrompt.
- If action=probe, probe.kind must be one of: git_status, git_diff_names, git_head, verify_command.
- Keep reason and updatedSummary concise but specific.
- updatedSummary should be a rolling controller summary for future iterations.

Decision policy:
- Prefer continue when there is still clear, high-value work toward the active goal.
- Prefer specific next prompts that tell the worker what to inspect, implement, test, or verify next.
- Avoid vague prompts like “continue improving” when a concrete next step is available.
- If the latest worker result already looks close to completion, weigh git state and verification evidence heavily.
- If verification is failing, the task is not complete.
- If final commit/push expectations are still unmet in a git repo, the task is not complete.
- Use stop only when the goal (or quality goal) appears met, or when iteration budget is exhausted and no further continuation is allowed.
- Use pause when the run appears blocked, unstable, or stuck and should not continue automatically.
- Use probe only if one fresh read-only repository snapshot would materially improve the next decision, and never for information that is already present.
- If the next prompt would be nearly identical to the previous one, prefer pause over repetition unless there is a strong reason to try once more.
- Be conservative about claiming completion.
- Do not ask the user anything.

JSON shape:
{
  "action":"continue|stop|pause|probe",
  "reason":"...",
  "updatedSummary":"...",
  "goalStatus":"in_progress|likely_met|met|blocked|stalled",
  "qualityGoalMet":true,
  "progressPercent":0,
  "commitRecommendation":"none|milestone|finalize",
  "nextPrompt":"...",
  "finalMessage":"...",
  "probe":{"kind":"git_status|git_diff_names|git_head|verify_command"}
}`;

interface GitSnapshot {
  isGitRepo: boolean;
  head?: string;
  status: string;
  changedFiles: string[];
  dirty: boolean;
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
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
    config.untilPrompt ? `Quality goal:\n${config.untilPrompt}` : undefined,
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
    untilPrompt: snapshot.untilPrompt,
  });
}

function getResumePrompt(snapshot: AutoModeStateV1): string {
  return buildResumePrompt({
    goal: snapshot.goal,
    untilPrompt: snapshot.untilPrompt,
    controllerSummary: snapshot.controllerSummary,
  });
}

function buildWorkerPromptSuffix(snapshot: AutoModeStateV1): string {
  return buildAutoWorkerSystemPrompt({
    goal: snapshot.goal,
    untilPrompt: snapshot.untilPrompt,
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
    snapshot.untilPrompt ? `Quality goal:\n${snapshot.untilPrompt}` : undefined,
    [
      `Mode: ${snapshot.mode}`,
      `Current iteration: ${snapshot.currentIteration}/${snapshot.maxIterations}`,
      `Remaining iterations after this turn: ${remainingIterations}`,
      `Commit policy: ${snapshot.commitPolicy}`,
      `Push policy: ${snapshot.pushPolicy}`,
      `Controller probes allowed: ${snapshot.allowControllerProbes ? "yes" : "no"}`,
      `Verification command configured: ${snapshot.verifyCommand ? snapshot.verifyCommand : "no"}`,
    ].join("\n"),
    `Controller summary:\n${snapshot.controllerSummary || "(empty)"}`,
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

async function getGitSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitSnapshot | undefined> {
  const isRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (isRepo.code !== 0 || !isRepo.stdout.includes("true")) {
    return undefined;
  }

  const [head, status, upstream] = await Promise.all([
    pi.exec("git", ["rev-parse", "HEAD"], { cwd }),
    pi.exec("git", ["status", "--short", "--branch"], { cwd }),
    pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd }),
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

  return {
    isGitRepo: true,
    head: head.code === 0 ? head.stdout.trim() : undefined,
    status: statusText,
    changedFiles,
    dirty: changedFiles.length > 0,
    hasUpstream,
    ahead,
    behind,
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

  const fallbackDefault = parseModelRef(DEFAULT_CONTROLLER_MODEL);
  if (fallbackDefault) {
    const found = registry.find(fallbackDefault.provider, fallbackDefault.id);
    if (found && registry.hasConfiguredAuth(found)) {
      return found as Model<Api>;
    }
  }

  if (ctx.model && registry.hasConfiguredAuth(ctx.model)) {
    return ctx.model as Model<Api>;
  }

  return undefined;
}

async function callController(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
  probeResult?: ProbeResult,
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
    content: [{ type: "text", text: buildControllerUserPrompt(snapshot, workerTurn, gitSnapshot, verifyResult, probeResult) }],
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
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
): Promise<ControllerDecision | undefined> {
  let decision = await callController(pi, ctx, snapshot, workerTurn, gitSnapshot, verifyResult);
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
      qualityGoalMet: false,
      progressPercent: decision.progressPercent,
      commitRecommendation: decision.commitRecommendation,
    };
  }

  let probeRounds = 0;
  while (decision.action === "probe" && probeRounds < PROBE_LIMIT_PER_CYCLE) {
    const probeResult = await executeProbe(pi, ctx, snapshot, decision.probe.kind);
    probeRounds += 1;
    decision = await callController(pi, ctx, snapshot, workerTurn, gitSnapshot, verifyResult, probeResult);
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
      qualityGoalMet: false,
      progressPercent: decision.progressPercent,
      commitRecommendation: decision.commitRecommendation,
    };
  }

  return decision;
}

function updateNoChangeCounters(snapshot: AutoModeStateV1, gitSnapshot: GitSnapshot | undefined): void {
  const nextHead = gitSnapshot?.head;
  const nextFiles = gitSnapshot?.changedFiles ?? [];
  const previousHead = snapshot.lastSeenHead;
  const previousFiles = snapshot.lastSeenChangedFiles ?? [];

  const sameHead = previousHead !== undefined && previousHead === nextHead;
  const sameFiles = JSON.stringify(previousFiles) === JSON.stringify(nextFiles);

  if (sameHead && sameFiles) {
    snapshot.consecutiveNoChangeCount += 1;
  } else {
    snapshot.consecutiveNoChangeCount = 0;
  }

  snapshot.lastSeenHead = nextHead;
  snapshot.lastSeenChangedFiles = [...nextFiles];
}

function updateStagnationCounter(snapshot: AutoModeStateV1, nextPrompt: string): void {
  if (snapshot.lastAutoPrompt && normalizeComparableText(snapshot.lastAutoPrompt) === normalizeComparableText(nextPrompt)) {
    snapshot.consecutiveStagnationCount += 1;
  } else {
    snapshot.consecutiveStagnationCount = 0;
  }
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

async function getStopOverridePrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: AutoModeStateV1,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult?: VerifyCommandResult,
): Promise<string | undefined> {
  const resolvedVerifyResult = verifyResult ?? (
    snapshot.verifyCommand
      ? await runVerifyCommand(pi, ctx.cwd, snapshot.verifyCommand)
      : undefined
  );
  if (snapshot.verifyCommand && resolvedVerifyResult && !resolvedVerifyResult.ok) {
    return `The configured verification command failed (${snapshot.verifyCommand}). Fix the remaining issues, rerun the verification command until it passes, and only then consider the task complete. Do not ask the user anything.`;
  }

  if (!gitSnapshot) {
    return undefined;
  }

  const actions: string[] = [];
  if (snapshot.commitPolicy !== "none" && gitSnapshot.dirty) {
    actions.push("Create an atomic commit for the completed work.");
  }
  if (snapshot.pushPolicy !== "never" && gitSnapshot.hasUpstream && (gitSnapshot.ahead ?? 0) > 0) {
    actions.push("Push the current branch so it is in sync with upstream.");
  }
  if (snapshot.pushPolicy !== "never" && gitSnapshot.hasUpstream && (gitSnapshot.behind ?? 0) > 0) {
    actions.push("Bring the branch back in sync with upstream before stopping.");
  }

  if (actions.length === 0) {
    return undefined;
  }

  return `${actions.join(" ")} Then verify git status is clean and the branch is synchronized. Do not ask the user anything.`;
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
    `paused=${snapshot.paused ? "yes" : "no"}`,
    `iteration=${snapshot.currentIteration}/${snapshot.maxIterations}`,
    `goal=${snapshot.goal}`,
    snapshot.untilPrompt ? `until=${snapshot.untilPrompt}` : undefined,
    snapshot.controllerModel ? `controller-model=${snapshot.controllerModel.provider}/${snapshot.controllerModel.id}` : `controller-model=${DEFAULT_CONTROLLER_MODEL} (fallback to active model if unavailable)`,
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
    allowControllerProbes: pi.getFlag("auto-allow-controller-probes"),
    resume: pi.getFlag("auto-resume"),
    maxWallClockMinutes: pi.getFlag("auto-max-wall-clock-minutes"),
  };
}

export default function (pi: ExtensionAPI) {
  const runtime: AutoRuntimeState = {
    controllerBusy: false,
  };

  pi.registerFlag("auto-goal", {
    description: "Start auto-mode with the given goal",
    type: "string",
  });
  pi.registerFlag("auto-iterations", {
    description: `Iteration limit for auto-mode (default ${DEFAULT_AUTO_ITERATIONS})`,
    type: "string",
  });
  pi.registerFlag("auto-until", {
    description: "Optional quality goal prompt for auto-mode stop decisions",
    type: "string",
  });
  pi.registerFlag("auto-controller-model", {
    description: `Optional controller model in provider/model form (defaults to ${DEFAULT_CONTROLLER_MODEL} when available)`,
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

      const gitSnapshot = await getGitSnapshot(pi, ctx.cwd);
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

      const decision = await decideControllerAction(pi, ctx, snapshot, workerTurn, gitSnapshot, verifyResult);

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
      recordControllerDecision(snapshot, decision);

      if (decision.action === "continue") {
        if (snapshot.currentIteration >= snapshot.maxIterations) {
          disableSnapshot(pi, ctx, runtime, "iteration budget exhausted", snapshot.mode === "iterations" ? "info" : "warning");
          return;
        }

        const nextPrompt = augmentContinuePrompt(decision, snapshot, gitSnapshot);
        updateStagnationCounter(snapshot, nextPrompt);
        snapshot.lastAutoPrompt = nextPrompt;

        if (snapshot.consecutiveStagnationCount >= DEFAULT_STAGNATION_LIMIT) {
          pauseSnapshot(pi, ctx, runtime, "controller produced the same next prompt repeatedly");
          return;
        }

        if (snapshot.consecutiveNoChangeCount >= DEFAULT_NO_CHANGE_LIMIT) {
          pauseSnapshot(pi, ctx, runtime, "repository state has not changed across several iterations");
          return;
        }

        snapshot.currentIteration += 1;
        persistSnapshot(pi, snapshot);
        setStatus(ctx, snapshot);
        ctx.ui.notify(`Auto-mode continuing (${snapshot.currentIteration}/${snapshot.maxIterations})`, "info");
        pi.sendUserMessage(nextPrompt);
        return;
      }

      if (decision.action === "pause") {
        persistSnapshot(pi, snapshot);
        pauseSnapshot(pi, ctx, runtime, decision.reason);
        return;
      }

      if (decision.action === "stop") {
        const overridePrompt = await getStopOverridePrompt(pi, ctx, snapshot, gitSnapshot, verifyResult);
        if (overridePrompt) {
          if (snapshot.currentIteration >= snapshot.maxIterations) {
            disableSnapshot(pi, ctx, runtime, `iteration budget exhausted before finalization: ${decision.reason}`, "warning");
            return;
          }

          snapshot.lastAutoPrompt = overridePrompt;
          snapshot.currentIteration += 1;
          persistSnapshot(pi, snapshot);
          setStatus(ctx, snapshot);
          ctx.ui.notify(`Auto-mode finalization pass requested: ${decision.reason}`, "warning");
          pi.sendUserMessage(overridePrompt);
          return;
        }

        persistSnapshot(pi, snapshot);
        disableSnapshot(pi, ctx, runtime, decision.finalMessage || decision.reason, decision.qualityGoalMet ? "info" : "warning");
      }
    } finally {
      runtime.controllerBusy = false;
    }
  });
}
