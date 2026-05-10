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
  {
    type: "function" as const,
    function: {
      name: "search_news",
      description: "搜索某个城市的本地新闻（演示用，故意慢 3 秒）",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

const toolImpls: Record<string, (input: any, ctx?: { signal?: AbortSignal }) => Promise<string>> = {
  get_weather: async ({ city }) => {
    await new Promise((r) => setTimeout(r, 300));
    return `${city} 今天 25°C 晴`;
  },
  search_news: async ({ city }) => {
    await new Promise((r) => setTimeout(r, 3000));
    return `${city} 今日要闻：mock 新闻数据`;
  },
};

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

  async run(input: string) {
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    console.log("[user]", input);
    this.messages.push({ role: "user", content: input });

    try {
      while (true) {
        if (signal.aborted) return;

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
        console.log(
          "[tool_calls]",
          `${assistant.tool_calls.map((c: any) => c.function.name).join(", ")} 并发执行（race 逐个 yield）`
        );

        for await (const toolMsg of this._act(assistant.tool_calls, signal)) {
          this.messages.push(toolMsg);
        }
      }
    } finally {
      this._abortController = null;
    }
  }

  private async *_act(toolCalls: any[], signal: AbortSignal): AsyncGenerator<any> {
    const start = Date.now();
    const pending = toolCalls.map((call, idx) =>
      (async () => {
        const args = JSON.parse(call.function.arguments);
        const t0 = Date.now();
        const result = await toolImpls[call.function.name](args, { signal });
        const dt = Date.now() - t0;
        console.log(
          "[tool_done]",
          `+${Date.now() - start}ms ${call.function.name} (用时 ${dt}ms)`
        );
        return { idx, tool_call_id: call.id, content: result };
      })()
    );

    const remaining = new Set(pending.map((_, i) => i));
    while (remaining.size > 0) {
      const candidates = [...remaining].map((i) => pending[i]);
      const winner = await Promise.race(candidates);
      remaining.delete(winner.idx);
      yield { role: "tool" as const, tool_call_id: winner.tool_call_id, content: winner.content };
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  signal?.addEventListener("abort", () => agent.abort(signal.reason));

  console.log("[dim] get_weather 快（300ms），search_news 慢（3s）。看 race 怎么把快的那个先 yield 出来。");
  await agent.run("查一下北京的天气，再搜一下北京今天的本地新闻");
}
