import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface LoopState {
  active: boolean;
  task: string;
  totalIterations: number;
  currentIteration: number;
  continueOnFailure: boolean;
  iterationStartAt: number;
  iterationHadError: boolean;
}

interface ParsedLoopArgs {
  task: string;
  repeat: number;
  continueOnFailure: boolean;
}

const STATUS_KEY = "ralphy-loop";
const DEFAULT_REPEAT = 1;
const MAX_REPEAT = 10_000;
const RALPHY_LOOP_SYSTEM_PROMPT = `You are running in autonomous execution mode.

Rules:
- No human interaction is available. Do not ask clarifying questions, do not ask for confirmation, and do not wait for user input.
- Work until the task is actually fulfilled.
- If information is missing, inspect the repository, files, logs, configs, tests, and available tools yourself.
- Do not stop with a partial plan or with “I need more information” when that information can be obtained from the workspace or tools.
- Do not defer unresolved work. Treat this run as responsible for completing the task.
- Before finishing, verify that the task requirements have been satisfied.
- If the workspace is a git repository, finish by creating a commit for the completed work and pushing the current branch. Do not treat the task as complete before commit and push have succeeded, unless git or the remote is unavailable and you have verified that programmatically.`;

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REPEAT) return undefined;
  return parsed;
}

function summarizeTask(task: string, maxLength = 48): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function parseLoopArgs(args: string): ParsedLoopArgs | { error: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "Usage: /ralphy-loop <repeat> <task> or /ralphy-loop --repeat <n> <task>" };
  }

  const tokens = trimmed.split(/\s+/);
  let repeat = DEFAULT_REPEAT;
  let continueOnFailure = false;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === "--continue-on-failure") {
      continueOnFailure = true;
      index++;
      continue;
    }

    if (token === "--repeat") {
      const value = tokens[index + 1];
      if (!value) {
        return { error: "--repeat requires a value" };
      }
      const parsed = parsePositiveInteger(value);
      if (!parsed) {
        return { error: `--repeat must be an integer between 1 and ${MAX_REPEAT}` };
      }
      repeat = parsed;
      index += 2;
      continue;
    }

    if (index === 0) {
      const parsed = parsePositiveInteger(token);
      if (parsed) {
        repeat = parsed;
        index++;
        continue;
      }
    }

    break;
  }

  const task = tokens.slice(index).join(" ").trim();
  if (!task) {
    return { error: "Missing task text" };
  }

  return { task, repeat, continueOnFailure };
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
        `Ralphy ${state.currentIteration}/${state.totalIterations} (${failureMode}): ${state.task}`,
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

    state.iterationHadError = stopReason === "error" || stopReason === "aborted";

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
