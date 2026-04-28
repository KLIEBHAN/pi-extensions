import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const COPY_PROMPT_SHORTCUT = "alt+c";

async function copyPromptDraft(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const text = ctx.ui.getEditorText();
  if (text.length === 0) {
    ctx.ui.notify("No prompt draft to copy", "warning");
    return;
  }

  try {
    await copyToClipboard(text);
    const lineCount = text.split("\n").length;
    const lineLabel = lineCount === 1 ? "line" : "lines";
    ctx.ui.notify(`Copied prompt draft (${lineCount} ${lineLabel})`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to copy prompt draft: ${message}`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerShortcut(COPY_PROMPT_SHORTCUT, {
    description: "Copy the current prompt draft to the clipboard",
    handler: copyPromptDraft,
  });
}
