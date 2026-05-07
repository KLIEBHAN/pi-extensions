import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_REPEAT,
  type CompletionVerificationResult,
  extractAssistantText,
  MAX_REPEAT,
  MAX_VERIFICATION_NUDGES,
  parseLoopArgs,
  parsePositiveInteger,
  parseVerificationResponse,
  RALPHY_VERIFIER_FALLBACK_CONTINUE_PROMPT,
  summarizeTask,
  shouldTreatStopReasonAsFailure,
  type ParsedLoopArgs,
} from "./core.ts";

interface LoopState {
  active: boolean;
  task: string;
  totalIterations: number;
  currentIteration: number;
  continueOnFailure: boolean;
  iterationStartAt: number;
  iterationHadError: boolean;
  verificationNudges: number;
}

interface GitSummary {
  status: string;
}

interface GitVerificationResult {
  summary: GitSummary;
  ok: boolean;
  reason: string;
}

const STATUS_KEY = "ralphy-loop";
const RALPHY_LOOP_SYSTEM_PROMPT = `You are running in autonomous execution mode.

Rules:
- No human interaction is available. Do not ask clarifying questions, do not ask for confirmation, and do not wait for user input.
- Work until the task is actually fulfilled.
- If information is missing, inspect the repository, files, logs, configs, tests, and available tools yourself.
- Do not stop with a partial plan or with “I need more information” when that information can be obtained from the workspace or tools.
- Do not defer unresolved work. Treat this run as responsible for completing the task.
- Before finishing, verify that the task requirements have been satisfied.
- If the workspace is a git repository, finish by creating a commit for the completed work and pushing the current branch. Do not treat the task as complete before commit and push have succeeded, unless git or the remote is unavailable and you have verified that programmatically.`;
const RALPHY_VERIFIER_SYSTEM_PROMPT = `You are a strict completion verifier for an autonomous coding agent.

Determine whether the task is fully complete right now.

Rules:
- No human interaction is possible.
- If the assistant asks the user a question, asks for confirmation, requests manual follow-up, or waits for input, the task is not complete.
- If the assistant leaves TODOs, unresolved follow-up work, or says something still needs to be checked, the task is not complete.
- If commit and push are required but clearly not done yet, the task is not complete.
- Be conservative. Only return done=true when the task appears fully completed.

Return JSON only in this shape:
{"done":boolean,"reason":string,"continuePrompt":string}

When done=false, continuePrompt must be a direct instruction telling the agent to continue the same task autonomously now, without asking the user anything.`;
const MAX_VERIFIER_TASK_CHARS = 4_000;
const MAX_VERIFIER_ASSISTANT_CHARS = 12_000;
const MAX_VERIFIER_GIT_STATUS_CHARS = 4_000;
const MAX_VERIFIER_CONTINUE_PROMPT_CHARS = 2_000;

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  const marker = `\n… [${text.length - maxChars} chars omitted] …\n`;
  if (marker.length >= maxChars) return `${text.slice(0, maxChars - 1)}…`;
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

function setStatus(ctx: ExtensionContext | ExtensionCommandContext, state: LoopState | undefined): void {
  if (!state?.active) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const mode = state.continueOnFailure ? " continue-on-failure" : "";
  ctx.ui.setStatus(
    STATUS_KEY,
    `Ralphy ${state.currentIteration}/${state.totalIterations}${mode}: ${summarizeTask(state.task, 36)}`,
  );
}

function clearState(ctx: ExtensionContext | ExtensionCommandContext, stateRef: { current: LoopState | undefined }): void {
  stateRef.current = undefined;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function startIteration(state: LoopState, pi: ExtensionAPI, deliverAs: "followUp" | undefined): void {
  state.iterationHadError = false;
  state.verificationNudges = 0;
  state.iterationStartAt = Date.now();
  if (deliverAs) {
    pi.sendUserMessage(state.task, { deliverAs });
  } else {
    pi.sendUserMessage(state.task);
  }
}

function startLoop(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  stateRef: { current: LoopState | undefined },
  config: ParsedLoopArgs,
): void {
  const state: LoopState = {
    active: true,
    task: config.task,
    totalIterations: config.repeat,
    currentIteration: 1,
    continueOnFailure: config.continueOnFailure,
    iterationStartAt: 0,
    iterationHadError: false,
    verificationNudges: 0,
  };

  stateRef.current = state;
  setStatus(ctx, state);

  if (!pi.getSessionName()) {
    pi.setSessionName(`Ralphy x${state.totalIterations}: ${summarizeTask(state.task, 48)}`);
  }

  const repeatInfo = state.totalIterations > 1 ? ` (${state.currentIteration}/${state.totalIterations})` : "";
  ctx.ui.notify(`Starting Ralphy loop${repeatInfo}`, "info");
  startIteration(state, pi, undefined);
}

function resolveVerifierModel(pi: ExtensionAPI, ctx: ExtensionContext): Model<Api> | undefined {
  const configured = pi.getFlag("ralphy-verifier-model");
  if (typeof configured !== "string" || !configured.trim()) {
    return ctx.model;
  }

  const trimmed = configured.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return ctx.model;
  }

  const provider = trimmed.slice(0, slashIndex);
  const modelId = trimmed.slice(slashIndex + 1);
  const verifierModel = ctx.modelRegistry.find(provider, modelId);
  if (!verifierModel) {
    return ctx.model;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(verifierModel)) {
    return ctx.model;
  }

  return verifierModel;
}

async function getGitSummary(pi: ExtensionAPI, cwd: string): Promise<GitSummary | undefined> {
  const isGitRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (isGitRepo.code !== 0 || !isGitRepo.stdout.includes("true")) {
    return undefined;
  }

  const status = await pi.exec("git", ["status", "--short", "--branch"], { cwd });
  if (status.code !== 0) {
    return { status: "git status unavailable" };
  }

  const text = status.stdout.trim();
  return { status: text.length > 0 ? truncateMiddle(text, MAX_VERIFIER_GIT_STATUS_CHARS) : "working tree clean" };
}

async function getGitVerification(pi: ExtensionAPI, cwd: string): Promise<GitVerificationResult | undefined> {
  const summary = await getGitSummary(pi, cwd);
  if (!summary) {
    return undefined;
  }

  const porcelain = await pi.exec("git", ["status", "--porcelain"], { cwd });
  if (porcelain.code !== 0) {
    return { summary, ok: false, reason: "git status could not be verified" };
  }
  if (porcelain.stdout.trim().length > 0) {
    return { summary, ok: false, reason: "working tree has uncommitted changes" };
  }

  const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd });
  if (upstream.code !== 0 || upstream.stdout.trim().length === 0) {
    return { summary, ok: false, reason: "no upstream configured; push status cannot be verified" };
  }

  const divergence = await pi.exec("git", ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd });
  if (divergence.code !== 0) {
    return { summary, ok: false, reason: "branch divergence against upstream could not be verified" };
  }

  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(divergence.stdout.trim());
  if (!match) {
    return { summary, ok: false, reason: "branch divergence output was invalid" };
  }

  const behind = Number(match[1]);
  const ahead = Number(match[2]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return { summary, ok: false, reason: "branch divergence output was invalid" };
  }
  if (ahead > 0) {
    return { summary, ok: false, reason: `branch has ${ahead} unpushed commit(s)` };
  }
  if (behind > 0) {
    return { summary, ok: false, reason: `branch is ${behind} commit(s) behind upstream` };
  }

  return { summary, ok: true, reason: "working tree clean and branch in sync with upstream" };
}

async function verifyIterationCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: string,
  assistantText: string,
  gitSummary?: GitSummary,
): Promise<CompletionVerificationResult | undefined> {
  const verifierModel = resolveVerifierModel(pi, ctx);
  if (!verifierModel) {
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(verifierModel).catch(() => undefined);
  if (!auth?.ok || !auth.apiKey) {
    return undefined;
  }

  const promptSections = [
    `Task:\n${truncateMiddle(task, MAX_VERIFIER_TASK_CHARS)}`,
    `Final assistant response:\n${truncateMiddle(assistantText || "(no assistant text)", MAX_VERIFIER_ASSISTANT_CHARS)}`,
  ];

  if (gitSummary) {
    promptSections.push(`Git status:\n${truncateMiddle(gitSummary.status, MAX_VERIFIER_GIT_STATUS_CHARS)}`);
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: promptSections.join("\n\n") }],
    timestamp: Date.now(),
  };

  const response = await complete(
    verifierModel,
    { systemPrompt: RALPHY_VERIFIER_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal, reasoningEffort: "minimal" },
  ).catch(() => undefined);

  if (!response || response.stopReason !== "stop") {
    return undefined;
  }

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return parseVerificationResponse(text);
}

function getFollowUpPrompt(reason: string): string {
  return `${RALPHY_VERIFIER_FALLBACK_CONTINUE_PROMPT}\n\nBlocking reason: ${reason}`;
}

export default function (pi: ExtensionAPI) {
  const stateRef: { current: LoopState | undefined } = { current: undefined };

  pi.registerFlag("ralphy-task", {
    description: "Auto-start a Ralphy loop with the given task",
    type: "string",
  });

  pi.registerFlag("ralphy-repeat", {
    description: "Repeat count for the auto-started Ralphy loop",
    type: "string",
    default: String(DEFAULT_REPEAT),
  });

  pi.registerFlag("ralphy-continue-on-failure", {
    description: "Continue the Ralphy loop after assistant/runtime failures",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ralphy-verifier-model", {
    description: "Optional verifier model in provider/model form, e.g. anthropic/claude-sonnet-4-5",
    type: "string",
  });

  pi.registerCommand("ralphy-loop", {
    description: "Repeat a task with cleared LLM context between iterations",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until idle before starting a Ralphy loop.", "warning");
        return;
      }

      if (stateRef.current?.active) {
        ctx.ui.notify("A Ralphy loop is already running. Use /ralphy-stop first.", "warning");
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

      const parsed = parseLoopArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }

      startLoop(pi, ctx, stateRef, parsed);
    },
  });

  pi.registerCommand("ralphy-stop", {
    description: "Stop the active Ralphy loop",
    handler: async (_args, ctx) => {
      const state = stateRef.current;
      if (!state?.active) {
        ctx.ui.notify("No active Ralphy loop", "info");
        return;
      }

      clearState(ctx, stateRef);
      if (!ctx.isIdle()) {
        ctx.abort();
      }
      ctx.ui.notify("Stopped Ralphy loop", "info");
    },
  });

  pi.registerCommand("ralphy-status", {
    description: "Show the current Ralphy loop status",
    handler: async (_args, ctx) => {
      const state = stateRef.current;
      if (!state?.active) {
        ctx.ui.notify("No active Ralphy loop", "info");
        return;
      }

      const failureMode = state.continueOnFailure ? "continue-on-failure" : "fail-fast";
      ctx.ui.notify(
        `Ralphy ${state.currentIteration}/${state.totalIterations} (${failureMode}): ${summarizeTask(state.task, 160)}`,
        "info",
      );
    },
  });

  pi.on("session_start", async (event, ctx) => {
    clearState(ctx, stateRef);

    if (event.reason !== "startup") return;
    if (!ctx.isIdle()) return;
    if (!ctx.model) return;
    if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return;

    const taskFlag = pi.getFlag("ralphy-task");
    const repeatFlag = pi.getFlag("ralphy-repeat");
    const continueOnFailureFlag = pi.getFlag("ralphy-continue-on-failure");

    if (typeof taskFlag !== "string" || !taskFlag.trim()) {
      return;
    }

    const repeat = typeof repeatFlag === "string" ? parsePositiveInteger(repeatFlag) : DEFAULT_REPEAT;
    if (!repeat) {
      ctx.ui.notify(`--ralphy-repeat must be an integer between 1 and ${MAX_REPEAT}`, "error");
      return;
    }

    startLoop(pi, ctx, stateRef, {
      task: taskFlag.trim(),
      repeat,
      continueOnFailure: continueOnFailureFlag === true,
    });
  });

  pi.on("before_agent_start", async (event) => {
    const state = stateRef.current;
    if (!state?.active) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${RALPHY_LOOP_SYSTEM_PROMPT}`,
    };
  });

  // This uses timestamps because the current context hook exposes AgentMessage[]
  // without stable per-iteration message ids. A more precise boundary would need
  // explicit core support from pi.
  pi.on("context", async (event) => {
    const state = stateRef.current;
    if (!state?.active || state.iterationStartAt === 0) return;

    const filteredMessages = event.messages.filter((message) => message.timestamp >= state.iterationStartAt);
    return { messages: filteredMessages };
  });

  pi.on("turn_end", async (event, ctx) => {
    const state = stateRef.current;
    if (!state?.active) return;
    if (event.message.role !== "assistant") return;

    const stopReason = event.message.stopReason;
    if (stopReason === "toolUse") {
      return;
    }

    state.iterationHadError = shouldTreatStopReasonAsFailure(stopReason);

    if (!state.iterationHadError && stopReason === "stop") {
      const gitVerification = await getGitVerification(pi, ctx.cwd);
      if (gitVerification && !gitVerification.ok) {
        state.verificationNudges += 1;

        if (state.verificationNudges >= MAX_VERIFICATION_NUDGES) {
          state.iterationHadError = true;
          ctx.ui.notify(`Ralphy git verification failed: ${gitVerification.reason}`, "warning");
        } else {
          ctx.ui.notify(`Ralphy git verification requested more work: ${gitVerification.reason}`, "warning");
          pi.sendUserMessage(getFollowUpPrompt(gitVerification.reason), { deliverAs: "followUp" });
          return;
        }
      }

      if (!state.iterationHadError) {
        const assistantText = extractAssistantText(event.message.content, MAX_VERIFIER_ASSISTANT_CHARS * 2);
        const verification = await verifyIterationCompletion(
          pi,
          ctx,
          state.task,
          assistantText,
          gitVerification?.summary,
        );

        if (!verification) {
          state.verificationNudges += 1;

          if (state.verificationNudges >= MAX_VERIFICATION_NUDGES) {
            state.iterationHadError = true;
            ctx.ui.notify("Ralphy verifier could not determine completion reliably", "warning");
          } else {
            ctx.ui.notify("Ralphy verifier was inconclusive. Requesting another completion pass.", "warning");
            pi.sendUserMessage(RALPHY_VERIFIER_FALLBACK_CONTINUE_PROMPT, { deliverAs: "followUp" });
            return;
          }
        } else if (!verification.done) {
          state.verificationNudges += 1;

          if (state.verificationNudges >= MAX_VERIFICATION_NUDGES) {
            state.iterationHadError = true;
            ctx.ui.notify(`Ralphy verifier could not confirm completion: ${verification.reason}`, "warning");
          } else {
            ctx.ui.notify(`Ralphy verifier requested more work: ${verification.reason}`, "warning");
            const continuePrompt = verification.continuePrompt || RALPHY_VERIFIER_FALLBACK_CONTINUE_PROMPT;
            pi.sendUserMessage(truncateEnd(continuePrompt, MAX_VERIFIER_CONTINUE_PROMPT_CHARS), { deliverAs: "followUp" });
            return;
          }
        }
      }
    }

    if (state.iterationHadError && !state.continueOnFailure) {
      clearState(ctx, stateRef);
      ctx.ui.notify("Ralphy loop stopped after a failed iteration", "warning");
      return;
    }

    if (state.currentIteration >= state.totalIterations) {
      clearState(ctx, stateRef);
      ctx.ui.notify(`Ralphy loop completed (${state.totalIterations}/${state.totalIterations})`, "info");
      return;
    }

    state.currentIteration += 1;
    setStatus(ctx, state);
    ctx.ui.notify(`Continuing Ralphy loop (${state.currentIteration}/${state.totalIterations})`, "info");
    startIteration(state, pi, "followUp");
  });
}
