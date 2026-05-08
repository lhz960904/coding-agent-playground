import OpenAI from "openai";
import { weatherTools, weatherImpls } from "./_shared/tools.js";

export type RunCtx = { log: (line: string) => void; signal?: AbortSignal };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

interface Tool {
  name: string;
  description: string;
  parameters: any;
}

interface InvokeParams {
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
}

class OpenAIProvider {
  constructor(private client: OpenAI, private model: string) {}

  async *stream({ messages, tools, signal }: InvokeParams): AsyncGenerator<Message> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.toOpenAIMessages(messages),
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        stream: true,
      },
      { signal }
    );

    let text = "";
    const toolCalls: { id: string; name: string; argsJson: string }[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) text += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        toolCalls[idx] ??= { id: "", name: "", argsJson: "" };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].argsJson += tc.function.arguments;
      }
      yield this.buildSnapshot(text, toolCalls);
    }
  }

  async invoke(params: InvokeParams): Promise<Message> {
    let last: Message | null = null;
    for await (const s of this.stream(params)) last = s;
    if (!last) throw new Error("Model produced no output");
    return last;
  }

  private buildSnapshot(text: string, toolCalls: any[]): Message {
    const blocks: ContentBlock[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const tc of toolCalls) {
      let input: any = {};
      try {
        input = JSON.parse(tc.argsJson);
      } catch {
        // 还没拼成 valid JSON，先留空对象
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
    return { role: "assistant", content: blocks };
  }

  private toOpenAIMessages(messages: Message[]): any[] {
    return messages.flatMap((m): any[] => {
      if (m.role === "tool") {
        return m.content
          .filter((c) => c.type === "tool_result")
          .map((c: any) => ({ role: "tool", tool_call_id: c.tool_use_id, content: c.content }));
      }
      if (m.role === "assistant") {
        const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
        const toolCalls = m.content
          .filter((c) => c.type === "tool_use")
          .map((c: any) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          }));
        return [{
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : undefined,
        }];
      }
      const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
      return [{ role: m.role, content: text }];
    });
  }
}

const tools: Tool[] = [
  {
    name: weatherTools[0].function.name,
    description: weatherTools[0].function.description,
    parameters: weatherTools[0].function.parameters,
  },
];

async function* runAgent(
  provider: OpenAIProvider,
  userMessage: string,
  signal: AbortSignal | undefined,
  log: (s: string) => void
): AsyncGenerator<{ type: "partial" | "message"; message: Message }> {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];

  while (true) {
    if (signal?.aborted) return;

    let assistantMsg: Message | null = null;
    let lastTextLen = 0;
    for await (const snapshot of provider.stream({ messages, tools, signal })) {
      assistantMsg = snapshot;
      const text = snapshot.content.find((c) => c.type === "text");
      if (text && text.type === "text" && text.text.length > lastTextLen) {
        log(text.text.slice(lastTextLen));
        lastTextLen = text.text.length;
      }
      yield { type: "partial", message: snapshot };
    }
    if (!assistantMsg) break;

    messages.push(assistantMsg);
    yield { type: "message", message: assistantMsg };

    const toolUses = assistantMsg.content.filter(
      (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use"
    );
    if (toolUses.length === 0) {
      log(`\n\n\x1b[32m✓ done\x1b[0m`);
      return;
    }
    log(`\n\x1b[35m[tool_use]\x1b[0m ${toolUses.map((u) => `${u.name}(${JSON.stringify(u.input)})`).join(", ")}`);

    for (const u of toolUses) {
      const result = await weatherImpls[u.name](u.input, { signal });
      log(`\x1b[34m[tool_result]\x1b[0m ${u.name}: ${result}`);
      const toolMsg: Message = {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: u.id, content: result }],
      };
      messages.push(toolMsg);
      yield { type: "message", message: toolMsg };
    }
  }
}

export async function run({ log, signal }: RunCtx) {
  const userMessage = "用一句话介绍一下你自己，然后顺便查一下北京和上海的天气";
  log(`\x1b[36m[user]\x1b[0m ${userMessage}\n`);
  log(`\x1b[2m[demo] 注意 [assistant] 文本是流式逐字到达的，不是一整段 flush 出来的。\x1b[0m`);
  log(`\x1b[2m─────────────────────────\x1b[0m`);
  log(`\x1b[32m[assistant]\x1b[0m `);

  const deepseek = new OpenAIProvider(
    new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      baseURL: "https://api.deepseek.com/v1",
    }),
    "deepseek-chat"
  );

  for await (const _ of runAgent(deepseek, userMessage, signal, log)) void _;
}
