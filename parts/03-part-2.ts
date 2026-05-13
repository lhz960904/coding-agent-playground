import OpenAI from "openai";
import { z } from "zod";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

const MAX_FILE_CHARS = 12000;

const readFileTool = defineTool({
  name: "read_file",
  description: "读取指定路径的文本文件。文件超过 12000 字符时会自动截断（保留头部 80% + 尾部 20%）",
  parameters: z.object({
    path: z.string().describe("文件的绝对路径"),
  }),
  invoke: async ({ path }) => {
    const content = await readFile(path, "utf8");
    if (!content) return "(empty)";

    if (content.length > MAX_FILE_CHARS) {
      const headChars = Math.floor(MAX_FILE_CHARS * 0.8);
      const tailChars = Math.floor(MAX_FILE_CHARS * 0.2);
      const head = content.slice(0, headChars);
      const tail = content.slice(-tailChars);
      const omitted = content.length - headChars - tailChars;
      return `${head}\n\n[... ${omitted} 字符省略 ...]\n\n${tail}`;
    }
    return content;
  },
});

const tools: FunctionTool[] = [readFileTool];

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
          const input = tool.parameters.parse(JSON.parse(call.function.arguments));
          const result = await tool.invoke(input, ctx);
          const display = typeof result === "string" ? result.split("\n")[0].slice(0, 80) : "...";
          console.log("[tool_result]", `${call.function.name}: ${display}${typeof result === "string" && result.length > 80 ? " ..." : ""}`);
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

async function setupWorkspace(): Promise<string> {
  const dir = join(tmpdir(), `playground-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "README.md"),
    "# code-artisan demo\n\n这是一个用 Node fs/promises 直接读写的 demo workspace。\n生产环境会跑在 E2B 沙箱里，工具实现保持不变。",
    "utf8"
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "demo", version: "0.0.1", description: "playground demo" }, null, 2),
    "utf8"
  );
  return dir;
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] read_file 工具直接用 node:fs/promises 实现，没有任何抽象层。");
  console.log("[dim] 工具内部带 12000 字符截断，避免长文件把 LLM 上下文撑爆。");
  console.log("[dim] ─────────────────────────");

  const workspace = await setupWorkspace();
  console.log("[dim]", `workspace = ${workspace}`);

  try {
    const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
    await agent.run(`读一下 ${workspace}/README.md，告诉我这个项目是干嘛的`, { signal });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
