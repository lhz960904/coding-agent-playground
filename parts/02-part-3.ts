import OpenAI from "openai";
import { racingTools, racingImpls } from "./_shared/tools.js";
import type { LogFn } from "./_shared/log.js";

export type RunCtx = { log: LogFn; signal?: AbortSignal };

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: "https://api.deepseek.com/v1",
});

const tools = racingTools;

async function* runToolsStreaming(
  toolCalls: any[],
  signal: AbortSignal | undefined,
  log: LogFn
): AsyncGenerator<{ tool_call_id: string; content: string }> {
  const start = Date.now();
  const pending = toolCalls.map((call, idx) =>
    (async () => {
      const args = JSON.parse(call.function.arguments);
      const t0 = Date.now();
      const result = await racingImpls[call.function.name](args, { signal });
      const dt = Date.now() - t0;
      log('tool_done', `+${(Date.now() - start)}ms ${call.function.name} (用时 ${dt}ms)`);
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

export async function run({ log, signal }: RunCtx) {
  const userMessage = "查一下北京的天气，再搜一下北京今天的本地新闻";
  log('user', userMessage);
  log('dim', 'get_weather 快（300ms），search_news 慢（3s）。看 race 怎么把快的那个先 yield 出来。');

  const messages: any[] = [{ role: "user", content: userMessage }];

  while (true) {
    if (signal?.aborted) return;

    log('step', '调用 deepseek-chat ...');
    const resp = await client.chat.completions.create(
      { model: "deepseek-chat", messages, tools },
      { signal }
    );
    const assistantMsg = resp.choices[0].message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls?.length) {
      log('assistant', assistantMsg.content ?? "");
      log('done');
      return;
    }
    log('tool_calls', `${assistantMsg.tool_calls.map((c: any) => c.function.name).join(", ")} 并发执行（race 逐个 yield）`);

    for await (const result of runToolsStreaming(assistantMsg.tool_calls, signal, log)) {
      messages.push({ role: "tool" as const, ...result });
    }
  }
}
