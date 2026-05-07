import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const COPY_PROMPT_SHORTCUTS = ["alt+c", "ctrl+alt+c"] as const;

// macOS Terminal/iTerm often insert a composed character for Option+C unless
// the user explicitly enables "Option as Meta". Treat the common layouts as the
// same shortcut so the extension works with default macOS terminal settings.
const MAC_OPTION_C_INPUTS = new Set(["ç", "Ç", "©"]);
let unsubscribeMacOptionCFallback: (() => void) | undefined;

function clearMacOptionCFallback(): void {
  unsubscribeMacOptionCFallback?.();
  unsubscribeMacOptionCFallback = undefined;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lines += 1;
  }
  return lines;
}

async function copyPromptDraft(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const text = ctx.ui.getEditorText();
  if (text.length === 0) {
    ctx.ui.notify("No prompt draft to copy", "warning");
    return;
  }

  try {
    await copyToClipboard(text);
    const lineCount = countLines(text);
    const lineLabel = lineCount === 1 ? "line" : "lines";
    ctx.ui.notify(`Copied prompt draft (${lineCount} ${lineLabel})`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to copy prompt draft: ${message}`, "error");
  }
}

function installMacOptionCFallback(ctx: ExtensionContext): void {
  clearMacOptionCFallback();
  if (process.platform !== "darwin" || !ctx.hasUI) return;

  unsubscribeMacOptionCFallback = ctx.ui.onTerminalInput((data) => {
    if (!MAC_OPTION_C_INPUTS.has(data)) return undefined;

    void copyPromptDraft(ctx);
    return { consume: true };
  });
}

export default function (pi: ExtensionAPI) {
  for (const shortcut of COPY_PROMPT_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Copy the current prompt draft to the clipboard",
      handler: copyPromptDraft,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    installMacOptionCFallback(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearMacOptionCFallback();
  });
}
