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
    // 故意返回比较长的文案，让 messages 体积涨得快一点，方便触发 auto-compact 阈值
    return `Product ${product_id} 详细信息：
- 名称：商品-${product_id}
- 规格：标准版 / 套装版 / 礼盒版
- 当前价格：¥${price}
- 库存：充足
- 评分：4.6/5.0
- 销量：本月已售 1200+
- 描述：性能优良，品质可靠，包装精美，售后无忧。深受消费者喜爱，是同类产品中的优选。支持七天无理由退货、十五天质保、全国联保。包装升级款，更环保更结实。配送时效：48 小时内发货，全国大部分地区可达 2 日。`;
  },
});

const tools: FunctionTool[] = [lookupProductTool];

function timingMiddleware(): AgentMiddleware {
  let modelStart = 0;
  return {
    beforeModel: () => {
      modelStart = Date.now();
    },
    afterModel: () => {
      console.log("[timing]", `model call took ${Date.now() - modelStart}ms`);
    },
  };
}

interface AutoCompactOptions {
  // 调谁来生成摘要：传一个独立的 LLMProvider，业务里常传便宜模型省钱
  provider: OpenAI;
  summaryModel: string;
  // token 阈值；这里故意调低，让 demo 里就能触发
  threshold?: number;
  countTokens?: (messages: any[]) => number;
  onCompacted?: (summary: { role: string; content: string }[]) => void | Promise<void>;
}

const ACK_TEXT = "Understood. Continuing with context from the summary.";

const SUMMARY_SYSTEM_PROMPT = "You are a conversation summarizer for coding agent sessions.";

function buildCompactPrompt(conversationText: string): string {
  return `Summarize this conversation for continuity. Preserve:
1) The user's original task and current progress
2) Tools that have been called and their key results (especially numeric data like prices)
3) Concrete next steps needed
Be concise but keep all product IDs and prices that have been queried.

Conversation:
${conversationText}`;
}

function serializeForSummary(messages: any[]): string {
  return messages
    .map((m: any) => {
      if (m.role === "tool") return `[TOOL_RESULT] ${String(m.content).slice(0, 400)}`;
      if (m.role === "assistant") {
        const toolCallStr = m.tool_calls?.length
          ? ` [TOOL_CALL: ${m.tool_calls.map((c: any) => `${c.function.name}(${c.function.arguments})`).join(", ")}]`
          : "";
        return `[ASSISTANT] ${m.content ?? ""}${toolCallStr}`;
      }
      return `[${String(m.role).toUpperCase()}] ${m.content ?? ""}`;
    })
    .join("\n");
}

// 极粗的 token 估算：每 4 个字符算 1 token；对代码和中文都偏低，所以默认阈值要留余量
function defaultCountTokens(messages: any[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function autoCompactMiddleware(options: AutoCompactOptions): AgentMiddleware {
  const { provider, summaryModel, onCompacted } = options;
  const threshold = options.threshold ?? 120_000;
  const countTokens = options.countTokens ?? defaultCountTokens;

  return {
    // 钩子选 beforeModel：调 LLM 之前先称重，超阈值就先压缩再走主循环
    beforeModel: async ({ messages }) => {
      const estimated = countTokens(messages);
      console.log("[auto-compact]", `estimated tokens = ${estimated}（阈值 ${threshold}）`);
      if (estimated < threshold) return;

      console.log("[auto-compact]", `阈值触发，调 summary model 生成摘要 ...`);

      // 把历史摊平成一段纯文本，喂给 summary 模型
      const text = serializeForSummary(messages);
      const resp = await provider.chat.completions.create({
        model: summaryModel,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: buildCompactPrompt(text) },
        ],
      });
      const summary = resp.choices[0].message?.content ?? "(summary unavailable)";

      const summaryUser = {
        role: "user" as const,
        content: `[Conversation Summary]\n\n${summary}`,
      };
      const ackAssistant = {
        role: "assistant" as const,
        content: ACK_TEXT,
      };

      const before = messages.length;
      // 原地清空再 push，保留 messages 数组引用（Part 3 已经定下的约定）
      messages.length = 0;
      messages.push(summaryUser, ackAssistant);

      console.log("[auto-compact]", `messages.length: ${before} → 2，summary 长度 ${summary.length} chars`);
      console.log("[auto-compact] summary preview:", summary.slice(0, 200).replace(/\n/g, " "));

      if (onCompacted) await onCompacted([summaryUser, ackAssistant]);
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

  getClient() {
    return this.client;
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
        console.log("[assistant]", (assistant.content ?? "").slice(0, 300));
        return;
      }
      console.log("[tool_calls]", assistant.tool_calls.map((c: any) => `${c.function.name}(${c.function.arguments})`).join(", "));

      const toolMsgs = await Promise.all(
        assistant.tool_calls.map(async (call: any) => {
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
          console.log("[tool_result]", `${call.function.name}: ${result.slice(0, 60)}...`);
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
  console.log("[dim] Part 4 · auto-compact middleware");
  console.log("[dim] 把 threshold 故意调到 1500 tokens，让 LLM 查到一半就触发摘要压缩");
  console.log("[dim] 注意压缩前后的 messages.length 数字变化");
  console.log("[dim] ─────────────────────────");

  const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
  const agent = new Agent(apiKey);
  agent.use(timingMiddleware());
  agent.use(
    autoCompactMiddleware({
      // 生产里这里应该传一个更便宜的模型；demo 简化用同一个
      provider: agent.getClient(),
      summaryModel: "deepseek-chat",
      threshold: 1500,
    })
  );

  await agent.run(
    "请依次用 lookup_product 工具查询 P001、P002、P003、P004、P005 这 5 个商品的价格，必须一个一个查（每次只调用一次 lookup_product，不要一次性查多个）。全部查完后告诉我哪一个最便宜，并报告所有商品的价格。",
    { signal }
  );
}
