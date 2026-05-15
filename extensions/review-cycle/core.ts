export const REVIEW_CYCLE_STATUS_KEY = "review-cycle";
export const DEFAULT_REVIEW_TIMEOUT_MS = 600_000;
export const DEFAULT_REVIEW_TOOLS = ["read", "grep", "find", "ls", "bash"] as const;
export const MAX_REVIEW_PROMPT_SECTION_CHARS = 20_000;
export const MAX_APPLY_REVIEW_CHARS = 24_000;
export const MAX_TASK_SUMMARY_CHARS = 48;

export interface ModelRef {
  provider: string;
  id: string;
}

export type ReviewCycleCommand =
  | { kind: "start"; task: string; reviewerModel?: ModelRef }
  | { kind: "status" }
  | { kind: "stop" }
  | { error: string };

export interface GitBaseline {
  isGitRepo: boolean;
  head?: string;
  status: string;
  dirty: boolean;
}

export interface ChangeSnapshot {
  isGitRepo: boolean;
  baselineHead?: string;
  status: string;
  diffStat: string;
  diff: string;
  committedChanges: string;
  untrackedFiles: string[];
  notes: string[];
}

export interface ReviewerPromptInput {
  task: string;
  implementationSummary?: string;
  baseline: GitBaseline;
  changes: ChangeSnapshot;
}

export interface ApplyReviewPromptInput {
  task: string;
  review: string;
}

export const IMPLEMENTATION_SYSTEM_PROMPT = `Review-cycle implementation phase:
- Implement the user's request normally and autonomously.
- Inspect the repository as needed; do not ask the user for clarification unless the task is impossible without external information.
- Before stopping, run the most relevant local verification you can and mention the concrete result.
- Do not perform the fresh-context code review yourself; a separate reviewer agent will run after this implementation phase.`;

export const APPLY_REVIEW_SYSTEM_PROMPT = `Review-cycle apply phase:
- You are receiving code-review feedback from a separate fresh-context reviewer agent.
- Apply every correct, high-value finding from the review.
- If you intentionally reject a suggestion, state the concrete reason.
- Re-run the most relevant local verification before stopping and mention the concrete result.
- Do not ask the user for confirmation; finish the review-application pass autonomously.`;

export const REVIEWER_SYSTEM_PROMPT = `You are a strict code-review agent running with a completely fresh context.

Rules:
- Review only; do not modify files.
- Use tools only for read-only inspection. Bash commands must be read-only (for example: git status, git diff, git show, grep, test commands that do not rewrite files only when safe).
- Review all current changes in scope, including committed changes since the baseline commit, staged changes, unstaged changes, and untracked files.
- Prioritize concrete defects over style preferences.
- Do not ask the user questions. If something is ambiguous, state the assumption and review conservatively.

Return Markdown in this structure:
## Verdict
One of: APPROVE, APPROVE_WITH_NOTES, or CHANGES_REQUESTED.

## Findings
Bullet list. Each finding should include severity, file/line when possible, the problem, and a specific suggested fix. If there are no mandatory findings, say so explicitly.

## Verification gaps
List missing or weak verification, or say none.

## Notes
Optional short positive notes or non-blocking improvements.`;

function tokenizeArgs(input: string): string[] | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (const char of trimmed) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escape) current += "\\";
  if (quote) return { error: "Unterminated quoted string" };
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function parseModelRef(value: string | undefined): ModelRef | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return undefined;
  }

  return {
    provider: trimmed.slice(0, slashIndex),
    id: trimmed.slice(slashIndex + 1),
  };
}

function parseStartArgs(tokens: string[]): ReviewCycleCommand {
  let reviewerModel: ModelRef | undefined;
  const taskTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token === "--reviewer-model") {
      const value = tokens[index + 1];
      const parsed = parseModelRef(value);
      if (!value || !parsed) {
        return { error: "--reviewer-model must be in provider/model form" };
      }
      reviewerModel = parsed;
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      return { error: `Unknown flag: ${token}` };
    }

    taskTokens.push(...tokens.slice(index));
    break;
  }

  const task = taskTokens.join(" ").trim();
  if (!task) {
    return { error: "Usage: /review-cycle [on] [--reviewer-model provider/model] <task>" };
  }

  return { kind: "start", task, reviewerModel };
}

export function parseReviewCycleArgs(args: string): ReviewCycleCommand {
  const tokenized = tokenizeArgs(args);
  if (!Array.isArray(tokenized)) return { error: tokenized.error };
  if (tokenized.length === 0) {
    return { error: "Usage: /review-cycle [on|status|stop] [--reviewer-model provider/model] <task>" };
  }

  const [first, ...rest] = tokenized;
  const command = first.toLowerCase();

  if (command === "status") return { kind: "status" };
  if (command === "stop" || command === "off") return { kind: "stop" };
  if (command === "on" || command === "start") return parseStartArgs(rest);

  return parseStartArgs(tokenized);
}

export function summarizeTask(task: string, maxLength = MAX_TASK_SUMMARY_CHARS): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…";
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";

  const marker = `\n… [${text.length - maxChars} chars omitted] …\n`;
  if (marker.length >= maxChars) return `${text.slice(0, maxChars - 1)}…`;

  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

export function formatList(items: string[], maxItems: number): string {
  if (items.length === 0) return "(none)";
  const shown = items.slice(0, maxItems);
  const omitted = items.length - shown.length;
  return omitted > 0 ? `${shown.join("\n")}\n… (${omitted} more)` : shown.join("\n");
}

export function extractAssistantText(content: unknown, maxChars = Number.POSITIVE_INFINITY): string {
  if (typeof content === "string") {
    return Number.isFinite(maxChars) ? truncateMiddle(content.trim(), maxChars) : content.trim();
  }

  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  let remaining = maxChars;
  let truncated = false;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const maybeBlock = block as { type?: unknown; text?: unknown };
    if (maybeBlock.type !== "text" || typeof maybeBlock.text !== "string") continue;

    const text = maybeBlock.text;
    if (Number.isFinite(maxChars)) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (text.length > remaining) {
        parts.push(text.slice(0, remaining));
        truncated = true;
        break;
      }
      remaining -= text.length + 1;
    }
    parts.push(text);
  }

  const joined = parts.join("\n").trim();
  return truncated && Number.isFinite(maxChars) ? truncateMiddle(joined, maxChars) : joined;
}

export function shouldTreatStopReasonAsFailure(stopReason: string | undefined): boolean {
  return stopReason === "error" || stopReason === "aborted" || stopReason === "length";
}

function formatOptionalSection(title: string, body: string | undefined): string | undefined {
  const trimmed = body?.trim();
  if (!trimmed) return undefined;
  return `### ${title}\n${truncateMiddle(trimmed, MAX_REVIEW_PROMPT_SECTION_CHARS)}`;
}

export function buildReviewerUserPrompt(input: ReviewerPromptInput): string {
  const baselineStatus = input.baseline.status.trim() || "(unknown)";
  const status = input.changes.status.trim() || "(unknown)";
  const notes = [...input.changes.notes];
  if (input.baseline.isGitRepo && input.baseline.dirty) {
    notes.push("The repository already had uncommitted changes before the implementation phase. Review scope may include pre-existing work as well as this run's work.");
  }
  if (!input.changes.isGitRepo) {
    notes.push("This workspace is not a git repository, so exact change detection is degraded. Use the task and implementation summary to inspect likely touched files.");
  }

  const sections = [
    "Run a fresh-context code review for the implementation described below. Do not edit files.",
    `## Original request\n${input.task.trim()}`,
    input.implementationSummary ? `## Implementation agent final message\n${truncateMiddle(input.implementationSummary, 8_000)}` : undefined,
    `## Baseline\n- git repository: ${input.baseline.isGitRepo ? "yes" : "no"}\n- baseline commit: ${input.baseline.head ?? "(none/unknown)"}\n- dirty at start: ${input.baseline.dirty ? "yes" : "no"}\n\n\`\`\`text\n${truncateMiddle(baselineStatus, 4_000)}\n\`\`\``,
    `## Current change snapshot\n- baseline commit for diff commands: ${input.changes.baselineHead ?? input.baseline.head ?? "(none/unknown)"}\n- review command hint: ${input.changes.baselineHead ? `git diff ${input.changes.baselineHead} --` : "git diff --stat && git diff"}\n\n### Git status\n\`\`\`text\n${truncateMiddle(status, 6_000)}\n\`\`\``,
    formatOptionalSection("Committed changes since baseline", input.changes.committedChanges),
    formatOptionalSection("Diff stat", input.changes.diffStat),
    formatOptionalSection("Diff", input.changes.diff),
    `### Untracked files\n\`\`\`text\n${formatList(input.changes.untrackedFiles, 200)}\n\`\`\``,
    notes.length > 0 ? `## Review notes\n${notes.map((note) => `- ${note}`).join("\n")}` : undefined,
    "## Required output\nFollow the Markdown structure from your system prompt. Be specific and actionable.",
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

export function buildApplyReviewPrompt(input: ApplyReviewPromptInput): string {
  return [
    "A separate fresh-context reviewer agent has reviewed the implementation.",
    "Apply the review now: fix all correct mandatory findings, use judgment for non-blocking notes, and explain any suggestion you intentionally decline.",
    `Original request:\n${input.task.trim()}`,
    `Fresh-context review:\n\n${truncateMiddle(input.review.trim() || "(reviewer returned no text)", MAX_APPLY_REVIEW_CHARS)}`,
    "Before stopping, run the most relevant local verification and mention the concrete result.",
  ].join("\n\n");
}
