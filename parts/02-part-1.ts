import OpenAI from "openai";
import { weatherTools, weatherImpls } from "./_shared/tools.js";

export type RunCtx = { log: (line: string) => void; signal?: AbortSignal };

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  baseURL: "https://api.deepseek.com/v1",
});

export async function run({ log }: RunCtx) {
  const userMessage = "北京和上海今天天气怎么样？";
  log(`\x1b[36m[user]\x1b[0m ${userMessage}\n`);

  const messages: any[] = [{ role: "user", content: userMessage }];

  while (true) {
    log(`\x1b[33m[step]\x1b[0m 调用 deepseek-chat ...`);
    const resp = await client.chat.completions.create({
      model: "deepseek-chat",
      messages,
      tools: weatherTools,
    });
    const assistantMsg = resp.choices[0].message;
    messages.push(assistantMsg);

    if (assistantMsg.tool_calls?.length) {
      const summary = assistantMsg.tool_calls
        .map((c: any) => `${c.function.name}(${c.function.arguments})`)
        .join(", ");
      log(`\x1b[35m[tool_calls]\x1b[0m ${summary}`);
    }

    if (!assistantMsg.tool_calls?.length) {
      log(`\n\x1b[32m[assistant]\x1b[0m ${assistantMsg.content ?? ""}`);
      log(`\n\x1b[32m✓ done\x1b[0m`);
      return;
    }

    const toolMsgs = await Promise.all(
      assistantMsg.tool_calls.map(async (call: any) => {
        const args = JSON.parse(call.function.arguments);
        const result = await weatherImpls[call.function.name](args);
        log(`\x1b[34m[tool_result]\x1b[0m ${call.function.name}: ${result}`);
        return {
          role: "tool" as const,
          tool_call_id: call.id,
          content: result,
        };
      })
    );
    messages.push(...toolMsgs);
  }
}
