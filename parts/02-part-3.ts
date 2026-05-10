import OpenAI from "openai";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "查询某个城市的天气",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
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
  | { type: "partial"; message: any }
  | { type: "message"; message: any };

export class Agent {
  private client: OpenAI;
  private messages: any[] = [];
  private _abortController: AbortController | null = null;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" });
  }

  abort(reason?: unknown) {
    this._abortController?.abort(reason);
  }

  async invoke(input: string): Promise<any[]> {
    const collected: any[] = [];
    for await (const ev of this.stream(input)) {
      if (ev.type === "message") collected.push(ev.message);
    }
    return collected;
  }

  async *stream(input: string): AsyncGenerator<AgentEvent> {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    console.log("[user]", input);
    this.messages.push({ role: "user", content: input });

    try {
      while (true) {
        if (signal.aborted) {
          console.log("[aborted]", String(signal.reason));
          this._finalizeOnAbort(String(signal.reason));
          return;
        }

        console.log("[step] stream deepseek-chat ...");
        const assistant = yield* this._streamAssistant(signal);
        if (!assistant) return;

        this.messages.push(assistant);
        yield { type: "message", message: assistant };

        if (!assistant.tool_calls?.length) return;

        if (signal.aborted) {
          console.log("[aborted] before tool execution");
          this._finalizeOnAbort(String(signal.reason));
          return;
        }

        const toolMsgs = await Promise.all(
          assistant.tool_calls.map(async (call: any) => {
            const args = JSON.parse(call.function.arguments);
            const result = await toolImpls[call.function.name](args, { signal });
            console.log("[tool_result]", `${call.function.name}: ${result}`);
            return { role: "tool" as const, tool_call_id: call.id, content: result };
          })
        );
        for (const m of toolMsgs) {
          this.messages.push(m);
          yield { type: "message", message: m };
        }
      }
    } catch (err: any) {
      if (signal.aborted) {
        console.log("[aborted] LLM request aborted");
        this._finalizeOnAbort(String(signal.reason));
        return;
      }
      throw err;
    } finally {
      this._abortController = null;
    }
  }

  private async *_streamAssistant(signal: AbortSignal): AsyncGenerator<AgentEvent, any> {
    const stream = await this.client.chat.completions.create(
      { model: "deepseek-chat", messages: this.messages, tools, stream: true },
      { signal }
    );

    let text = "";
    let lastTextLen = 0;
    const toolCalls: { id: string; name: string; argsJson: string }[] = [];
    let snapshot: any = null;

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

      snapshot = {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.length
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.argsJson },
            }))
          : undefined,
      };

      if (text.length > lastTextLen) {
        process.stdout.write(text.slice(lastTextLen));
        lastTextLen = text.length;
      }
      yield { type: "partial", message: snapshot };
    }
    if (text) process.stdout.write("\n");
    return snapshot;
  }

  private _finalizeOnAbort(reason: string) {
    const last = this.messages.findLast((m: any) => m.role === "assistant");
    if (!last?.tool_calls?.length) return;
    const done = new Set(
      this.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)
    );
    for (const call of last.tool_calls) {
      if (done.has(call.id)) continue;
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `[interrupted] ${reason}`,
      });
      console.log("[tool_result]", `${call.function.name}: [interrupted] ${reason}`);
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] partial 事件按 token 推流（前端做打字机效果）；message 事件是定稿（前端落到消息列表）");
  console.log("[dim] ─────────────────────────");

  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  signal?.addEventListener("abort", () => agent.abort(signal.reason));

  for await (const _ of agent.stream("用一句话介绍一下你自己，然后查一下北京的天气")) void _;
}
