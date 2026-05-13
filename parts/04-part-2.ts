import OpenAI from "openai";
import { z } from "zod";
import { createHash } from "node:crypto";

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

// 构造一个"永远 pending"的 mock：让 LLM 自然陷入"再试一次"的循环
const checkBuildTool = defineTool({
  name: "check_build_status",
  description: "查询 CI 构建状态，返回 pending / success / failed",
  parameters: z.object({
    build_id: z.string().describe("构建 ID"),
  }),
  invoke: async ({ build_id }) => {
    return `Build ${build_id}: status=pending, please check again in a moment`;
  },
});

const tools: FunctionTool[] = [checkBuildTool];

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

interface LoopDetectionOptions {
  windowSize?: number;
  warnThreshold?: number;
  hardLimit?: number;
}

const WARN_MESSAGE =
  "SYSTEM: 检测到你似乎在重复调用同一个工具。请确认当前策略是否有效，必要时换个思路或者直接告诉用户当前情况。";

const STOP_MESSAGE =
  "SYSTEM: 重复调用模式已触发硬限制。请直接告诉用户当前进展和遇到的障碍，不要再继续尝试。";

function loopDetectionMiddleware(options: LoopDetectionOptions = {}): AgentMiddleware {
  const windowSize = options.windowSize ?? 20;
  const warnThreshold = options.warnThreshold ?? 2;
  const hardLimit = options.hardLimit ?? 4;

  // 状态全在闭包里，每个 .use() 都拿到独立实例，多 agent 并发互不串台
  const hashes: string[] = [];
  let warned = false;
  // OpenAI 协议要求 assistant.tool_calls 后紧接 tool 消息，中间不能插 user；
  // 所以 afterModel 检测到的提示消息要先挂在闭包里，下一次 beforeModel（tool_results 都 push 完之后）再补
  let pendingMsg: { role: "user"; content: string } | null = null;
  let pendingStop = false;

  return {
    // 下一轮开头：把上一轮 afterModel 排好的消息真正 push 进去，再决定要不要 shouldStop
    beforeModel: (ctx) => {
      if (pendingMsg) {
        ctx.messages.push(pendingMsg);
        pendingMsg = null;
      }
      if (pendingStop) {
        ctx.shouldStop = true;
        pendingStop = false;
      }
    },
    // 钩子用 afterModel：LLM 已经决定调哪些工具，但还没真跑，是阻止资源浪费的最早时机
    afterModel: (_ctx, message) => {
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) return;

      for (const tc of toolCalls) {
        const h = createHash("md5")
          .update(`${tc.function.name}:${tc.function.arguments}`)
          .digest("hex")
          .slice(0, 12);
        hashes.push(h);
      }
      if (hashes.length > windowSize) {
        hashes.splice(0, hashes.length - windowSize);
      }

      const counts = new Map<string, number>();
      let max = 0;
      for (const h of hashes) {
        const next = (counts.get(h) ?? 0) + 1;
        counts.set(h, next);
        if (next > max) max = next;
      }

      if (max >= hardLimit) {
        // 排好下一轮 beforeModel 的动作：先补 STOP_MESSAGE，再把 shouldStop 置 true
        pendingMsg = { role: "user", content: STOP_MESSAGE };
        pendingStop = true;
        console.log("[loop-detection]", `hard stop scheduled (max repeat = ${max})`);
      } else if (max >= warnThreshold && !warned) {
        warned = true; // 警告只发一次，重复消息只会让 LLM 更乱
        pendingMsg = { role: "user", content: WARN_MESSAGE };
        console.log("[loop-detection]", `warning scheduled (max repeat = ${max})`);
      }
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
      // beforeModel 里可能把 shouldStop 标了（loop-detection 的硬停就是这样），这时立刻退出避免多调一次 LLM
      if (agentCtx.shouldStop) break;

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

    if (agentCtx.shouldStop) {
      console.log("[aborted]", "agent stopped by middleware (shouldStop = true)");
    }
  }
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] Part 2 · loop-detection middleware");
  console.log("[dim] 构造一个永远 pending 的 check_build_status，看 LLM 重复轮询时怎么被拦下来");
  console.log("[dim] 阈值故意调低：warnThreshold=2, hardLimit=4");
  console.log("[dim] ─────────────────────────");

  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  agent.use(timingMiddleware());
  agent.use(loopDetectionMiddleware({ warnThreshold: 2, hardLimit: 4 }));

  await agent.run(
    "请用 check_build_status 查询 build_id=build_42 的 CI 构建状态。如果返回 pending，请用完全相同的参数继续查询直到拿到 success 或 failed 为止，不要换 build_id。",
    { signal }
  );
}
