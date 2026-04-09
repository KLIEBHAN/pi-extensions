export interface ParsedLoopArgs {
  task: string;
  repeat: number;
  continueOnFailure: boolean;
}

export interface CompletionVerificationResult {
  done: boolean;
  reason: string;
  continuePrompt: string;
}

export interface TextBlock {
  type: string;
  text?: string;
}

interface ParsedVerificationPayload {
  done?: unknown;
  reason?: unknown;
  continuePrompt?: unknown;
}

export const DEFAULT_REPEAT = 1;
export const MAX_REPEAT = 10_000;
export const MAX_VERIFICATION_NUDGES = 3;
export const RALPHY_VERIFIER_FALLBACK_CONTINUE_PROMPT =
  "Completion verification was inconclusive. Continue working on the same task now. Re-check requirements, repository state, tests, git status, commit, and push. Do not ask the user anything. Only stop when the task is fully complete.";

export function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REPEAT) return undefined;
  return parsed;
}

export function summarizeTask(task: string, maxLength = 48): string {
  const normalized = task.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function parseLoopArgs(args: string): ParsedLoopArgs | { error: string } {
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

export function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is TextBlock => typeof block === "object" && block !== null && "type" in block)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

export function parseVerificationResponse(text: string): CompletionVerificationResult | undefined {
  const normalized = text.trim();
  const candidates = [normalized];

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ParsedVerificationPayload;
      if (typeof parsed.done !== "boolean") continue;
      if (typeof parsed.reason !== "string") continue;
      if (typeof parsed.continuePrompt !== "string") continue;
      return {
        done: parsed.done,
        reason: parsed.reason.trim(),
        continuePrompt: parsed.continuePrompt.trim(),
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

export function shouldTreatStopReasonAsFailure(stopReason: string): boolean {
  return stopReason === "error" || stopReason === "aborted" || stopReason === "length";
}
