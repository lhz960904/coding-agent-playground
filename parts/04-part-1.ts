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

interface AgentContext {
  messages: any[];
  tools: FunctionTool[];
  shouldStop?: boolean;
}

interface AgentMiddleware {
  beforeModel?: (ctx: AgentContext) => void | Promise<void>;
  afterModel?: (ctx: AgentContext, message: any) => void | Promise<void>;
  beforeToolUse?: (ctx: AgentContext, toolUse: any) => void | Promise<void>;
  afterToolUse?: (ctx: AgentContext, toolUse: any, toolResult: string) => void | Promise<void>;
}

const weatherTool = defineTool({
  name: "get_weather",
  description: "查询某个城市的天气，返回温度",
  parameters: z.object({
    city: z.string().describe("城市名"),
  }),
  invoke: async ({ city }) => {
    const fakeTemp = 18 + Math.floor(Math.random() * 12);
    await new Promise((r) => setTimeout(r, 20));
    return `${city} 今天 ${fakeTemp}°C 晴`;
  },
});

const calcSumTool = defineTool({
  name: "calc_sum",
  description: "计算两个数字的和",
  parameters: z.object({
    a: z.number(),
    b: z.number(),
  }),
  invoke: async ({ a, b }) => `${a + b}`,
});

const tools: FunctionTool[] = [weatherTool, calcSumTool];

function timingMiddleware(): AgentMiddleware {
  const toolTimers = new Map<string, number>();
  let modelStart = 0;

  return {
    beforeModel: () => {
      modelStart = Date.now();
    },
    afterModel: () => {
      console.log("[timing]", `model call took ${Date.now() - modelStart}ms`);
    },
    beforeToolUse: (_ctx, call) => {
      toolTimers.set(call.id, Date.now());
    },
    afterToolUse: (_ctx, call) => {
      const elapsed = Date.now() - (toolTimers.get(call.id) ?? 0);
      console.log("[timing]", `tool ${call.function.name} took ${elapsed}ms`);
      toolTimers.delete(call.id);
    },
  };
}

export class Agent {
  private client: OpenAI;
  private messages: any[] = [];
  private middlewares: AgentMiddleware[] = [];

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" });
  }

  use(mw: AgentMiddleware) {
    this.middlewares.push(mw);
    return this;
  }

  async run(input: string, ctx: ToolContext = {}) {
    console.log("[user]", input);
    this.messages.push({ role: "user", content: input });

    const agentCtx: AgentContext = {
      messages: this.messages,
      tools,
    };

    while (!ctx.signal?.aborted && !agentCtx.shouldStop) {
      for (const mw of this.middlewares) await mw.beforeModel?.(agentCtx);

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

      for (const mw of this.middlewares) await mw.afterModel?.(agentCtx, assistant);

      if (!assistant.tool_calls?.length) {
        console.log("[assistant]", assistant.content ?? "");
        return;
      }
      console.log("[tool_calls]", assistant.tool_calls.map((c: any) => `${c.function.name}(${c.function.arguments})`).join(", "));

      const toolMsgs = await Promise.all(
        assistant.tool_calls.map(async (call: any) => {
          for (const mw of this.middlewares) await mw.beforeToolUse?.(agentCtx, call);

          let result: string;
          try {
            const tool = tools.find((t) => t.name === call.function.name);
            if (!tool) throw new Error(`Tool ${call.function.name} not found`);
            const input = tool.parameters.parse(JSON.parse(call.function.arguments));
            const r = await tool.invoke(input, ctx);
            result = typeof r === "string" ? r : JSON.stringify(r);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          for (const mw of this.middlewares) await mw.afterToolUse?.(agentCtx, call, result);

          console.log("[tool_result]", `${call.function.name}: ${result.split("\n")[0].slice(0, 100)}`);
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: result,
          };
        })
      );
      this.messages.push(...toolMsgs);
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] Part 1 · middleware 接口 + 主循环织入");
  console.log("[dim] 装一个 timing middleware，用 4 个钩子全统计 model 和 tool 的耗时");
  console.log("[dim] ─────────────────────────");

  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  agent.use(timingMiddleware());

  await agent.run(
    "请帮我查一下北京和上海的天气，然后用 calc_sum 算一下两地的温度之和",
    { signal }
  );
}
