/**
 * Local demo provider for recording the Prompt Autocomplete Gallery video.
 *
 * Registers `demo/autocomplete` with a streamSimple that answers from the draft
 * in the request, deterministically and without network access or credentials.
 * Used only by scripts/demo/record-prompt-autocomplete-demo.py; not shipped.
 */
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANSWERS: Array<[draft: RegExp, completions: string[]]> = [
  [/^Review$/, [" the patch for edge cases", " the failing tests first", " the API changes"]],
  [/^Add tests for$/, [" the budget ceiling", " the cursor cell forms"]],
];

function draftOf(messages: readonly Message[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (!user || user.role !== "user") return "";
  const text = typeof user.content === "string"
    ? user.content
    : user.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return /Current draft \(cursor at end\):\n([^\n]*)/.exec(text)?.[1] ?? "";
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("demo", {
    baseUrl: "http://127.0.0.1:9/demo",
    apiKey: "demo-key",
    api: "demo-autocomplete",
    models: [
      {
        id: "autocomplete",
        name: "Demo autocomplete",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1_024,
      },
    ],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const draft = draftOf(context.messages);
      const completions = ANSWERS.find(([pattern]) => pattern.test(draft))?.[1] ?? [];
      const text = JSON.stringify({ completions });
      const message = (content: string): AssistantMessage => ({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 412,
          output: 38,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 450,
          cost: { input: 0.0000618, output: 0.0000228, cacheRead: 0, cacheWrite: 0, total: 0.0000846 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      // Stream in small chunks so the recording shows the preview growing.
      const chunks = text.match(/.{1,9}/gs) ?? [text];
      void (async () => {
        stream.push({ type: "start", partial: message("") });
        let sent = "";
        for (const chunk of chunks) {
          if (options?.signal?.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 70));
          sent += chunk;
          stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: message(sent) });
        }
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message(text) });
        stream.push({ type: "done", reason: "stop", message: message(text) });
        stream.end();
      })();
      return stream;
    },
  });
}
