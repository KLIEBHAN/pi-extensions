import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const DANGEROUS_COMMAND_PATTERNS = [
  "rm -rf",
  "sudo ",
  "git reset --hard",
  "git clean -fd",
  "mkfs",
  "dd if=",
];
const MAX_COMMAND_PREVIEW_CHARS = 2_000;

function truncatePreview(text: string): string {
  if (text.length <= MAX_COMMAND_PREVIEW_CHARS) return text;
  return `${text.slice(0, MAX_COMMAND_PREVIEW_CHARS - 1)}…`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const dangerousPattern = DANGEROUS_COMMAND_PATTERNS.find((pattern) => command.includes(pattern));
    if (!dangerousPattern) return;

    const ok = await ctx.ui.confirm(
      "Dangerous bash command",
      `Allow this command?\n\n${truncatePreview(command)}`,
    );
    if (!ok) {
      return { block: true, reason: `Blocked by permission-gate: ${dangerousPattern}` };
    }
  });
}
