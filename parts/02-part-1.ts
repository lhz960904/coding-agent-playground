import OpenAI from "openai";
import { weatherTools, weatherImpls } from "./_shared/tools.js";
import type { LogFn } from "./_shared/log.js";

export type RunCtx = { log: LogFn; signal?: AbortSignal };

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: "https://api.deepseek.com/v1",
});

const tools = weatherTools;

export async function run({ log }: RunCtx) {
  const userMessage = "北京和上海今天天气怎么样？";
  log('user', userMessage);

  const messages: any[] = [{ role: "user", content: userMessage }];

  while (true) {
    log('step', '调用 deepseek-chat ...');
    const resp = await client.chat.completions.create({
      model: "deepseek-chat",
      messages,
      tools,
    });
    const assistantMsg = resp.choices[0].message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls?.length) {
      log('assistant', assistantMsg.content ?? "");
      log('done');
      return;
    }

    const summary = assistantMsg.tool_calls.map((c: any) => `${c.function.name}(${c.function.arguments})`).join(", ");
    log('tool_calls', summary);

    const toolMsgs = await Promise.all(
      assistantMsg.tool_calls.map(async (call: any) => {
        const args = JSON.parse(call.function.arguments);
        const result = await weatherImpls[call.function.name](args);
        log('tool_result', `${call.function.name}: ${result}`);
        return { role: "tool" as const, tool_call_id: call.id, content: result };
      })
    );
    messages.push(...toolMsgs);
  }
}
