import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  truncateEnd,
  truncateMiddle,
  type ChangeSnapshot,
  type GitBaseline,
  type ModelRef,
  type ReviewSummary,
} from "./core.ts";

const GIT_TIMEOUT_MS = 120_000;
const MAX_REVIEWER_STDERR_CHARS = 4_000;
const MAX_IMPLEMENTATION_SUMMARY_CHARS = 8_000;
const STATUS_CARD_WIDGET_KEY = "review-cycle-status-card";
const REVIEWER_OUTPUT_WIDGET_KEY = "review-cycle-reviewer-output";
const HELP_WIDGET_KEY = "review-cycle-help";
const ARTIFACT_WIDGET_KEY = "review-cycle-artifact";
const PREFS_WIDGET_KEY = "review-cycle-prefs";
const CONFIG_DOCTOR_WIDGET_KEY = "review-cycle-config-doctor";
const MAX_REVIEWER_OUTPUT_LINES = 80;
const MAX_REVIEWER_OUTPUT_LINE_CHARS = 240;
const MAX_CHECKLIST_ITEMS = 12;
const STATUS_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_REVIEW_ROUNDS = 2;
const REVIEWER_KILL_GRACE_MS = 5_000;
const FOLLOW_UP_IDLE_RETRY_MS = 50;
const REPLACEMENT_IDLE_TIMEOUT_MS = 10_000;
const MAX_ARTIFACT_LIST_ITEMS = 10;
const REVIEW_CYCLE_CONFIG_PATH = ".pi/review-cycle.json";
const REVIEW_CYCLE_ARTIFACT_DIR = ".pi/review-cycle";
const REVIEW_CYCLE_PREFERENCES_PATH = ".pi/review-cycle/preferences.json";
const STATUS_CARD_LABEL_WIDTH = 9;
const STATUS_CARD_DIVIDER = "─────";
const NO_REVIEWER_TEXT = "Reviewer returned no text.";
const LARGE_REVIEW_FILE_COUNT = 25;
const LARGE_REVIEW_PROMPT_CHARS = 45_000;

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
  reviewStopReason?: string;
  reviewerOutputVisible: boolean;
  statusCardVisible: boolean;
  reviewerOutputCollapsed: boolean;
  reviewerOutputLines: string[];
  reviewerAbortController?: AbortController;
  allowedTestCommands: string[];
  manualApply: boolean;
  autoRerunAfterApply: boolean;
  maxReviewRounds: number;
  reviewRound: number;
  allowDirty: boolean;
  artifactRunPath?: string;
  statusCardAction?: string;
  statusCardChecklistMode?: "pending" | "handled";
}

interface FreshReviewResult {
  text: string;
  exitCode: number;
  stderr: string;
  messages: Message[];
  stopReason?: string;
  streamedText: string;
}

interface AssistantTurn {
  text: string;
  stopReason: string | undefined;
}

interface ReviewCyclePreferences {
  reviewerOutputVisible?: boolean;
  statusCardVisible?: boolean;
  allowedTestCommands?: string[];
}

interface ReviewCycleRepoConfig {
  reviewerModel?: ModelRef;
  tests?: string[];
  manualApply?: boolean;
  autoRerunAfterApply?: boolean;
  maxReviewRounds?: number;
  allowDirty?: boolean;
  reviewerOutputVisible?: boolean;
  statusCardVisible?: boolean;
  ignoredTests?: string[];
}

interface ReviewCycleRunOptions {
  reviewerModel?: ModelRef;
  reviewerModelSource: "command" | "config" | "active";
  testPolicySource: "command" | "config" | "default";
  reviewerOutputVisible: boolean;
  statusCardVisible: boolean;
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
  reviewSummary?: ReviewSummary;
  artifactRunPath?: string;
}

interface ReviewCycleDependencies {
  getGitBaseline?: typeof getGitBaseline;
  getChangeSnapshot?: typeof getChangeSnapshot;
  runFreshReviewAgent?: typeof runFreshReviewAgent;
  replacementIdleTimeoutMs?: number;
}

interface ReviewCyclePanelAction {
  id: string;
  label: string;
  description: string;
  command?: string;
  recommended?: boolean;
}

interface ReviewArtifactEntry {
  index: number;
  path: string;
  fileName: string;
  stage?: string;
  task?: string;
  started?: string;
  verdict?: string;
  findings?: string;
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
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
  if (!state?.active) {
    clearStatusCardWidget(ctx);
    return;
  }

  updateStatusCardWidget(ctx, state);
}

function clearStatusCardWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  ctx.ui.setWidget(STATUS_CARD_WIDGET_KEY, undefined);
}

function clearReviewerOutputWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  ctx.ui.setWidget(REVIEWER_OUTPUT_WIDGET_KEY, undefined);
}

function abortActiveReviewer(state: ReviewCycleState | undefined): void {
  state?.reviewerAbortController?.abort();
}

function clearState(ctx: ExtensionContext | ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): void {
  abortActiveReviewer(stateRef.current);
  if (stateRef.current) stateRef.current.active = false;
  stateRef.current = undefined;
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
  clearStatusCardWidget(ctx);
  clearReviewerOutputWidget(ctx);
}

function finishState(ctx: ExtensionContext | ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): void {
  abortActiveReviewer(stateRef.current);
  if (stateRef.current) stateRef.current.active = false;
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
  clearStatusCardWidget(ctx);
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
  if (!state.reviewerModel) return "active model at review time";
  return `${modelRefToCli(state.reviewerModel)} (${state.reviewerModelSource})`;
}

function formatGitLine(state: ReviewCycleState): string {
  if (!state.baseline.isGitRepo) return "not a git repository";
  const status = state.baseline.dirty ? "dirty" : "clean";
  const head = state.baseline.head ? ` · ${state.baseline.head.slice(0, 12)}` : "";
  return `${status}${head}`;
}

function getDefaultStatusCardAction(state: ReviewCycleState): string {
  switch (state.phase) {
    case "confirming":
      return "/review-cycle continue or /review-cycle abort";
    case "implementing":
      return "waiting for implementation agent to finish";
    case "reviewing":
      return "reviewer running — /review-cycle stop to cancel";
    case "manual":
      return "/review-cycle apply or /review-cycle skip";
    case "applying":
      return "waiting for apply pass to finish";
    case "failed":
      return "/review-cycle retry or /review-cycle stop";
  }
}

function formatStatusCardLabel(label: string, value: string): string {
  return `${`${label}:`.padEnd(STATUS_CARD_LABEL_WIDTH)} ${value}`;
}

function formatFlowLine(state: ReviewCycleState): string {
  const apply = state.manualApply ? "wait for /review-cycle apply" : "auto-apply unless APPROVE";
  const round = `${Math.max(0, state.reviewRound)}/${state.maxReviewRounds}`;
  let rerun = "";
  if (state.autoRerunAfterApply) {
    rerun = ` · round ${round} (rerun until approved)`;
  } else if (state.reviewRound > 0) {
    rerun = ` · round ${round}`;
  }
  return `implement → review → ${apply}${rerun}`;
}

function updateStatusCardWidget(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState): void {
  if (!state.statusCardVisible) {
    clearStatusCardWidget(ctx);
    return;
  }

  const workerLabel = ctx.model ? modelRefToCli(ctx.model) : "selected model";
  const summary = state.reviewSummary;
  const mandatoryFindings = summary?.findings.filter((finding) => finding.mandatory !== false).length ?? 0;
  const warnings = [
    !state.baseline.isGitRepo ? "⚠ git change scoping is degraded" : undefined,
    state.baseline.isGitRepo && state.baseline.dirty ? "⚠ workspace was already dirty before start" : undefined,
    state.lastReviewError ? `⚠ last error: ${truncateMiddle(state.lastReviewError, 700)}` : undefined,
  ].filter((line): line is string => !!line);
  const defaultChecklistMode: "pending" | "handled" = state.phase === "applying" || !state.active ? "handled" : "pending";
  const checklistMode = state.statusCardChecklistMode ?? defaultChecklistMode;
  const verdictLine = summary
    ? `Verdict: ${summary.verdict ?? "UNKNOWN"} · ${summary.findingCount} finding${summary.findingCount === 1 ? "" : "s"} · ${mandatoryFindings} mandatory`
    : undefined;

  const phase = getPhaseStatus(state);
  const lines = [
    "Review-cycle status",
    formatStatusCardLabel("Phase", `Review ${phase.step}/3 ${phase.label}`),
    formatStatusCardLabel("Elapsed", formatElapsed(Date.now() - state.startedAt)),
    formatStatusCardLabel("Task", summarizeTask(state.task, 140)),
    STATUS_CARD_DIVIDER,
    formatStatusCardLabel("Worker", workerLabel),
    formatStatusCardLabel("Reviewer", formatReviewerLabel(state)),
    formatStatusCardLabel("Tests", `${formatTestPolicy(state.allowedTestCommands)} (${state.testPolicySource})`),
    formatStatusCardLabel("Git", formatGitLine(state)),
    formatStatusCardLabel("Flow", formatFlowLine(state)),
    summary ? STATUS_CARD_DIVIDER : undefined,
    verdictLine,
    summary?.reviewDataWarning ? `⚠ ${summary.reviewDataWarning}` : undefined,
    ...(summary ? formatFindingsChecklist(summary, checklistMode) : []),
    STATUS_CARD_DIVIDER,
    state.artifactRunPath ? formatStatusCardLabel("Artifact", state.artifactRunPath) : undefined,
    formatStatusCardLabel("Next", state.statusCardAction ?? getDefaultStatusCardAction(state)),
    ...warnings,
  ].filter((line): line is string => !!line).map((line) => truncateLine(line));

  ctx.ui.setWidget(STATUS_CARD_WIDGET_KEY, lines, { placement: "belowEditor" });
}

function showHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.setWidget(
    HELP_WIDGET_KEY,
    [
      "Review-cycle commands",
      "",
      "Start",
      "  /review-cycle <task>                              start implement → review → apply (replaces active run)",
      "  /rc <task>                                        short alias",
      "  /review-cycle --manual-apply <task>               wait for apply/skip after review",
      "  /review-cycle --until-approved [--max-review-rounds n] <task>",
      "                                                    auto-rerun review after apply",
      "  /review-cycle --allow-dirty <task>                start with dirty workspace",
      "",
      "Control",
      "  /review-cycle continue|abort                      after a dirty-workspace pause",
      "  /review-cycle apply|skip                          finish a manual-apply review",
      "  /review-cycle retry [--reviewer-model provider/model]",
      "                                                    retry a failed reviewer subprocess",
      "  /review-cycle rerun [--reviewer-model provider/model]",
      "                                                    rerun fresh review for the last task",
      "  /review-cycle stop                                cancel the managed workflow",
      "",
      "Inspect",
      "  /review-cycle status                              notify current run status",
      "  /review-cycle status-card off|on|toggle           hide/show main status card (hidden by default)",
      "  /review-cycle panel                               interactive overlay with status details and shortcuts",
      "  /review-cycle output off|on|toggle                hide/show live reviewer log (on expands)",
      "  /review-cycle artifact [show|list|path] [n]       inspect review artifacts",
      "",
      "Config",
      "  /review-cycle prefs status|reset                  inspect/reset persisted UI preferences",
      "  /review-cycle config doctor                       diagnose repo config and preferences",
      "  /review-cycle tests status|set <cmd>|add <cmd>|clear",
      "                                                    configure reviewer test commands",
      "  Repo file: .pi/review-cycle.json",
      "    keys: reviewerModel, tests, manualApply, autoRerunAfterApply, maxReviewRounds, allowDirty, reviewerOutputVisible, statusCardVisible",
    ],
    { placement: "belowEditor" },
  );
  ctx.ui.notify("Review-cycle help shown", "info");
}

function formatFindingsChecklist(summary: ReviewSummary, mode: "pending" | "handled"): string[] {
  if (summary.findings.length === 0) return ["Findings: (none)"];
  const marker = mode === "handled" ? "[x]" : "[ ]";
  const shown = summary.findings.slice(0, MAX_CHECKLIST_ITEMS).map((finding, index) => {
    const severity = finding.severity === "other" ? "finding" : finding.severity.toUpperCase();
    const optional = finding.mandatory === false ? " optional" : "";
    return `${marker} ${index + 1}. ${severity}${optional}: ${truncateLine(finding.text)}`;
  });
  const omitted = summary.findings.length - shown.length;
  return [
    "Findings:",
    ...shown,
    ...(omitted > 0 ? [`… (${omitted} more)`] : []),
  ];
}

function applyReviewAction(
  ctx: ExtensionContext | ExtensionCommandContext,
  state: ReviewCycleState,
  action: string,
  checklistMode: "pending" | "handled",
): void {
  state.statusCardAction = action;
  state.statusCardChecklistMode = checklistMode;
  updateStatusCardWidget(ctx, state);
}

function formatReviewerOutputSummary(state: ReviewCycleState): string[] {
  const summary = state.reviewSummary;
  const lines: string[] = [];
  if (state.lastReviewError) {
    lines.push(`Last reviewer error: ${truncateMiddle(state.lastReviewError, 220)}`);
  }
  if (summary) {
    const mandatoryFindings = summary.findings.filter((finding) => finding.mandatory !== false).length;
    lines.push(`Verdict: ${summary.verdict ?? "UNKNOWN"} · findings ${summary.findingCount} · mandatory ${mandatoryFindings}`);
    if (summary.reviewDataWarning) lines.push(`Warning: ${summary.reviewDataWarning}`);
    for (const finding of summary.findings.slice(0, 3)) {
      const severity = finding.severity === "other" ? "finding" : finding.severity.toUpperCase();
      lines.push(`- ${severity}: ${truncateLine(finding.text)}`);
    }
    if (summary.findings.length > 3) lines.push(`… (${summary.findings.length - 3} more findings)`);
  }
  if (state.artifactRunPath) lines.push(`Artifact: ${state.artifactRunPath}`);
  lines.push("Full reviewer log captured; use /rc output on to expand or /rc output off to hide.");
  return lines;
}

function updateReviewerOutputWidget(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState): void {
  if (!state.reviewerOutputVisible) {
    clearReviewerOutputWidget(ctx);
    return;
  }

  if (state.reviewerOutputCollapsed) {
    const captured = state.reviewerOutputLines.length;
    ctx.ui.setWidget(
      REVIEWER_OUTPUT_WIDGET_KEY,
      [
        `Reviewer output collapsed · ${captured} captured line${captured === 1 ? "" : "s"}`,
        ...formatReviewerOutputSummary(state),
      ],
      { placement: "belowEditor" },
    );
    return;
  }

  const lines = state.reviewerOutputLines.length > 0 ? state.reviewerOutputLines : ["(waiting for reviewer output...)"];
  ctx.ui.setWidget(
    REVIEWER_OUTPUT_WIDGET_KEY,
    [
      `Reviewer output · ${lines.length} line${lines.length === 1 ? "" : "s"} · /rc output off to hide`,
      ...lines,
    ],
    { placement: "belowEditor" },
  );
}

function collapseReviewerOutputWidget(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState): void {
  state.reviewerOutputCollapsed = true;
  updateReviewerOutputWidget(ctx, state);
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

function truncatePanelLine(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function matchesPanelArrowInput(data: string, direction: "up" | "down"): boolean {
  const finalByte = direction === "up" ? "A" : "B";
  const applicationSequence = direction === "up" ? "\u001bOA" : "\u001bOB";
  return data === direction
    || data === `\u001b[${finalByte}`
    || data === applicationSequence
    || new RegExp(`^\\u001b\\[1;\\d+(?::[123])?${finalByte}$`).test(data);
}

function matchesPanelInput(data: string, ...keys: string[]): boolean {
  return keys.some((key) => {
    if (key === "up" || key === "down") return matchesPanelArrowInput(data, key);
    if (key === "home") return data === "home" || data === "\u001b[H" || data === "\u001bOH" || data === "\u001b[1~" || data === "\u001b[7~";
    if (key === "end") return data === "end" || data === "\u001b[F" || data === "\u001bOF" || data === "\u001b[4~" || data === "\u001b[8~";
    if (key === "enter") return data === "enter" || data === "return" || data === "\r" || data === "\n";
    if (key === "escape") return data === "escape" || data === "\u001b";
    return data === key;
  });
}

function buildPanelRunDetails(state: ReviewCycleState): string[] {
  const lines = [
    formatStatusLine(state),
    `Task: ${summarizeTask(state.task, 100)}`,
    `Reviewer: ${formatReviewerLabel(state)}`,
    `Tests: ${formatTestPolicy(state.allowedTestCommands)}`,
    `Git: ${formatGitLine(state)}`,
  ];
  if (state.reviewSummary) {
    const mandatoryFindings = state.reviewSummary.findings.filter((finding) => finding.mandatory !== false).length;
    lines.push(`Review: ${state.reviewSummary.verdict ?? "UNKNOWN"} · findings ${state.reviewSummary.findingCount} · mandatory ${mandatoryFindings}`);
  }
  if (state.lastReviewError) lines.push(`Last error: ${truncateMiddle(state.lastReviewError, 220)}`);
  return lines;
}

function buildPanelIntroLines(state: ReviewCycleState | undefined, lastRun: LastReviewCycleRun | undefined): string[] {
  if (state?.active) {
    return state.statusCardVisible
      ? [
          "Actions for the active review-cycle run.",
          "Run details stay in the status card to avoid duplicated panels.",
        ]
      : [
          "Review status is hidden from the main view. Details are shown here.",
          ...buildPanelRunDetails(state),
        ];
  }
  const lines = ["No active review-cycle run."];
  if (lastRun) {
    lines.push(`Rerun target: ${summarizeTask(lastRun.task, 100)}`);
    if (lastRun.reviewSummary) {
      const mandatoryFindings = lastRun.reviewSummary.findings.filter((finding) => finding.mandatory !== false).length;
      lines.push(`Last review: ${lastRun.reviewSummary.verdict ?? "UNKNOWN"} · findings ${lastRun.reviewSummary.findingCount} · mandatory ${mandatoryFindings}`);
    }
    if (lastRun.artifactRunPath) lines.push(`Last artifact: ${lastRun.artifactRunPath}`);
  } else {
    lines.push("Start with /review-cycle <task>.");
  }
  return lines;
}

function buildOutputPanelAction(state: ReviewCycleState): ReviewCyclePanelAction {
  if (!state.reviewerOutputVisible) {
    return { id: "output-toggle", label: "Show reviewer output", description: "Open the live reviewer log widget", command: "output on" };
  }
  if (state.reviewerOutputCollapsed) {
    return { id: "output-toggle", label: "Expand reviewer output", description: "Show the full captured reviewer log", command: "output on" };
  }
  return { id: "output-toggle", label: "Hide reviewer output", description: "Hide the live reviewer log widget", command: "output off" };
}

function buildPanelActions(state: ReviewCycleState | undefined, lastRun: LastReviewCycleRun | undefined): ReviewCyclePanelAction[] {
  const actions: ReviewCyclePanelAction[] = [];
  const artifactAction: ReviewCyclePanelAction = { id: "artifact", label: "Open latest review artifact", description: "Show saved review details and metadata", command: "artifact" };
  const hasPrimaryArtifact = !!state?.artifactRunPath || !!lastRun?.artifactRunPath;

  if (state?.active) {
    if (state.phase === "confirming") {
      actions.push(
        { id: "continue", label: "Continue with dirty workspace", description: "Start implementation despite pre-existing changes", command: "continue", recommended: true },
        { id: "abort", label: "Abort run", description: "Cancel this paused run", command: "abort" },
      );
    }
    if (state.phase === "manual") {
      actions.push(
        { id: "apply", label: "Apply review feedback", description: "Queue the apply pass", command: "apply", recommended: true },
        { id: "skip", label: "Skip apply pass", description: "Finish this run without applying feedback", command: "skip" },
      );
    }
    if (state.phase === "failed") {
      actions.push({ id: "retry", label: "Retry reviewer", description: "Retry the failed fresh-context reviewer", command: "retry", recommended: true });
    }
    if (hasPrimaryArtifact) actions.push(artifactAction);
    actions.push(
      buildOutputPanelAction(state),
      { id: "stop", label: "Stop run", description: "Cancel the active review-cycle run", command: "stop" },
      { id: "status-toggle", label: state.statusCardVisible ? "Hide review status" : "Show review status", description: "Toggle the main status-card widget", command: "status-card toggle" },
    );
  } else if (lastRun) {
    if (hasPrimaryArtifact) actions.push(artifactAction);
    actions.push({ id: "rerun", label: "Rerun last review", description: "Run a fresh review for the previous task", command: "rerun", recommended: true });
  }

  actions.push(
    ...(hasPrimaryArtifact ? [] : [artifactAction]),
    { id: "artifact-list", label: "List artifact history", description: "Show recent review-cycle runs", command: "artifact list" },
    { id: "artifact-path", label: "Copy/show artifact path", description: "Notify the latest artifact path", command: "artifact path" },
    { id: "close", label: "Close panel", description: "Dismiss this overlay" },
  );
  return actions;
}

class ReviewCyclePanelComponent {
  private selectedIndex = 0;
  private selectionInitialized = false;
  private lastRenderedActionIds: string[] = [];
  private readonly getState: () => ReviewCycleState | undefined;
  private readonly getLastRun: () => LastReviewCycleRun | undefined;
  private readonly getActions: () => readonly ReviewCyclePanelAction[];
  private readonly requestRender: () => void;
  private readonly done: (actionId: string | undefined) => void;

  constructor(
    getState: () => ReviewCycleState | undefined,
    getLastRun: () => LastReviewCycleRun | undefined,
    getActions: () => readonly ReviewCyclePanelAction[],
    requestRender: () => void,
    done: (actionId: string | undefined) => void,
  ) {
    this.getState = getState;
    this.getLastRun = getLastRun;
    this.getActions = getActions;
    this.requestRender = requestRender;
    this.done = done;
  }

  private currentActions(): readonly ReviewCyclePanelAction[] {
    const actions = this.getActions();
    if (!this.selectionInitialized) {
      const recommendedIndex = actions.findIndex((action) => action.recommended);
      if (recommendedIndex >= 0) this.selectedIndex = recommendedIndex;
      this.selectionInitialized = true;
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, actions.length - 1));
    return actions;
  }

  private actionsChangedSinceRender(actions: readonly ReviewCyclePanelAction[]): boolean {
    if (this.lastRenderedActionIds.length !== actions.length) return true;
    return actions.some((action, index) => action.id !== this.lastRenderedActionIds[index]);
  }

  render(width: number): string[] {
    const actions = this.currentActions();
    this.lastRenderedActionIds = actions.map((action) => action.id);
    const safeWidth = Math.max(24, width);
    const innerWidth = Math.max(1, safeWidth - 4);
    const border = `╭${"─".repeat(Math.max(0, safeWidth - 2))}╮`;
    const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`;
    const row = (text = "") => `│ ${truncatePanelLine(text, innerWidth).padEnd(innerWidth, " ")} │`;
    const lines = [
      border,
      row("Review-cycle panel"),
      row("↑↓/j/k navigate wraps • home/end jump • 1-9 run • enter run • esc/q close"),
      row(),
      ...buildPanelIntroLines(this.getState(), this.getLastRun()).map((line) => row(line)),
      row(),
      row("Actions"),
      ...actions.map((action, index) => {
        const marker = index === this.selectedIndex ? "›" : " ";
        const number = index < 9 ? `${index + 1}.` : "  ";
        const recommended = action.recommended ? "★ " : "  ";
        return row(`${marker} ${number} ${recommended}${action.label} — ${action.description}`);
      }),
      bottom,
    ];
    return lines.map((line) => truncatePanelLine(line, safeWidth));
  }

  handleInput(data: string): void {
    const actions = this.currentActions();
    if (matchesPanelInput(data, "escape") || data === "q" || data === "Q") {
      this.done(undefined);
      return;
    }
    if (matchesPanelInput(data, "up") || data === "k" || data === "K") {
      this.selectedIndex = actions.length > 0 ? (this.selectedIndex - 1 + actions.length) % actions.length : 0;
      this.requestRender();
      return;
    }
    if (matchesPanelInput(data, "down") || data === "j" || data === "J") {
      this.selectedIndex = actions.length > 0 ? (this.selectedIndex + 1) % actions.length : 0;
      this.requestRender();
      return;
    }
    if (matchesPanelInput(data, "home")) {
      this.selectedIndex = 0;
      this.requestRender();
      return;
    }
    if (matchesPanelInput(data, "end")) {
      this.selectedIndex = Math.max(0, actions.length - 1);
      this.requestRender();
      return;
    }
    if (/^[1-9]$/.test(data)) {
      const selected = Number(data) - 1;
      if (selected < actions.length) this.done(actions[selected]?.id);
      return;
    }
    if (matchesPanelInput(data, "enter")) {
      if (this.actionsChangedSinceRender(actions)) {
        this.requestRender();
        return;
      }
      this.done(actions[this.selectedIndex]?.id);
    }
  }

  invalidate(): void {}
}

async function showReviewCyclePanel(
  ctx: ExtensionCommandContext,
  getState: () => ReviewCycleState | undefined,
  getLastRun: () => LastReviewCycleRun | undefined,
): Promise<string | undefined> {
  const activeState = getState();
  if (activeState?.active) updateStatusCardWidget(ctx, activeState);
  const custom = (ctx.ui as { custom?: Function }).custom;
  if (typeof custom !== "function") {
    if (activeState?.active) {
      activeState.statusCardVisible = true;
      updateStatusCardWidget(ctx, activeState);
    }
    ctx.ui.notify("Review-cycle panel overlay is not available in this UI; showing the status card instead", "warning");
    return undefined;
  }

  const getActions = () => buildPanelActions(getState(), getLastRun());
  const selectedActionId = await custom.call(
    ctx.ui,
    (tui: { requestRender?: () => void } | undefined, _theme: unknown, _keybindings: unknown, done: (actionId: string | undefined) => void) => new ReviewCyclePanelComponent(
      getState,
      getLastRun,
      getActions,
      () => tui?.requestRender?.(),
      done,
    ),
    {
      overlay: true,
      overlayOptions: {
        width: "72%",
        minWidth: 56,
        maxHeight: "85%",
        anchor: "right-center",
        margin: 1,
      },
    },
  );

  const action = getActions().find((candidate) => candidate.id === selectedActionId);
  if (!action?.command) return undefined;
  ctx.ui.notify(`Review-cycle panel action: ${action.label}`, "info");
  return action.command;
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

function splitGitPathLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueGitPathLines(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

async function getChangeSnapshot(pi: ExtensionAPI, cwd: string, baseline: GitBaseline): Promise<ChangeSnapshot> {
  if (!baseline.isGitRepo) {
    return {
      isGitRepo: false,
      status: "not a git repository",
      diffStat: "",
      diff: "",
      committedChanges: "",
      changedFiles: [],
      untrackedFiles: [],
      notes: ["No git repository was detected."],
    };
  }

  const status = await execText(pi, cwd, "git", ["status", "--short", "--branch", "--untracked-files=all"]);
  const untracked = await execText(pi, cwd, "git", ["ls-files", "--others", "--exclude-standard"]);
  const untrackedFiles = untracked.ok ? splitGitPathLines(untracked.text) : [];
  const notes: string[] = [];

  if (!baseline.head) {
    const stagedStat = await execText(pi, cwd, "git", ["diff", "--cached", "--stat"]);
    const unstagedStat = await execText(pi, cwd, "git", ["diff", "--stat"]);
    const stagedDiff = await execText(pi, cwd, "git", ["diff", "--cached"]);
    const unstagedDiff = await execText(pi, cwd, "git", ["diff"]);
    const stagedNames = await execText(pi, cwd, "git", ["diff", "--cached", "--name-only"]);
    const unstagedNames = await execText(pi, cwd, "git", ["diff", "--name-only"]);
    const changedFiles = uniqueGitPathLines([
      ...(stagedNames.ok ? splitGitPathLines(stagedNames.text) : []),
      ...(unstagedNames.ok ? splitGitPathLines(unstagedNames.text) : []),
      ...untrackedFiles,
    ]);

    return {
      isGitRepo: true,
      status: status.text.trim() || "working tree clean",
      diffStat: [stagedStat.text, unstagedStat.text].filter(Boolean).join("\n\n"),
      diff: [stagedDiff.text, unstagedDiff.text].filter(Boolean).join("\n\n"),
      committedChanges: "",
      changedFiles,
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
  const worktreeChangedNames = await execText(pi, cwd, "git", ["diff", "--name-only", baseline.head, "--"]);
  const indexChangedNames = await execText(pi, cwd, "git", ["diff", "--cached", "--name-only", baseline.head, "--"]);
  const changedFiles = uniqueGitPathLines([
    ...(worktreeChangedNames.ok ? splitGitPathLines(worktreeChangedNames.text) : []),
    ...(indexChangedNames.ok ? splitGitPathLines(indexChangedNames.text) : []),
    ...untrackedFiles,
  ]);

  if (!worktreeDiff.ok) notes.push(`git diff against baseline failed: ${truncateMiddle(worktreeDiff.text, 800)}`);
  if (!indexDiff.ok) notes.push(`git diff --cached against baseline failed: ${truncateMiddle(indexDiff.text, 800)}`);
  if (!worktreeDiffStat.ok) notes.push(`git diff --stat against baseline failed: ${truncateMiddle(worktreeDiffStat.text, 800)}`);
  if (!indexDiffStat.ok) notes.push(`git diff --cached --stat against baseline failed: ${truncateMiddle(indexDiffStat.text, 800)}`);
  if (!worktreeChangedNames.ok) notes.push(`git diff --name-only against baseline failed: ${truncateMiddle(worktreeChangedNames.text, 800)}`);
  if (!indexChangedNames.ok) notes.push(`git diff --cached --name-only against baseline failed: ${truncateMiddle(indexChangedNames.text, 800)}`);

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
    changedFiles,
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
      let streamedAssistantText = "";
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
          if (delta) {
            streamedAssistantText += delta;
            options.onOutput?.(delta);
          }
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
          resolve({ text: finalText, exitCode, stderr, messages, stopReason: getFinalAssistantStopReason(messages), streamedText: streamedAssistantText });
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

function getFinalAssistantStopReason(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    return typeof stopReason === "string" && stopReason ? stopReason : undefined;
  }
  return undefined;
}

function summarizeReviewerStderr(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) return undefined;
  const tail = trimmed.split(/\r?\n/).filter((line) => line.trim()).slice(-5).join(" | ");
  return truncateEnd(tail, 400) || undefined;
}

function buildReviewVerdictError(reviewText: string, result: FreshReviewResult): string {
  const diagnostics: string[] = [];
  if (result.stopReason) diagnostics.push(`stopReason=${result.stopReason}`);
  const stderrSummary = summarizeReviewerStderr(result.stderr);
  if (stderrSummary) diagnostics.push(`stderr=${stderrSummary}`);
  const suffix = diagnostics.length > 0 ? ` (${diagnostics.join("; ")})` : "";
  const lengthHint = result.stopReason === "length"
    ? " The reviewer hit its output token limit; use a dedicated --reviewer-model with more headroom or reduce the review scope."
    : "";

  if (!reviewText) {
    return `Fresh review produced no assistant text${suffix}. The reviewer model may be reasoning-only, may have hit its output limit, or returned an empty response.${lengthHint} Try /review-cycle retry, optionally with a dedicated --reviewer-model.`;
  }

  return `Fresh review output did not include a recognized verdict (APPROVE, APPROVE_WITH_NOTES, or CHANGES_REQUESTED)${suffix}.${lengthHint}`;
}

function countStatusChangedFiles(status: string | undefined): number {
  const trimmedStatus = status?.trim();
  if (
    !trimmedStatus
    || trimmedStatus === "working tree clean"
    || trimmedStatus === "not a git repository"
    || trimmedStatus === "(unknown)"
  ) {
    return 0;
  }

  return trimmedStatus.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("##");
  }).length;
}

function parseDiffStatChangedFileCount(stat: string | undefined): number {
  const matches = [...(stat ?? "").matchAll(/(\d+)\s+files?\s+changed/g)];
  if (matches.length === 0) return 0;
  return Math.max(...matches.map((match) => Number.parseInt(match[1] ?? "0", 10)).filter(Number.isFinite));
}

function countChangedFiles(changes: ChangeSnapshot): number {
  const explicitChangedFiles = Array.isArray(changes.changedFiles)
    ? uniqueGitPathLines(changes.changedFiles.map((file) => file.trim()).filter(Boolean)).length
    : 0;

  return Math.max(
    explicitChangedFiles,
    changes.untrackedFiles.length,
    countStatusChangedFiles(changes.status),
    parseDiffStatChangedFileCount(changes.diffStat),
    parseDiffStatChangedFileCount(changes.committedChanges),
  );
}

function parseConfigBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseConfigPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function loadReviewCyclePreferences(cwd: string): Promise<ReviewCyclePreferences> {
  const path = join(cwd, REVIEW_CYCLE_PREFERENCES_PATH);
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
  return {
    reviewerOutputVisible: parseConfigBoolean(record.reviewerOutputVisible),
    statusCardVisible: parseConfigBoolean(record.statusCardVisible),
  };
}

async function writeReviewCyclePreferences(cwd: string, preferences: ReviewCyclePreferences): Promise<void> {
  const path = join(cwd, REVIEW_CYCLE_PREFERENCES_PATH);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify({
    schemaVersion: 1,
    reviewerOutputVisible: preferences.reviewerOutputVisible,
    statusCardVisible: preferences.statusCardVisible,
  }, null, 2);

  try {
    await mkdir(join(cwd, REVIEW_CYCLE_ARTIFACT_DIR), { recursive: true });
    await writeFile(tmpPath, `${content}\n`, "utf8");
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistReviewCyclePreferences(
  ctx: ExtensionCommandContext | ExtensionContext,
  preferences: ReviewCyclePreferences,
): Promise<void> {
  try {
    await writeReviewCyclePreferences(ctx.cwd, preferences);
  } catch (error) {
    ctx.ui.notify(`Review-cycle preferences were updated for this session but could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

function formatOptionalVisibility(value: boolean | undefined): string {
  return value === undefined ? "unset" : value ? "shown" : "hidden";
}

function formatOptionalBoolean(value: boolean | undefined): string {
  return value === undefined ? "unset" : value ? "true" : "false";
}

async function showReviewCyclePreferencesStatus(
  ctx: ExtensionCommandContext,
  preferences: ReviewCyclePreferences,
  config: ReviewCycleRepoConfig,
  effective: ReviewCycleRunOptions,
): Promise<void> {
  const path = join(ctx.cwd, REVIEW_CYCLE_PREFERENCES_PATH);
  const persisted = await loadReviewCyclePreferences(ctx.cwd);
  const exists = existsSync(path);
  ctx.ui.setWidget(PREFS_WIDGET_KEY, [
    "Review-cycle preferences",
    `File: ${REVIEW_CYCLE_PREFERENCES_PATH} (${exists ? "present" : "absent"})`,
    "",
    `Status card: effective ${formatOptionalVisibility(effective.statusCardVisible)} · session ${formatOptionalVisibility(preferences.statusCardVisible)} · persisted ${formatOptionalVisibility(persisted.statusCardVisible)} · repo ${formatOptionalVisibility(config.statusCardVisible)} · default hidden`,
    `Reviewer output: effective ${formatOptionalVisibility(effective.reviewerOutputVisible)} · session ${formatOptionalVisibility(preferences.reviewerOutputVisible)} · persisted ${formatOptionalVisibility(persisted.reviewerOutputVisible)} · repo ${formatOptionalVisibility(config.reviewerOutputVisible)} · default shown`,
    "",
    "Reset UI preferences: /review-cycle prefs reset",
  ], { placement: "belowEditor" });
  ctx.ui.notify("Review-cycle preferences shown", "info");
}

async function resetReviewCyclePreferences(
  ctx: ExtensionCommandContext,
  preferences: ReviewCyclePreferences,
  config: ReviewCycleRepoConfig,
  state: ReviewCycleState | undefined,
): Promise<void> {
  delete preferences.statusCardVisible;
  delete preferences.reviewerOutputVisible;
  await rm(join(ctx.cwd, REVIEW_CYCLE_PREFERENCES_PATH), { force: true }).catch(() => undefined);

  const effective = resolveRunOptions(preferences, config, {});
  if (state?.active) {
    state.statusCardVisible = effective.statusCardVisible;
    state.reviewerOutputVisible = effective.reviewerOutputVisible;
    updateStatusCardWidget(ctx, state);
    updateReviewerOutputWidget(ctx, state);
  } else {
    clearStatusCardWidget(ctx);
    if (!effective.reviewerOutputVisible) clearReviewerOutputWidget(ctx);
  }

  ctx.ui.notify("Review-cycle preferences reset to repo/default values", "info");
}

interface JsonObjectFileDiagnostic {
  exists: boolean;
  parseError?: string;
  record?: Record<string, unknown>;
}

async function readJsonObjectFile(path: string): Promise<JsonObjectFileDiagnostic> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { exists: false };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { exists: true, parseError: "expected a JSON object" };
    }
    return { exists: true, record: parsed as Record<string, unknown> };
  } catch (error) {
    return { exists: true, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function formatConfigValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function inspectBooleanConfig(record: Record<string, unknown>, key: string, lines: string[]): number {
  if (!(key in record)) return 0;
  if (typeof record[key] === "boolean") {
    lines.push(`✓ ${key}: ${record[key] ? "true" : "false"}`);
    return 0;
  }
  lines.push(`✗ invalid boolean ${key}: expected true/false, got ${formatConfigValue(record[key])}`);
  return 1;
}

async function showReviewCycleConfigDoctor(
  ctx: ExtensionCommandContext,
  preferences: ReviewCyclePreferences,
  config: ReviewCycleRepoConfig,
  effective: ReviewCycleRunOptions,
): Promise<void> {
  const lines: string[] = ["Review-cycle config doctor"];
  let issues = 0;

  const configDiagnostic = await readJsonObjectFile(join(ctx.cwd, REVIEW_CYCLE_CONFIG_PATH));
  lines.push("", `Repo config: ${REVIEW_CYCLE_CONFIG_PATH} (${configDiagnostic.exists ? "found" : "missing"})`);
  if (!configDiagnostic.exists) {
    lines.push("ℹ no repo config; built-in defaults and persisted preferences apply");
  } else if (configDiagnostic.parseError) {
    issues += 1;
    lines.push(`✗ JSON invalid: ${configDiagnostic.parseError}`);
  } else if (configDiagnostic.record) {
    const record = configDiagnostic.record;
    const knownKeys = new Set(["reviewerModel", "tests", "manualApply", "autoRerunAfterApply", "maxReviewRounds", "allowDirty", "reviewerOutputVisible", "statusCardVisible"]);
    const unknownKeys = Object.keys(record).filter((key) => !knownKeys.has(key));
    const reviewerModel = record.reviewerModel;
    if (reviewerModel === undefined) {
      lines.push("✓ reviewerModel: unset (uses active model)");
    } else if (typeof reviewerModel === "string") {
      const parsedReviewerModel = parseModelRef(reviewerModel);
      if (!parsedReviewerModel) {
        issues += 1;
        lines.push(`✗ invalid reviewerModel: expected provider/model, got ${formatConfigValue(reviewerModel)}`);
      } else {
        const reviewerModelError = validateRequestedReviewerModel(ctx, parsedReviewerModel);
        if (reviewerModelError) {
          issues += 1;
          lines.push(`✗ reviewerModel unusable: ${reviewerModelError}`);
        } else {
          lines.push(`✓ reviewerModel: ${reviewerModel}`);
        }
      }
    } else {
      issues += 1;
      lines.push(`✗ invalid reviewerModel: expected provider/model, got ${formatConfigValue(reviewerModel)}`);
    }

    const tests = record.tests;
    if (tests === undefined) {
      lines.push("✓ tests: unset (default safe allowlist)");
    } else if (Array.isArray(tests)) {
      const stringTests = tests.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
      const invalidTestCount = tests.length - stringTests.length;
      const safeTests = stringTests.filter((command) => isReviewerTestCommandAllowed(command, { allowedTestCommands: [command] }));
      const unsafeTests = stringTests.filter((command) => !isReviewerTestCommandAllowed(command, { allowedTestCommands: [command] }));
      lines.push(`✓ tests: ${safeTests.length} safe${invalidTestCount ? `, ${invalidTestCount} invalid entr${invalidTestCount === 1 ? "y" : "ies"}` : ""}${unsafeTests.length ? `, ${unsafeTests.length} unsafe` : ""}`);
      if (unsafeTests.length > 0) {
        issues += unsafeTests.length;
        lines.push(`✗ unsafe tests: ${unsafeTests.join("; ")}`);
      }
      if (invalidTestCount > 0) issues += invalidTestCount;
    } else {
      issues += 1;
      lines.push(`✗ invalid tests: expected string array, got ${formatConfigValue(tests)}`);
    }

    for (const key of ["manualApply", "autoRerunAfterApply", "allowDirty", "reviewerOutputVisible", "statusCardVisible"]) {
      issues += inspectBooleanConfig(record, key, lines);
    }
    if ("maxReviewRounds" in record) {
      const maxReviewRounds = parseConfigPositiveInteger(record.maxReviewRounds);
      if (maxReviewRounds) lines.push(`✓ maxReviewRounds: ${maxReviewRounds}`);
      else {
        issues += 1;
        lines.push(`✗ invalid maxReviewRounds: expected positive integer, got ${formatConfigValue(record.maxReviewRounds)}`);
      }
    }
    if (unknownKeys.length > 0) {
      issues += unknownKeys.length;
      lines.push(`✗ unknown keys: ${unknownKeys.join(", ")}`);
    }
  }

  const prefsDiagnostic = await readJsonObjectFile(join(ctx.cwd, REVIEW_CYCLE_PREFERENCES_PATH));
  lines.push("", `Preferences: ${REVIEW_CYCLE_PREFERENCES_PATH} (${prefsDiagnostic.exists ? "found" : "missing"})`);
  if (!prefsDiagnostic.exists) {
    lines.push("ℹ no persisted UI preferences");
  } else if (prefsDiagnostic.parseError) {
    issues += 1;
    lines.push(`✗ JSON invalid: ${prefsDiagnostic.parseError}`);
  } else if (prefsDiagnostic.record) {
    issues += inspectBooleanConfig(prefsDiagnostic.record, "reviewerOutputVisible", lines);
    issues += inspectBooleanConfig(prefsDiagnostic.record, "statusCardVisible", lines);
  }

  const reviewer = effective.reviewerModel ? `${modelRefToCli(effective.reviewerModel)} (${effective.reviewerModelSource})` : "active model at review time";
  lines.push(
    "",
    "Effective defaults",
    `Reviewer: ${reviewer}`,
    `Tests: ${formatTestPolicy(effective.allowedTestCommands)} (${effective.testPolicySource})`,
    `Status card: ${effective.statusCardVisible ? "shown" : "hidden"}`,
    `Reviewer output: ${effective.reviewerOutputVisible ? "shown" : "hidden"}`,
    `Mode: manualApply=${formatOptionalBoolean(effective.manualApply)}, autoRerunAfterApply=${formatOptionalBoolean(effective.autoRerunAfterApply)}, maxReviewRounds=${effective.maxReviewRounds}, allowDirty=${formatOptionalBoolean(effective.allowDirty)}`,
    "",
    issues === 0 ? "✓ No config problems detected" : `✗ ${issues} config issue${issues === 1 ? "" : "s"} detected`,
  );

  ctx.ui.setWidget(CONFIG_DOCTOR_WIDGET_KEY, lines.map((line) => truncateLine(line)), { placement: "belowEditor" });
  ctx.ui.notify(`Review-cycle config doctor shown${issues === 0 ? "" : `: ${issues} issue${issues === 1 ? "" : "s"}`}`, issues === 0 ? "info" : "warning");
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
    reviewerOutputVisible: parseConfigBoolean(record.reviewerOutputVisible),
    statusCardVisible: parseConfigBoolean(record.statusCardVisible),
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
  const reviewerModel = command.reviewerModel ?? config.reviewerModel;

  let reviewerModelSource: ReviewCycleRunOptions["reviewerModelSource"];
  if (command.reviewerModel) reviewerModelSource = "command";
  else if (config.reviewerModel) reviewerModelSource = "config";
  else reviewerModelSource = "active";

  const commandTests = preferences.allowedTestCommands;
  const configTests = config.tests ?? [];
  let testPolicySource: ReviewCycleRunOptions["testPolicySource"];
  let allowedTestCommands: string[];
  if (commandTests !== undefined) {
    testPolicySource = commandTests.length > 0 ? "command" : "default";
    allowedTestCommands = [...commandTests];
  } else {
    testPolicySource = configTests.length > 0 ? "config" : "default";
    allowedTestCommands = [...configTests];
  }

  return {
    reviewerModel,
    reviewerModelSource,
    testPolicySource,
    reviewerOutputVisible: preferences.reviewerOutputVisible ?? config.reviewerOutputVisible ?? true,
    statusCardVisible: preferences.statusCardVisible ?? config.statusCardVisible ?? false,
    allowedTestCommands,
    manualApply: command.manualApply ?? config.manualApply ?? false,
    autoRerunAfterApply: command.untilApproved ?? config.autoRerunAfterApply ?? false,
    maxReviewRounds: Math.max(1, command.maxReviewRounds ?? config.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS),
    allowDirty: command.allowDirty ?? config.allowDirty ?? false,
  };
}

function formatArtifactTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatArtifactSummary(state: ReviewCycleState, stage: string): string {
  const summary = state.reviewSummary;
  const started = new Date(state.startedAt).toISOString();
  const metadata = JSON.stringify({
    schemaVersion: 1,
    stage,
    task: state.task,
    started,
    verdict: summary?.verdict ?? null,
    findings: summary?.findingCount ?? 0,
    stopReason: state.reviewStopReason ?? null,
  }, null, 2);
  const findings = summary?.findings.length
    ? summary.findings.map((finding, index) => `- [ ] ${index + 1}. ${finding.severity.toUpperCase()}: ${finding.text}`).join("\n")
    : "(none)";
  return [
    `# Review-cycle run ${state.runId}`,
    `Stage: ${stage}`,
    `Task: ${summarizeTask(state.task, 180)}`,
    `Started: ${started}`,
    `Reviewer: ${formatReviewerLabel(state)}`,
    `Tests: ${formatTestPolicy(state.allowedTestCommands)}`,
    `Mode: manualApply=${state.manualApply}, autoRerunAfterApply=${state.autoRerunAfterApply}, maxReviewRounds=${state.maxReviewRounds}`,
    "",
    "## Artifact metadata",
    "```json",
    metadata,
    "```",
    "",
    "## Original task",
    "```text",
    state.task,
    "```",
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
    state.lastReviewError && state.reviewerOutputLines.length > 0
      ? `\n## Reviewer log (captured)\n\`\`\`text\n${truncateMiddle(state.reviewerOutputLines.join("\n"), 8_000)}\n\`\`\``
      : undefined,
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

function getArtifactMarkdownSection(content: string, title: string): string | undefined {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`##\\s+${escapedTitle}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`, "i").exec(content)?.[1];
}

function parseArtifactMetadata(content: string): Partial<ReviewArtifactEntry> | undefined {
  const section = getArtifactMarkdownSection(content, "Artifact metadata");
  if (!section) return undefined;
  const raw = /(?:```|~~~)(?:json)?\s*\n([\s\S]*?)\n(?:```|~~~)/i.exec(section)?.[1]?.trim() ?? section.trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;

  let findings: string | undefined;
  if (typeof record.findings === "number" && Number.isFinite(record.findings)) {
    findings = String(record.findings);
  } else if (typeof record.findings === "string") {
    findings = record.findings;
  }
  return {
    stage: typeof record.stage === "string" ? record.stage : undefined,
    task: typeof record.task === "string" ? record.task : undefined,
    started: typeof record.started === "string" ? record.started : undefined,
    verdict: typeof record.verdict === "string" ? record.verdict : undefined,
    findings,
  };
}

function parseArtifactEntry(content: string, path: string, index: number): ReviewArtifactEntry {
  const header = content.split(/\n##\s+/)[0] ?? content;
  const reviewSummary = getArtifactMarkdownSection(content, "Review summary") ?? "";
  const lineValue = (body: string, pattern: RegExp) => pattern.exec(body)?.[1]?.trim();
  const metadata = parseArtifactMetadata(content) ?? {};
  return {
    index,
    path,
    fileName: basename(path),
    stage: metadata.stage ?? lineValue(header, /^Stage:\s*(.+)$/m),
    task: metadata.task ?? lineValue(header, /^Task:\s*(.+)$/m),
    started: metadata.started ?? lineValue(header, /^Started:\s*(.+)$/m),
    verdict: metadata.verdict ?? lineValue(reviewSummary, /^- verdict:\s*(.+)$/m),
    findings: metadata.findings ?? lineValue(reviewSummary, /^- findings:\s*(.+)$/m),
  };
}

async function listReviewArtifactRunPaths(cwd: string): Promise<string[]> {
  const runsDir = join(cwd, REVIEW_CYCLE_ARTIFACT_DIR, "runs");
  const names = await readdir(runsDir).catch(() => []);
  return names
    .filter((name) => name.endsWith(".md"))
    .sort((left, right) => right.localeCompare(left))
    .map((name) => join(runsDir, name));
}

async function readReviewArtifactEntries(cwd: string, limit = MAX_ARTIFACT_LIST_ITEMS): Promise<ReviewArtifactEntry[]> {
  const paths = (await listReviewArtifactRunPaths(cwd)).slice(0, limit);
  return await Promise.all(paths.map(async (path, index) => {
    const content = await readFile(path, "utf8").catch(() => "");
    return parseArtifactEntry(content, path, index + 1);
  }));
}

async function resolveReviewArtifactPath(cwd: string, runIndex: number | undefined): Promise<string | undefined> {
  if (!runIndex) return join(cwd, REVIEW_CYCLE_ARTIFACT_DIR, "latest.md");
  return (await listReviewArtifactRunPaths(cwd))[runIndex - 1];
}

function formatArtifactListLine(entry: ReviewArtifactEntry): string {
  const started = entry.started ? entry.started.replace(/T/, " ").replace(/\.\d{3}Z$/, "Z") : entry.fileName;
  const verdict = entry.verdict && entry.verdict !== "(none)" ? entry.verdict : "no verdict";
  const findings = entry.findings ?? "0";
  const task = entry.task ? summarizeTask(entry.task, 80) : "(unknown task)";
  return `${entry.index}. ${started} · ${entry.stage ?? "unknown stage"} · ${verdict} · findings ${findings} · ${task}`;
}

async function showReviewArtifactList(ctx: ExtensionCommandContext): Promise<void> {
  const entries = await readReviewArtifactEntries(ctx.cwd);
  if (entries.length === 0) {
    ctx.ui.notify("No review-cycle artifacts found yet", "info");
    return;
  }

  const total = (await listReviewArtifactRunPaths(ctx.cwd)).length;
  ctx.ui.setWidget(
    ARTIFACT_WIDGET_KEY,
    [
      "Review-cycle artifact history",
      "Newest first. Use /review-cycle artifact show <n> or /review-cycle artifact path <n>.",
      ...entries.map(formatArtifactListLine),
      ...(total > entries.length ? [`… (${total - entries.length} older artifacts not shown)`] : []),
    ].map((line) => truncateLine(line)),
    { placement: "belowEditor" },
  );
  ctx.ui.notify("Review-cycle artifact history shown", "info");
}

async function showReviewArtifact(ctx: ExtensionCommandContext, action: "show" | "path" | "list", runIndex?: number): Promise<void> {
  if (action === "list") {
    await showReviewArtifactList(ctx);
    return;
  }

  const artifactPath = await resolveReviewArtifactPath(ctx.cwd, runIndex);
  if (!artifactPath) {
    ctx.ui.notify(`No review-cycle artifact #${runIndex} found`, "info");
    return;
  }

  const label = runIndex ? `Review-cycle artifact #${runIndex}` : "Review-cycle latest artifact";
  if (action === "path") {
    ctx.ui.notify(`${label}: ${artifactPath}`, "info");
    return;
  }

  let content: string;
  try {
    content = await readFile(artifactPath, "utf8");
  } catch {
    ctx.ui.notify(runIndex ? `No review-cycle artifact #${runIndex} found` : "No review-cycle artifact found yet", "info");
    return;
  }

  ctx.ui.setWidget(
    ARTIFACT_WIDGET_KEY,
    [label, `Path: ${artifactPath}`, ...truncateMiddle(content, 6_000).split(/\r?\n/)],
    { placement: "belowEditor" },
  );
  ctx.ui.notify(`${label} shown`, "info");
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

function sendFollowUpUserMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  content: string,
  shouldSend?: () => boolean,
): void {
  const sendWhenIdle = () => {
    if (shouldSend && !shouldSend()) return;

    if (!ctx.isIdle()) {
      setTimeout(sendWhenIdle, FOLLOW_UP_IDLE_RETRY_MS);
      return;
    }

    pi.sendUserMessage(content, { deliverAs: "followUp" });
  };

  // agent_end handlers run before the underlying AgentSession is fully idle.
  // Wait until idle so the apply prompt starts a real next turn instead of
  // being queued after the final follow-up poll and left stranded.
  if (!ctx.isIdle()) {
    setTimeout(sendWhenIdle, 0);
    return;
  }

  sendWhenIdle();
}

function validateReviewCycleStartOptions(
  ctx: ExtensionContext | ExtensionCommandContext,
  reviewerModel: ModelRef | undefined,
): string | undefined {
  if (!ctx.model) return "No model selected";
  if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
    return `No configured auth for ${ctx.model.provider}/${ctx.model.id}`;
  }
  return validateRequestedReviewerModel(ctx, reviewerModel);
}

async function stopActiveReviewCycleForReplacement(
  ctx: ExtensionCommandContext,
  stateRef: { current?: ReviewCycleState },
  stopStatusTicker: () => void,
  nextTask: string,
  idleTimeoutMs: number,
): Promise<boolean> {
  const activeState = stateRef.current;
  if (!activeState?.active) return true;

  const previousPhase = activeState.phase;
  const previousTask = summarizeTask(activeState.task, 48);
  const shouldAbortMainAgent = previousPhase === "implementing" || previousPhase === "applying";
  const stillBusyMessage = "Review-cycle: stopped the active run, but the agent is still busy. Wait until idle before starting the new run.";

  clearState(ctx, stateRef);
  stopStatusTicker();

  if (!ctx.isIdle()) {
    if (shouldAbortMainAgent) ctx.abort();

    const waitForIdle = (ctx as ExtensionCommandContext & { waitForIdle?: () => Promise<void> | void }).waitForIdle;
    if (typeof waitForIdle !== "function") {
      ctx.ui.notify(stillBusyMessage, "warning");
      return false;
    }

    try {
      await waitForIdleWithTimeout(waitForIdle.call(ctx), idleTimeoutMs);
    } catch (error) {
      if (error instanceof ReplacementIdleTimeoutError) {
        ctx.ui.notify(stillBusyMessage, "warning");
        return false;
      }
      ctx.ui.notify(`Review-cycle: stopped the active run, but waiting for idle failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  }

  if (!ctx.isIdle()) {
    ctx.ui.notify(stillBusyMessage, "warning");
    return false;
  }

  ctx.ui.notify(`Review-cycle: stopped active ${previousPhase} run (${previousTask}) to start ${summarizeTask(nextTask, 48)}`, "info");
  return true;
}

class ReplacementIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the agent to become idle`);
    this.name = "ReplacementIdleTimeoutError";
  }
}

async function waitForIdleWithTimeout(idle: Promise<void> | void, timeoutMs: number): Promise<void> {
  if (!(idle instanceof Promise)) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    // This timer settles an awaited operation, so it must remain referenced even
    // when no TUI handle is keeping the event loop alive (for example in CI).
    timer = setTimeout(() => reject(new ReplacementIdleTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    await Promise.race([idle, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  const startOptionsError = validateReviewCycleStartOptions(ctx, options.reviewerModel);
  if (startOptionsError) {
    ctx.ui.notify(startOptionsError, "error");
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
    statusCardVisible: options.statusCardVisible,
    reviewerOutputCollapsed: false,
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

  if (!pi.getSessionName()) {
    pi.setSessionName(`Review: ${summarizeTask(task, 56)}`);
  }

  if (!baseline.isGitRepo) {
    ctx.ui.notify("Review-cycle started without git; review scope will be degraded.", "warning");
  } else if (baseline.dirty && !options.allowDirty) {
    ctx.ui.notify("Review-cycle paused: workspace already dirty. Use /review-cycle continue or /review-cycle abort.", "warning");
    return;
  } else if (baseline.dirty) {
    ctx.ui.notify("Review-cycle started with pre-existing git changes because dirty runs are allowed for this run.", "warning");
  }

  ctx.ui.notify(
    state.statusCardVisible
      ? "Review-cycle started: implementation phase"
      : "Review-cycle started: implementation phase · details in /review-cycle panel",
    "info",
  );
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
  state.reviewStopReason = undefined;
  state.review = undefined;
  state.reviewSummary = undefined;
  state.statusCardAction = undefined;
  state.statusCardChecklistMode = undefined;
  state.reviewRound += 1;
  state.reviewerOutputCollapsed = false;
  state.reviewerOutputLines = [];
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

  const changedFileCount = countChangedFiles(changes);
  if (changedFileCount >= LARGE_REVIEW_FILE_COUNT || reviewerPrompt.length >= LARGE_REVIEW_PROMPT_CHARS) {
    ctx.ui.notify(
      `Review-cycle: large review scope (${changedFileCount} file${changedFileCount === 1 ? "" : "s"}, ~${Math.round(reviewerPrompt.length / 1000)} KB prompt). If the reviewer returns no text, use a dedicated --reviewer-model or reduce the scope.`,
      "warning",
    );
  }

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

  const reviewText = result.text.trim() || (result.streamedText ?? "").trim();
  state.review = reviewText || NO_REVIEWER_TEXT;
  state.reviewStopReason = result.stopReason;
  appendReviewerOutputLineAndRender(ctx, state, "Fresh-context reviewer finished.");
  const summary = parseReviewSummary(state.review);
  state.reviewSummary = summary;
  collapseReviewerOutputWidget(ctx, state);
  if (!summary.verdict) {
    throw new Error(buildReviewVerdictError(reviewText, result));
  }

  await writeReviewArtifact(ctx.cwd, state, "review-complete");
  if (stateRef.current !== state || !state.active || state.phase !== "reviewing") return;

  if (summary.verdict === "APPROVE") {
    applyReviewAction(ctx, state, "done; no apply pass needed", "handled");
    finishState(ctx, stateRef);
    ctx.ui.notify("Review-cycle: reviewer approved; no apply pass needed", "info");
    return;
  }

  if (state.manualApply) {
    applyReviewAction(ctx, state, "waiting for /review-cycle apply or /review-cycle skip", "pending");
    state.phase = "manual";
    setStatus(ctx, state);
    ctx.ui.notify("Review-cycle: review complete; waiting for /review-cycle apply or /review-cycle skip", "info");
    return;
  }

  applyReviewAction(ctx, state, "applying feedback", "pending");
  state.phase = "applying";
  setStatus(ctx, state);
  ctx.ui.notify("Review-cycle: fresh review complete; applying feedback", "info");

  sendFollowUpUserMessage(
    pi,
    ctx,
    buildApplyReviewPrompt({ task: state.task, review: state.review }),
    () => stateRef.current === state && state.active && state.phase === "applying",
  );
}

function queueManualApply(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: ReviewCycleState): void {
  if (state.phase !== "manual" || !state.review) {
    ctx.ui.notify("No manual review feedback is waiting to apply", "info");
    return;
  }
  state.phase = "applying";
  setStatus(ctx, state);
  if (state.reviewSummary) applyReviewAction(ctx, state, "applying feedback", "pending");
  ctx.ui.notify("Review-cycle: applying manually approved review feedback", "info");
  pi.sendUserMessage(buildApplyReviewPrompt({ task: state.task, review: state.review }), { deliverAs: "followUp" });
}

async function skipManualApply(ctx: ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): Promise<void> {
  const state = stateRef.current;
  if (!state?.active || state.phase !== "manual") {
    ctx.ui.notify("No manual review feedback is waiting to skip", "info");
    return;
  }
  if (state.reviewSummary) applyReviewAction(ctx, state, "skipped by user", "handled");
  await writeReviewArtifact(ctx.cwd, state, "manual-apply-skipped");
  if (stateRef.current !== state || !state.active || state.phase !== "manual") return;
  finishState(ctx, stateRef);
  ctx.ui.notify("Review-cycle completed: manual apply skipped", "info");
}

function markReviewFailure(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState, error: unknown): void {
  state.phase = "failed";
  state.lastReviewError = error instanceof Error ? error.message : String(error);
  state.reviewRound = Math.max(0, state.reviewRound - 1);
  state.reviewerOutputCollapsed = true;
  updateReviewerOutputWidget(ctx, state);
  applyReviewAction(ctx, state, "/review-cycle retry or /review-cycle stop", "pending");
  setStatus(ctx, state);
}

function makeLastRunFromState(state: ReviewCycleState): LastReviewCycleRun {
  return {
    task: state.task,
    baseline: state.baseline,
    reviewerModel: state.reviewerModel,
    implementationSummary: state.implementationSummary,
    reviewSummary: state.reviewSummary,
    artifactRunPath: state.artifactRunPath,
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
): Promise<LastReviewCycleRun | undefined> {
  if (stateRef.current?.active) {
    ctx.ui.notify("A review-cycle run is already active. Use /review-cycle stop first.", "warning");
    return undefined;
  }
  if (!lastRun) {
    ctx.ui.notify("No previous review-cycle run to rerun", "warning");
    return undefined;
  }

  const state: ReviewCycleState = {
    active: true,
    phase: "reviewing",
    runId: makeRunId(),
    task: lastRun.task,
    startedAt: Date.now(),
    baseline: lastRun.baseline,
    reviewerModel: reviewerModelOverride ?? lastRun.reviewerModel ?? options.reviewerModel,
    reviewerModelSource: reviewerModelOverride || lastRun.reviewerModel ? "command" : options.reviewerModelSource,
    testPolicySource: options.testPolicySource,
    implementationSummary: lastRun.implementationSummary,
    reviewerOutputVisible: options.reviewerOutputVisible,
    statusCardVisible: options.statusCardVisible,
    reviewerOutputCollapsed: false,
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
    return makeLastRunFromState(state);
  } catch (error) {
    if (stateRef.current !== state) return undefined;
    markReviewFailure(ctx, state, error);
    await writeReviewArtifact(ctx.cwd, state, "review-failed");
    ctx.ui.notify(`Review-cycle rerun failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return makeLastRunFromState(state);
  }
}

function showStatus(
  ctx: ExtensionCommandContext,
  state: ReviewCycleState | undefined,
  defaults: ReviewCycleRunOptions,
): void {
  if (!state?.active) {
    const reviewer = defaults.reviewerModel ? `${modelRefToCli(defaults.reviewerModel)} (${defaults.reviewerModelSource})` : "active model at review time";
    ctx.ui.notify(
      `No active review-cycle run · defaults: reviewer=${reviewer}, tests=${formatTestPolicy(defaults.allowedTestCommands)}, status-card=${defaults.statusCardVisible ? "shown" : "hidden"}, reviewer-output=${defaults.reviewerOutputVisible ? "shown" : "hidden"}, manualApply=${defaults.manualApply}, autoRerun=${defaults.autoRerunAfterApply}, maxRounds=${defaults.maxReviewRounds}, allowDirty=${defaults.allowDirty} · panel=/review-cycle panel`,
      "info",
    );
    return;
  }

  const reviewer = `reviewer=${formatReviewerLabel(state)}`;
  const tests = `tests=${formatTestPolicy(state.allowedTestCommands)}`;
  const card = `status-card=${state.statusCardVisible ? "shown" : "hidden"}`;
  const output = `reviewer-output=${state.reviewerOutputVisible ? (state.reviewerOutputCollapsed ? "collapsed" : "shown") : "hidden"}`;
  ctx.ui.notify(
    `${formatStatusLine(state)} · ${reviewer} · ${tests} · ${card} · ${output} · panel=/review-cycle panel`,
    "info",
  );
}

export function createReviewCycleExtension(deps: ReviewCycleDependencies = {}) {
  return function (pi: ExtensionAPI) {
  const stateRef: { current?: ReviewCycleState } = {};
  const preferences: ReviewCyclePreferences = {};
  let preferencesLoaded = false;
  let lastRun: LastReviewCycleRun | undefined;
  let statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const getGitBaselineImpl = deps.getGitBaseline ?? getGitBaseline;
  const getChangeSnapshotImpl = deps.getChangeSnapshot ?? getChangeSnapshot;
  const runFreshReviewAgentImpl = deps.runFreshReviewAgent ?? runFreshReviewAgent;
  const replacementIdleTimeoutMs = deps.replacementIdleTimeoutMs ?? REPLACEMENT_IDLE_TIMEOUT_MS;

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

  const ensurePreferencesLoaded = async (cwd: string) => {
    if (preferencesLoaded) return;
    const persistedPreferences = await loadReviewCyclePreferences(cwd);
    preferences.reviewerOutputVisible ??= persistedPreferences.reviewerOutputVisible;
    preferences.statusCardVisible ??= persistedPreferences.statusCardVisible;
    preferencesLoaded = true;
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
      await ensurePreferencesLoaded(ctx.cwd);
      notifyConfigWarnings(ctx, repoConfig);

      if (parsed.kind === "help") {
        showHelp(ctx);
        return;
      }

      if (parsed.kind === "panel") {
        const panelCommand = await showReviewCyclePanel(ctx, () => stateRef.current, () => lastRun);
        if (panelCommand) await handleReviewCycleCommand(panelCommand, ctx);
        return;
      }

      if (parsed.kind === "status") {
        showStatus(ctx, stateRef.current, resolveRunOptions(preferences, repoConfig, {}));
        return;
      }

      if (parsed.kind === "prefs") {
        if (parsed.action === "status") {
          await showReviewCyclePreferencesStatus(ctx, preferences, repoConfig, resolveRunOptions(preferences, repoConfig, {}));
        } else {
          await resetReviewCyclePreferences(ctx, preferences, repoConfig, stateRef.current);
        }
        return;
      }

      if (parsed.kind === "config") {
        await showReviewCycleConfigDoctor(ctx, preferences, repoConfig, resolveRunOptions(preferences, repoConfig, {}));
        return;
      }

      if (parsed.kind === "status-card") {
        const currentVisible = stateRef.current?.statusCardVisible ?? preferences.statusCardVisible ?? repoConfig.statusCardVisible ?? false;
        const nextVisible = parsed.mode === "toggle" ? !currentVisible : parsed.mode === "on";
        preferences.statusCardVisible = nextVisible;
        await persistReviewCyclePreferences(ctx, preferences);
        if (stateRef.current) {
          stateRef.current.statusCardVisible = nextVisible;
          updateStatusCardWidget(ctx, stateRef.current);
        } else if (!nextVisible) {
          clearStatusCardWidget(ctx);
        }
        ctx.ui.notify(`Review-cycle status card ${nextVisible ? "shown" : "hidden"}`, "info");
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
        const state = stateRef.current;
        await skipManualApply(ctx, stateRef);
        if (state) lastRun = makeLastRunFromState(state);
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
          lastRun = makeLastRunFromState(state);
        } catch (error) {
          if (stateRef.current !== state) return;
          markReviewFailure(ctx, state, error);
          stopStatusTicker();
          await writeReviewArtifact(ctx.cwd, state, "review-failed");
          lastRun = makeLastRunFromState(state);
          ctx.ui.notify(`Review-cycle retry failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (parsed.kind === "artifact") {
        await showReviewArtifact(ctx, parsed.action, parsed.runIndex);
        return;
      }

      if (parsed.kind === "rerun") {
        const reviewerModelError = validateRequestedReviewerModel(ctx, parsed.reviewerModel);
        if (reviewerModelError) {
          ctx.ui.notify(reviewerModelError, "error");
          return;
        }
        const runOptions = resolveRunOptions(preferences, repoConfig, { reviewerModel: parsed.reviewerModel });
        const rerunLastRun = await rerunReviewCycle(
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
        if (rerunLastRun) lastRun = rerunLastRun;
        if (!stateRef.current?.active || stateRef.current.phase === "failed") stopStatusTicker();
        return;
      }

      if (parsed.kind === "tests") {
        switch (parsed.action) {
          case "show": {
            const activeCommands = preferences.allowedTestCommands ?? repoConfig.tests ?? [];
            ctx.ui.notify(`Review-cycle test commands: ${formatTestPolicy(activeCommands)}`, "info");
            return;
          }
          case "clear":
            preferences.allowedTestCommands = [];
            ctx.ui.notify("Review-cycle test commands reset to default safe allowlist", "info");
            return;
          case "add":
          case "set": {
            const command = parsed.command;
            if (!isReviewerTestCommandAllowed(command, { allowedTestCommands: [command] })) {
              ctx.ui.notify(`Unsafe reviewer test command rejected: ${command}`, "warning");
              return;
            }
            const currentConfigured = preferences.allowedTestCommands ?? repoConfig.tests ?? [];
            preferences.allowedTestCommands = parsed.action === "set"
              ? [command]
              : [...currentConfigured, command];
            ctx.ui.notify(`Review-cycle test command ${parsed.action === "set" ? "set" : "added"}: ${command}`, "info");
            return;
          }
        }
      }

      if (parsed.kind === "output") {
        const currentVisible = stateRef.current?.reviewerOutputVisible ?? preferences.reviewerOutputVisible ?? repoConfig.reviewerOutputVisible ?? true;
        const nextVisible = parsed.mode === "toggle" ? !currentVisible : parsed.mode === "on";
        preferences.reviewerOutputVisible = nextVisible;
        await persistReviewCyclePreferences(ctx, preferences);
        if (stateRef.current) {
          stateRef.current.reviewerOutputVisible = nextVisible;
          if (nextVisible && parsed.mode === "on") stateRef.current.reviewerOutputCollapsed = false;
          if (nextVisible && parsed.mode === "toggle" && !currentVisible) stateRef.current.reviewerOutputCollapsed = false;
          updateReviewerOutputWidget(ctx, stateRef.current);
        } else if (!nextVisible) {
          clearReviewerOutputWidget(ctx);
        }
        ctx.ui.notify(`Review-cycle reviewer output ${nextVisible ? "shown" : "hidden"}`, "info");
        return;
      }

      const runOptions = resolveRunOptions(preferences, repoConfig, parsed);
      const replacingActiveRun = !!stateRef.current?.active;
      if (replacingActiveRun) {
        const startOptionsError = validateReviewCycleStartOptions(ctx, runOptions.reviewerModel);
        if (startOptionsError) {
          ctx.ui.notify(startOptionsError, "error");
          return;
        }
        const stopped = await stopActiveReviewCycleForReplacement(ctx, stateRef, stopStatusTicker, parsed.task, replacementIdleTimeoutMs);
        if (!stopped) return;
      }

      await startReviewCycle(
        pi,
        ctx,
        stateRef,
        getGitBaselineImpl,
        parsed.task,
        replacingActiveRun ? { ...runOptions, allowDirty: true } : runOptions,
      );
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
    await ensurePreferencesLoaded(ctx.cwd);
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
        lastRun = makeLastRunFromState(state);
      } catch (error) {
        if (stateRef.current !== state) return;
        markReviewFailure(ctx, state, error);
        stopStatusTicker();
        await writeReviewArtifact(ctx.cwd, state, "review-failed");
        lastRun = makeLastRunFromState(state);
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
      if (state.reviewSummary) applyReviewAction(ctx, state, "apply pass finished", "handled");
      const afterApplyChanges = await getChangeSnapshotImpl(pi, ctx.cwd, state.baseline).catch(() => undefined);
      if (stateRef.current !== state || !state.active || state.phase !== "applying") return;
      const applyMadeNoWorkspaceChanges = !!afterApplyChanges && !!beforeApplyFingerprint && changeSnapshotFingerprint(afterApplyChanges) === beforeApplyFingerprint;
      if (afterApplyChanges) state.lastChanges = afterApplyChanges;

      if (state.autoRerunAfterApply && state.reviewRound < state.maxReviewRounds && applyMadeNoWorkspaceChanges) {
        if (state.reviewSummary) applyReviewAction(ctx, state, "stopped: apply pass made no workspace changes", "handled");
        await writeReviewArtifact(ctx.cwd, state, "stopped-no-change-after-apply");
        if (stateRef.current !== state || !state.active || state.phase !== "applying") return;
        lastRun = makeLastRunFromState(state);
        finishState(ctx, stateRef);
        stopStatusTicker();
        ctx.ui.notify("Review-cycle stopped: apply pass made no workspace changes", "warning");
        return;
      }

      await writeReviewArtifact(ctx.cwd, state, "apply-complete");
      if (stateRef.current !== state || !state.active || state.phase !== "applying") return;
      lastRun = makeLastRunFromState(state);

      if (state.autoRerunAfterApply && state.reviewRound < state.maxReviewRounds) {
        ctx.ui.notify(`Review-cycle: rerunning fresh review (${state.reviewRound + 1}/${state.maxReviewRounds})`, "info");
        try {
          await runReviewAndQueueApply(pi, ctx, stateRef, state, getChangeSnapshotImpl, runFreshReviewAgentImpl);
          lastRun = makeLastRunFromState(state);
        } catch (error) {
          if (stateRef.current !== state) return;
          markReviewFailure(ctx, state, error);
          stopStatusTicker();
          await writeReviewArtifact(ctx.cwd, state, "review-failed");
          lastRun = makeLastRunFromState(state);
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
