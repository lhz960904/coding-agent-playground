import OpenAI from "openai";

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

type AgentEvent =
  | { type: "partial"; message: Message }
  | { type: "message"; message: Message };

export class OpenAIProvider {
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
      } catch {}
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
    name: "get_weather",
    description: "查询某个城市的天气",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
];

const toolImpls: Record<string, (input: any, ctx?: { signal?: AbortSignal }) => Promise<string>> = {
  get_weather: async ({ city }) => {
    await new Promise((r) => setTimeout(r, 300));
    return `${city} 今天 25°C 晴`;
  },
};

export class Agent {
  private messages: Message[] = [];
  private _abortController: AbortController | null = null;

  constructor(private provider: OpenAIProvider) {}

  abort(reason?: unknown) {
    this._abortController?.abort(reason);
  }

  async invoke(input: string): Promise<Message[]> {
    const collected: Message[] = [];
    for await (const ev of this.stream(input)) {
      if (ev.type === "message") collected.push(ev.message);
    }
    return collected;
  }

  async *stream(input: string): AsyncGenerator<AgentEvent> {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;
    this.messages.push({ role: "user", content: [{ type: "text", text: input }] });

    try {
      while (true) {
        if (signal.aborted) return;

        let assistant: Message | null = null;
        let lastTextLen = 0;
        for await (const snapshot of this.provider.stream({ messages: this.messages, tools, signal })) {
          assistant = snapshot;
          const text = snapshot.content.find((c) => c.type === "text");
          if (text && text.type === "text" && text.text.length > lastTextLen) {
            process.stdout.write(text.text.slice(lastTextLen));
            lastTextLen = text.text.length;
          }
          yield { type: "partial", message: snapshot };
        }
        if (!assistant) return;

        this.messages.push(assistant);
        yield { type: "message", message: assistant };

        const toolUses = assistant.content.filter(
          (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use"
        );
        if (toolUses.length === 0) return;

        console.log("\n[tool_use]", toolUses.map((u) => `${u.name}(${JSON.stringify(u.input)})`).join(", "));

        for (const u of toolUses) {
          const result = await toolImpls[u.name](u.input, { signal });
          console.log("[tool_result]", `${u.name}: ${result}`);
          const toolMsg: Message = {
            role: "tool",
            content: [{ type: "tool_result", tool_use_id: u.id, content: result }],
          };
          this.messages.push(toolMsg);
          yield { type: "message", message: toolMsg };
        }
      }
    } finally {
      this._abortController = null;
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[user] 用一句话介绍一下你自己，然后顺便查一下北京和上海的天气");
  console.log("[dim] 注意 [assistant] 文本是流式逐字到达的，不是一整段 flush 出来的。");
  console.log("[dim] ─────────────────────────");
  console.log("[assistant]");

  const provider = new OpenAIProvider(
    new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY ?? "", baseURL: "https://api.deepseek.com/v1" }),
    "deepseek-chat"
  );
  const agent = new Agent(provider);
  signal?.addEventListener("abort", () => agent.abort(signal.reason));

  for await (const _ of agent.stream("用一句话介绍一下你自己，然后顺便查一下北京和上海的天气")) void _;
}
