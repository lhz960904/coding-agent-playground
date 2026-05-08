import OpenAI from "openai";
import { weatherTools, weatherImpls } from "./_shared/tools.js";
import type { LogFn } from "./_shared/log.js";

export type RunCtx = { log: LogFn; signal?: AbortSignal };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

interface Tool {
  name: string;
  description: string;
  parameters: any;
}

interface InvokeParams {
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
}

interface LLMProvider {
  invoke(params: InvokeParams): Promise<Message>;
}

class OpenAIProvider implements LLMProvider {
  constructor(private client: OpenAI, private model: string) {}

  async invoke({ messages, tools, signal }: InvokeParams): Promise<Message> {
    const resp = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: this.toOpenAIMessages(messages),
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      },
      { signal }
    );
    return this.fromOpenAIMessage(resp.choices[0].message);
  }

  private toOpenAIMessages(messages: Message[]): any[] {
    return messages.flatMap((m): any[] => {
      if (m.role === "tool") {
        return m.content
          .filter((c) => c.type === "tool_result")
          .map((c: any) => ({ role: "tool", tool_call_id: c.tool_use_id, content: c.content }));
      }
      if (m.role === "assistant") {
        const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
        const toolCalls = m.content
          .filter((c) => c.type === "tool_use")
          .map((c: any) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          }));
        return [{
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : undefined,
        }];
      }
      const text = m.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
      return [{ role: m.role, content: text }];
    });
  }

  private fromOpenAIMessage(msg: any): Message {
    const blocks: ContentBlock[] = [];
    if (msg.content) blocks.push({ type: "text", text: msg.content });
    if (msg.tool_calls) {
      for (const c of msg.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: c.id,
          name: c.function.name,
          input: JSON.parse(c.function.arguments),
        });
      }
    }
    return { role: "assistant", content: blocks };
  }
}

const tools: Tool[] = [
  {
    name: weatherTools[0].function.name,
    description: weatherTools[0].function.description,
    parameters: weatherTools[0].function.parameters,
  },
];

async function runAgent(provider: LLMProvider, providerLabel: string, userMessage: string, log: LogFn, signal?: AbortSignal) {
  log('user', `[${providerLabel}] ${userMessage}`);
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];
  while (true) {
    if (signal?.aborted) return;

    log('step', 'provider.invoke ...');
    const assistantMsg = await provider.invoke({ messages, tools, signal });
    messages.push(assistantMsg);

    const toolUses = assistantMsg.content.filter(
      (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use"
    );

    if (toolUses.length === 0) {
      const text = assistantMsg.content.filter((c) => c.type === "text").map((c: any) => c.text).join("");
      log('assistant', `[@ ${providerLabel}] ${text}`);
      return;
    }
    log('tool_use', toolUses.map((u) => `${u.name}(${JSON.stringify(u.input)})`).join(", "));

    for (const u of toolUses) {
      const result = await weatherImpls[u.name](u.input, { signal });
      log('tool_result', `${u.name}: ${result}`);
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: u.id, content: result }],
      });
    }
  }
}

export async function run({ log, signal }: RunCtx) {
  log('dim', '同一个主循环跑 DeepSeek（OpenAI 协议）。如果配了 ANTHROPIC_API_KEY，再跑一遍 Claude 对比。');

  const deepseek = new OpenAIProvider(
    new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      baseURL: "https://api.deepseek.com/v1",
    }),
    "deepseek-chat"
  );

  await runAgent(deepseek, "deepseek-chat", "北京今天天气怎么样？", log, signal);

  if (process.env.ANTHROPIC_API_KEY) {
    log('dim', '─── 切到 Anthropic Provider ───');
    const { AnthropicProvider } = await import("./_shared/anthropic-provider.js");
    const claude = new AnthropicProvider(process.env.ANTHROPIC_API_KEY, "claude-sonnet-4-6");
    await runAgent(claude, "claude-sonnet-4-6", "北京今天天气怎么样？", log, signal);
  } else {
    log('dim', '[skip] 未配置 ANTHROPIC_API_KEY，跳过 Claude 对比。');
  }

  log('done');
}
