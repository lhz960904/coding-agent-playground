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

const lookupProductTool = defineTool({
  name: "lookup_product",
  description: "根据商品 ID 查询详情，返回名称、规格、价格、描述",
  parameters: z.object({
    product_id: z.string().describe("商品 ID，例如 P001"),
  }),
  invoke: async ({ product_id }) => {
    const prices: Record<string, number> = {
      P001: 199, P002: 89, P003: 449, P004: 129, P005: 299,
    };
    const price = prices[product_id] ?? 0;
    // 故意返回稍长一点的字符串，方便对比 stub 前后的 messages 体积差
    return `Product ${product_id} | 名称：商品-${product_id} | 规格：标准版 | 价格：¥${price} | 库存：充足 | 描述：性能优良，品质可靠，包装精美，售后无忧，深受消费者喜爱，是同类产品中的优选。`;
  },
});

const tools: FunctionTool[] = [lookupProductTool];

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

interface MicroCompactOptions {
  keepRecent?: number;
}

function microCompactMiddleware(options: MicroCompactOptions = {}): AgentMiddleware {
  const keepRecent = options.keepRecent ?? 10;

  return {
    // 钩子用 beforeModel：哪怕中间没触发任何工具，下次调 LLM 也会重新走一遍压缩判断
    beforeModel: ({ messages }) => {
      // OpenAI shape：tool_result 就是 role=tool 的消息，content 是字符串
      const toolMsgs = messages.filter((m: any) => m.role === "tool");

      if (toolMsgs.length <= keepRecent) {
        console.log("[micro-compact]", `tool_results=${toolMsgs.length} <= keepRecent=${keepRecent}，无需压缩`);
        return;
      }

      // 倒数 keepRecent 个保持原文，更早的挨个换 content（不改 messages 结构）
      const stubCount = toolMsgs.length - keepRecent;
      let newlyStubbed = 0;
      for (let i = 0; i < stubCount; i++) {
        const r = toolMsgs[i];
        // 已经 stub 过的不再 stub，避免占位符嵌套
        if (typeof r.content === "string" && r.content.startsWith("[Previous tool call output omitted")) continue;
        r.content = `[Previous tool call output omitted: used lookup_product]`;
        newlyStubbed++;
      }
      const totalStubbed = toolMsgs.slice(0, stubCount).filter((m: any) => typeof m.content === "string" && m.content.startsWith("[Previous")).length;
      console.log("[micro-compact]", `压缩 ${newlyStubbed} 条；当前 ${toolMsgs.length} 条 tool_result 中 ${totalStubbed} 条已 stub`);
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
        console.log("[assistant]", (assistant.content ?? "").slice(0, 200));
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

          console.log("[tool_result]", `${call.function.name}: ${result.slice(0, 80)}...`);
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
  console.log("[dim] Part 3 · micro-compact middleware");
  console.log("[dim] 让 LLM 一个一个查 5 个商品，故意把 keepRecent 调到 2，看早期 tool_result 被 stub 的过程");
  console.log("[dim] ─────────────────────────");

  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  agent.use(timingMiddleware());
  agent.use(microCompactMiddleware({ keepRecent: 2 }));

  await agent.run(
    "请依次用 lookup_product 工具查询 P001、P002、P003、P004、P005 这 5 个商品的价格，必须一个一个查（每次只调用一次 lookup_product，不要一次性查多个），全部查完后告诉我哪一个最便宜。",
    { signal }
  );
}
