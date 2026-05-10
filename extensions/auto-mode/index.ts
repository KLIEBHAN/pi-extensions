import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
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
const CONTROLLER_DECISION_TIMEOUT_MS = 120_000;
const VERIFY_COMMAND_TIMEOUT_MS = 600_000;
const MAX_UNTRACKED_CONTENT_HASH_FILES = 100;
const MAX_UNTRACKED_CONTENT_HASH_BYTES = 5 * 1024 * 1024;
const MAX_UNTRACKED_CONTENT_HASH_PATH_CHARS = 32_000;
const MAX_UNTRACKED_METADATA_FILES = 2_000;
const MAX_TRACKED_CONTENT_HASH_FILES = 100;
const MAX_TRACKED_CONTENT_HASH_BYTES = 5 * 1024 * 1024;
const MAX_TRACKED_CONTENT_HASH_PATH_CHARS = 32_000;
const MAX_TRACKED_METADATA_FILES = 2_000;
const MAX_CONTROLLER_ASSISTANT_TEXT_CHARS = 6_000;
const MAX_CONTROLLER_PROMPT_FIELD_CHARS = 4_000;
const MAX_CONTROLLER_REASON_CHARS = 1_500;
const MAX_CONTROLLER_FINAL_MESSAGE_CHARS = 2_000;
const MAX_HISTORY_REASON_CHARS = 400;
const MAX_HISTORY_PROMPT_CHARS = 600;
const MAX_GIT_STATUS_CHARS = 3_000;
const MAX_GIT_CHANGED_FILES_DISPLAY = 80;
const MAX_GIT_CHANGED_FILES_STATE = 200;
const COMMAND_USAGE =
  "Usage: /auto on [--iterations N] [--until \"completion gate\"] [--controller-model provider/model] [--verify \"cmd\"] [--assurance pragmatic|strict] <goal>";

const AUTO_CONTROLLER_SYSTEM_PROMPT = buildAutoControllerSystemPrompt();

interface GitSnapshot {
  isGitRepo: boolean;
  head?: string;
  status: string;
  changedFiles: string[];
  changedFileCount?: number;
  untrackedFileCount?: number;
  dirty: boolean;
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
  repoFingerprint: string;
}

interface FileFingerprint {
  fingerprint: string;
  total: number;
  samplePaths: string[];
  mode: "none" | "content" | "metadata" | "path-only";
}

interface ParsedPathList {
  paths: string[];
  total: number;
  truncated: boolean;
  rawHash: string;
}

interface ParsedGitStatusV2 {
  head?: string;
  branchHead?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  statusLines: string[];
  trackedPaths: string[];
  untrackedPaths: string[];
  unknownRecords: string[];
}

interface GitFinalizationSnapshot {
  dirty: boolean;
  hasUpstream: boolean;
  ahead?: number;
  behind?: number;
}

interface UntrackedFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
  isSymbolicLink: boolean;
}

interface VerifyCommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecLikeResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
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
  getGitFinalizationSnapshot?: typeof getGitFinalizationSnapshot;
  decideControllerAction?: typeof decideControllerAction;
  runVerifyCommand?: typeof runVerifyCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): number {
  return Date.now();
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";

  const omitted = text.length - maxChars;
  const marker = `\n… [${omitted} chars omitted] …\n`;
  if (marker.length >= maxChars) {
    return `${text.slice(0, maxChars - 1)}…`;
  }

  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

function formatCappedList(items: string[], total: number, maxItems: number): string {
  if (total === 0 || items.length === 0) return "(none)";
  const shown = items.slice(0, maxItems);
  const omitted = Math.max(0, total - shown.length);
  return omitted > 0 ? `${shown.join(", ")}, … (${omitted} more)` : shown.join(", ");
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

function persistSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
): boolean {
  try {
    pi.appendEntry(AUTO_MODE_STATE_TYPE, snapshot);
    return true;
  } catch (error) {
    snapshot.enabled = true;
    snapshot.paused = true;
    snapshot.lastStopReason = "state persistence failed";
    runtime.snapshot = snapshot;
    ctx.ui.notify(
      `Auto-mode paused: state persistence failed (${getErrorMessage(error)})`,
      "warning",
    );
    return false;
  }
}

function persistSnapshotAndSetStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
): boolean {
  const persisted = persistSnapshot(pi, ctx, runtime, snapshot);
  setStatus(ctx, snapshot);
  return persisted;
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
      const prompt = entry.nextPrompt ? `\nNext prompt: ${truncateEnd(entry.nextPrompt, MAX_HISTORY_PROMPT_CHARS)}` : "";
      return `Iteration ${entry.iteration}: ${entry.action}\nReason: ${truncateEnd(entry.reason, MAX_HISTORY_REASON_CHARS)}${prompt}`;
    })
    .join("\n\n");
}

function buildGitSnapshotText(gitSnapshot: GitSnapshot | undefined): string {
  if (!gitSnapshot) {
    return "Not a git repository or git state unavailable.";
  }

  const changedFileCount = gitSnapshot.changedFileCount ?? gitSnapshot.changedFiles.length;
  const status = truncateMiddle(gitSnapshot.status, MAX_GIT_STATUS_CHARS);

  return [
    `isGitRepo=${gitSnapshot.isGitRepo ? "yes" : "no"}`,
    gitSnapshot.head ? `head=${gitSnapshot.head}` : undefined,
    `dirty=${gitSnapshot.dirty ? "yes" : "no"}`,
    `has-upstream=${gitSnapshot.hasUpstream ? "yes" : "no"}`,
    gitSnapshot.ahead !== undefined ? `ahead=${gitSnapshot.ahead}` : undefined,
    gitSnapshot.behind !== undefined ? `behind=${gitSnapshot.behind}` : undefined,
    `changed-file-count=${changedFileCount}`,
    gitSnapshot.untrackedFileCount !== undefined ? `untracked-file-count=${gitSnapshot.untrackedFileCount}` : undefined,
    `changed-files-sample=${formatCappedList(gitSnapshot.changedFiles, changedFileCount, MAX_GIT_CHANGED_FILES_DISPLAY)}`,
    `status:\n${status}`,
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
    snapshot.lastAutoPrompt
      ? `Last auto prompt sent to worker:\n${truncateMiddle(snapshot.lastAutoPrompt, MAX_CONTROLLER_PROMPT_FIELD_CHARS)}`
      : undefined,
    `Latest worker result:\nStop reason: ${workerTurn.stopReason}\n\n${truncateMiddle(workerTurn.assistantText || "(no assistant text)", MAX_CONTROLLER_ASSISTANT_TEXT_CHARS)}`,
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

function formatGitCommandFailure(label: string, result: ExecLikeResult): string {
  const reason = result.killed === true ? "was killed or timed out" : `failed with exit code ${result.code}`;
  return `${label} ${reason}: ${summarizeBashOutput(result.stdout, result.stderr, 500)}`;
}

function buildGitRepoFingerprint(statusText: string, trackedFilesText: string, untrackedFilesText: string): string {
  return createHash("sha256")
    .update("status\0")
    .update(statusText)
    .update("\0tracked\0")
    .update(trackedFilesText)
    .update("\0untracked\0")
    .update(untrackedFilesText)
    .digest("hex");
}

function emptyFileFingerprint(): FileFingerprint {
  return { fingerprint: "", total: 0, samplePaths: [], mode: "none" };
}

function buildParsedPathList(paths: string[], sampleLimit: number): ParsedPathList {
  return {
    paths: paths.slice(0, sampleLimit),
    total: paths.length,
    truncated: paths.length > sampleLimit,
    rawHash: hashString(paths.join("\0")),
  };
}

function collectFileMetadata(cwd: string, paths: string[], maxMetadataFiles: number): UntrackedFileMetadata[] | undefined {
  if (paths.length > maxMetadataFiles) {
    return undefined;
  }

  return paths.map((path) => {
    try {
      const stats = lstatSync(join(cwd, path));
      return {
        path,
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        isSymbolicLink: stats.isSymbolicLink(),
      };
    } catch {
      return { path, size: -1, mtimeMs: -1, isSymbolicLink: false };
    }
  });
}

function formatPathOnlyFingerprint(label: string, parsed: ParsedPathList): string {
  return hashString(`${label}\tpath-only\t${parsed.total}\t${parsed.rawHash}`);
}

function formatMetadataFingerprint(label: string, metadata: UntrackedFileMetadata[]): string {
  return hashString(
    metadata
      .map((entry) => `${label}\tmetadata\t${entry.size}\t${entry.mtimeMs}\t${entry.isSymbolicLink ? "symlink" : "file"}\t${entry.path}`)
      .join("\0"),
  );
}

function shouldHashFileContents(
  metadata: UntrackedFileMetadata[],
  maxFiles: number,
  maxBytes: number,
  maxPathChars: number,
): boolean {
  if (metadata.some((entry) => entry.isSymbolicLink || entry.size < 0)) {
    return false;
  }

  if (metadata.length > maxFiles) {
    return false;
  }

  const totalBytes = metadata.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
  if (totalBytes > maxBytes) {
    return false;
  }

  const totalPathChars = metadata.reduce((sum, entry) => sum + entry.path.length, 0);
  return totalPathChars <= maxPathChars;
}

async function buildFilesFingerprint(
  pi: ExtensionAPI,
  cwd: string,
  label: "tracked" | "untracked",
  parsed: ParsedPathList,
  limits: {
    maxMetadataFiles: number;
    maxContentHashFiles: number;
    maxContentHashBytes: number;
    maxContentHashPathChars: number;
  },
): Promise<FileFingerprint> {
  if (parsed.total === 0) {
    return emptyFileFingerprint();
  }

  const samplePaths = parsed.paths.slice(0, MAX_GIT_CHANGED_FILES_STATE);
  if (parsed.truncated || parsed.total > limits.maxMetadataFiles) {
    return {
      fingerprint: formatPathOnlyFingerprint(label, parsed),
      total: parsed.total,
      samplePaths,
      mode: "path-only",
    };
  }

  const metadata = collectFileMetadata(cwd, parsed.paths, limits.maxMetadataFiles);
  if (!metadata) {
    return {
      fingerprint: formatPathOnlyFingerprint(label, parsed),
      total: parsed.total,
      samplePaths,
      mode: "path-only",
    };
  }

  if (!shouldHashFileContents(
    metadata,
    limits.maxContentHashFiles,
    limits.maxContentHashBytes,
    limits.maxContentHashPathChars,
  )) {
    return {
      fingerprint: formatMetadataFingerprint(label, metadata),
      total: parsed.total,
      samplePaths,
      mode: "metadata",
    };
  }

  const hashes = await pi.exec("git", ["hash-object", "--no-filters", "--", ...parsed.paths], {
    cwd,
    timeout: GIT_DIFF_TIMEOUT_MS,
  });
  if (hashes.code !== 0) {
    return {
      fingerprint: formatMetadataFingerprint(label, metadata),
      total: parsed.total,
      samplePaths,
      mode: "metadata",
    };
  }

  const contentHashes = hashes.stdout.trim().split(/\r?\n/);
  return {
    fingerprint: hashString(
      parsed.paths
        .map((path, index) => `${label}\tcontent\t${contentHashes[index] ?? "missing"}\t${path}`)
        .join("\0"),
    ),
    total: parsed.total,
    samplePaths,
    mode: "content",
  };
}

function fieldAfterSpaces(record: string, spacesBeforeField: number): string {
  let spaces = 0;
  for (let index = 0; index < record.length; index += 1) {
    if (record[index] !== " ") continue;
    spaces += 1;
    if (spaces === spacesBeforeField) {
      return record.slice(index + 1);
    }
  }
  return "";
}

function parseGitStatusV2(output: string): ParsedGitStatusV2 {
  const parsed: ParsedGitStatusV2 = {
    statusLines: [],
    trackedPaths: [],
    untrackedPaths: [],
    unknownRecords: [],
  };
  const entries = output.split("\0").filter(Boolean);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;

    if (entry.startsWith("# branch.oid ")) {
      const oid = entry.slice("# branch.oid ".length).trim();
      parsed.head = oid && oid !== "(initial)" ? oid : undefined;
      continue;
    }

    if (entry.startsWith("# branch.head ")) {
      parsed.branchHead = entry.slice("# branch.head ".length).trim() || undefined;
      continue;
    }

    if (entry.startsWith("# branch.upstream ")) {
      parsed.upstream = entry.slice("# branch.upstream ".length).trim() || undefined;
      continue;
    }

    if (entry.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(entry);
      if (match) {
        parsed.ahead = Number(match[1]);
        parsed.behind = Number(match[2]);
      }
      continue;
    }

    const recordType = entry[0];
    if (recordType === "1") {
      const path = fieldAfterSpaces(entry, 8);
      if (!path) continue;
      const xy = entry.slice(2, 4).replace(/\./g, " ");
      parsed.trackedPaths.push(path);
      parsed.statusLines.push(`${xy} ${path}`);
      continue;
    }

    if (recordType === "2") {
      const path = fieldAfterSpaces(entry, 9);
      if (!path) continue;
      const xy = entry.slice(2, 4).replace(/\./g, " ");
      const originalPath = entries[index + 1];
      parsed.trackedPaths.push(path);
      parsed.statusLines.push(`${xy} ${originalPath ? `${originalPath} -> ${path}` : path}`);
      if (originalPath) {
        index += 1; // porcelain v2 -z stores the original rename path in the next record.
      }
      continue;
    }

    if (recordType === "u") {
      const path = fieldAfterSpaces(entry, 10);
      if (!path) continue;
      const xy = entry.slice(2, 4).replace(/\./g, " ");
      parsed.trackedPaths.push(path);
      parsed.statusLines.push(`${xy} ${path}`);
      continue;
    }

    if (recordType === "?") {
      const path = entry.slice(2);
      if (!path) continue;
      parsed.untrackedPaths.push(path);
      parsed.statusLines.push(`?? ${path}`);
      continue;
    }

    parsed.unknownRecords.push(entry);
  }

  return parsed;
}

function buildGitStatusText(status: ParsedGitStatusV2): string {
  const branchLabel = status.branchHead && status.branchHead !== "(detached)"
    ? status.branchHead
    : status.head
      ? `HEAD ${status.head.slice(0, 12)}`
      : "HEAD";
  const upstream = status.upstream ? `...${status.upstream}` : "";
  const divergence = [
    (status.ahead ?? 0) > 0 ? `ahead ${status.ahead}` : undefined,
    (status.behind ?? 0) > 0 ? `behind ${status.behind}` : undefined,
  ].filter((value): value is string => !!value);
  const branchLine = `## ${branchLabel}${upstream}${divergence.length > 0 ? ` [${divergence.join(", ")}]` : ""}`;
  const unknownLines = status.unknownRecords.map((record) => `!! ${record}`);
  return [branchLine, ...status.statusLines, ...unknownLines].join("\n").trim() || "working tree clean";
}

function getUnknownChangeRecords(status: ParsedGitStatusV2): string[] {
  return status.unknownRecords.filter((record) => !record.startsWith("#"));
}

async function loadGitStatusV2(pi: ExtensionAPI, cwd: string): Promise<ParsedGitStatusV2 | undefined> {
  const statusResult = await pi.exec("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], {
    cwd,
    timeout: GIT_DIFF_TIMEOUT_MS,
  });

  if (statusResult.killed === true) {
    throw new Error(formatGitCommandFailure("git status --porcelain=v2 --branch -z", statusResult));
  }

  if (statusResult.code !== 0) {
    const output = `${statusResult.stdout}\n${statusResult.stderr}`.toLowerCase();
    if (output.includes("not a git repository") || output.includes("not a git repo")) {
      return undefined;
    }
    throw new Error(formatGitCommandFailure("git status --porcelain=v2 --branch -z", statusResult));
  }

  return parseGitStatusV2(statusResult.stdout);
}

async function getGitSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitSnapshot | undefined> {
  const status = await loadGitStatusV2(pi, cwd);
  if (!status) return undefined;
  const trackedFilesFingerprint = await buildFilesFingerprint(
    pi,
    cwd,
    "tracked",
    buildParsedPathList(status.trackedPaths, MAX_TRACKED_METADATA_FILES + 1),
    {
      maxMetadataFiles: MAX_TRACKED_METADATA_FILES,
      maxContentHashFiles: MAX_TRACKED_CONTENT_HASH_FILES,
      maxContentHashBytes: MAX_TRACKED_CONTENT_HASH_BYTES,
      maxContentHashPathChars: MAX_TRACKED_CONTENT_HASH_PATH_CHARS,
    },
  );
  const untrackedFilesFingerprint = await buildFilesFingerprint(
    pi,
    cwd,
    "untracked",
    buildParsedPathList(status.untrackedPaths, MAX_UNTRACKED_METADATA_FILES + 1),
    {
      maxMetadataFiles: MAX_UNTRACKED_METADATA_FILES,
      maxContentHashFiles: MAX_UNTRACKED_CONTENT_HASH_FILES,
      maxContentHashBytes: MAX_UNTRACKED_CONTENT_HASH_BYTES,
      maxContentHashPathChars: MAX_UNTRACKED_CONTENT_HASH_PATH_CHARS,
    },
  );

  const statusText = buildGitStatusText(status);
  const unknownChangeRecords = getUnknownChangeRecords(status);
  const changedFileCount = trackedFilesFingerprint.total + untrackedFilesFingerprint.total + unknownChangeRecords.length;
  const changedFiles = [
    ...trackedFilesFingerprint.samplePaths,
    ...untrackedFilesFingerprint.samplePaths.map((path) => `?? ${path}`),
    ...unknownChangeRecords.map((record) => `!! ${truncateEnd(record, 160)}`),
  ].slice(0, MAX_GIT_CHANGED_FILES_STATE);
  const statusSections = [
    statusText,
    untrackedFilesFingerprint.total > 0
      ? `Untracked files (${untrackedFilesFingerprint.total}, ${untrackedFilesFingerprint.mode} fingerprint): ${formatCappedList(
        untrackedFilesFingerprint.samplePaths,
        untrackedFilesFingerprint.total,
        MAX_GIT_CHANGED_FILES_DISPLAY,
      )}`
      : undefined,
  ].filter((value): value is string => !!value);
  const repoFingerprint = buildGitRepoFingerprint(
    statusText,
    trackedFilesFingerprint.fingerprint,
    untrackedFilesFingerprint.fingerprint,
  );

  return {
    isGitRepo: true,
    head: status.head,
    status: truncateMiddle(statusSections.join("\n"), MAX_GIT_STATUS_CHARS),
    changedFiles,
    changedFileCount,
    untrackedFileCount: untrackedFilesFingerprint.total,
    dirty: changedFileCount > 0,
    hasUpstream: !!status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    repoFingerprint,
  };
}

function gitSnapshotToFinalizationSnapshot(gitSnapshot: GitSnapshot | undefined): GitFinalizationSnapshot | undefined {
  if (!gitSnapshot) return undefined;
  return {
    dirty: gitSnapshot.dirty,
    hasUpstream: gitSnapshot.hasUpstream,
    ahead: gitSnapshot.ahead,
    behind: gitSnapshot.behind,
  };
}

async function getGitFinalizationSnapshot(pi: ExtensionAPI, cwd: string): Promise<GitFinalizationSnapshot | undefined> {
  const status = await loadGitStatusV2(pi, cwd);
  if (!status) return undefined;

  return {
    dirty: status.trackedPaths.length + status.untrackedPaths.length + getUnknownChangeRecords(status).length > 0,
    hasUpstream: !!status.upstream,
    ahead: status.ahead,
    behind: status.behind,
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

async function runVerifyCommandSafely(
  runner: typeof runVerifyCommand,
  pi: ExtensionAPI,
  cwd: string,
  command: string,
): Promise<VerifyCommandResult> {
  try {
    return await runner(pi, cwd, command);
  } catch (error) {
    return {
      command,
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: getErrorMessage(error),
    };
  }
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

async function withControllerTimeout<T>(ctx: ExtensionContext, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (ctx.signal.aborted) {
    throw new Error("controller decision aborted before start");
  }

  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};
  const waitForAbort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortWith = (error: Error, reason: unknown = error) => {
    controller.abort(reason);
    rejectAbort(error);
  };
  const timeout = setTimeout(() => {
    abortWith(new Error(`controller decision timed out after ${CONTROLLER_DECISION_TIMEOUT_MS}ms`));
  }, CONTROLLER_DECISION_TIMEOUT_MS);
  const abortFromParent = () => {
    abortWith(
      ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("controller decision aborted"),
      ctx.signal.reason,
    );
  };
  ctx.signal.addEventListener("abort", abortFromParent, { once: true });

  try {
    return await Promise.race([run(controller.signal), waitForAbort]);
  } finally {
    clearTimeout(timeout);
    ctx.signal.removeEventListener("abort", abortFromParent);
  }
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

  const response = await withControllerTimeout(ctx, (signal) => complete(
    model,
    {
      systemPrompt: AUTO_CONTROLLER_SYSTEM_PROMPT,
      messages: [userMessage],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      reasoningEffort: "minimal",
    },
  ));

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
  snapshot.lastSeenRepoFingerprint = nextFingerprint;
}

function sanitizeControllerDecision(decision: ControllerDecision): ControllerDecision {
  const base = {
    ...decision,
    reason: truncateEnd(decision.reason, MAX_CONTROLLER_REASON_CHARS),
    updatedSummary: truncateControllerSummary(decision.updatedSummary),
  };

  if (decision.action === "continue") {
    return {
      ...base,
      action: "continue",
      nextPrompt: truncateEnd(decision.nextPrompt, MAX_CONTROLLER_PROMPT_FIELD_CHARS),
    };
  }

  if (decision.action === "stop") {
    return {
      ...base,
      action: "stop",
      finalMessage: decision.finalMessage
        ? truncateEnd(decision.finalMessage, MAX_CONTROLLER_FINAL_MESSAGE_CHARS)
        : undefined,
    };
  }

  return {
    ...base,
    action: "pause",
  };
}

function recordControllerDecision(snapshot: AutoModeStateV2, decision: ControllerDecision): void {
  snapshot.lastControllerAt = now();
  snapshot.controllerSummary = truncateControllerSummary(decision.updatedSummary);
  snapshot.recentDecisions = appendDecisionHistory(
    snapshot.recentDecisions,
    {
      iteration: snapshot.currentIteration,
      action: decision.action,
      reason: truncateEnd(decision.reason, MAX_CONTROLLER_REASON_CHARS),
      nextPrompt: decision.action === "continue" ? truncateEnd(decision.nextPrompt, MAX_CONTROLLER_PROMPT_FIELD_CHARS) : undefined,
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
    const assistantText = extractMessageText(message.content, MAX_CONTROLLER_ASSISTANT_TEXT_CHARS * 2);
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
): boolean {
  const snapshot = runtime.snapshot;
  if (!snapshot) return false;
  snapshot.paused = true;
  snapshot.lastStopReason = reason;
  const persisted = persistSnapshot(pi, ctx, runtime, snapshot);
  setStatus(ctx, snapshot);
  if (persisted) {
    ctx.ui.notify(`Auto-mode paused: ${reason}`, level);
  }
  return persisted;
}

function disableSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: AutoRuntimeState,
  reason: string,
  level: "info" | "warning" = "info",
): boolean {
  const snapshot = runtime.snapshot;
  if (!snapshot) return false;
  snapshot.enabled = false;
  snapshot.paused = false;
  snapshot.lastStopReason = reason;
  const persisted = persistSnapshot(pi, ctx, runtime, snapshot);
  setStatus(ctx, persisted ? undefined : snapshot);
  if (persisted) {
    ctx.ui.notify(`Auto-mode stopped: ${reason}`, level);
  }
  return persisted;
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

  if (!pi.getSessionName()) {
    pi.setSessionName(`Auto: ${summarizeGoal(snapshot.goal, 56)}`);
  }

  const startPrompt = getStartPrompt(snapshot);
  snapshot.lastAutoPrompt = startPrompt;
  if (!persistSnapshotAndSetStatus(pi, ctx, runtime, snapshot)) {
    return;
  }

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

  const hadMigrationWarnings = Array.isArray(restored.migrationWarnings) && restored.migrationWarnings.length > 0;
  const forcePausedForMigration = hadMigrationWarnings;
  notifyWarnings(ctx, restored.migrationWarnings);
  if (hadMigrationWarnings) {
    restored.migrationWarnings = undefined;
  }

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

  if (restored.paused !== previousPaused || hadMigrationWarnings) {
    if (!persistSnapshotAndSetStatus(pi, ctx, runtime, restored)) {
      return { resumed: false };
    }
  } else {
    setStatus(ctx, restored);
  }
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
  if (!persistSnapshotAndSetStatus(pi, ctx, runtime, snapshot)) {
    return;
  }
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
  if (!persistSnapshotAndSetStatus(pi, ctx, runtime, snapshot)) {
    return;
  }
  ctx.ui.notify(options.notifyMessage, options.notifyLevel ?? "info");
  pi.sendUserMessage(followUpPlan.nextPrompt);
}

type GitSnapshotLoadResult = { ok: true; snapshot: GitSnapshot | undefined } | { ok: false };
type GitFinalizationSnapshotLoadResult = { ok: true; snapshot: GitFinalizationSnapshot | undefined } | { ok: false };

type AutoEvidenceResult =
  | {
      ok: true;
      gitSnapshot: GitSnapshot | undefined;
      verifyResult: VerifyCommandResult | undefined;
      verifyRan: boolean;
    }
  | { ok: false };

function recordWorkerOutcome(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
  workerTurn: WorkerTurnSnapshot,
): boolean {
  snapshot.lastWorkerFinishedAt = now();

  if (!shouldTreatWorkerFailure(workerTurn.stopReason)) {
    snapshot.consecutiveWorkerFailures = 0;
    return true;
  }

  snapshot.consecutiveWorkerFailures += 1;
  if (snapshot.consecutiveWorkerFailures < DEFAULT_WORKER_FAILURE_LIMIT) {
    return true;
  }

  pauseSnapshot(pi, ctx, runtime, `worker failed ${snapshot.consecutiveWorkerFailures} times in a row`);
  return false;
}

async function loadGitSnapshotOrPause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  getGitSnapshotImpl: typeof getGitSnapshot,
): Promise<GitSnapshotLoadResult> {
  try {
    return { ok: true, snapshot: await getGitSnapshotImpl(pi, ctx.cwd) };
  } catch (error) {
    pauseSnapshot(pi, ctx, runtime, `git state unavailable: ${getErrorMessage(error)}`);
    return { ok: false };
  }
}

async function loadGitFinalizationSnapshotOrPause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  getGitFinalizationSnapshotImpl: typeof getGitFinalizationSnapshot,
): Promise<GitFinalizationSnapshotLoadResult> {
  try {
    return { ok: true, snapshot: await getGitFinalizationSnapshotImpl(pi, ctx.cwd) };
  } catch (error) {
    pauseSnapshot(pi, ctx, runtime, `git state unavailable: ${getErrorMessage(error)}`);
    return { ok: false };
  }
}

async function gatherEvidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
  workerTurn: WorkerTurnSnapshot,
  getGitSnapshotImpl: typeof getGitSnapshot,
  runVerifyCommandImpl: typeof runVerifyCommand,
): Promise<AutoEvidenceResult> {
  const loadedGitSnapshot = await loadGitSnapshotOrPause(pi, ctx, runtime, getGitSnapshotImpl);
  if (!loadedGitSnapshot.ok) return { ok: false };

  const gitSnapshot = loadedGitSnapshot.snapshot;
  updateNoChangeCounters(snapshot, gitSnapshot);

  let verifyResult: VerifyCommandResult | undefined;
  let verifyRan = false;
  if (shouldPreRunVerifyCommand({
    verifyCommandConfigured: !!snapshot.verifyCommand,
    stopReason: workerTurn.stopReason,
    currentIteration: snapshot.currentIteration,
    maxIterations: snapshot.maxIterations,
  }) && snapshot.verifyCommand) {
    verifyResult = await runVerifyCommandSafely(runVerifyCommandImpl, pi, ctx.cwd, snapshot.verifyCommand);
    verifyRan = true;
  }

  return { ok: true, gitSnapshot, verifyResult, verifyRan };
}

async function decideControllerActionSafely(
  ctx: ExtensionContext,
  snapshot: AutoModeStateV2,
  workerTurn: WorkerTurnSnapshot,
  gitSnapshot: GitSnapshot | undefined,
  verifyResult: VerifyCommandResult | undefined,
  decideControllerActionImpl: typeof decideControllerAction,
): Promise<ControllerDecision | undefined> {
  try {
    return await decideControllerActionImpl(ctx, snapshot, workerTurn, gitSnapshot, verifyResult);
  } catch {
    return undefined;
  }
}

function handleInconclusiveControllerDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
): void {
  snapshot.consecutiveControllerFailures += 1;
  if (snapshot.consecutiveControllerFailures >= DEFAULT_CONTROLLER_FAILURE_LIMIT) {
    pauseSnapshot(pi, ctx, runtime, `controller failed ${snapshot.consecutiveControllerFailures} times in a row`);
    return;
  }

  if (persistSnapshotAndSetStatus(pi, ctx, runtime, snapshot)) {
    ctx.ui.notify("Auto-mode controller was inconclusive; waiting for the next worker turn.", "warning");
  }
}

function applyContinueDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
  decision: ContinueDecision,
): void {
  recordControllerDecision(snapshot, decision);
  queueContinueLikeFollowUp(pi, ctx, runtime, snapshot, decision, {
    budgetPauseReason: "iteration budget exhausted",
    notifyMessage: `Auto-mode continuing (${Math.min(snapshot.currentIteration + 1, snapshot.maxIterations)}/${snapshot.maxIterations})`,
    notifyLevel: "info",
  });
}

// Stop guards only need dirty/upstream/ahead/behind, so this path refreshes
// the lightweight finalization snapshot instead of the full fingerprinted git snapshot.
async function applyStopDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoRuntimeState,
  snapshot: AutoModeStateV2,
  decision: Extract<ControllerDecision, { action: "stop" }>,
  evidence: Extract<AutoEvidenceResult, { ok: true }>,
  getGitFinalizationSnapshotImpl: typeof getGitFinalizationSnapshot,
  runVerifyCommandImpl: typeof runVerifyCommand,
): Promise<void> {
  let gitFinalizationSnapshot = gitSnapshotToFinalizationSnapshot(evidence.gitSnapshot);
  let verifyResult = evidence.verifyResult;
  let gitSnapshotMayBeStale = evidence.verifyRan;

  if (snapshot.verifyCommand && !verifyResult) {
    verifyResult = await runVerifyCommandSafely(runVerifyCommandImpl, pi, ctx.cwd, snapshot.verifyCommand);
    gitSnapshotMayBeStale = true;
  }

  // Verification commands can write coverage, snapshots, lockfiles, or other artifacts.
  // Refresh the cheap finalization state before stop guards whenever verification ran
  // after the initial git read; no full fingerprint is needed for this check.
  if (gitSnapshotMayBeStale) {
    const loadedGitSnapshot = await loadGitFinalizationSnapshotOrPause(pi, ctx, runtime, getGitFinalizationSnapshotImpl);
    if (!loadedGitSnapshot.ok) return;
    gitFinalizationSnapshot = loadedGitSnapshot.snapshot;
  }

  const stopGuard = evaluateAutoStopGuard({
    goalStatus: decision.goalStatus,
    requiresCompletionGate: !!snapshot.untilPrompt,
    completionGateMet: decision.completionGateMet,
    verifyCommandConfigured: !!snapshot.verifyCommand,
    verifyCommandPassed: snapshot.verifyCommand ? !!verifyResult?.ok : false,
    commitPolicy: snapshot.commitPolicy,
    pushPolicy: snapshot.pushPolicy,
    git: gitFinalizationSnapshot,
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
  disableSnapshot(pi, ctx, runtime, decision.finalMessage || decision.reason, decision.completionGateMet ? "info" : "warning");
}

function resolveFinalizationSnapshotProvider(
  deps: AutoModeDependencies,
  getGitSnapshotImpl: typeof getGitSnapshot,
): typeof getGitFinalizationSnapshot {
  if (deps.getGitFinalizationSnapshot) {
    return deps.getGitFinalizationSnapshot;
  }

  // Backwards compatibility for tests/extensions that override the full git snapshot
  // provider only: derive the lightweight finalization state from that override so
  // stop guards observe the same mocked repository state.
  if (deps.getGitSnapshot) {
    return async (piArg: ExtensionAPI, cwd: string) => gitSnapshotToFinalizationSnapshot(await getGitSnapshotImpl(piArg, cwd));
  }

  return getGitFinalizationSnapshot;
}

export function createAutoModeExtension(deps: AutoModeDependencies = {}) {
  return function (pi: ExtensionAPI) {
    const runtime: AutoRuntimeState = {
      controllerBusy: false,
    };
    const getGitSnapshotImpl = deps.getGitSnapshot ?? getGitSnapshot;
    const getGitFinalizationSnapshotImpl = resolveFinalizationSnapshotProvider(deps, getGitSnapshotImpl);
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
            if (!persistSnapshotAndSetStatus(pi, ctx, runtime, runtime.snapshot)) {
              return;
            }
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
          if (persistSnapshotAndSetStatus(pi, ctx, runtime, runtime.snapshot)) {
            pi.sendUserMessage(resumePrompt);
          }
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
        if (!recordWorkerOutcome(pi, ctx, runtime, snapshot, workerTurn)) return;

        const evidence = await gatherEvidence(
          pi,
          ctx,
          runtime,
          snapshot,
          workerTurn,
          getGitSnapshotImpl,
          runVerifyCommandImpl,
        );
        if (!evidence.ok) return;

        const rawDecision = await decideControllerActionSafely(
          ctx,
          snapshot,
          workerTurn,
          evidence.gitSnapshot,
          evidence.verifyResult,
          decideControllerActionImpl,
        );

        if (!rawDecision) {
          handleInconclusiveControllerDecision(pi, ctx, runtime, snapshot);
          return;
        }

        snapshot.consecutiveControllerFailures = 0;
        const decision = sanitizeControllerDecision(rawDecision);

        if (decision.action === "continue") {
          applyContinueDecision(pi, ctx, runtime, snapshot, decision);
          return;
        }

        if (decision.action === "pause") {
          recordControllerDecision(snapshot, decision);
          pauseSnapshot(pi, ctx, runtime, decision.reason);
          return;
        }

        await applyStopDecision(
          pi,
          ctx,
          runtime,
          snapshot,
          decision,
          evidence,
          getGitFinalizationSnapshotImpl,
          runVerifyCommandImpl,
        );
      } finally {
        runtime.controllerBusy = false;
      }
    });
  };
}

export default createAutoModeExtension();
