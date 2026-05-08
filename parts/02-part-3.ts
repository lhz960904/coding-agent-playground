import OpenAI from "openai";
import { racingTools, racingImpls } from "./_shared/tools.js";

export type RunCtx = { log: (line: string) => void; signal?: AbortSignal };

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: "https://api.deepseek.com/v1",
});

async function* runToolsStreaming(
  toolCalls: any[],
  signal: AbortSignal | undefined,
  log: (s: string) => void
): AsyncGenerator<{ tool_call_id: string; content: string }> {
  const start = Date.now();
  const pending = toolCalls.map((call, idx) =>
    (async () => {
      const args = JSON.parse(call.function.arguments);
      const t0 = Date.now();
      const result = await racingImpls[call.function.name](args, { signal });
      const dt = Date.now() - t0;
      log(`\x1b[34m[tool_done +${(Date.now() - start).toString().padStart(4)}ms]\x1b[0m ${call.function.name} (用时 ${dt}ms)`);
      return { idx, tool_call_id: call.id, content: result };
    })()
  );

  const remaining = new Set(pending.map((_, i) => i));
  while (remaining.size > 0) {
    const candidates = [...remaining].map((i) => pending[i]);
    const winner = await Promise.race(candidates);
    remaining.delete(winner.idx);
    yield { tool_call_id: winner.tool_call_id, content: winner.content };
  }
}

export async function* runStream({ log, signal }: RunCtx): AsyncGenerator<void> {
  const userMessage = "查一下北京的天气，再搜一下北京今天的本地新闻";
  log(`\x1b[36m[user]\x1b[0m ${userMessage}`);
  log(`\x1b[2m[demo] get_weather 快（300ms），search_news 慢（3s）。看 race 怎么把快的那个先 yield 出来。\x1b[0m\n`);

  const messages: any[] = [{ role: "user", content: userMessage }];

  while (true) {
    if (signal?.aborted) return;

    log(`\x1b[33m[step]\x1b[0m 调用 deepseek-chat ...`);
    const resp = await client.chat.completions.create(
      { model: "deepseek-chat", messages, tools: racingTools },
      { signal }
    );
    const assistantMsg = resp.choices[0].message;
    messages.push(assistantMsg);
    yield;

    if (!assistantMsg.tool_calls?.length) {
      log(`\n\x1b[32m[assistant]\x1b[0m ${assistantMsg.content ?? ""}`);
      log(`\n\x1b[32m✓ done\x1b[0m`);
      return;
    }
    log(`\x1b[35m[tool_calls]\x1b[0m ${assistantMsg.tool_calls.map((c: any) => c.function.name).join(", ")} 并发执行（race 逐个 yield）`);

    for await (const result of runToolsStreaming(assistantMsg.tool_calls, signal, log)) {
      messages.push({ role: "tool" as const, ...result });
      yield;
    }
  }
}

export async function run(ctx: RunCtx) {
  for await (const _ of runStream(ctx)) void _;
}
