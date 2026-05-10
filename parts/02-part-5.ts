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
  stream(params: InvokeParams): AsyncGenerator<Message>;
}

export class OpenAIProvider implements LLMProvider {
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
      yield this.snapshot(text, toolCalls);
    }
  }

  private snapshot(text: string, toolCalls: any[]): Message {
    const blocks: ContentBlock[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const tc of toolCalls) {
      let input: any = {};
      try { input = JSON.parse(tc.argsJson); } catch {}
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

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  constructor(apiKey: string, private model: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL });
  }

  async *stream({ messages, tools, signal }: InvokeParams): AsyncGenerator<Message> {
    const sys = messages.find((m) => m.role === "system");
    const sysText = sys?.content.filter((c) => c.type === "text").map((c: any) => c.text).join("") ?? "";

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 1024,
        system: sysText || undefined,
        messages: messages.filter((m) => m.role !== "system").map((m) => this.toAnthropicMessage(m)) as any,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      },
      { signal }
    );

    let text = "";
    const toolUses: { id: string; name: string; argsJson: string }[] = [];
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        if (ev.content_block.type === "tool_use") {
          toolUses[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, argsJson: "" };
        }
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") text += ev.delta.text;
        else if (ev.delta.type === "input_json_delta") toolUses[ev.index].argsJson += ev.delta.partial_json;
      }
      yield this.snapshot(text, toolUses);
    }
  }

  private snapshot(text: string, toolUses: any[]): Message {
    const blocks: ContentBlock[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const u of toolUses) {
      if (!u) continue;
      let input: any = {};
      try { input = u.argsJson ? JSON.parse(u.argsJson) : {}; } catch {}
      blocks.push({ type: "tool_use", id: u.id, name: u.name, input });
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

const toolImpls: Record<string, (input: any, ctx: { signal?: AbortSignal }) => Promise<string>> = {
  get_weather: async ({ city }, { signal }) => {
    await new Promise((r) => setTimeout(r, 300));
    if (signal?.aborted) throw signal.reason;
    return `${city} 今天 25°C 晴`;
  },
};

type AgentEvent =
  | { type: "partial"; message: Message }
  | { type: "message"; message: Message };

export class Agent {
  private messages: Message[] = [];
  private _abortController: AbortController | null = null;

  constructor(private provider: LLMProvider, private label: string) {}

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

    console.log("[user]", `[${this.label}] ${input}`);
    this.messages.push({ role: "user", content: [{ type: "text", text: input }] });

    try {
      while (true) {
        if (signal.aborted) {
          console.log("[aborted]", String(signal.reason));
          this._finalizeOnAbort(String(signal.reason));
          return;
        }

        console.log("[step] provider.stream ...");
        let assistant: Message | null = null;
        let lastTextLen = 0;
        for await (const snap of this.provider.stream({ messages: this.messages, tools, signal })) {
          assistant = snap;
          const textBlock = snap.content.find((c) => c.type === "text");
          if (textBlock?.type === "text" && textBlock.text.length > lastTextLen) {
            process.stdout.write(textBlock.text.slice(lastTextLen));
            lastTextLen = textBlock.text.length;
          }
          yield { type: "partial", message: snap };
        }
        if (lastTextLen > 0) process.stdout.write("\n");
        if (!assistant) return;

        this.messages.push(assistant);
        yield { type: "message", message: assistant };

        const toolUses = assistant.content.filter(
          (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use"
        );
        if (toolUses.length === 0) return;

        if (signal.aborted) {
          console.log("[aborted] before tool execution");
          this._finalizeOnAbort(String(signal.reason));
          return;
        }

        for await (const m of this._act(toolUses, signal)) {
          this.messages.push(m);
          yield { type: "message", message: m };
        }
      }
    } catch (err: any) {
      if (signal.aborted) {
        console.log("[aborted] provider stream aborted");
        this._finalizeOnAbort(String(signal.reason));
        return;
      }
      throw err;
    } finally {
      this._abortController = null;
    }
  }

  private async *_act(
    toolUses: Extract<ContentBlock, { type: "tool_use" }>[],
    signal: AbortSignal
  ): AsyncGenerator<Message> {
    const start = Date.now();
    const pending = toolUses.map((u, idx) =>
      (async () => {
        const result = await toolImpls[u.name](u.input, { signal });
        console.log("[tool_result]", `+${Date.now() - start}ms ${u.name}: ${result}`);
        return { idx, tool_use_id: u.id, content: result };
      })()
    );

    const remaining = new Set(pending.map((_, i) => i));
    while (remaining.size > 0) {
      const candidates = [...remaining].map((i) => pending[i]);
      const winner = await Promise.race(candidates);
      remaining.delete(winner.idx);
      yield {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: winner.tool_use_id, content: winner.content }],
      };
    }
  }

  private _finalizeOnAbort(reason: string) {
    const last = this.messages.findLast((m) => m.role === "assistant");
    if (!last) return;
    const orphanIds = last.content
      .filter((c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use")
      .map((c) => c.id);
    if (orphanIds.length === 0) return;
    const done = new Set<string>();
    for (const m of this.messages) {
      if (m.role !== "tool") continue;
      for (const c of m.content) {
        if (c.type === "tool_result") done.add(c.tool_use_id);
      }
    }
    for (const id of orphanIds) {
      if (done.has(id)) continue;
      this.messages.push({
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: id, content: `[interrupted] ${reason}` }],
      });
      console.log("[tool_result]", `${id}: [interrupted] ${reason}`);
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] 同一个 Agent 主循环 + 同一套 block-based message，先跑 DeepSeek（OpenAI 兼容协议）");
  console.log("[dim] 如果配了 ANTHROPIC_API_KEY，再跑一遍 Claude，主循环代码完全不变");
  console.log("[dim] ─────────────────────────");

  const deepseek = new OpenAIProvider(
    new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY ?? "", baseURL: "https://api.deepseek.com/v1" }),
    "deepseek-chat"
  );
  const a1 = new Agent(deepseek, "deepseek-chat");
  signal?.addEventListener("abort", () => a1.abort(signal.reason));
  for await (const _ of a1.stream("北京今天天气怎么样？")) void _;

  if (process.env.ANTHROPIC_API_KEY) {
    console.log("[dim] ─── 切到 Anthropic Provider，主循环代码不变 ───");
    const claude = new AnthropicProvider(
      process.env.ANTHROPIC_API_KEY,
      "claude-sonnet-4-6",
      process.env.ANTHROPIC_BASE_URL
    );
    const a2 = new Agent(claude, "claude-sonnet-4-6");
    signal?.addEventListener("abort", () => a2.abort(signal.reason));
    for await (const _ of a2.stream("北京今天天气怎么样？")) void _;
  } else {
    console.log("[dim] [skip] 未配置 ANTHROPIC_API_KEY，跳过 Claude 对比。");
  }
}
