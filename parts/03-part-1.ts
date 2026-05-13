import OpenAI from "openai";
import { z } from "zod";

interface ToolContext {
  signal?: AbortSignal;
}

interface FunctionTool<P extends z.ZodObject = z.ZodObject, R = unknown> {
  name: string;
  description: string;
  parameters: P;
  invoke: (input: z.infer<P>, ctx: ToolContext) => Promise<R>;
}

function defineTool<P extends z.ZodObject, R>(opts: {
  name: string;
  description: string;
  parameters: P;
  invoke: (input: z.infer<P>, ctx: ToolContext) => Promise<R>;
}): FunctionTool<P, R> {
  return opts;
}

const getWeatherTool = defineTool({
  name: "get_weather",
  description: "查询某个城市的天气",
  parameters: z.object({
    city: z.string().describe("城市中文名，例如：北京、上海"),
  }),
  invoke: async ({ city }, { signal }) => {
    await new Promise((r) => setTimeout(r, 300));
    if (signal?.aborted) throw signal.reason;
    return `${city} 今天 25°C 晴`;
  },
});

const tools: FunctionTool[] = [getWeatherTool];

export class Agent {
  private client: OpenAI;
  private messages: any[] = [];

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" });
  }

  async run(input: string, ctx: ToolContext = {}) {
    console.log("[user]", input);
    this.messages.push({ role: "user", content: input });

    while (true) {
      console.log("[step] 调用 deepseek-chat ...");
      const resp = await this.client.chat.completions.create({
        model: "deepseek-chat",
        messages: this.messages,
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: z.toJSONSchema(t.parameters) as Record<string, unknown>,
          },
        })),
      });
      const assistant = resp.choices[0].message;
      this.messages.push(assistant);

      if (!assistant.tool_calls?.length) {
        console.log("[assistant]", assistant.content ?? "");
        return;
      }
      console.log("[tool_calls]", assistant.tool_calls.map((c: any) => `${c.function.name}(${c.function.arguments})`).join(", "));

      const toolMsgs = await Promise.all(
        assistant.tool_calls.map(async (call: any) => {
          const tool = tools.find((t) => t.name === call.function.name);
          if (!tool) throw new Error(`Tool ${call.function.name} not found`);
          const rawArgs = JSON.parse(call.function.arguments);
          const input = tool.parameters.parse(rawArgs);
          const result = await tool.invoke(input, ctx);
          console.log("[tool_result]", `${call.function.name}: ${result}`);
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          };
        })
      );
      this.messages.push(...toolMsgs);
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] defineTool + Zod schema —— schema 和 impl 写在一起，且类型安全。");
  console.log("[dim] tool.parameters 是 Zod schema；调 LLM 时 z.toJSONSchema 转成 OpenAI 期望的 JSON Schema。");
  console.log("[dim] ─────────────────────────");

  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  await agent.run("北京和上海今天天气怎么样？", { signal });
}
