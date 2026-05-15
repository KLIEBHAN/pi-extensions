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

export interface ReviewerGuardOptions {
  allowedTestCommands?: readonly string[];
}

export interface ReviewSummary {
  verdict?: ReviewVerdict;
  findingCount: number;
  severityCounts: Record<"critical" | "high" | "medium" | "low" | "other", number>;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export type ReviewCycleCommand =
  | { kind: "start"; task: string; reviewerModel?: ModelRef }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "rerun"; reviewerModel?: ModelRef }
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

function parseReviewerModelFlag(tokens: string[]): { reviewerModel?: ModelRef; remaining: string[] } | { error: string } {
  let reviewerModel: ModelRef | undefined;
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

    if (token.startsWith("--")) {
      return { error: `Unknown flag: ${token}` };
    }

    remaining.push(token);
  }

  return { reviewerModel, remaining };
}

function parseStartArgs(tokens: string[]): ReviewCycleCommand {
  const parsed = parseReviewerModelFlag(tokens);
  if ("error" in parsed) return parsed;

  const task = parsed.remaining.join(" ").trim();
  if (!task) {
    return { error: "Usage: /review-cycle [on] [--reviewer-model provider/model] <task>" };
  }

  return { kind: "start", task, reviewerModel: parsed.reviewerModel };
}

function parseRerunArgs(tokens: string[]): ReviewCycleCommand {
  const parsed = parseReviewerModelFlag(tokens);
  if ("error" in parsed) return parsed;
  if (parsed.remaining.length > 0) return { error: "Usage: /review-cycle rerun [--reviewer-model provider/model]" };
  return { kind: "rerun", reviewerModel: parsed.reviewerModel };
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
    return { error: "Usage: /review-cycle [on|status|stop] [--reviewer-model provider/model] <task>" };
  }

  const [first, ...rest] = tokenized;
  const command = first.toLowerCase();

  if (command === "status") return { kind: "status" };
  if (command === "stop" || command === "off") return { kind: "stop" };
  if (command === "rerun") return parseRerunArgs(rest);
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

function testCommandMatchesConfigured(tokens: string[], allowedTestCommands: readonly string[]): boolean {
  return allowedTestCommands.some((allowedCommand) => {
    const allowedTokens = normalizeTestCommandTokens(allowedCommand);
    if (!allowedTokens || allowedTokens.length !== tokens.length) return false;
    return allowedTokens.every((token, index) => token === tokens[index]);
  });
}

export function isReviewerTestCommandAllowed(command: string, options: ReviewerGuardOptions = {}): boolean {
  const tokens = normalizeTestCommandTokens(command);
  if (!tokens) return false;

  if (options.allowedTestCommands && options.allowedTestCommands.length > 0) {
    return testCommandMatchesConfigured(tokens, options.allowedTestCommands);
  }

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

function testCommandMatchesConfigured(tokens, allowedTestCommands) {
  return allowedTestCommands.some((allowedCommand) => {
    const allowedTokens = normalizeTestCommandTokens(allowedCommand);
    if (!allowedTokens || allowedTokens.length !== tokens.length) return false;
    return allowedTokens.every((token, index) => token === tokens[index]);
  });
}

function isReviewerTestCommandAllowed(command) {
  const tokens = normalizeTestCommandTokens(command);
  if (!tokens) return false;
  if (REVIEWER_ALLOWED_CONFIGURED_TEST_COMMANDS.length > 0) {
    return testCommandMatchesConfigured(tokens, REVIEWER_ALLOWED_CONFIGURED_TEST_COMMANDS);
  }
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

export function parseReviewSummary(review: string): ReviewSummary {
  const verdictMatch = /\b(APPROVE_WITH_NOTES|CHANGES_REQUESTED|APPROVE)\b/.exec(review);
  const verdict = verdictMatch?.[1] as ReviewVerdict | undefined;
  const severityCounts: ReviewSummary["severityCounts"] = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    other: 0,
  };

  const findingsSection = /##\s+Findings\s*\n([\s\S]*?)(?:\n##\s+|$)/i.exec(review)?.[1] ?? "";
  const findingLines = findingsSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .filter((line) => !/no\s+(mandatory\s+)?findings|none/i.test(line));

  for (const line of findingLines) {
    const normalized = line.toLowerCase();
    if (/\bcritical\b/.test(normalized)) severityCounts.critical += 1;
    else if (/\bhigh\b/.test(normalized)) severityCounts.high += 1;
    else if (/\bmedium\b/.test(normalized)) severityCounts.medium += 1;
    else if (/\blow\b/.test(normalized)) severityCounts.low += 1;
    else severityCounts.other += 1;
  }

  return {
    verdict,
    findingCount: findingLines.length,
    severityCounts,
  };
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
