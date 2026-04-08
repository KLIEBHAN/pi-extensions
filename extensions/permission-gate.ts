import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const DANGEROUS_COMMAND_PATTERNS = [
  "rm -rf",
  "sudo ",
  "git reset --hard",
  "git clean -fd",
  "mkfs",
  "dd if=",
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const dangerousPattern = DANGEROUS_COMMAND_PATTERNS.find((pattern) => command.includes(pattern));
    if (!dangerousPattern) return;

    const ok = await ctx.ui.confirm(
      "Dangerous bash command",
      `Allow this command?\n\n${command}`,
    );
    if (!ok) {
      return { block: true, reason: `Blocked by permission-gate: ${dangerousPattern}` };
    }
  });
}
