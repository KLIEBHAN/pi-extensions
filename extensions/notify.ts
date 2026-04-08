import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("notify", {
    description: "Show a desktop-style notification inside pi",
    handler: async (args, ctx) => {
      ctx.ui.notify(args || "Hello from pi-extensions", "info");
    },
  });
}
