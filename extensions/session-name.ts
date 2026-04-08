import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("session-name", {
    description: "Set the current session name",
    handler: async (args, ctx) => {
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /session-name <name>", "warning");
        return;
      }

      pi.setSessionName(name);
      ctx.ui.notify(`Session name set to: ${name}`, "info");
    },
  });
}
