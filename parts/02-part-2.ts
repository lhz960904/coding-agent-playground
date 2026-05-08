import OpenAI from "openai";
import { weatherTools, weatherImpls } from "./_shared/tools.js";
import type { LogFn } from "./_shared/log.js";

export type RunCtx = { log: LogFn; signal?: AbortSignal };

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: "https://api.deepseek.com/v1",
});

const tools = weatherTools;

export async function run({ log, signal }: RunCtx) {
  const userMessage = "帮我查 5 个城市的天气：北京、上海、深圳、杭州、广州";
  log('user', userMessage);
  log('dim', '5 秒后会自动 abort，模拟用户点了 Stop 按钮');

  const internalAbort = new AbortController();
  const onExternal = () => internalAbort.abort(signal?.reason ?? "external abort");
  signal?.addEventListener("abort", onExternal);
  const timer = setTimeout(() => internalAbort.abort("user clicked stop (5s timeout)"), 5000);
  const runSignal = internalAbort.signal;

  const messages: any[] = [{ role: "user", content: userMessage }];

  try {
    while (true) {
      if (runSignal.aborted) {
        log('aborted', String(runSignal.reason));
        return;
      }

      log('step', '调用 deepseek-chat ...');
      const resp = await client.chat.completions.create(
        { model: "deepseek-chat", messages, tools },
        { signal: runSignal }
      );
      const assistantMsg = resp.choices[0].message;
      messages.push(assistantMsg);

      if (!assistantMsg.tool_calls?.length) {
        log('assistant', assistantMsg.content ?? "");
        log('done');
        return;
      }
      log('tool_calls', `${assistantMsg.tool_calls.length} 个并发调用`);

      if (runSignal.aborted) {
        log('aborted', 'before tool execution');
        return;
      }

      const toolMsgs = await Promise.all(
        assistantMsg.tool_calls.map(async (call: any) => {
          const args = JSON.parse(call.function.arguments);
          const result = await weatherImpls[call.function.name](args, { signal: runSignal });
          log('tool_result', `${call.function.name}(${args.city}): ${result}`);
          return { role: "tool" as const, tool_call_id: call.id, content: result };
        })
      );
      messages.push(...toolMsgs);
    }
  } catch (err: any) {
    if (runSignal.aborted) {
      log('aborted', 'LLM request aborted');
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternal);
  }
}
