import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NOTIFY_CHARS = 1_000;

function truncateMessage(message: string): string {
  if (message.length <= MAX_NOTIFY_CHARS) return message;
  return `${message.slice(0, MAX_NOTIFY_CHARS - 1)}…`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("notify", {
    description: "Show a desktop-style notification inside pi",
    handler: async (args, ctx) => {
      ctx.ui.notify(truncateMessage(args || "Hello from pi-extensions"), "info");
    },
  });
}
