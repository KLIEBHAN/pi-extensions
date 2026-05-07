import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_SESSION_NAME_CHARS = 160;

function truncateSessionName(name: string): string {
  if (name.length <= MAX_SESSION_NAME_CHARS) return name;
  return `${name.slice(0, MAX_SESSION_NAME_CHARS - 1)}…`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("session-name", {
    description: "Set the current session name",
    handler: async (args, ctx) => {
      const name = truncateSessionName(args?.trim() ?? "");
      if (!name) {
        ctx.ui.notify("Usage: /session-name <name>", "warning");
        return;
      }

      pi.setSessionName(name);
      ctx.ui.notify(`Session name set to: ${name}`, "info");
    },
  });
}
