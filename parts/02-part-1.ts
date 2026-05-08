import { weatherTools, weatherImpls } from "./_shared/tools.js";
import { makeClient } from "./_shared/client.js";

export type RunCtx = { log: (line: string) => void; signal?: AbortSignal };

export async function run({ log }: RunCtx) {
  const { client, model, label } = makeClient();
  log(`\x1b[2m[provider] ${label} · model=${model}\x1b[0m`);

  const userMessage = "北京和上海今天天气怎么样？";
  log(`\x1b[36m[user]\x1b[0m ${userMessage}\n`);

  const messages: any[] = [{ role: "user", content: userMessage }];

  while (true) {
    log(`\x1b[33m[step]\x1b[0m 调用 ${model} ...`);
    const resp = await client.chat.completions.create({
      model,
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
