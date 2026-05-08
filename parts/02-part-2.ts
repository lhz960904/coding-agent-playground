import OpenAI from "openai";
import { weatherTools, weatherImpls } from "./_shared/tools.js";

export type RunCtx = { log: (line: string) => void; signal?: AbortSignal };

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: "https://api.deepseek.com/v1",
});

export async function run({ log, signal }: RunCtx) {
  const userMessage = "帮我查 5 个城市的天气：北京、上海、深圳、杭州、广州";
  log(`\x1b[36m[user]\x1b[0m ${userMessage}`);
  log(`\x1b[2m[demo] 5 秒后会自动 abort，模拟用户点了 Stop 按钮\x1b[0m\n`);

  const internalAbort = new AbortController();
  const externalSub = () => internalAbort.abort(signal?.reason ?? "external abort");
  signal?.addEventListener("abort", externalSub);
  const timer = setTimeout(() => internalAbort.abort("user clicked stop (5s timeout)"), 5000);
  const runSignal = internalAbort.signal;

  const messages: any[] = [{ role: "user", content: userMessage }];

  try {
    while (true) {
      if (runSignal.aborted) {
        log(`\n\x1b[31m✗ aborted:\x1b[0m ${String(runSignal.reason)}`);
        return;
      }

      log(`\x1b[33m[step]\x1b[0m 调用 deepseek-chat ...`);
      const resp = await client.chat.completions.create(
        { model: "deepseek-chat", messages, tools: weatherTools },
        { signal: runSignal }
      );
      const assistantMsg = resp.choices[0].message;
      messages.push(assistantMsg);

      if (!assistantMsg.tool_calls?.length) {
        log(`\n\x1b[32m[assistant]\x1b[0m ${assistantMsg.content ?? ""}`);
        log(`\n\x1b[32m✓ done\x1b[0m`);
        return;
      }
      log(`\x1b[35m[tool_calls]\x1b[0m ${assistantMsg.tool_calls.length} 个并发调用`);

      if (runSignal.aborted) {
        log(`\n\x1b[31m✗ aborted before tool execution\x1b[0m`);
        return;
      }

      const toolMsgs = await Promise.all(
        assistantMsg.tool_calls.map(async (call: any) => {
          const args = JSON.parse(call.function.arguments);
          const result = await weatherImpls[call.function.name](args, { signal: runSignal });
          log(`\x1b[34m[tool_result]\x1b[0m ${call.function.name}(${args.city}): ${result}`);
          return { role: "tool" as const, tool_call_id: call.id, content: result };
        })
      );
      messages.push(...toolMsgs);
    }
  } catch (err: any) {
    if (runSignal.aborted) {
      log(`\n\x1b[31m✗ LLM 请求被 abort\x1b[0m`);
      return;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", externalSub);
  }
}
