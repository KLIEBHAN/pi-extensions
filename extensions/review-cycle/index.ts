import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  APPLY_REVIEW_SYSTEM_PROMPT,
  buildApplyReviewPrompt,
  buildReviewerUserPrompt,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DEFAULT_REVIEW_TOOLS,
  buildReviewerToolGuardExtensionSource,
  extractAssistantText,
  isReviewerTestCommandAllowed,
  parseReviewSummary,
  IMPLEMENTATION_SYSTEM_PROMPT,
  parseModelRef,
  parseReviewCycleArgs,
  REVIEW_CYCLE_STATUS_KEY,
  REVIEWER_SYSTEM_PROMPT,
  shouldTreatStopReasonAsFailure,
  summarizeTask,
  truncateMiddle,
  type ChangeSnapshot,
  type GitBaseline,
  type ModelRef,
  type ReviewSummary,
} from "./core.ts";

const GIT_TIMEOUT_MS = 120_000;
const MAX_REVIEWER_STDERR_CHARS = 4_000;
const MAX_IMPLEMENTATION_SUMMARY_CHARS = 8_000;
const REVIEWER_OUTPUT_WIDGET_KEY = "review-cycle-reviewer-output";
const REVIEWER_SUMMARY_WIDGET_KEY = "review-cycle-review-summary";
const PREFLIGHT_WIDGET_KEY = "review-cycle-preflight";
const HELP_WIDGET_KEY = "review-cycle-help";
const ARTIFACT_WIDGET_KEY = "review-cycle-artifact";
const MAX_REVIEWER_OUTPUT_LINES = 80;
const MAX_REVIEWER_OUTPUT_LINE_CHARS = 240;
const MAX_CHECKLIST_ITEMS = 12;
const STATUS_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_REVIEW_ROUNDS = 2;
const REVIEWER_KILL_GRACE_MS = 5_000;
const REVIEW_CYCLE_CONFIG_PATH = ".pi/review-cycle.json";
const REVIEW_CYCLE_ARTIFACT_DIR = ".pi/review-cycle";

type ReviewCyclePhase = "confirming" | "implementing" | "reviewing" | "manual" | "applying" | "failed";

interface ReviewCycleState {
  active: boolean;
  phase: ReviewCyclePhase;
  runId: string;
  task: string;
  startedAt: number;
  baseline: GitBaseline;
  reviewerModel?: ModelRef;
  reviewerModelSource: "command" | "config" | "active";
  testPolicySource: "command" | "config" | "default";
  implementationSummary?: string;
  applySummary?: string;
  review?: string;
  reviewSummary?: ReviewSummary;
  lastChanges?: ChangeSnapshot;
  lastReviewError?: string;
  reviewerOutputVisible: boolean;
  reviewerOutputLines: string[];
  reviewerAbortController?: AbortController;
  allowedTestCommands: string[];
  manualApply: boolean;
  autoRerunAfterApply: boolean;
  maxReviewRounds: number;
  reviewRound: number;
  allowDirty: boolean;
  artifactRunPath?: string;
}

interface FreshReviewResult {
  text: string;
  exitCode: number;
  stderr: string;
  messages: Message[];
}

interface AssistantTurn {
  text: string;
  stopReason: string | undefined;
}

interface ReviewCyclePreferences {
  reviewerOutputVisible: boolean;
  allowedTestCommands?: string[];
}

interface ReviewCycleRepoConfig {
  reviewerModel?: ModelRef;
  tests?: string[];
  manualApply?: boolean;
  autoRerunAfterApply?: boolean;
  maxReviewRounds?: number;
  allowDirty?: boolean;
  ignoredTests?: string[];
}

interface ReviewCycleRunOptions {
  reviewerModel?: ModelRef;
  reviewerModelSource: "command" | "config" | "active";
  testPolicySource: "command" | "config" | "default";
  reviewerOutputVisible: boolean;
  allowedTestCommands: string[];
  manualApply: boolean;
  autoRerunAfterApply: boolean;
  maxReviewRounds: number;
  allowDirty: boolean;
}

interface LastReviewCycleRun {
  task: string;
  baseline: GitBaseline;
  reviewerModel?: ModelRef;
  implementationSummary?: string;
}

interface ReviewCycleDependencies {
  getGitBaseline?: typeof getGitBaseline;
  getChangeSnapshot?: typeof getChangeSnapshot;
  runFreshReviewAgent?: typeof runFreshReviewAgent;
}

function makeRunId(): string {
  return `review-cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function modelRefToCli(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

function resolveDefaultReviewerModel(ctx: ExtensionContext | ExtensionCommandContext): ModelRef | undefined {
  if (!ctx.model) return undefined;
  return { provider: ctx.model.provider, id: ctx.model.id };
}

function validateRequestedReviewerModel(
  ctx: ExtensionContext | ExtensionCommandContext,
  reviewerModel: ModelRef | undefined,
): string | undefined {
  if (!reviewerModel) return undefined;
  const found = ctx.modelRegistry.find(reviewerModel.provider, reviewerModel.id);
  if (!found) return `Reviewer model not found: ${modelRefToCli(reviewerModel)}`;
  if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
    return `No configured auth for reviewer model ${modelRefToCli(reviewerModel)}`;
  }
  return undefined;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder > 0 ? `${minutes}m${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder > 0 ? `${hours}h${minuteRemainder}m` : `${hours}h`;
}

function getPhaseStatus(state: ReviewCycleState): { step: number; label: string } {
  switch (state.phase) {
    case "confirming":
      return { step: 0, label: "awaiting dirty-workspace decision" };
    case "implementing":
      return { step: 1, label: "implementing" };
    case "reviewing":
      return { step: 2, label: `reviewing round ${Math.max(1, state.reviewRound)}` };
    case "manual":
      return { step: 2, label: "awaiting manual apply" };
    case "applying":
      return { step: 3, label: "applying" };
    case "failed":
      return { step: 2, label: "review failed" };
  }
}

function formatStatusLine(state: ReviewCycleState): string {
  const phase = getPhaseStatus(state);
  return `Review ${phase.step}/3 ${phase.label} · ${formatElapsed(Date.now() - state.startedAt)} · ${summarizeTask(state.task, 42)}`;
}

function setStatus(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState | undefined): void {
  if (!state?.active) {
    ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, formatStatusLine(state));
}

function clearReviewerOutputWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  ctx.ui.setWidget(REVIEWER_OUTPUT_WIDGET_KEY, undefined);
}

function clearReviewerSummaryWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  ctx.ui.setWidget(REVIEWER_SUMMARY_WIDGET_KEY, undefined);
}

function clearPreflightWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  ctx.ui.setWidget(PREFLIGHT_WIDGET_KEY, undefined);
}

function abortActiveReviewer(state: ReviewCycleState | undefined): void {
  state?.reviewerAbortController?.abort();
}

function clearState(ctx: ExtensionContext | ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): void {
  abortActiveReviewer(stateRef.current);
  stateRef.current = undefined;
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
  clearReviewerOutputWidget(ctx);
  clearReviewerSummaryWidget(ctx);
  clearPreflightWidget(ctx);
}

function finishState(ctx: ExtensionContext | ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): void {
  abortActiveReviewer(stateRef.current);
  if (stateRef.current) stateRef.current.active = false;
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
}

function truncateLine(text: string): string {
  return text.length <= MAX_REVIEWER_OUTPUT_LINE_CHARS ? text : `${text.slice(0, MAX_REVIEWER_OUTPUT_LINE_CHARS - 1)}…`;
}

function pushReviewerOutputLine(state: ReviewCycleState, line: string): void {
  state.reviewerOutputLines.push(truncateLine(line));
  if (state.reviewerOutputLines.length > MAX_REVIEWER_OUTPUT_LINES) {
    state.reviewerOutputLines.splice(0, state.reviewerOutputLines.length - MAX_REVIEWER_OUTPUT_LINES);
  }
}

function appendReviewerOutputChunk(state: ReviewCycleState, chunk: string): void {
  const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (index === 0 && state.reviewerOutputLines.length > 0) {
      const lastIndex = state.reviewerOutputLines.length - 1;
      state.reviewerOutputLines[lastIndex] = truncateLine(`${state.reviewerOutputLines[lastIndex]}${part}`);
    } else {
      pushReviewerOutputLine(state, part);
    }

    if (index < parts.length - 1) {
      pushReviewerOutputLine(state, "");
    }
  }
}

function formatTestPolicy(allowedTestCommands: readonly string[]): string {
  return allowedTestCommands.length > 0 ? allowedTestCommands.join("; ") : "default safe test allowlist";
}

function formatReviewerLabel(state: Pick<ReviewCycleState, "reviewerModel" | "reviewerModelSource">): string {
  const source = state.reviewerModelSource === "active" ? "active" : state.reviewerModelSource;
  return state.reviewerModel ? `${modelRefToCli(state.reviewerModel)} (${source})` : "active model at review time";
}

function updatePreflightWidget(
  ctx: ExtensionContext | ExtensionCommandContext,
  state: ReviewCycleState,
  workerModel: ModelRef | undefined,
): void {
  const gitLine = state.baseline.isGitRepo
    ? `${state.baseline.dirty ? "dirty" : "clean"}${state.baseline.head ? ` · ${state.baseline.head.slice(0, 12)}` : ""}`
    : "not a git repository";
  const warnings = [
    !state.baseline.isGitRepo ? "Warning: git change scoping is degraded." : undefined,
    state.baseline.isGitRepo && state.baseline.dirty ? "Warning: workspace was already dirty before start." : undefined,
  ].filter((line): line is string => !!line);

  ctx.ui.setWidget(
    PREFLIGHT_WIDGET_KEY,
    [
      "Review-cycle preflight",
      `Task: ${summarizeTask(state.task, 140)}`,
      `Worker: ${workerModel ? modelRefToCli(workerModel) : "selected model"}`,
      `Reviewer: ${formatReviewerLabel(state)}`,
      `Tests: ${formatTestPolicy(state.allowedTestCommands)} (${state.testPolicySource})`,
      `Git: ${gitLine}`,
      `Mode: implement → fresh review → ${state.manualApply ? "wait for /review-cycle apply" : "auto-apply unless APPROVE"}${state.autoRerunAfterApply ? ` → rerun until approved (max ${state.maxReviewRounds} reviews)` : ""}`,
      state.phase === "confirming" ? "Action: workspace is dirty; use /review-cycle continue or /review-cycle abort." : undefined,
      ...warnings,
    ].filter((line): line is string => !!line),
    { placement: "belowEditor" },
  );
}

function updateFailureWidget(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState): void {
  ctx.ui.setWidget(
    REVIEWER_SUMMARY_WIDGET_KEY,
    [
      "Review-cycle reviewer failed",
      `Error: ${truncateMiddle(state.lastReviewError ?? "unknown error", 800)}`,
      "Next: /review-cycle retry, /review-cycle retry --reviewer-model provider/model, /review-cycle output on, or /review-cycle stop",
    ],
    { placement: "belowEditor" },
  );
}

function showHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.setWidget(
    HELP_WIDGET_KEY,
    [
      "Review-cycle commands",
      "/review-cycle <task>  — start implement → review → apply",
      "/rc <task>            — short alias for /review-cycle",
      "/review-cycle --manual-apply <task>  — wait for /review-cycle apply or skip after review",
      "/review-cycle --until-approved [--max-review-rounds n] <task>  — auto-rerun review after apply",
      "/review-cycle --allow-dirty <task>  — start even when the workspace is already dirty",
      "/review-cycle continue|abort  — decide after a dirty-workspace preflight pause",
      "/review-cycle apply|skip  — continue or finish a manual-apply review",
      "/review-cycle retry [--reviewer-model provider/model]  — retry a failed reviewer subprocess",
      "/review-cycle status  — show phase, elapsed time, reviewer, tests, task",
      "/review-cycle rerun [--reviewer-model provider/model]  — rerun fresh review for the last task",
      "/review-cycle output off|on|toggle  — hide/show live reviewer output",
      "/review-cycle artifact [show|path]  — show latest review artifact or its path",
      "/review-cycle tests status|set <cmd>|add <cmd>|clear  — configure exact reviewer test commands",
      "Repo config: .pi/review-cycle.json with reviewerModel, tests, manualApply, autoRerunAfterApply, maxReviewRounds, allowDirty",
      "/review-cycle stop  — cancel the managed workflow",
    ],
    { placement: "belowEditor" },
  );
  ctx.ui.notify("Review-cycle help shown", "info");
}

function formatReviewSummary(summary: ReviewSummary): string[] {
  const severityParts = Object.entries(summary.severityCounts)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`);
  return [
    `Verdict: ${summary.verdict ?? "UNKNOWN"}`,
    `Findings: ${summary.findingCount}${severityParts.length > 0 ? ` (${severityParts.join(", ")})` : ""}`,
  ];
}

function formatFindingsChecklist(summary: ReviewSummary, mode: "pending" | "handled"): string[] {
  if (summary.findings.length === 0) return ["Findings checklist: (none)"];
  const marker = mode === "handled" ? "[x]" : "[ ]";
  const shown = summary.findings.slice(0, MAX_CHECKLIST_ITEMS).map((finding, index) => {
    const severity = finding.severity === "other" ? "finding" : finding.severity.toUpperCase();
    const optional = finding.mandatory === false ? " optional" : "";
    return `${marker} ${index + 1}. ${severity}${optional}: ${truncateLine(finding.text)}`;
  });
  const omitted = summary.findings.length - shown.length;
  return [
    `Findings checklist (${mode === "handled" ? "apply pass completed" : "pending apply"}):`,
    ...shown,
    ...(omitted > 0 ? [`… (${omitted} more)`] : []),
  ];
}

function updateReviewSummaryWidget(
  ctx: ExtensionContext | ExtensionCommandContext,
  summary: ReviewSummary,
  action: string,
  checklistMode: "pending" | "handled" = "pending",
): void {
  ctx.ui.setWidget(
    REVIEWER_SUMMARY_WIDGET_KEY,
    [
      "Fresh reviewer summary",
      ...formatReviewSummary(summary),
      ...(summary.reviewDataWarning ? [summary.reviewDataWarning] : []),
      ...formatFindingsChecklist(summary, checklistMode),
      `Next: ${action}`,
    ],
    { placement: "belowEditor" },
  );
}

function updateReviewerOutputWidget(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState): void {
  if (!state.reviewerOutputVisible) {
    clearReviewerOutputWidget(ctx);
    return;
  }

  const lines = state.reviewerOutputLines.length > 0 ? state.reviewerOutputLines : ["(waiting for reviewer output...)"];
  ctx.ui.setWidget(
    REVIEWER_OUTPUT_WIDGET_KEY,
    [
      `Fresh reviewer output — /review-cycle output off or /rc output off to hide (${lines.length} line${lines.length === 1 ? "" : "s"})`,
      ...lines.slice(-MAX_REVIEWER_OUTPUT_LINES),
    ],
    { placement: "belowEditor" },
  );
}

function appendReviewerOutputLineAndRender(
  ctx: ExtensionContext | ExtensionCommandContext,
  state: ReviewCycleState,
  line: string,
): void {
  pushReviewerOutputLine(state, line);
  updateReviewerOutputWidget(ctx, state);
}

function appendReviewerOutputChunkAndRender(
  ctx: ExtensionContext | ExtensionCommandContext,
  state: ReviewCycleState,
  chunk: string,
): void {
  appendReviewerOutputChunk(state, chunk);
  updateReviewerOutputWidget(ctx, state);
}

function createCombinedAbortSignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const activeSignals = signals.filter((signal): signal is AbortSignal => !!signal);
  const listeners: Array<{ signal: AbortSignal; abort: () => void }> = [];
  const cleanup = () => {
    for (const listener of listeners) {
      listener.signal.removeEventListener("abort", listener.abort);
    }
    listeners.length = 0;
  };
  const abort = () => {
    controller.abort();
    cleanup();
  };

  if (activeSignals.some((signal) => signal.aborted)) {
    controller.abort();
    return { signal: controller.signal, cleanup };
  }

  for (const signal of activeSignals) {
    signal.addEventListener("abort", abort, { once: true });
    listeners.push({ signal, abort });
  }
  return { signal: controller.signal, cleanup };
}

function getLastAssistantTurn(event: { messages?: unknown[] }): AssistantTurn | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown; stopReason?: unknown } | undefined;
    if (!message || message.role !== "assistant") continue;
    return {
      text: extractAssistantText(message.content, MAX_IMPLEMENTATION_SUMMARY_CHARS * 2),
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    };
  }
  return undefined;
}

async function execText(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<{ ok: boolean; text: string }> {
  const result = await pi.exec(command, args, { cwd, timeout });
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return {
    ok: result.code === 0 && result.killed !== true,
    text: combined,
  };
}

async function getGitBaseline(pi: ExtensionAPI, cwd: string): Promise<GitBaseline> {
  const isRepo = await execText(pi, cwd, "git", ["rev-parse", "--is-inside-work-tree"]);
  if (!isRepo.ok || !/true/.test(isRepo.text)) {
    return {
      isGitRepo: false,
      status: "not a git repository",
      dirty: false,
    };
  }

  const head = await execText(pi, cwd, "git", ["rev-parse", "--verify", "HEAD"]);
  const status = await execText(pi, cwd, "git", ["status", "--short", "--branch", "--untracked-files=all"]);
  const porcelain = await execText(pi, cwd, "git", ["status", "--porcelain", "--untracked-files=all"]);

  return {
    isGitRepo: true,
    head: head.ok ? head.text.split(/\r?\n/)[0]?.trim() || undefined : undefined,
    status: status.text.trim() || "working tree clean",
    dirty: porcelain.ok ? porcelain.text.trim().length > 0 : true,
  };
}

async function getChangeSnapshot(pi: ExtensionAPI, cwd: string, baseline: GitBaseline): Promise<ChangeSnapshot> {
  if (!baseline.isGitRepo) {
    return {
      isGitRepo: false,
      status: "not a git repository",
      diffStat: "",
      diff: "",
      committedChanges: "",
      untrackedFiles: [],
      notes: ["No git repository was detected."],
    };
  }

  const status = await execText(pi, cwd, "git", ["status", "--short", "--branch", "--untracked-files=all"]);
  const untracked = await execText(pi, cwd, "git", ["ls-files", "--others", "--exclude-standard"]);
  const untrackedFiles = untracked.ok ? untracked.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  const notes: string[] = [];

  if (!baseline.head) {
    const stagedStat = await execText(pi, cwd, "git", ["diff", "--cached", "--stat"]);
    const unstagedStat = await execText(pi, cwd, "git", ["diff", "--stat"]);
    const stagedDiff = await execText(pi, cwd, "git", ["diff", "--cached"]);
    const unstagedDiff = await execText(pi, cwd, "git", ["diff"]);

    return {
      isGitRepo: true,
      status: status.text.trim() || "working tree clean",
      diffStat: [stagedStat.text, unstagedStat.text].filter(Boolean).join("\n\n"),
      diff: [stagedDiff.text, unstagedDiff.text].filter(Boolean).join("\n\n"),
      committedChanges: "",
      untrackedFiles,
      notes: [
        "No baseline commit was available, so the snapshot uses staged and unstaged diffs only.",
        ...notes,
      ],
    };
  }

  const committedChanges = await execText(pi, cwd, "git", ["log", "--oneline", "--decorate", "--stat", `${baseline.head}..HEAD`, "--"]);
  const worktreeDiffStat = await execText(pi, cwd, "git", ["diff", "--stat", baseline.head, "--"]);
  const indexDiffStat = await execText(pi, cwd, "git", ["diff", "--cached", "--stat", baseline.head, "--"]);
  const worktreeDiff = await execText(pi, cwd, "git", ["diff", baseline.head, "--"]);
  const indexDiff = await execText(pi, cwd, "git", ["diff", "--cached", baseline.head, "--"]);

  if (!worktreeDiff.ok) notes.push(`git diff against baseline failed: ${truncateMiddle(worktreeDiff.text, 800)}`);
  if (!indexDiff.ok) notes.push(`git diff --cached against baseline failed: ${truncateMiddle(indexDiff.text, 800)}`);
  if (!worktreeDiffStat.ok) notes.push(`git diff --stat against baseline failed: ${truncateMiddle(worktreeDiffStat.text, 800)}`);
  if (!indexDiffStat.ok) notes.push(`git diff --cached --stat against baseline failed: ${truncateMiddle(indexDiffStat.text, 800)}`);

  return {
    isGitRepo: true,
    baselineHead: baseline.head,
    status: status.text.trim() || "working tree clean",
    diffStat: [
      worktreeDiffStat.text ? `# Working tree vs baseline\n${worktreeDiffStat.text}` : undefined,
      indexDiffStat.text ? `# Index vs baseline\n${indexDiffStat.text}` : undefined,
    ].filter((value): value is string => !!value).join("\n\n"),
    diff: [
      worktreeDiff.text ? `# Working tree vs baseline\n${worktreeDiff.text}` : undefined,
      indexDiff.text ? `# Index vs baseline\n${indexDiff.text}` : undefined,
    ].filter((value): value is string => !!value).join("\n\n"),
    committedChanges: committedChanges.text,
    untrackedFiles,
    notes,
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function writeReviewerRuntimeFiles(allowedTestCommands: readonly string[]): Promise<{ dir: string; systemPromptPath: string; toolGuardPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-cycle-"));
  const systemPromptPath = join(dir, "reviewer-system-prompt.md");
  const toolGuardPath = join(dir, "reviewer-tool-guard.ts");
  await Promise.all([
    writeFile(systemPromptPath, REVIEWER_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 }),
    writeFile(toolGuardPath, buildReviewerToolGuardExtensionSource({ allowedTestCommands }), { encoding: "utf8", mode: 0o600 }),
  ]);
  return { dir, systemPromptPath, toolGuardPath };
}

export async function runFreshReviewAgent(options: {
  cwd: string;
  prompt: string;
  reviewerModel?: ModelRef;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  onOutput?: (chunk: string) => void;
  onLine?: (line: string) => void;
  allowedTestCommands?: readonly string[];
  invocation?: { command: string; args?: string[] };
}): Promise<FreshReviewResult> {
  const temp = await writeReviewerRuntimeFiles(options.allowedTestCommands ?? []);
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "-e",
    temp.toolGuardPath,
    "--tools",
    DEFAULT_REVIEW_TOOLS.join(","),
  ];

  if (options.reviewerModel) {
    args.push("--model", modelRefToCli(options.reviewerModel));
  }

  args.push("--append-system-prompt", temp.systemPromptPath, options.prompt);

  try {
    return await new Promise<FreshReviewResult>((resolve, reject) => {
      const invocation = options.invocation
        ? { command: options.invocation.command, args: [...(options.invocation.args ?? []), ...args] }
        : getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const messages: Message[] = [];
      let stderr = "";
      let buffer = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const getEventTextDelta = (event: any): string | undefined => {
        const messageEvent = event?.assistantMessageEvent;
        if (!messageEvent || messageEvent.type !== "text_delta") return undefined;
        if (typeof messageEvent.delta === "string") return messageEvent.delta;
        if (typeof messageEvent.delta?.text === "string") return messageEvent.delta.text;
        if (typeof messageEvent.text === "string") return messageEvent.text;
        return undefined;
      };

      const getToolResultText = (result: any): string => {
        const content = result?.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((part) => typeof part?.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\n");
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_update") {
          const delta = getEventTextDelta(event);
          if (delta) options.onOutput?.(delta);
          return;
        }

        if (event.type === "tool_execution_start") {
          const argsText = event.args ? JSON.stringify(event.args) : "";
          options.onLine?.(`→ ${event.toolName}${argsText ? ` ${truncateMiddle(argsText, 220)}` : ""}`);
          return;
        }

        if (event.type === "tool_execution_end") {
          const icon = event.isError ? "✗" : "✓";
          options.onLine?.(`${icon} ${event.toolName}`);
          const resultText = truncateMiddle(getToolResultText(event.result), 1_200).trim();
          if (resultText) {
            for (const resultLine of resultText.split(/\r?\n/).slice(0, 12)) {
              options.onLine?.(`  ${resultLine}`);
            }
          }
          return;
        }

        if (event.type === "message_end" && event.message) {
          messages.push(event.message as Message);
        }
      };

      const clearKillTimer = () => {
        if (!killTimer) return;
        clearTimeout(killTimer);
        killTimer = undefined;
      };

      const killProcess = () => {
        proc.kill("SIGTERM");
        killTimer ??= setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        }, options.killGraceMs ?? REVIEWER_KILL_GRACE_MS);
        killTimer.unref?.();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        killProcess();
      }, options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS);

      const abortHandler = () => {
        aborted = true;
        killProcess();
      };

      if (options.signal) {
        if (options.signal.aborted) abortHandler();
        else options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          options.onLine?.(`stderr: ${line}`);
        }
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        clearKillTimer();
        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
        finishReject(error);
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        clearKillTimer();
        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
        if (buffer.trim()) processLine(buffer);

        if (aborted) {
          finishReject(new Error("Fresh review agent was aborted"));
          return;
        }
        if (timedOut) {
          finishReject(new Error(`Fresh review agent timed out after ${options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS}ms`));
          return;
        }

        const exitCode = code ?? 0;
        const finalText = getFinalAssistantOutput(messages);
        if (exitCode !== 0) {
          finishReject(new Error(`Fresh review agent failed with exit code ${exitCode}: ${truncateMiddle(stderr, MAX_REVIEWER_STDERR_CHARS)}`));
          return;
        }
        if (!settled) {
          settled = true;
          resolve({ text: finalText, exitCode, stderr, messages });
        }
      });
    });
  } finally {
    await rm(temp.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function getFinalAssistantOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = extractAssistantText(message.content);
    if (text) return text;
  }
  return "";
}

function parseConfigBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseConfigPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function loadReviewCycleConfig(cwd: string): Promise<ReviewCycleRepoConfig> {
  const path = join(cwd, REVIEW_CYCLE_CONFIG_PATH);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};

  const record = parsed as Record<string, unknown>;
  const reviewerModel = typeof record.reviewerModel === "string" ? parseModelRef(record.reviewerModel) : undefined;
  const configuredTests = Array.isArray(record.tests)
    ? record.tests.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
    : undefined;
  const tests = configuredTests?.filter((command) => isReviewerTestCommandAllowed(command, { allowedTestCommands: [command] }));
  const ignoredTests = configuredTests?.filter((command) => !isReviewerTestCommandAllowed(command, { allowedTestCommands: [command] }));

  return {
    reviewerModel,
    tests,
    ignoredTests,
    manualApply: parseConfigBoolean(record.manualApply),
    autoRerunAfterApply: parseConfigBoolean(record.autoRerunAfterApply),
    maxReviewRounds: parseConfigPositiveInteger(record.maxReviewRounds),
    allowDirty: parseConfigBoolean(record.allowDirty),
  };
}

function notifyConfigWarnings(ctx: ExtensionCommandContext | ExtensionContext, config: ReviewCycleRepoConfig): void {
  for (const command of config.ignoredTests ?? []) {
    ctx.ui.notify(`Ignored unsafe configured reviewer test command: ${command}`, "warning");
  }
}

function resolveRunOptions(
  preferences: ReviewCyclePreferences,
  config: ReviewCycleRepoConfig,
  command: {
    reviewerModel?: ModelRef;
    manualApply?: boolean;
    untilApproved?: boolean;
    allowDirty?: boolean;
    maxReviewRounds?: number;
  },
): ReviewCycleRunOptions {
  const autoRerunAfterApply = command.untilApproved ?? config.autoRerunAfterApply ?? false;
  const reviewerModel = command.reviewerModel ?? config.reviewerModel;
  const commandTestsConfigured = preferences.allowedTestCommands !== undefined;
  return {
    reviewerModel,
    reviewerModelSource: command.reviewerModel ? "command" : config.reviewerModel ? "config" : "active",
    testPolicySource: commandTestsConfigured ? preferences.allowedTestCommands!.length > 0 ? "command" : "default" : config.tests && config.tests.length > 0 ? "config" : "default",
    reviewerOutputVisible: preferences.reviewerOutputVisible,
    allowedTestCommands: commandTestsConfigured ? [...preferences.allowedTestCommands!] : [...(config.tests ?? [])],
    manualApply: command.manualApply ?? config.manualApply ?? false,
    autoRerunAfterApply,
    maxReviewRounds: Math.max(1, command.maxReviewRounds ?? config.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS),
    allowDirty: command.allowDirty ?? config.allowDirty ?? false,
  };
}

function formatArtifactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatArtifactSummary(state: ReviewCycleState, stage: string): string {
  const summary = state.reviewSummary;
  const findings = summary?.findings.length
    ? summary.findings.map((finding, index) => `- [ ] ${index + 1}. ${finding.severity.toUpperCase()}: ${finding.text}`).join("\n")
    : "(none)";
  return [
    `# Review-cycle run ${state.runId}`,
    `Stage: ${stage}`,
    `Task: ${state.task}`,
    `Started: ${new Date(state.startedAt).toISOString()}`,
    `Reviewer: ${formatReviewerLabel(state)}`,
    `Tests: ${formatTestPolicy(state.allowedTestCommands)}`,
    `Mode: manualApply=${state.manualApply}, autoRerunAfterApply=${state.autoRerunAfterApply}, maxReviewRounds=${state.maxReviewRounds}`,
    "",
    "## Baseline",
    `- git repository: ${state.baseline.isGitRepo ? "yes" : "no"}`,
    `- head: ${state.baseline.head ?? "(none/unknown)"}`,
    `- dirty at start: ${state.baseline.dirty ? "yes" : "no"}`,
    "",
    "```text",
    state.baseline.status || "(unknown)",
    "```",
    "",
    "## Latest change snapshot",
    "```text",
    state.lastChanges?.status || "(not collected yet)",
    "```",
    state.lastChanges?.diffStat ? `\n### Diff stat\n\n\`\`\`text\n${state.lastChanges.diffStat}\n\`\`\`` : undefined,
    "",
    "## Review summary",
    `- verdict: ${summary?.verdict ?? "(none)"}`,
    `- findings: ${summary?.findingCount ?? 0}`,
    "",
    "## Findings checklist",
    findings,
    "",
    "## Reviewer output",
    state.review ? truncateMiddle(state.review, 24_000) : "(not available)",
    "",
    "## Apply output",
    state.applySummary ? truncateMiddle(state.applySummary, 8_000) : "(not available)",
    state.lastReviewError ? `\n## Last reviewer error\n${state.lastReviewError}` : undefined,
  ].filter((value): value is string => value !== undefined).join("\n");
}

async function writeReviewArtifact(cwd: string, state: ReviewCycleState, stage: string): Promise<string | undefined> {
  const dir = join(cwd, REVIEW_CYCLE_ARTIFACT_DIR);
  state.artifactRunPath ??= join(dir, "runs", `${formatArtifactTimestamp()}-${state.runId}.md`);
  const latestPath = join(dir, "latest.md");
  const content = formatArtifactSummary(state, stage);
  const runTempPath = `${state.artifactRunPath}.${process.pid}.${Date.now()}.tmp`;
  const latestTempPath = `${latestPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(join(dir, "runs"), { recursive: true });
    await Promise.all([
      writeFile(runTempPath, content, "utf8"),
      writeFile(latestTempPath, content, "utf8"),
    ]);
    await Promise.all([
      rename(runTempPath, state.artifactRunPath),
      rename(latestTempPath, latestPath),
    ]);
    return state.artifactRunPath;
  } catch {
    await Promise.all([
      rm(runTempPath, { force: true }).catch(() => undefined),
      rm(latestTempPath, { force: true }).catch(() => undefined),
    ]);
    return undefined;
  }
}

async function showReviewArtifact(ctx: ExtensionCommandContext, action: "show" | "path"): Promise<void> {
  const latestPath = join(ctx.cwd, REVIEW_CYCLE_ARTIFACT_DIR, "latest.md");
  if (action === "path") {
    ctx.ui.notify(`Review-cycle latest artifact: ${latestPath}`, "info");
    return;
  }

  let content: string;
  try {
    content = await readFile(latestPath, "utf8");
  } catch {
    ctx.ui.notify("No review-cycle artifact found yet", "info");
    return;
  }

  ctx.ui.setWidget(
    ARTIFACT_WIDGET_KEY,
    ["Review-cycle latest artifact", `Path: ${latestPath}`, ...truncateMiddle(content, 6_000).split(/\r?\n/)],
    { placement: "belowEditor" },
  );
  ctx.ui.notify("Review-cycle latest artifact shown", "info");
}

function changeSnapshotFingerprint(snapshot: ChangeSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  return JSON.stringify({
    status: snapshot.status,
    diffStat: snapshot.diffStat,
    diff: snapshot.diff,
    committedChanges: snapshot.committedChanges,
    untrackedFiles: snapshot.untrackedFiles,
  });
}

async function startReviewCycle(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  stateRef: { current?: ReviewCycleState },
  getGitBaselineImpl: typeof getGitBaseline,
  task: string,
  options: ReviewCycleRunOptions,
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Wait until idle before starting review-cycle.", "warning");
    return;
  }

  if (stateRef.current?.active) {
    ctx.ui.notify("A review-cycle run is already active. Use /review-cycle stop first.", "warning");
    return;
  }

  if (!ctx.model) {
    ctx.ui.notify("No model selected", "error");
    return;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
    ctx.ui.notify(`No configured auth for ${ctx.model.provider}/${ctx.model.id}`, "error");
    return;
  }

  const reviewerModelError = validateRequestedReviewerModel(ctx, options.reviewerModel);
  if (reviewerModelError) {
    ctx.ui.notify(reviewerModelError, "error");
    return;
  }

  const baseline = await getGitBaselineImpl(pi, ctx.cwd).catch((error) => ({
    isGitRepo: false,
    status: `git baseline unavailable: ${error instanceof Error ? error.message : String(error)}`,
    dirty: false,
  } satisfies GitBaseline));

  const state: ReviewCycleState = {
    active: true,
    phase: baseline.isGitRepo && baseline.dirty && !options.allowDirty ? "confirming" : "implementing",
    runId: makeRunId(),
    task,
    startedAt: Date.now(),
    baseline,
    reviewerModel: options.reviewerModel,
    reviewerModelSource: options.reviewerModelSource,
    testPolicySource: options.testPolicySource,
    reviewerOutputVisible: options.reviewerOutputVisible,
    reviewerOutputLines: [],
    allowedTestCommands: [...options.allowedTestCommands],
    manualApply: options.manualApply,
    autoRerunAfterApply: options.autoRerunAfterApply,
    maxReviewRounds: options.maxReviewRounds,
    reviewRound: 0,
    allowDirty: options.allowDirty,
  };

  stateRef.current = state;
  setStatus(ctx, state);
  updatePreflightWidget(ctx, state, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);

  if (!pi.getSessionName()) {
    pi.setSessionName(`Review: ${summarizeTask(task, 56)}`);
  }

  if (!baseline.isGitRepo) {
    ctx.ui.notify("Review-cycle started without git; review scope will be degraded.", "warning");
  } else if (baseline.dirty && !options.allowDirty) {
    ctx.ui.notify("Review-cycle paused: workspace already dirty. Use /review-cycle continue or /review-cycle abort.", "warning");
    return;
  } else if (baseline.dirty) {
    ctx.ui.notify("Review-cycle started with pre-existing git changes because --allow-dirty/config allowDirty is set.", "warning");
  }

  ctx.ui.notify("Review-cycle started: implementation phase", "info");
  pi.sendUserMessage(task);
}

function continueDirtyReviewCycle(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: ReviewCycleState): void {
  if (state.phase !== "confirming") {
    ctx.ui.notify("No dirty-workspace decision is pending", "info");
    return;
  }
  state.phase = "implementing";
  state.allowDirty = true;
  setStatus(ctx, state);
  updatePreflightWidget(ctx, state, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
  ctx.ui.notify("Review-cycle continued with pre-existing git changes", "warning");
  pi.sendUserMessage(state.task);
}

async function runReviewAndQueueApply(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stateRef: { current?: ReviewCycleState },
  state: ReviewCycleState,
  getChangeSnapshotImpl: typeof getChangeSnapshot,
  runFreshReviewAgentImpl: typeof runFreshReviewAgent,
): Promise<void> {
  state.phase = "reviewing";
  state.lastReviewError = undefined;
  state.reviewRound += 1;
  state.reviewerOutputLines = [];
  clearPreflightWidget(ctx);
  clearReviewerSummaryWidget(ctx);
  setStatus(ctx, state);
  appendReviewerOutputLineAndRender(ctx, state, "Starting fresh-context reviewer...");
  ctx.ui.notify("Review-cycle: starting fresh-context review", "info");

  const changes = await getChangeSnapshotImpl(pi, ctx.cwd, state.baseline).catch((error) => ({
    isGitRepo: state.baseline.isGitRepo,
    baselineHead: state.baseline.head,
    status: `change snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    diffStat: "",
    diff: "",
    committedChanges: "",
    untrackedFiles: [],
    notes: ["Change snapshot collection failed before review."],
  } satisfies ChangeSnapshot));

  if (stateRef.current !== state || !state.active || state.phase !== "reviewing") return;

  state.lastChanges = changes;

  const reviewerPrompt = buildReviewerUserPrompt({
    task: state.task,
    implementationSummary: state.implementationSummary,
    baseline: state.baseline,
    changes,
  });

  const reviewerModel = state.reviewerModel ?? resolveDefaultReviewerModel(ctx);
  const reviewerAbortController = new AbortController();
  const combinedSignal = createCombinedAbortSignal([ctx.signal, reviewerAbortController.signal]);
  state.reviewerAbortController = reviewerAbortController;
  const result = await (async () => {
    try {
      return await runFreshReviewAgentImpl({
        cwd: ctx.cwd,
        prompt: reviewerPrompt,
        reviewerModel,
        signal: combinedSignal.signal,
        onOutput: (chunk) => {
          if (stateRef.current === state) appendReviewerOutputChunkAndRender(ctx, state, chunk);
        },
        onLine: (line) => {
          if (stateRef.current === state) appendReviewerOutputLineAndRender(ctx, state, line);
        },
        allowedTestCommands: state.allowedTestCommands,
      });
    } finally {
      combinedSignal.cleanup();
      if (state.reviewerAbortController === reviewerAbortController) state.reviewerAbortController = undefined;
    }
  })();

  if (stateRef.current !== state || !state.active || state.phase !== "reviewing") return;

  state.review = result.text.trim() || "Reviewer returned no text.";
  appendReviewerOutputLineAndRender(ctx, state, "Fresh-context reviewer finished.");
  const summary = parseReviewSummary(state.review);
  state.reviewSummary = summary;
  if (!summary.verdict) {
    throw new Error("Fresh review output did not include a recognized verdict (APPROVE, APPROVE_WITH_NOTES, or CHANGES_REQUESTED)");
  }

  await writeReviewArtifact(ctx.cwd, state, "review-complete");
  if (stateRef.current !== state || !state.active || state.phase !== "reviewing") return;

  if (summary.verdict === "APPROVE") {
    updateReviewSummaryWidget(ctx, summary, "done; no apply pass needed", "handled");
    finishState(ctx, stateRef);
    ctx.ui.notify("Review-cycle: reviewer approved; no apply pass needed", "info");
    return;
  }

  if (state.manualApply) {
    updateReviewSummaryWidget(ctx, summary, "waiting for /review-cycle apply or /review-cycle skip", "pending");
    state.phase = "manual";
    setStatus(ctx, state);
    ctx.ui.notify("Review-cycle: review complete; waiting for /review-cycle apply or /review-cycle skip", "info");
    return;
  }

  updateReviewSummaryWidget(ctx, summary, "applying feedback", "pending");
  state.phase = "applying";
  setStatus(ctx, state);
  ctx.ui.notify("Review-cycle: fresh review complete; applying feedback", "info");

  pi.sendUserMessage(buildApplyReviewPrompt({ task: state.task, review: state.review }));
}

function queueManualApply(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: ReviewCycleState): void {
  if (state.phase !== "manual" || !state.review) {
    ctx.ui.notify("No manual review feedback is waiting to apply", "info");
    return;
  }
  state.phase = "applying";
  setStatus(ctx, state);
  if (state.reviewSummary) updateReviewSummaryWidget(ctx, state.reviewSummary, "applying feedback", "pending");
  ctx.ui.notify("Review-cycle: applying manually approved review feedback", "info");
  pi.sendUserMessage(buildApplyReviewPrompt({ task: state.task, review: state.review }));
}

async function skipManualApply(ctx: ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): Promise<void> {
  const state = stateRef.current;
  if (!state?.active || state.phase !== "manual") {
    ctx.ui.notify("No manual review feedback is waiting to skip", "info");
    return;
  }
  if (state.reviewSummary) updateReviewSummaryWidget(ctx, state.reviewSummary, "skipped by user", "handled");
  await writeReviewArtifact(ctx.cwd, state, "manual-apply-skipped");
  if (stateRef.current !== state || !state.active || state.phase !== "manual") return;
  finishState(ctx, stateRef);
  ctx.ui.notify("Review-cycle completed: manual apply skipped", "info");
}

function markReviewFailure(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState, error: unknown): void {
  state.phase = "failed";
  state.lastReviewError = error instanceof Error ? error.message : String(error);
  state.reviewRound = Math.max(0, state.reviewRound - 1);
  setStatus(ctx, state);
  updateFailureWidget(ctx, state);
}

function makeLastRunFromState(state: ReviewCycleState): LastReviewCycleRun {
  return {
    task: state.task,
    baseline: state.baseline,
    reviewerModel: state.reviewerModel,
    implementationSummary: state.implementationSummary,
  };
}

async function rerunReviewCycle(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  stateRef: { current?: ReviewCycleState },
  options: ReviewCycleRunOptions,
  lastRun: LastReviewCycleRun | undefined,
  reviewerModelOverride: ModelRef | undefined,
  getChangeSnapshotImpl: typeof getChangeSnapshot,
  runFreshReviewAgentImpl: typeof runFreshReviewAgent,
  onStateStarted?: () => void,
): Promise<void> {
  if (stateRef.current?.active) {
    ctx.ui.notify("A review-cycle run is already active. Use /review-cycle stop first.", "warning");
    return;
  }
  if (!lastRun) {
    ctx.ui.notify("No previous review-cycle run to rerun", "warning");
    return;
  }

  const state: ReviewCycleState = {
    active: true,
    phase: "reviewing",
    runId: makeRunId(),
    task: lastRun.task,
    startedAt: Date.now(),
    baseline: lastRun.baseline,
    reviewerModel: reviewerModelOverride ?? lastRun.reviewerModel ?? options.reviewerModel,
    reviewerModelSource: reviewerModelOverride ? "command" : lastRun.reviewerModel ? "command" : options.reviewerModelSource,
    testPolicySource: options.testPolicySource,
    implementationSummary: lastRun.implementationSummary,
    reviewerOutputVisible: options.reviewerOutputVisible,
    reviewerOutputLines: [],
    allowedTestCommands: [...options.allowedTestCommands],
    manualApply: options.manualApply,
    autoRerunAfterApply: options.autoRerunAfterApply,
    maxReviewRounds: options.maxReviewRounds,
    reviewRound: 0,
    allowDirty: true,
  };
  stateRef.current = state;
  onStateStarted?.();
  try {
    await runReviewAndQueueApply(pi, ctx, stateRef, state, getChangeSnapshotImpl, runFreshReviewAgentImpl);
  } catch (error) {
    if (stateRef.current !== state) return;
    markReviewFailure(ctx, state, error);
    await writeReviewArtifact(ctx.cwd, state, "review-failed");
    ctx.ui.notify(`Review-cycle rerun failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function showStatus(ctx: ExtensionCommandContext, state: ReviewCycleState | undefined): void {
  if (!state?.active) {
    ctx.ui.notify("No active review-cycle run", "info");
    return;
  }

  const reviewer = `reviewer=${formatReviewerLabel(state)}`;
  const tests = `tests=${formatTestPolicy(state.allowedTestCommands)}`;
  ctx.ui.notify(
    `${formatStatusLine(state)} · ${reviewer} · ${tests}`,
    "info",
  );
}

export function createReviewCycleExtension(deps: ReviewCycleDependencies = {}) {
  return function (pi: ExtensionAPI) {
  const stateRef: { current?: ReviewCycleState } = {};
  const preferences: ReviewCyclePreferences = { reviewerOutputVisible: true };
  let lastRun: LastReviewCycleRun | undefined;
  let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const getGitBaselineImpl = deps.getGitBaseline ?? getGitBaseline;
  const getChangeSnapshotImpl = deps.getChangeSnapshot ?? getChangeSnapshot;
  const runFreshReviewAgentImpl = deps.runFreshReviewAgent ?? runFreshReviewAgent;

  const stopStatusTicker = () => {
    if (!statusRefreshTimer) return;
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = undefined;
  };

  const startStatusTicker = (ctx: ExtensionContext | ExtensionCommandContext) => {
    stopStatusTicker();
    statusRefreshTimer = setInterval(() => {
      const state = stateRef.current;
      if (!state?.active) {
        stopStatusTicker();
        return;
      }
      setStatus(ctx, state);
    }, STATUS_REFRESH_INTERVAL_MS);
    statusRefreshTimer.unref?.();
  };

  pi.registerFlag("review-cycle-task", {
    description: "Auto-start a review-cycle run with this task",
    type: "string",
  });

  pi.registerFlag("review-cycle-reviewer-model", {
    description: "Optional reviewer model in provider/model form",
    type: "string",
  });

  const handleReviewCycleCommand = async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseReviewCycleArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const repoConfig = await loadReviewCycleConfig(ctx.cwd);
      notifyConfigWarnings(ctx, repoConfig);

      if (parsed.kind === "help") {
        showHelp(ctx);
        return;
      }

      if (parsed.kind === "status") {
        showStatus(ctx, stateRef.current);
        return;
      }

      if (parsed.kind === "stop" || parsed.kind === "abort") {
        if (!stateRef.current?.active) {
          ctx.ui.notify("No active review-cycle run", "info");
          return;
        }
        clearState(ctx, stateRef);
        stopStatusTicker();
        if (!ctx.isIdle()) ctx.abort();
        ctx.ui.notify(parsed.kind === "abort" ? "Aborted review-cycle" : "Stopped review-cycle", "info");
        return;
      }

      if (parsed.kind === "continue") {
        const state = stateRef.current;
        if (!state?.active) {
          ctx.ui.notify("No paused dirty-workspace review-cycle run", "info");
          return;
        }
        continueDirtyReviewCycle(pi, ctx, state);
        return;
      }

      if (parsed.kind === "apply") {
        const state = stateRef.current;
        if (!state?.active) {
          ctx.ui.notify("No active review-cycle run", "info");
          return;
        }
        queueManualApply(pi, ctx, state);
        return;
      }

      if (parsed.kind === "skip") {
        await skipManualApply(ctx, stateRef);
        if (!stateRef.current?.active) stopStatusTicker();
        return;
      }

      if (parsed.kind === "retry") {
        const state = stateRef.current;
        if (!state?.active || state.phase !== "failed") {
          ctx.ui.notify("No failed review-cycle reviewer run to retry", "info");
          return;
        }
        const reviewerModelError = validateRequestedReviewerModel(ctx, parsed.reviewerModel);
        if (reviewerModelError) {
          ctx.ui.notify(reviewerModelError, "error");
          return;
        }
        if (parsed.reviewerModel) {
          state.reviewerModel = parsed.reviewerModel;
          state.reviewerModelSource = "command";
        }
        startStatusTicker(ctx);
        try {
          await runReviewAndQueueApply(pi, ctx, stateRef, state, getChangeSnapshotImpl, runFreshReviewAgentImpl);
        } catch (error) {
          if (stateRef.current !== state) return;
          markReviewFailure(ctx, state, error);
          stopStatusTicker();
          await writeReviewArtifact(ctx.cwd, state, "review-failed");
          ctx.ui.notify(`Review-cycle retry failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (parsed.kind === "artifact") {
        await showReviewArtifact(ctx, parsed.action);
        return;
      }

      if (parsed.kind === "rerun") {
        const reviewerModelError = validateRequestedReviewerModel(ctx, parsed.reviewerModel);
        if (reviewerModelError) {
          ctx.ui.notify(reviewerModelError, "error");
          return;
        }
        const runOptions = resolveRunOptions(preferences, repoConfig, { reviewerModel: parsed.reviewerModel });
        await rerunReviewCycle(
          pi,
          ctx,
          stateRef,
          runOptions,
          lastRun,
          parsed.reviewerModel,
          getChangeSnapshotImpl,
          runFreshReviewAgentImpl,
          () => startStatusTicker(ctx),
        );
        if (!stateRef.current?.active || stateRef.current.phase === "failed") stopStatusTicker();
        return;
      }

      if (parsed.kind === "tests") {
        if (parsed.action === "show") {
          const configured = preferences.allowedTestCommands !== undefined
            ? preferences.allowedTestCommands.length > 0
              ? preferences.allowedTestCommands.join("; ")
              : "default safe test allowlist"
            : repoConfig.tests && repoConfig.tests.length > 0
              ? repoConfig.tests.join("; ")
              : "default safe test allowlist";
          ctx.ui.notify(`Review-cycle test commands: ${configured}`, "info");
          return;
        }
        if (parsed.action === "clear") {
          preferences.allowedTestCommands = [];
          ctx.ui.notify("Review-cycle test commands reset to default safe allowlist", "info");
          return;
        }
        if (parsed.command) {
          if (!isReviewerTestCommandAllowed(parsed.command, { allowedTestCommands: [parsed.command] })) {
            ctx.ui.notify(`Unsafe reviewer test command rejected: ${parsed.command}`, "warning");
            return;
          }
          const currentConfigured = preferences.allowedTestCommands ?? repoConfig.tests ?? [];
          preferences.allowedTestCommands = parsed.action === "set"
            ? [parsed.command]
            : [...currentConfigured, parsed.command];
          ctx.ui.notify(`Review-cycle test command ${parsed.action === "set" ? "set" : "added"}: ${parsed.command}`, "info");
          return;
        }
      }

      if (parsed.kind === "output") {
        const nextVisible = parsed.mode === "toggle" ? !preferences.reviewerOutputVisible : parsed.mode === "on";
        preferences.reviewerOutputVisible = nextVisible;
        if (stateRef.current) {
          stateRef.current.reviewerOutputVisible = nextVisible;
          updateReviewerOutputWidget(ctx, stateRef.current);
        } else if (!nextVisible) {
          clearReviewerOutputWidget(ctx);
        }
        ctx.ui.notify(`Review-cycle reviewer output ${nextVisible ? "shown" : "hidden"}`, "info");
        return;
      }

      const runOptions = resolveRunOptions(preferences, repoConfig, parsed);
      await startReviewCycle(pi, ctx, stateRef, getGitBaselineImpl, parsed.task, runOptions);
      if (stateRef.current?.active) startStatusTicker(ctx);
      if (stateRef.current) lastRun = makeLastRunFromState(stateRef.current);
  };

  pi.registerCommand("review-cycle", {
    description: "Implement a task, run a fresh-context code review, then apply the feedback",
    handler: handleReviewCycleCommand,
  });

  pi.registerCommand("rc", {
    description: "Alias for /review-cycle",
    handler: handleReviewCycleCommand,
  });

  pi.on("session_start", async (event, ctx) => {
    clearState(ctx, stateRef);
    stopStatusTicker();

    if (event.reason !== "startup") return;
    const taskFlag = pi.getFlag("review-cycle-task");
    if (typeof taskFlag !== "string" || !taskFlag.trim()) return;

    const reviewerModelFlag = pi.getFlag("review-cycle-reviewer-model");
    const reviewerModel = typeof reviewerModelFlag === "string" && reviewerModelFlag.trim()
      ? parseModelRef(reviewerModelFlag)
      : undefined;
    if (typeof reviewerModelFlag === "string" && reviewerModelFlag.trim() && !reviewerModel) {
      ctx.ui.notify("--review-cycle-reviewer-model must be in provider/model form", "error");
      return;
    }

    const repoConfig = await loadReviewCycleConfig(ctx.cwd);
    notifyConfigWarnings(ctx, repoConfig);
    const runOptions = resolveRunOptions(preferences, repoConfig, { reviewerModel });
    await startReviewCycle(pi, ctx, stateRef, getGitBaselineImpl, taskFlag.trim(), runOptions);
    if (stateRef.current?.active) startStatusTicker(ctx);
    if (stateRef.current) lastRun = makeLastRunFromState(stateRef.current);
  });

  pi.on("before_agent_start", async (event) => {
    const state = stateRef.current;
    if (!state?.active) return;

    if (state.phase === "implementing") {
      return { systemPrompt: `${event.systemPrompt}\n\n${IMPLEMENTATION_SYSTEM_PROMPT}` };
    }

    if (state.phase === "applying") {
      return { systemPrompt: `${event.systemPrompt}\n\n${APPLY_REVIEW_SYSTEM_PROMPT}` };
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const state = stateRef.current;
    if (!state?.active) return;
    if (state.phase === "reviewing" || state.phase === "manual" || state.phase === "confirming" || state.phase === "failed") return;

    const assistantTurn = getLastAssistantTurn(event);
    if (!assistantTurn) return;

    if (shouldTreatStopReasonAsFailure(assistantTurn.stopReason)) {
      const phase = state.phase;
      clearState(ctx, stateRef);
      stopStatusTicker();
      ctx.ui.notify(`Review-cycle stopped: ${phase} phase ended with ${assistantTurn.stopReason}`, "warning");
      return;
    }

    if (state.phase === "implementing") {
      state.implementationSummary = truncateMiddle(assistantTurn.text, MAX_IMPLEMENTATION_SUMMARY_CHARS);
      lastRun = makeLastRunFromState(state);
      try {
        await runReviewAndQueueApply(pi, ctx, stateRef, state, getChangeSnapshotImpl, runFreshReviewAgentImpl);
      } catch (error) {
        if (stateRef.current !== state) return;
        markReviewFailure(ctx, state, error);
        stopStatusTicker();
        await writeReviewArtifact(ctx.cwd, state, "review-failed");
        ctx.ui.notify(
          `Review-cycle failed during fresh review: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return;
    }

    if (state.phase === "applying") {
      const beforeApplyFingerprint = changeSnapshotFingerprint(state.lastChanges);
      state.applySummary = truncateMiddle(assistantTurn.text, MAX_IMPLEMENTATION_SUMMARY_CHARS);
      if (state.reviewSummary) updateReviewSummaryWidget(ctx, state.reviewSummary, "apply pass finished", "handled");
      const afterApplyChanges = await getChangeSnapshotImpl(pi, ctx.cwd, state.baseline).catch(() => undefined);
      if (stateRef.current !== state || !state.active || state.phase !== "applying") return;
      const applyMadeNoWorkspaceChanges = !!afterApplyChanges && !!beforeApplyFingerprint && changeSnapshotFingerprint(afterApplyChanges) === beforeApplyFingerprint;
      if (afterApplyChanges) state.lastChanges = afterApplyChanges;

      if (state.autoRerunAfterApply && state.reviewRound < state.maxReviewRounds && applyMadeNoWorkspaceChanges) {
        if (state.reviewSummary) updateReviewSummaryWidget(ctx, state.reviewSummary, "stopped: apply pass made no workspace changes", "handled");
        await writeReviewArtifact(ctx.cwd, state, "stopped-no-change-after-apply");
        if (stateRef.current !== state || !state.active || state.phase !== "applying") return;
        finishState(ctx, stateRef);
        stopStatusTicker();
        ctx.ui.notify("Review-cycle stopped: apply pass made no workspace changes", "warning");
        return;
      }

      await writeReviewArtifact(ctx.cwd, state, "apply-complete");
      if (stateRef.current !== state || !state.active || state.phase !== "applying") return;

      if (state.autoRerunAfterApply && state.reviewRound < state.maxReviewRounds) {
        ctx.ui.notify(`Review-cycle: rerunning fresh review (${state.reviewRound + 1}/${state.maxReviewRounds})`, "info");
        try {
          await runReviewAndQueueApply(pi, ctx, stateRef, state, getChangeSnapshotImpl, runFreshReviewAgentImpl);
        } catch (error) {
          if (stateRef.current !== state) return;
          markReviewFailure(ctx, state, error);
          stopStatusTicker();
          await writeReviewArtifact(ctx.cwd, state, "review-failed");
          ctx.ui.notify(
            `Review-cycle failed during follow-up review: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      finishState(ctx, stateRef);
      stopStatusTicker();
      ctx.ui.notify("Review-cycle completed: feedback application phase finished", "info");
    }
  });
  };
}

export default createReviewCycleExtension();
