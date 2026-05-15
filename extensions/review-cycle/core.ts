export const REVIEW_CYCLE_STATUS_KEY = "review-cycle";
export const DEFAULT_REVIEW_TIMEOUT_MS = 600_000;
export const REVIEWER_ALLOWED_DIRECT_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const REVIEWER_ALLOWED_BASH_TOOL_NAME = "bash";
export const REVIEWER_ALLOWED_TOOL_NAMES = [
  ...REVIEWER_ALLOWED_DIRECT_TOOL_NAMES,
  REVIEWER_ALLOWED_BASH_TOOL_NAME,
] as const;
export const REVIEWER_ALLOWED_GIT_SUBCOMMANDS = [
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "describe",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "merge-base",
  "name-rev",
  "rev-parse",
  "shortlog",
  "show",
  "status",
] as const;
export const REVIEWER_BLOCKED_GIT_ARGUMENTS = [
  "--exec-path",
  "--ext-diff",
  "--external-diff",
  "--git-dir",
  "--output",
  "--paginate",
  "--receive-pack",
  "--upload-pack",
  "--work-tree",
] as const;
export const REVIEWER_ALLOWED_DIRECT_TEST_COMMANDS = [
  "ava",
  "bun",
  "cargo",
  "ctest",
  "deno",
  "dotnet",
  "go",
  "gradle",
  "gradlew",
  "jest",
  "mocha",
  "mvn",
  "mvnw",
  "node",
  "npm",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "tap",
  "uv",
  "vitest",
  "yarn",
] as const;
export const REVIEWER_BLOCKED_TEST_ARGUMENTS = [
  "--init",
  "--inspect",
  "--inspect-brk",
  "--interactive",
  "--open",
  "--pdb",
  "--ui",
  "--update",
  "--update-snapshot",
  "--updateSnapshot",
  "--watch",
  "--watchAll",
  "-u",
  "-w",
  "init",
] as const;
export const DEFAULT_REVIEW_TOOLS = REVIEWER_ALLOWED_TOOL_NAMES;
export const MAX_REVIEW_PROMPT_SECTION_CHARS = 20_000;
export const MAX_APPLY_REVIEW_CHARS = 24_000;
export const MAX_TASK_SUMMARY_CHARS = 48;

export type ReviewVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "CHANGES_REQUESTED";
export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "other";

export interface ReviewerGuardOptions {
  allowedTestCommands?: readonly string[];
}

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  text: string;
  title?: string;
  file?: string;
  line?: number;
  suggestion?: string;
  mandatory?: boolean;
}

export interface ReviewSummary {
  verdict?: ReviewVerdict;
  findingCount: number;
  severityCounts: Record<ReviewFindingSeverity, number>;
  findings: ReviewFinding[];
  reviewDataSchemaVersion?: number;
  reviewDataWarning?: string;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export type ReviewCycleCommand =
  | {
      kind: "start";
      task: string;
      reviewerModel?: ModelRef;
      manualApply?: boolean;
      untilApproved?: boolean;
      allowDirty?: boolean;
      maxReviewRounds?: number;
    }
  | { kind: "help" }
  | { kind: "panel" }
  | { kind: "status" }
  | { kind: "status-card"; mode: "on" | "off" | "toggle" }
  | { kind: "stop" }
  | { kind: "continue" }
  | { kind: "abort" }
  | { kind: "apply" }
  | { kind: "skip" }
  | { kind: "retry"; reviewerModel?: ModelRef }
  | { kind: "rerun"; reviewerModel?: ModelRef }
  | { kind: "artifact"; action: "show" | "path" | "list"; runIndex?: number }
  | { kind: "output"; mode: "on" | "off" | "toggle" }
  | { kind: "tests"; action: "show" | "clear" | "add" | "set"; command?: string }
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
- In your final response, include a short findings checklist that marks each mandatory finding as fixed or intentionally declined.
- Re-run the most relevant local verification before stopping and mention the concrete result.
- Do not ask the user for confirmation; finish the review-application pass autonomously.`;

export const REVIEWER_SYSTEM_PROMPT = `You are a strict code-review agent running with a completely fresh context.

Rules:
- Review only; do not modify files.
- Use tools only for read-only inspection and verification. The review-cycle runtime technically allows only: read, grep, find, ls, guarded bash for read-only git inspection, and guarded bash for common test commands.
- Mutating tools, arbitrary shell execution, unsafe shell/git arguments, and unknown/custom tools are blocked by a runtime guard in the reviewer process.
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
Optional short positive notes or non-blocking improvements.

## Review Data
A fenced JSON object for machine parsing. Use this shape exactly:
~~~json
{
  "schemaVersion": 1,
  "verdict": "APPROVE_WITH_NOTES",
  "findings": [
    {
      "severity": "high",
      "title": "Short finding title",
      "file": "src/example.ts",
      "line": 42,
      "mandatory": true,
      "suggestion": "Specific fix"
    }
  ]
}
~~~
Use an empty findings array when there are no findings.`;

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

function parsePositiveIntegerToken(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRunFlags(tokens: string[]): {
  reviewerModel?: ModelRef;
  manualApply?: boolean;
  untilApproved?: boolean;
  allowDirty?: boolean;
  maxReviewRounds?: number;
  remaining: string[];
} | { error: string } {
  let reviewerModel: ModelRef | undefined;
  let manualApply: boolean | undefined;
  let untilApproved: boolean | undefined;
  let allowDirty: boolean | undefined;
  let maxReviewRounds: number | undefined;
  const remaining: string[] = [];

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

    if (token === "--manual-apply") {
      manualApply = true;
      continue;
    }

    if (token === "--auto-apply") {
      manualApply = false;
      continue;
    }

    if (token === "--until-approved") {
      untilApproved = true;
      continue;
    }

    if (token === "--allow-dirty") {
      allowDirty = true;
      continue;
    }

    if (token === "--max-review-rounds") {
      const parsed = parsePositiveIntegerToken(tokens[index + 1]);
      if (!parsed) return { error: "--max-review-rounds must be a positive integer" };
      maxReviewRounds = parsed;
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      return { error: `Unknown flag: ${token}` };
    }

    remaining.push(token);
  }

  return { reviewerModel, manualApply, untilApproved, allowDirty, maxReviewRounds, remaining };
}

function parseStartArgs(tokens: string[]): ReviewCycleCommand {
  const parsed = parseRunFlags(tokens);
  if ("error" in parsed) return parsed;

  const task = parsed.remaining.join(" ").trim();
  if (!task) {
    return { error: "Usage: /review-cycle [on] [--reviewer-model provider/model] [--manual-apply] [--until-approved] [--allow-dirty] [--max-review-rounds n] <task>" };
  }

  return {
    kind: "start",
    task,
    reviewerModel: parsed.reviewerModel,
    ...(parsed.manualApply !== undefined ? { manualApply: parsed.manualApply } : {}),
    ...(parsed.untilApproved !== undefined ? { untilApproved: parsed.untilApproved } : {}),
    ...(parsed.allowDirty !== undefined ? { allowDirty: parsed.allowDirty } : {}),
    ...(parsed.maxReviewRounds !== undefined ? { maxReviewRounds: parsed.maxReviewRounds } : {}),
  };
}

function parseRerunArgs(tokens: string[]): ReviewCycleCommand {
  const parsed = parseRunFlags(tokens);
  if ("error" in parsed) return parsed;
  if (parsed.remaining.length > 0 || parsed.manualApply !== undefined || parsed.untilApproved !== undefined || parsed.allowDirty !== undefined || parsed.maxReviewRounds !== undefined) {
    return { error: "Usage: /review-cycle rerun [--reviewer-model provider/model]" };
  }
  return { kind: "rerun", reviewerModel: parsed.reviewerModel };
}

function parseRetryArgs(tokens: string[]): ReviewCycleCommand {
  const parsed = parseRunFlags(tokens);
  if ("error" in parsed) return parsed;
  if (parsed.remaining.length > 0 || parsed.manualApply !== undefined || parsed.untilApproved !== undefined || parsed.allowDirty !== undefined || parsed.maxReviewRounds !== undefined) {
    return { error: "Usage: /review-cycle retry [--reviewer-model provider/model]" };
  }
  return { kind: "retry", reviewerModel: parsed.reviewerModel };
}

function parseTestsArgs(tokens: string[]): ReviewCycleCommand {
  const action = (tokens[0] ?? "status").toLowerCase();
  if (action === "status" || action === "show" || action === "list") return { kind: "tests", action: "show" };
  if (action === "clear" || action === "off") return { kind: "tests", action: "clear" };
  if (action === "add" || action === "set") {
    const command = tokens.slice(1).join(" ").trim();
    if (!command) return { error: `Usage: /review-cycle tests ${action} <test command>` };
    return { kind: "tests", action: action === "add" ? "add" : "set", command };
  }
  return { error: "Usage: /review-cycle tests [status|clear|add <cmd>|set <cmd>]" };
}

export function parseReviewCycleArgs(args: string): ReviewCycleCommand {
  const tokenized = tokenizeArgs(args);
  if (!Array.isArray(tokenized)) return { error: tokenized.error };
  if (tokenized.length === 0) {
    return { error: "Usage: /review-cycle [help|on|status|stop] [--reviewer-model provider/model] <task>" };
  }

  const [first, ...rest] = tokenized;
  const command = first.toLowerCase();

  if (command === "help" || command === "--help" || command === "-h") return { kind: "help" };
  if (command === "panel") return rest.length === 0 ? { kind: "panel" } : { error: "Usage: /review-cycle panel" };
  if (command === "status") {
    if (rest.length === 0) return { kind: "status" };
    const mode = rest[0]?.toLowerCase();
    if (rest.length === 1 && (mode === "on" || mode === "show" || mode === "visible")) return { kind: "status-card", mode: "on" };
    if (rest.length === 1 && (mode === "off" || mode === "hide" || mode === "hidden")) return { kind: "status-card", mode: "off" };
    if (rest.length === 1 && mode === "toggle") return { kind: "status-card", mode: "toggle" };
    return { error: "Usage: /review-cycle status [on|off|toggle]" };
  }
  if (command === "status-card" || command === "statuscard" || command === "card" || command === "review-status") {
    const mode = (rest[0] ?? "toggle").toLowerCase();
    if (rest.length <= 1 && (mode === "on" || mode === "show" || mode === "visible")) return { kind: "status-card", mode: "on" };
    if (rest.length <= 1 && (mode === "off" || mode === "hide" || mode === "hidden")) return { kind: "status-card", mode: "off" };
    if (rest.length <= 1 && mode === "toggle") return { kind: "status-card", mode: "toggle" };
    return { error: "Usage: /review-cycle status-card [on|off|toggle]" };
  }
  if (command === "stop" || command === "off") return { kind: "stop" };
  if (command === "continue") return rest.length === 0 ? { kind: "continue" } : { error: "Usage: /review-cycle continue" };
  if (command === "abort") return rest.length === 0 ? { kind: "abort" } : { error: "Usage: /review-cycle abort" };
  if (command === "apply") return rest.length === 0 ? { kind: "apply" } : { error: "Usage: /review-cycle apply" };
  if (command === "skip") return rest.length === 0 ? { kind: "skip" } : { error: "Usage: /review-cycle skip" };
  if (command === "retry") return parseRetryArgs(rest);
  if (command === "rerun") return parseRerunArgs(rest);
  if (command === "artifact") {
    const action = (rest[0] ?? "show").toLowerCase();
    if (rest.length <= 1 && (action === "list" || action === "history" || action === "runs")) return { kind: "artifact", action: "list" };
    if (rest.length === 1) {
      const runIndex = parsePositiveIntegerToken(action);
      if (runIndex) return { kind: "artifact", action: "show", runIndex };
    }
    if (action === "show" || action === "latest") {
      const runIndex = parsePositiveIntegerToken(rest[1]);
      if (rest.length <= 1 || (rest.length === 2 && runIndex)) return { kind: "artifact", action: "show", ...(runIndex ? { runIndex } : {}) };
    }
    if (action === "path") {
      const runIndex = parsePositiveIntegerToken(rest[1]);
      if (rest.length <= 1 || (rest.length === 2 && runIndex)) return { kind: "artifact", action: "path", ...(runIndex ? { runIndex } : {}) };
    }
    return { error: "Usage: /review-cycle artifact [show|latest|list|path] [run-number]" };
  }
  if (command === "tests") return parseTestsArgs(rest);
  if (command === "config" && rest[0]?.toLowerCase() === "tests") return parseTestsArgs(rest.slice(1));
  if (command === "output") {
    const mode = (rest[0] ?? "toggle").toLowerCase();
    if (mode === "on" || mode === "show") return { kind: "output", mode: "on" };
    if (mode === "off" || mode === "hide") return { kind: "output", mode: "off" };
    if (mode === "toggle") return { kind: "output", mode: "toggle" };
    return { error: "Usage: /review-cycle output [on|off|toggle]" };
  }
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

export function tokenizeReviewerShellCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (const char of trimmed) {
    if (char === "\n" || char === "\r") {
      return undefined;
    }

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
      else {
        if (quote === '"' && "$`\\!".includes(char)) return undefined;
        current += char;
      }
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

    // Reject shell control/metacharacters instead of trying to sandbox bash.
    if (";&|<>`$(){}[]*!?".includes(char)) {
      return undefined;
    }

    current += char;
  }

  if (escape || quote) return undefined;
  if (current.length > 0) tokens.push(current);
  return tokens.length > 0 ? tokens : undefined;
}

function isBlockedGitArgument(token: string): boolean {
  return REVIEWER_BLOCKED_GIT_ARGUMENTS.some((blocked) => token === blocked || token.startsWith(`${blocked}=`));
}

function stripEnvAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) {
    index += 1;
  }
  return tokens.slice(index);
}

function isTestScriptName(token: string | undefined): boolean {
  return !!token && (token === "test" || token.startsWith("test:") || token.endsWith(":test"));
}

function isPythonTestCommand(tokens: string[]): boolean {
  if (tokens[0] !== "python" && tokens[0] !== "python3") return false;
  return tokens[1] === "-m" && (tokens[2] === "pytest" || tokens[2] === "unittest");
}

function isBlockedTestArgument(token: string): boolean {
  return REVIEWER_BLOCKED_TEST_ARGUMENTS.some((blocked) => token === blocked || token.startsWith(`${blocked}=`));
}

function hasBlockedTestArguments(tokens: string[]): boolean {
  return tokens.some(isBlockedTestArgument);
}

function normalizeTestCommandTokens(command: string): string[] | undefined {
  const rawTokens = tokenizeReviewerShellCommand(command);
  const tokens = rawTokens ? stripEnvAssignments(rawTokens) : undefined;
  if (!tokens || tokens.length === 0) return undefined;
  if (hasBlockedTestArguments(tokens.slice(1))) return undefined;
  return tokens;
}

function normalizeConfiguredTestCommandTokens(command: string): string[] | undefined {
  const tokens = tokenizeReviewerShellCommand(command);
  if (!tokens || tokens.length === 0) return undefined;
  if (hasBlockedTestArguments(tokens)) return undefined;
  return tokens;
}

function isReviewerTestTokensAllowed(tokens: string[]): boolean {
  const executable = tokens[0]!.startsWith("./") ? tokens[0]!.slice(2) : tokens[0]!;
  if (!(REVIEWER_ALLOWED_DIRECT_TEST_COMMANDS as readonly string[]).includes(executable)) return false;

  switch (executable) {
    case "npm":
    case "pnpm":
    case "yarn":
      return tokens[1] === "test" || (tokens[1] === "run" && isTestScriptName(tokens[2]));
    case "bun":
    case "deno":
    case "cargo":
    case "dotnet":
      return tokens[1] === "test";
    case "go":
      return tokens[1] === "test";
    case "node":
      return tokens.includes("--test");
    case "ava":
    case "ctest":
    case "jest":
    case "mocha":
    case "pytest":
    case "tap":
    case "vitest":
      return true;
    case "python":
    case "python3":
      return isPythonTestCommand(tokens);
    case "uv":
      return tokens[1] === "run" && (tokens[2] === "pytest" || isPythonTestCommand(tokens.slice(2)));
    case "mvn":
    case "mvnw":
      return tokens.includes("test") || tokens.includes("verify");
    case "gradle":
    case "gradlew":
      return tokens.includes("test") || tokens.some((token) => token.endsWith("Test"));
    default:
      return false;
  }
}

function isReviewerConfiguredTestTokensAllowed(tokens: string[]): boolean {
  const testTokens = stripEnvAssignments(tokens);
  return testTokens.length > 0 && isReviewerTestTokensAllowed(testTokens);
}

function testCommandMatchesConfigured(command: string, allowedTestCommands: readonly string[]): boolean {
  const tokens = normalizeConfiguredTestCommandTokens(command);
  if (!tokens || !isReviewerConfiguredTestTokensAllowed(tokens)) return false;

  return allowedTestCommands.some((allowedCommand) => {
    const allowedTokens = normalizeConfiguredTestCommandTokens(allowedCommand);
    if (!allowedTokens || !isReviewerConfiguredTestTokensAllowed(allowedTokens) || allowedTokens.length !== tokens.length) return false;
    return allowedTokens.every((token, index) => token === tokens[index]);
  });
}

export function isReviewerTestCommandAllowed(command: string, options: ReviewerGuardOptions = {}): boolean {
  if (options.allowedTestCommands && options.allowedTestCommands.length > 0) {
    return testCommandMatchesConfigured(command, options.allowedTestCommands);
  }

  const tokens = normalizeTestCommandTokens(command);
  return !!tokens && isReviewerTestTokensAllowed(tokens);
}

export function isReviewerGitCommandAllowed(command: string): boolean {
  const tokens = tokenizeReviewerShellCommand(command);
  if (!tokens || tokens[0] !== "git") return false;

  let subcommandIndex = 1;
  while (subcommandIndex < tokens.length) {
    const token = tokens[subcommandIndex]!;
    if (token === "--no-pager") {
      subcommandIndex += 1;
      continue;
    }
    break;
  }

  const subcommand = tokens[subcommandIndex];
  if (!subcommand) return false;
  if (subcommand.startsWith("-")) return false;
  if (!REVIEWER_ALLOWED_GIT_SUBCOMMANDS.includes(subcommand as typeof REVIEWER_ALLOWED_GIT_SUBCOMMANDS[number])) {
    return false;
  }

  return tokens.slice(1).every((token) => !isBlockedGitArgument(token));
}

export function isReviewerBashCommandAllowed(command: string, options: ReviewerGuardOptions = {}): boolean {
  return isReviewerGitCommandAllowed(command) || isReviewerTestCommandAllowed(command, options);
}

export function isReviewerToolCallAllowed(toolName: string, input: unknown, options: ReviewerGuardOptions = {}): boolean {
  if ((REVIEWER_ALLOWED_DIRECT_TOOL_NAMES as readonly string[]).includes(toolName)) return true;
  if (toolName !== REVIEWER_ALLOWED_BASH_TOOL_NAME) return false;
  if (typeof input !== "object" || input === null) return false;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && isReviewerBashCommandAllowed(command, options);
}

export function buildReviewerToolGuardExtensionSource(options: ReviewerGuardOptions = {}): string {
  const allowedConfiguredTestCommands = options.allowedTestCommands ?? [];
  return `const REVIEWER_ALLOWED_DIRECT_TOOL_NAMES = new Set(${JSON.stringify([...REVIEWER_ALLOWED_DIRECT_TOOL_NAMES])});
const REVIEWER_ALLOWED_BASH_TOOL_NAME = ${JSON.stringify(REVIEWER_ALLOWED_BASH_TOOL_NAME)};
const REVIEWER_ALLOWED_GIT_SUBCOMMANDS = new Set(${JSON.stringify([...REVIEWER_ALLOWED_GIT_SUBCOMMANDS])});
const REVIEWER_BLOCKED_GIT_ARGUMENTS = ${JSON.stringify([...REVIEWER_BLOCKED_GIT_ARGUMENTS])};
const REVIEWER_ALLOWED_DIRECT_TEST_COMMANDS = new Set(${JSON.stringify([...REVIEWER_ALLOWED_DIRECT_TEST_COMMANDS])});
const REVIEWER_BLOCKED_TEST_ARGUMENTS = ${JSON.stringify([...REVIEWER_BLOCKED_TEST_ARGUMENTS])};
const REVIEWER_ALLOWED_CONFIGURED_TEST_COMMANDS = ${JSON.stringify([...allowedConfiguredTestCommands])};
const REVIEWER_BLOCKED_SHELL_CHARS = ${JSON.stringify(";&|<>`$(){}[]*!?")};
const REVIEWER_BLOCKED_DOUBLE_QUOTE_CHARS = ${JSON.stringify("$`\\!")};

function tokenizeReviewerShellCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const tokens = [];
  let current = "";
  let quote;
  let escape = false;
  for (const char of trimmed) {
    if (char === "\\n" || char === "\\r") {
      return undefined;
    }

    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        if (quote === "\\\"" && REVIEWER_BLOCKED_DOUBLE_QUOTE_CHARS.includes(char)) return undefined;
        current += char;
      }
      continue;
    }
    if (char === "\\\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (REVIEWER_BLOCKED_SHELL_CHARS.includes(char)) return undefined;
    current += char;
  }
  if (escape || quote) return undefined;
  if (current.length > 0) tokens.push(current);
  return tokens.length > 0 ? tokens : undefined;
}

function isBlockedGitArgument(token) {
  return REVIEWER_BLOCKED_GIT_ARGUMENTS.some((blocked) => token === blocked || token.startsWith(blocked + "="));
}

function stripEnvAssignments(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  return tokens.slice(index);
}

function isTestScriptName(token) {
  return !!token && (token === "test" || token.startsWith("test:") || token.endsWith(":test"));
}

function isPythonTestCommand(tokens) {
  if (tokens[0] !== "python" && tokens[0] !== "python3") return false;
  return tokens[1] === "-m" && (tokens[2] === "pytest" || tokens[2] === "unittest");
}

function isBlockedTestArgument(token) {
  return REVIEWER_BLOCKED_TEST_ARGUMENTS.some((blocked) => token === blocked || token.startsWith(blocked + "="));
}

function hasBlockedTestArguments(tokens) {
  return tokens.some(isBlockedTestArgument);
}

function normalizeTestCommandTokens(command) {
  const rawTokens = tokenizeReviewerShellCommand(command);
  const tokens = rawTokens ? stripEnvAssignments(rawTokens) : undefined;
  if (!tokens || tokens.length === 0) return undefined;
  if (hasBlockedTestArguments(tokens.slice(1))) return undefined;
  return tokens;
}

function normalizeConfiguredTestCommandTokens(command) {
  const tokens = tokenizeReviewerShellCommand(command);
  if (!tokens || tokens.length === 0) return undefined;
  if (hasBlockedTestArguments(tokens)) return undefined;
  return tokens;
}

function isReviewerTestTokensAllowed(tokens) {
  const executable = tokens[0].startsWith("./") ? tokens[0].slice(2) : tokens[0];
  if (!REVIEWER_ALLOWED_DIRECT_TEST_COMMANDS.has(executable)) return false;
  switch (executable) {
    case "npm":
    case "pnpm":
    case "yarn":
      return tokens[1] === "test" || (tokens[1] === "run" && isTestScriptName(tokens[2]));
    case "bun":
    case "deno":
    case "cargo":
    case "dotnet":
      return tokens[1] === "test";
    case "go":
      return tokens[1] === "test";
    case "node":
      return tokens.includes("--test");
    case "ava":
    case "ctest":
    case "jest":
    case "mocha":
    case "pytest":
    case "tap":
    case "vitest":
      return true;
    case "python":
    case "python3":
      return isPythonTestCommand(tokens);
    case "uv":
      return tokens[1] === "run" && (tokens[2] === "pytest" || isPythonTestCommand(tokens.slice(2)));
    case "mvn":
    case "mvnw":
      return tokens.includes("test") || tokens.includes("verify");
    case "gradle":
    case "gradlew":
      return tokens.includes("test") || tokens.some((token) => token.endsWith("Test"));
    default:
      return false;
  }
}

function isReviewerConfiguredTestTokensAllowed(tokens) {
  const testTokens = stripEnvAssignments(tokens);
  return testTokens.length > 0 && isReviewerTestTokensAllowed(testTokens);
}

function testCommandMatchesConfigured(command, allowedTestCommands) {
  const tokens = normalizeConfiguredTestCommandTokens(command);
  if (!tokens || !isReviewerConfiguredTestTokensAllowed(tokens)) return false;
  return allowedTestCommands.some((allowedCommand) => {
    const allowedTokens = normalizeConfiguredTestCommandTokens(allowedCommand);
    if (!allowedTokens || !isReviewerConfiguredTestTokensAllowed(allowedTokens) || allowedTokens.length !== tokens.length) return false;
    return allowedTokens.every((token, index) => token === tokens[index]);
  });
}

function isReviewerTestCommandAllowed(command) {
  if (REVIEWER_ALLOWED_CONFIGURED_TEST_COMMANDS.length > 0) {
    return testCommandMatchesConfigured(command, REVIEWER_ALLOWED_CONFIGURED_TEST_COMMANDS);
  }
  const tokens = normalizeTestCommandTokens(command);
  return !!tokens && isReviewerTestTokensAllowed(tokens);
}

function isReviewerGitCommandAllowed(command) {
  const tokens = tokenizeReviewerShellCommand(command);
  if (!tokens || tokens[0] !== "git") return false;
  let subcommandIndex = 1;
  while (subcommandIndex < tokens.length) {
    const token = tokens[subcommandIndex];
    if (token === "--no-pager") {
      subcommandIndex += 1;
      continue;
    }
    break;
  }
  const subcommand = tokens[subcommandIndex];
  if (!subcommand) return false;
  if (subcommand.startsWith("-")) return false;
  if (!REVIEWER_ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) return false;
  return tokens.slice(1).every((token) => !isBlockedGitArgument(token));
}

function isReviewerBashCommandAllowed(command) {
  return isReviewerGitCommandAllowed(command) || isReviewerTestCommandAllowed(command);
}

function isReviewerToolCallAllowed(toolName, input) {
  if (REVIEWER_ALLOWED_DIRECT_TOOL_NAMES.has(toolName)) return true;
  if (toolName !== REVIEWER_ALLOWED_BASH_TOOL_NAME) return false;
  if (!input || typeof input !== "object") return false;
  const command = input.command;
  return typeof command === "string" && isReviewerBashCommandAllowed(command);
}

export default function(pi) {
  pi.on("tool_call", (event) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (!isReviewerToolCallAllowed(toolName, event.input)) {
      return {
        block: true,
        reason: "Review-cycle reviewer is read-only. Tool or command is not allowed: " + toolName,
      };
    }
  });
}
`;
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
    `## Current change snapshot\n- baseline commit for diff source: ${input.changes.baselineHead ?? input.baseline.head ?? "(none/unknown)"}\n- diff source: ${input.changes.baselineHead ? `equivalent to git diff ${input.changes.baselineHead} --; diff content is already included below` : "staged and unstaged diff content is already included below"}\n\n### Git status\n\`\`\`text\n${truncateMiddle(status, 6_000)}\n\`\`\``,
    formatOptionalSection("Committed changes since baseline", input.changes.committedChanges),
    formatOptionalSection("Diff stat", input.changes.diffStat),
    formatOptionalSection("Diff", input.changes.diff),
    `### Untracked files\n\`\`\`text\n${formatList(input.changes.untrackedFiles, 200)}\n\`\`\``,
    notes.length > 0 ? `## Review notes\n${notes.map((note) => `- ${note}`).join("\n")}` : undefined,
    "## Required output\nFollow the Markdown structure from your system prompt. Be specific and actionable.",
  ].filter((value): value is string => !!value);

  return sections.join("\n\n");
}

function parseFindingSeverity(text: string): ReviewFindingSeverity {
  const normalized = text.toLowerCase();
  if (/\bcritical\b/.test(normalized)) return "critical";
  if (/\bhigh\b/.test(normalized)) return "high";
  if (/\bmedium\b/.test(normalized)) return "medium";
  if (/\blow\b/.test(normalized)) return "low";
  return "other";
}

function normalizeFindingSeverity(value: unknown, fallbackText = ""): ReviewFindingSeverity {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low" || normalized === "other") {
      return normalized;
    }
  }
  return parseFindingSeverity(fallbackText);
}

function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return value === "APPROVE" || value === "APPROVE_WITH_NOTES" || value === "CHANGES_REQUESTED";
}

function emptySeverityCounts(): ReviewSummary["severityCounts"] {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    other: 0,
  };
}

function buildReviewSummary(
  verdict: ReviewVerdict | undefined,
  findings: ReviewFinding[],
  metadata: Pick<ReviewSummary, "reviewDataSchemaVersion" | "reviewDataWarning"> = {},
): ReviewSummary {
  const severityCounts = emptySeverityCounts();
  for (const finding of findings) {
    severityCounts[finding.severity] += 1;
  }
  return {
    verdict,
    findingCount: findings.length,
    severityCounts,
    findings,
    ...metadata,
  };
}

function extractReviewDataRaw(review: string): string | undefined {
  const section = /##\s+Review Data\s*\n([\s\S]*?)(?:\n##\s+|$)/i.exec(review)?.[1];
  if (!section) return undefined;
  const fenced = /(?:```|~~~)(?:json)?\s*\n([\s\S]*?)\n(?:```|~~~)/i.exec(section)?.[1];
  return (fenced ?? section).trim() || undefined;
}

function parseStructuredReviewSummary(review: string): { summary?: ReviewSummary; warning?: string } {
  const raw = extractReviewDataRaw(review);
  if (!raw) return {};

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { warning: "Review Data invalid: JSON parse failed; fell back to Markdown findings." };
  }

  if (typeof data !== "object" || data === null) {
    return { warning: "Review Data invalid: expected a JSON object; fell back to Markdown findings." };
  }

  const record = data as { schemaVersion?: unknown; verdict?: unknown; findings?: unknown };
  if (record.schemaVersion !== 1) {
    return { warning: "Review Data invalid: expected schemaVersion 1; fell back to Markdown findings." };
  }

  const verdict = isReviewVerdict(record.verdict) ? record.verdict : undefined;
  if (!Array.isArray(record.findings)) {
    return { warning: "Review Data invalid: findings must be an array; fell back to Markdown findings." };
  }

  const findings = record.findings
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => {
      const title = typeof item.title === "string" ? item.title.trim() : undefined;
      const suggestion = typeof item.suggestion === "string" ? item.suggestion.trim() : undefined;
      const file = typeof item.file === "string" ? item.file.trim() : undefined;
      const line = typeof item.line === "number" && Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : undefined;
      const textParts = [
        title,
        file ? `${file}${line ? `:${line}` : ""}` : undefined,
        suggestion,
      ].filter((value): value is string => !!value);
      const text = textParts.join(" — ") || JSON.stringify(item);
      return {
        severity: normalizeFindingSeverity(item.severity, text),
        text,
        title,
        file,
        line,
        suggestion,
        mandatory: typeof item.mandatory === "boolean" ? item.mandatory : true,
      } satisfies ReviewFinding;
    });

  return { summary: buildReviewSummary(verdict, findings, { reviewDataSchemaVersion: 1 }) };
}

export function parseReviewSummary(review: string): ReviewSummary {
  const structured = parseStructuredReviewSummary(review);
  if (structured.summary) return structured.summary;

  const verdictMatch = /\b(APPROVE_WITH_NOTES|CHANGES_REQUESTED|APPROVE)\b/.exec(review);
  const verdict = verdictMatch?.[1] as ReviewVerdict | undefined;
  const findingsSection = /##\s+Findings\s*\n([\s\S]*?)(?:\n##\s+|$)/i.exec(review)?.[1] ?? "";
  const findings = findingsSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .filter((line) => !/no\s+(mandatory\s+)?findings|none/i.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .map((text) => ({ severity: parseFindingSeverity(text), text }));

  return buildReviewSummary(verdict, findings, structured.warning ? { reviewDataWarning: structured.warning } : {});
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
