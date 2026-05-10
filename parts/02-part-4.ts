import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

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

interface LLMProvider {
  invoke(params: InvokeParams): Promise<Message>;
}

export class OpenAIProvider implements LLMProvider {
  constructor(private client: OpenAI, private model: string) {}

  async invoke({ messages, tools, signal }: InvokeParams): Promise<Message> {
    const resp = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.toOpenAIMessages(messages),
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      },
      { signal }
    );
    return this.fromOpenAIMessage(resp.choices[0].message);
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

  private fromOpenAIMessage(msg: any): Message {
    const blocks: ContentBlock[] = [];
    if (msg.content) blocks.push({ type: "text", text: msg.content });
    if (msg.tool_calls) {
      for (const c of msg.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: c.id,
          name: c.function.name,
          input: JSON.parse(c.function.arguments),
        });
      }
    }
    return { role: "assistant", content: blocks };
  }
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async invoke({ messages, tools, signal }: InvokeParams): Promise<Message> {
    const sys = messages.find((m) => m.role === "system");
    const sysText = sys?.content.filter((c) => c.type === "text").map((c: any) => c.text).join("") ?? "";

    const resp = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        system: sysText || undefined,
        messages: messages.filter((m) => m.role !== "system").map((m) => this.toAnthropicMessage(m)) as any,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      },
      { signal }
    );

    const blocks: ContentBlock[] = [];
    for (const b of resp.content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    return { role: "assistant", content: blocks };
  }

  private toAnthropicMessage(m: Message): any {
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.content.filter((c) => c.type === "tool_result").map((c: any) => ({
          type: "tool_result", tool_use_id: c.tool_use_id, content: c.content,
        })),
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content.map((c) => {
          if (c.type === "text") return { type: "text", text: c.text };
          if (c.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input };
          throw new Error("unsupported assistant block");
        }),
      };
    }
    return {
      role: "user",
      content: m.content.filter((c) => c.type === "text").map((c: any) => ({ type: "text", text: c.text })),
    };
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

  constructor(private provider: LLMProvider, private label: string) {}

  abort(reason?: unknown) {
    this._abortController?.abort(reason);
  }

  async run(input: string) {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    console.log("[user]", `[${this.label}] ${input}`);
    this.messages.push({ role: "user", content: [{ type: "text", text: input }] });

    try {
      while (true) {
        if (signal.aborted) return;

        console.log("[step] provider.invoke ...");
        const assistant = await this.provider.invoke({ messages: this.messages, tools, signal });
        this.messages.push(assistant);

        const toolUses = assistant.content.filter(
          (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use"
        );

        if (toolUses.length === 0) {
          const text = assistant.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
          console.log("[assistant]", `[@ ${this.label}] ${text}`);
          return;
        }
        console.log("[tool_use]", toolUses.map((u) => `${u.name}(${JSON.stringify(u.input)})`).join(", "));

        for (const u of toolUses) {
          const result = await toolImpls[u.name](u.input, { signal });
          console.log("[tool_result]", `${u.name}: ${result}`);
          this.messages.push({
            role: "tool",
            content: [{ type: "tool_result", tool_use_id: u.id, content: result }],
          });
        }
      }
    } finally {
      this._abortController = null;
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] 同一个 Agent 主循环，先跑 DeepSeek（OpenAI 协议）。如果配了 ANTHROPIC_API_KEY，再跑一遍 Claude。");

  const deepseek = new OpenAIProvider(
    new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY ?? "", baseURL: "https://api.deepseek.com/v1" }),
    "deepseek-chat"
  );
  const a1 = new Agent(deepseek, "deepseek-chat");
  signal?.addEventListener("abort", () => a1.abort(signal.reason));
  await a1.run("北京今天天气怎么样？");

  if (process.env.ANTHROPIC_API_KEY) {
    console.log("[dim] ─── 切到 Anthropic Provider ───");
    const claude = new AnthropicProvider(process.env.ANTHROPIC_API_KEY, "claude-sonnet-4-6");
    const a2 = new Agent(claude, "claude-sonnet-4-6");
    signal?.addEventListener("abort", () => a2.abort(signal.reason));
    await a2.run("北京今天天气怎么样？");
  } else {
    console.log("[dim] [skip] 未配置 ANTHROPIC_API_KEY，跳过 Claude 对比。");
  }
}
