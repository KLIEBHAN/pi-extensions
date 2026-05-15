import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  extractAssistantText,
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
} from "./core.ts";

const GIT_TIMEOUT_MS = 120_000;
const MAX_REVIEWER_STDERR_CHARS = 4_000;
const MAX_IMPLEMENTATION_SUMMARY_CHARS = 8_000;

interface ReviewCycleState {
  active: boolean;
  phase: "implementing" | "reviewing" | "applying";
  runId: string;
  task: string;
  startedAt: number;
  baseline: GitBaseline;
  reviewerModel?: ModelRef;
  implementationSummary?: string;
  review?: string;
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

function setStatus(ctx: ExtensionContext | ExtensionCommandContext, state: ReviewCycleState | undefined): void {
  if (!state?.active) {
    ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
    return;
  }

  const phase = state.phase === "implementing" ? "implement" : state.phase === "reviewing" ? "review" : "apply";
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, `Review ${phase}: ${summarizeTask(state.task, 36)}`);
}

function clearState(ctx: ExtensionContext | ExtensionCommandContext, stateRef: { current?: ReviewCycleState }): void {
  stateRef.current = undefined;
  ctx.ui.setStatus(REVIEW_CYCLE_STATUS_KEY, undefined);
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

async function writeReviewerSystemPrompt(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-cycle-"));
  const promptPath = join(dir, "reviewer-system-prompt.md");
  await writeFile(promptPath, REVIEWER_SYSTEM_PROMPT, { encoding: "utf8", mode: 0o600 });
  return { dir, path: promptPath };
}

async function runFreshReviewAgent(options: {
  cwd: string;
  prompt: string;
  reviewerModel?: ModelRef;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<FreshReviewResult> {
  const temp = await writeReviewerSystemPrompt();
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--tools",
    DEFAULT_REVIEW_TOOLS.join(","),
  ];

  if (options.reviewerModel) {
    args.push("--model", modelRefToCli(options.reviewerModel));
  }

  args.push("--append-system-prompt", temp.path, options.prompt);

  try {
    return await new Promise<FreshReviewResult>((resolve, reject) => {
      const invocation = getPiInvocation(args);
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

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          messages.push(event.message as Message);
        }
      };

      const killProcess = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5_000).unref?.();
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
        stderr += data.toString();
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        if (options.signal) options.signal.removeEventListener("abort", abortHandler);
        finishReject(error);
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
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

async function startReviewCycle(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  stateRef: { current?: ReviewCycleState },
  task: string,
  reviewerModel: ModelRef | undefined,
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

  const reviewerModelError = validateRequestedReviewerModel(ctx, reviewerModel);
  if (reviewerModelError) {
    ctx.ui.notify(reviewerModelError, "error");
    return;
  }

  const baseline = await getGitBaseline(pi, ctx.cwd).catch((error) => ({
    isGitRepo: false,
    status: `git baseline unavailable: ${error instanceof Error ? error.message : String(error)}`,
    dirty: false,
  } satisfies GitBaseline));

  const state: ReviewCycleState = {
    active: true,
    phase: "implementing",
    runId: makeRunId(),
    task,
    startedAt: Date.now(),
    baseline,
    reviewerModel,
  };

  stateRef.current = state;
  setStatus(ctx, state);

  if (!pi.getSessionName()) {
    pi.setSessionName(`Review: ${summarizeTask(task, 56)}`);
  }

  if (!baseline.isGitRepo) {
    ctx.ui.notify("Review-cycle started without git; review scope will be degraded.", "warning");
  } else if (baseline.dirty) {
    ctx.ui.notify("Review-cycle started with pre-existing git changes; review may include them.", "warning");
  }

  ctx.ui.notify("Review-cycle started: implementation phase", "info");
  pi.sendUserMessage(task);
}

async function runReviewAndQueueApply(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stateRef: { current?: ReviewCycleState },
  state: ReviewCycleState,
): Promise<void> {
  state.phase = "reviewing";
  setStatus(ctx, state);
  ctx.ui.notify("Review-cycle: starting fresh-context review", "info");

  const changes = await getChangeSnapshot(pi, ctx.cwd, state.baseline).catch((error) => ({
    isGitRepo: state.baseline.isGitRepo,
    baselineHead: state.baseline.head,
    status: `change snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    diffStat: "",
    diff: "",
    committedChanges: "",
    untrackedFiles: [],
    notes: ["Change snapshot collection failed before review."],
  } satisfies ChangeSnapshot));

  const reviewerPrompt = buildReviewerUserPrompt({
    task: state.task,
    implementationSummary: state.implementationSummary,
    baseline: state.baseline,
    changes,
  });

  const reviewerModel = state.reviewerModel ?? resolveDefaultReviewerModel(ctx);
  const result = await runFreshReviewAgent({
    cwd: ctx.cwd,
    prompt: reviewerPrompt,
    reviewerModel,
    signal: ctx.signal,
  });

  if (stateRef.current !== state || !state.active || state.phase !== "reviewing") return;

  state.review = result.text.trim() || "Reviewer returned no text.";
  state.phase = "applying";
  setStatus(ctx, state);
  ctx.ui.notify("Review-cycle: fresh review complete; applying feedback", "info");

  pi.sendUserMessage(buildApplyReviewPrompt({ task: state.task, review: state.review }));
}

function showStatus(ctx: ExtensionCommandContext, state: ReviewCycleState | undefined): void {
  if (!state?.active) {
    ctx.ui.notify("No active review-cycle run", "info");
    return;
  }

  const reviewer = state.reviewerModel ? ` reviewer=${modelRefToCli(state.reviewerModel)}` : " reviewer=active-model";
  ctx.ui.notify(
    `review-cycle phase=${state.phase}${reviewer} task=${summarizeTask(state.task, 160)}`,
    "info",
  );
}

export default function (pi: ExtensionAPI) {
  const stateRef: { current?: ReviewCycleState } = {};

  pi.registerFlag("review-cycle-task", {
    description: "Auto-start a review-cycle run with this task",
    type: "string",
  });

  pi.registerFlag("review-cycle-reviewer-model", {
    description: "Optional reviewer model in provider/model form",
    type: "string",
  });

  pi.registerCommand("review-cycle", {
    description: "Implement a task, run a fresh-context code review, then apply the feedback",
    handler: async (args, ctx) => {
      const parsed = parseReviewCycleArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      if (parsed.kind === "status") {
        showStatus(ctx, stateRef.current);
        return;
      }

      if (parsed.kind === "stop") {
        if (!stateRef.current?.active) {
          ctx.ui.notify("No active review-cycle run", "info");
          return;
        }
        clearState(ctx, stateRef);
        if (!ctx.isIdle()) ctx.abort();
        ctx.ui.notify("Stopped review-cycle", "info");
        return;
      }

      await startReviewCycle(pi, ctx, stateRef, parsed.task, parsed.reviewerModel);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    clearState(ctx, stateRef);

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

    await startReviewCycle(pi, ctx, stateRef, taskFlag.trim(), reviewerModel);
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
    if (state.phase === "reviewing") return;

    const assistantTurn = getLastAssistantTurn(event);
    if (!assistantTurn) return;

    if (shouldTreatStopReasonAsFailure(assistantTurn.stopReason)) {
      const phase = state.phase;
      clearState(ctx, stateRef);
      ctx.ui.notify(`Review-cycle stopped: ${phase} phase ended with ${assistantTurn.stopReason}`, "warning");
      return;
    }

    if (state.phase === "implementing") {
      state.implementationSummary = truncateMiddle(assistantTurn.text, MAX_IMPLEMENTATION_SUMMARY_CHARS);
      try {
        await runReviewAndQueueApply(pi, ctx, stateRef, state);
      } catch (error) {
        if (stateRef.current === state) clearState(ctx, stateRef);
        ctx.ui.notify(
          `Review-cycle failed during fresh review: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return;
    }

    if (state.phase === "applying") {
      clearState(ctx, stateRef);
      ctx.ui.notify("Review-cycle completed: feedback application phase finished", "info");
    }
  });
}
