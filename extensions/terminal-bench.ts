/**
 * Terminal-Bench Extension
 *
 * Optimizes pi for Terminal-Bench 2.0 benchmark performance by porting
 * key strategies from the Meta-Harness agent:
 *
 * 1. **Environment Bootstrapping**: Gathers a sandbox snapshot (files,
 *    languages, package managers, memory) before the first LLM call and
 *    injects it into the system prompt. Saves 2-5 early exploration turns.
 *
 * 2. **Completion Verification**: When the agent signals it is done, injects
 *    a self-verification checklist as a follow-up to reduce false completions.
 *
 * 3. **Prompt Optimizations**: Appends Terminal-Bench-specific instructions
 *    to the system prompt (no human help, programmatic multimedia handling,
 *    minimal state changes, cleanup).
 *
 * 4. **tmux Tools**: Registers `tmux_send` and `tmux_read` tools for
 *    keystroke-level terminal interaction. Enables the agent to drive
 *    interactive programs (vim, gdb, interactive prompts, Ctrl+C, etc.)
 *    that pi's standard `bash` tool cannot handle. Includes marker-based
 *    polling for early completion detection.
 *
 * 5. **Aggressive Output Truncation**: Reduces bash output from 50KB/2000
 *    lines to 30KB/1500 lines when active, so more turns fit in the
 *    context window.
 *
 * The extension is gated behind the --terminal-bench flag and does nothing
 * unless that flag is provided. This avoids side effects during normal usage.
 *
 * Usage:
 *   pi -e ./terminal-bench.ts --terminal-bench
 *
 * Works best with:
 *   pi -e ./terminal-bench.ts --terminal-bench --thinking high
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const TBENCH_MAX_BYTES = 30 * 1024;
const TBENCH_MAX_LINES = 1500;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const TMUX_KILL_TIMEOUT_MS = 3_000;
const TMUX_START_TIMEOUT_MS = 5_000;
const TMUX_CAPTURE_TIMEOUT_MS = 5_000;
const TMUX_MARKER_SEND_TIMEOUT_MS = 5_000;
const TMUX_SEND_TIMEOUT_MS = 10_000;
const TMUX_MARKER_PREFIX = "__PI_TBENCH_END__";
const MAX_CONTRACT_ITEMS = 10;
const MAX_RECENT_TOOL_ACTIONS = 8;

const TERMINAL_BENCH_GUIDELINES = `
## Terminal-Bench Rules

- You must complete the entire task WITHOUT any human intervention. Do not ask
  clarifying questions or wait for human input. Make reasonable assumptions and
  proceed.
- You do NOT have eyes or ears. For multimedia files (images, audio, video),
  use programmatic or CLI tools to inspect them (e.g. file, identify, ffprobe,
  exiftool, python scripts). Never guess content from filenames alone.
- Keep state changes minimal, but preserve required final artifacts, services,
  processes, sockets, ports, and files exactly as requested.
- Prefer short, targeted commands. Avoid long blocking commands; if something
  may take a while, inspect intermediate output instead of waiting blindly.
- First identify the exact observable contract: required paths, filenames,
  sockets, ports, hashes/checksums, command outputs, versions, modes,
  thresholds, counts, artifacts, and final running state. Implement those exact
  facts; do not substitute approximate equivalents.
- Before finishing, verify from the user/verifier perspective with targeted
  checks. If tests/specs are present, inspect them to understand the observable
  contract; compare actual final values against that contract.
- If verification or cleanup may be destructive, perform it only on temporary
  copies.
- For interactive programs or commands that need special key sequences
  (Ctrl+C, Ctrl+D, arrow keys, etc.), use the tmux_send tool instead of bash.
  Use tmux_read to inspect the current terminal state at any time.
`.trim();

const COMPLETION_CHECKLIST = (
  taskHint: string,
  terminalState: string,
  contractItems: string[],
  recentToolActions: string[],
) => {
  const contractSection =
    contractItems.length > 0
      ? `\n\nExplicit contract items detected from the task:\n${contractItems.map((item) => `- ${item}`).join("\n")}`
      : "";

  const recentActionsSection =
    recentToolActions.length > 0
      ? `\n\nRecent tool activity:\n${recentToolActions.map((item) => `- ${item}`).join("\n")}`
      : "";

  return `
VERIFICATION REQUIRED: You signaled that you are finished. Before moving on,
review this checklist carefully.

Original task:
${taskHint}${contractSection}${recentActionsSection}

Last terminal output:
${terminalState}

Checklist — mark each as DONE or TODO:
- Exact observable contract satisfied, including required paths/files/ports/
  sockets/artifacts/outputs/final state? [TODO/DONE]
- Targeted verification run from the user/verifier perspective, with actual
  values compared against the contract? [TODO/DONE]
- Required final state preserved, and any destructive checks/cleanup limited to
  temporary copies? [TODO/DONE]

If everything is DONE, proceed. If any item is TODO, fix it first.
`.trim();
};

const BOOTSTRAP_COMMAND = [
  "echo '@@PWD@@'; pwd",
  "echo '@@LS@@'; (ls -la 2>/dev/null | sed -n '1,31p') || true",
  "echo '@@LANG@@'",
  "(python3 --version 2>&1 || echo 'python3: not found')",
  "(gcc --version 2>&1 | head -1 || echo 'gcc: not found')",
  "(g++ --version 2>&1 | head -1 || echo 'g++: not found')",
  "(node --version 2>&1 || echo 'node: not found')",
  "(java -version 2>&1 | head -1 || echo 'java: not found')",
  "(rustc --version 2>&1 || echo 'rustc: not found')",
  "(go version 2>&1 || echo 'go: not found')",
  "echo '@@PKG@@'",
  "(pip3 --version 2>&1 || echo 'pip3: not found')",
  "(pip --version 2>&1 || echo 'pip: not found')",
  "(apt-get --version 2>&1 | head -1 || echo 'apt-get: not found')",
  "(npm --version 2>&1 || echo 'npm: not found')",
  "(cargo --version 2>&1 || echo 'cargo: not found')",
  "echo '@@MEM@@'; free -h 2>/dev/null | head -2 || true",
].join("; ");

interface BootstrapSections {
  [key: string]: string;
}

function parseBootstrapOutput(stdout: string): BootstrapSections {
  const sections: BootstrapSections = {};
  let currentKey: string | null = null;
  const currentLines: string[] = [];

  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@") && line.endsWith("@@")) {
      if (currentKey) {
        sections[currentKey] = currentLines.join("\n");
        currentLines.length = 0;
      }
      currentKey = line.replace(/^@@|@@$/g, "");
    } else {
      currentLines.push(line);
    }
  }
  if (currentKey) {
    sections[currentKey] = currentLines.join("\n");
  }
  return sections;
}

function formatSnapshot(sections: BootstrapSections): string {
  const parts: string[] = [];

  if (sections.LS) {
    const lsLines = sections.LS.trim().split("\n");
    if (lsLines.length <= 1 || (lsLines.length === 2 && lsLines[0].includes("total 0"))) {
      parts.push("Directory contents: (empty)");
    } else if (lsLines.length > 30) {
      parts.push(
        `Directory contents (${lsLines.length} entries):\n${lsLines.slice(0, 25).join("\n")}\n... (${lsLines.length - 25} more files)`,
      );
    } else {
      parts.push(`Directory contents:\n${sections.LS.trim()}`);
    }
  }

  if (sections.LANG) {
    const langLines = sections.LANG.trim()
      .split("\n")
      .filter((line) => line.trim());
    if (langLines.length > 0) {
      parts.push(`Available languages/tools: ${langLines.join("; ")}`);
    }
  }

  if (sections.PKG) {
    const pkgLines = sections.PKG.trim()
      .split("\n")
      .filter((line) => line.trim());
    if (pkgLines.length > 0) {
      parts.push(`Package managers: ${pkgLines.join("; ")}`);
    }
  }

  if (sections.MEM) {
    const mem = sections.MEM.trim();
    if (mem) {
      parts.push(`Memory: ${mem}`);
    }
  }

  if (parts.length === 0) {
    return "";
  }

  return `[Environment Snapshot]\n${parts.join("\n")}`;
}

function isCompletionStatement(text: string): boolean {
  const lower = text.toLowerCase();
  const trimmed = lower.trim();

  const patterns = [
    /\b(?:the\s+)?task\s+is\s+(?:now\s+)?complete\b/,
    /\b(?:the\s+)?task\s+is\s+(?:now\s+)?done\b/,
    /\b(?:the\s+)?task\s+has\s+been\s+completed\b/,
    /\bi(?:'ve|'ve|\s+have)\s+completed\s+the\s+task\b/,
    /\b(?:the\s+)?task\s+is\s+(?:now\s+)?finished\b/,
    /\b(?:the\s+)?solution\s+is\s+(?:now\s+)?complete\b/,
    /\ball\s+requirements\s+(?:have\s+been|are(?:\s+now)?)\s+met\b/,
  ];

  const negatingPrefixes = [
    "check if",
    "check whether",
    "verify if",
    "verify whether",
    "verify that",
    "ensure that",
    "ensure the",
    "confirm that",
    "confirm whether",
    "once the",
    "when the",
    "if the",
    "whether the",
    "before the",
    "until the",
    "not yet",
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(lower);
    if (!match) continue;

    const preContext = lower.slice(Math.max(0, match.index - 40), match.index);
    const isNegated = negatingPrefixes.some((prefix) => preContext.includes(prefix));
    if (!isNegated) {
      return true;
    }
  }

  if (/^(done|completed|configured|fixed|implemented)\b/.test(trimmed)) {
    const completionLead = trimmed.slice(0, 160);
    const continuationHints = ["next", "remaining", "still need", "need to", "then i", "continue"];
    const looksIncomplete = continuationHints.some((hint) => completionLead.includes(hint));
    if (!looksIncomplete) {
      return true;
    }
  }

  return false;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pushUnique(items: string[], value: string): void {
  const normalized = normalizeLine(value);
  if (!normalized) return;
  if (items.some((item) => normalizeLine(item).toLowerCase() === normalized.toLowerCase())) {
    return;
  }
  items.push(normalized);
}

function extractContractItems(taskText: string): string[] {
  const items: string[] = [];
  const cleanText = taskText
    .replace(/<file name="[^"]+">/g, "")
    .replace(/<\/file>/g, "")
    .trim();

  let inFence = false;
  for (const rawLine of cleanText.split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }

    if (inFence || rawLine.startsWith("    ") || rawLine.startsWith("\t")) {
      pushUnique(items, `User-visible command/workflow: ${trimmed}`);
    }
  }

  for (const match of cleanText.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    pushUnique(items, `Required URL: ${match[0]}`);
  }

  for (const match of cleanText.matchAll(/(^|[\s"'`(])((?:\/[A-Za-z0-9._-]+)+)/g)) {
    pushUnique(items, `Required path/file: ${match[2]}`);
  }

  for (const match of cleanText.matchAll(/\bport\s+(\d{2,5})\b/gi)) {
    pushUnique(items, `Required port/service: port ${match[1]}`);
  }

  const clauses = cleanText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => normalizeLine(part))
    .filter(Boolean);
  const clausePattern =
    /\b(i(?:'ll| will)|if i run|you should|exactly|at least|at most|no more than|greater than|less than|under|over|cpu|gpu|version|named|called|compile|curl|git clone|git push|solver_mode|cpu_only|iterations?)\b/i;

  for (const clause of clauses) {
    if (clausePattern.test(clause) && clause.length <= 200) {
      pushUnique(items, clause);
    }
  }

  return items.slice(0, MAX_CONTRACT_ITEMS);
}

function summarizeToolAction(toolName: string, args: unknown): string {
  if (toolName === "bash" && args && typeof args === "object" && "command" in args) {
    const command = typeof args.command === "string" ? args.command : "";
    const firstLine = command
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return `bash: ${(firstLine ?? command).slice(0, 140)}`;
  }

  if ((toolName === "read" || toolName === "write" || toolName === "edit") && args && typeof args === "object" && "path" in args) {
    const path = typeof args.path === "string" ? args.path : "(unknown path)";
    return `${toolName}: ${path}`;
  }

  return `${toolName}`;
}

function truncateOutput(output: string, maxBytes: number, maxLines: number): string {
  const lines = output.split("\n");

  if (lines.length <= maxLines && Buffer.byteLength(output, "utf-8") <= maxBytes) {
    return output;
  }

  const kept: string[] = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) break;
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }

  const totalLines = lines.length;
  const shownLines = kept.length;

  if (shownLines === 0 && output) {
    const tail = Buffer.from(output, "utf-8").subarray(-maxBytes).toString("utf-8");
    return `[Showing last ${Buffer.byteLength(tail, "utf-8")} bytes of oversized output]\n${tail}`;
  }

  if (shownLines < totalLines) {
    return `[Showing last ${shownLines} of ${totalLines} lines]\n${kept.join("\n")}`;
  }
  return kept.join("\n");
}

function stripMarkerLines(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.includes(TMUX_MARKER_PREFIX))
    .join("\n");
}

function countLinesUpTo(text: string, maxLines: number): number {
  let lines = 1;
  let index = -1;
  while (lines <= maxLines) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) break;
    lines += 1;
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("terminal-bench", {
    description: "Enable Terminal-Bench optimizations",
    type: "boolean",
    default: false,
  });

  let enabled = false;
  let envSnapshot = "";
  let completionPending = false;
  let lastBashOutput = "";
  let tmuxSession = "";
  let markerSeq = 0;
  let recentToolActions: string[] = [];

  function resetRuntimeState(): void {
    envSnapshot = "";
    completionPending = false;
    lastBashOutput = "";
    markerSeq = 0;
    recentToolActions = [];
  }

  async function cleanupTmuxSession(): Promise<void> {
    const session = tmuxSession;
    tmuxSession = "";
    if (!session) return;
    await pi.exec("tmux", ["kill-session", "-t", session], {
      timeout: TMUX_KILL_TIMEOUT_MS,
    }).catch(() => {});
  }

  pi.on("session_start", async (_event, ctx) => {
    await cleanupTmuxSession();
    resetRuntimeState();
    enabled = pi.getFlag("terminal-bench") === true;
    if (!enabled) return;

    try {
      const result = await pi.exec("bash", ["-c", BOOTSTRAP_COMMAND], {
        cwd: ctx.cwd,
        timeout: BOOTSTRAP_TIMEOUT_MS,
      });
      if (result.code === 0 && result.stdout) {
        const sections = parseBootstrapOutput(result.stdout);
        envSnapshot = formatSnapshot(sections);
      }
    } catch {
    }

    const sessionName = `pi-tbench-${process.pid}`;
    try {
      await pi.exec("tmux", ["kill-session", "-t", sessionName], {
        timeout: TMUX_KILL_TIMEOUT_MS,
      }).catch(() => {});

      await pi.exec("tmux", ["new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50", "-c", ctx.cwd], {
        timeout: TMUX_START_TIMEOUT_MS,
      });
      tmuxSession = sessionName;
      await sleep(200);
    } catch {
    }
  });

  pi.on("session_shutdown", async () => {
    enabled = false;
    resetRuntimeState();
    await cleanupTmuxSession();
  });

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;

    let systemPrompt = event.systemPrompt;
    systemPrompt += `\n\n${TERMINAL_BENCH_GUIDELINES}`;

    if (envSnapshot) {
      systemPrompt += `\n\n${envSnapshot}`;
    }

    if (tmuxSession) {
      systemPrompt += `\n\n[tmux session "${tmuxSession}" is available. Use tmux_send/tmux_read for interactive programs.]`;
    }

    return { systemPrompt };
  });

  if (pi.getFlag("terminal-bench") === true) {
    pi.registerTool({
      name: "tmux_send",
    label: "tmux Send",
    description:
      "Send keystrokes to the tmux terminal session and return the resulting output. " +
      "Use this for interactive programs, special key sequences (Ctrl+C, Ctrl+D, arrow keys), " +
      "or when you need to observe the terminal state after a command. " +
      "Most shell commands should end with a newline (\\n) to execute. " +
      "For special keys, use tmux key names: C-c for Ctrl+C, C-d for Ctrl+D, " +
      "Enter for Return, Escape for Esc, Up/Down/Left/Right for arrow keys. " +
      "Set wait_seconds to control how long to wait for output (default: 1). " +
      "For fast commands (cd, echo) use 0.1. For slow commands (make, compilation) use higher values. " +
      "Never set wait_seconds above 30; prefer to poll with tmux_read instead.",
    promptSnippet: "Send keystrokes to tmux and capture terminal output",
    parameters: Type.Object({
      keys: Type.String({
        description:
          "Keystrokes to send. Text is sent verbatim. " +
          "End shell commands with \\n. " +
          "For special keys use tmux names: C-c, C-d, Enter, Escape, Up, Down, Left, Right, Tab, BSpace.",
      }),
      wait_seconds: Type.Optional(
        Type.Number({
          description: "Seconds to wait for output (default: 1.0, max: 30). Use 0.1 for instant commands.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!enabled) {
        throw new Error("Terminal-Bench mode is not enabled.");
      }
      if (!tmuxSession) {
        throw new Error("No tmux session available. Is tmux installed?");
      }
      if (signal?.aborted) {
        throw new Error("Aborted");
      }

      const waitSeconds = Math.min(Math.max(params.wait_seconds ?? 1.0, 0.05), 30);

      const sendResult = await pi.exec("tmux", ["send-keys", "-t", tmuxSession, params.keys], {
        timeout: TMUX_SEND_TIMEOUT_MS,
      });
      if (sendResult.code !== 0) {
        throw new Error(`tmux send-keys failed: ${sendResult.stderr || "unknown error"}`);
      }

      markerSeq++;
      const marker = `${TMUX_MARKER_PREFIX}${markerSeq}`;
      await pi.exec("tmux", ["send-keys", "-t", tmuxSession, `echo '${marker}'`, "Enter"], {
        timeout: TMUX_MARKER_SEND_TIMEOUT_MS,
      });

      const startTime = Date.now();
      const deadlineMs = waitSeconds * 1000;
      let paneContent = "";

      await sleep(Math.min(300, deadlineMs), signal);

      while (Date.now() - startTime < deadlineMs) {
        if (signal?.aborted) break;

        const captureResult = await pi.exec("tmux", ["capture-pane", "-t", tmuxSession, "-p", "-S", `-${TBENCH_MAX_LINES}`], {
          timeout: TMUX_CAPTURE_TIMEOUT_MS,
        });
        paneContent = captureResult.stdout || "";

        if (paneContent.includes(marker)) {
          break;
        }

        await sleep(500, signal);
      }

      const finalCapture = await pi.exec("tmux", ["capture-pane", "-t", tmuxSession, "-p", "-S", `-${TBENCH_MAX_LINES}`], {
        timeout: TMUX_CAPTURE_TIMEOUT_MS,
      });
      paneContent = finalCapture.stdout || "";

      const cleanOutput = stripMarkerLines(paneContent).trim();
      const truncated = truncateOutput(cleanOutput, TBENCH_MAX_BYTES, TBENCH_MAX_LINES);

      return {
        content: [{ type: "text", text: truncated || "(no output)" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "tmux_read",
    label: "tmux Read",
    description:
      "Capture the current content of the tmux terminal pane without sending any keystrokes. " +
      "Use this to check the state of a running program, inspect output after waiting, " +
      "or read the terminal before deciding what to do next.",
    promptSnippet: "Read current tmux terminal content without sending input",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (!enabled) {
        throw new Error("Terminal-Bench mode is not enabled.");
      }
      if (!tmuxSession) {
        throw new Error("No tmux session available. Is tmux installed?");
      }
      if (signal?.aborted) {
        throw new Error("Aborted");
      }

      const captureResult = await pi.exec("tmux", ["capture-pane", "-t", tmuxSession, "-p", "-S", `-${TBENCH_MAX_LINES}`], {
        timeout: TMUX_CAPTURE_TIMEOUT_MS,
      });

      if (captureResult.code !== 0) {
        throw new Error(`tmux capture-pane failed: ${captureResult.stderr || "unknown error"}`);
      }

      const cleanOutput = stripMarkerLines(captureResult.stdout || "").trim();
      const truncated = truncateOutput(cleanOutput, TBENCH_MAX_BYTES, TBENCH_MAX_LINES);

      return {
        content: [{ type: "text", text: truncated || "(empty terminal)" }],
        details: {},
      };
    },
  });

  }

  pi.on("tool_execution_start", async (event) => {
    if (!enabled) return;

    recentToolActions.push(summarizeToolAction(event.toolName, event.args));
    if (recentToolActions.length > MAX_RECENT_TOOL_ACTIONS) {
      recentToolActions = recentToolActions.slice(-MAX_RECENT_TOOL_ACTIONS);
    }
  });

  pi.on("tool_result", async (event) => {
    if (!enabled) return;

    if (event.toolName === "bash" && !event.isError) {
      const textBlocks = event.content.filter((content): content is { type: "text"; text: string } => content.type === "text");

      for (const block of textBlocks) {
        if (block.text) {
          lastBashOutput = `${lastBashOutput}\n${block.text}`.slice(-2000);
        }
      }

      for (const block of textBlocks) {
        const bytes = Buffer.byteLength(block.text, "utf-8");
        const lines = countLinesUpTo(block.text, TBENCH_MAX_LINES + 1);

        if (bytes > TBENCH_MAX_BYTES || lines > TBENCH_MAX_LINES) {
          block.text = truncateOutput(block.text, TBENCH_MAX_BYTES, TBENCH_MAX_LINES);
        }
      }

      return { content: event.content };
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!enabled) return;
    if (event.message.role !== "assistant") return;

    const content = event.message.content;
    if (!Array.isArray(content)) return;

    const textBlocks = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && "type" in block && block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");

    if (!textBlocks) return;
    if (event.message.stopReason && event.message.stopReason !== "stop") return;

    const isCompletion = isCompletionStatement(textBlocks);

    if (isCompletion && !completionPending) {
      completionPending = true;

      const entries = ctx.sessionManager.getBranch();
      let taskHint = "(not available in context)";
      for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "user") {
          const message = entry.message;
          if (typeof message.content === "string") {
            taskHint = message.content.slice(0, 2000);
          } else if (Array.isArray(message.content)) {
            const texts = message.content
              .filter(
                (block): block is { type: "text"; text: string } =>
                  typeof block === "object" && block !== null && "type" in block && block.type === "text",
              )
              .map((block) => block.text);
            taskHint = texts.join("\n").slice(0, 2000);
          }
          break;
        }
      }

      const contractItems = extractContractItems(taskHint);
      const checklist = COMPLETION_CHECKLIST(
        taskHint,
        lastBashOutput.slice(-1000) || "(no recent output)",
        contractItems,
        recentToolActions,
      );
      if (ctx.isIdle()) {
        pi.sendUserMessage(checklist);
      } else {
        pi.sendUserMessage(checklist, { deliverAs: "steer" });
      }
    } else if (!isCompletion) {
      completionPending = false;
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);

    if (signal?.aborted) {
      finish();
      return;
    }

    signal?.addEventListener("abort", finish, { once: true });
  });
}
