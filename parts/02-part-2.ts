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

export class Agent {
  private client: OpenAI;
  private messages: any[] = [];
  private _abortController: AbortController | null = null;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com/v1",
    });
  }

  abort(reason?: unknown) {
    this._abortController?.abort(reason);
  }

  async run(input: string) {
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

        console.log("[step] 调用 deepseek-chat ...");
        const resp = await this.client.chat.completions.create(
          { model: "deepseek-chat", messages: this.messages, tools },
          { signal }
        );
        const assistant = resp.choices[0].message;
        this.messages.push(assistant);

        if (!assistant.tool_calls?.length) {
          console.log("[assistant]", assistant.content ?? "");
          return;
        }
        console.log("[tool_calls]", `${assistant.tool_calls.length} 个并发调用`);

        if (signal.aborted) {
          console.log("[aborted] before tool execution");
          this._finalizeOnAbort(String(signal.reason));
          return;
        }

        const toolMsgs = await Promise.all(
          assistant.tool_calls.map(async (call: any) => {
            const args = JSON.parse(call.function.arguments);
            const result = await toolImpls[call.function.name](args, { signal });
            console.log("[tool_result]", `${call.function.name}(${args.city}): ${result}`);
            return { role: "tool" as const, tool_call_id: call.id, content: result };
          })
        );
        this.messages.push(...toolMsgs);
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
  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");

  console.log("[dim] 5 秒后会自动 abort，模拟用户点了 Stop 按钮");
  signal?.addEventListener("abort", () => agent.abort(signal.reason));
  const timer = setTimeout(() => agent.abort("user clicked stop (5s timeout)"), 5000);

  try {
    await agent.run("帮我查 5 个城市的天气：北京、上海、深圳、杭州、广州");
  } finally {
    clearTimeout(timer);
  }
}
