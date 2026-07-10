import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NAME_CHARS = 200;

function truncateName(name: string): string {
  if (name.length <= MAX_NAME_CHARS) return name;
  return `${name.slice(0, MAX_NAME_CHARS - 1)}…`;
}

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const name = truncateName(params.name);
    return {
      content: [{ type: "text", text: `Hello, ${name}!` }],
      details: { greeted: name },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
