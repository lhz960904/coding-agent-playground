import OpenAI from "openai";
import { z } from "zod";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

interface ToolContext {
  signal?: AbortSignal;
  cwd?: string;
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
  description: "读取指定路径的文本文件",
  parameters: z.object({
    path: z.string().describe("文件的绝对路径"),
  }),
  invoke: async ({ path }) => {
    const content = await readFile(path, "utf8");
    if (!content) return "(empty)";
    if (content.length > MAX_FILE_CHARS) {
      const headChars = Math.floor(MAX_FILE_CHARS * 0.8);
      const tailChars = Math.floor(MAX_FILE_CHARS * 0.2);
      return `${content.slice(0, headChars)}\n\n[... ${content.length - headChars - tailChars} chars omitted ...]\n\n${content.slice(-tailChars)}`;
    }
    return content;
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description: "覆盖写入文件（不存在则创建，存在则整个覆盖）",
  parameters: z.object({
    path: z.string().describe("文件的绝对路径"),
    content: z.string().describe("文件内容"),
  }),
  invoke: async ({ path, content }) => {
    await writeFile(path, content, "utf8");
    return `wrote ${content.length} chars to ${path}`;
  },
});

const strReplaceTool = defineTool({
  name: "str_replace",
  description: "在文件里把 old_str 替换成 new_str。默认只换第一处出现；传 replace_all=true 才会全部替换",
  parameters: z.object({
    path: z.string().describe("文件的绝对路径"),
    old_str: z.string().describe("要替换的旧字符串"),
    new_str: z.string().describe("新字符串"),
    replace_all: z.boolean().optional().describe("是否替换所有匹配"),
  }),
  invoke: async ({ path, old_str, new_str, replace_all }) => {
    let content = await readFile(path, "utf8");
    if (!content.includes(old_str)) throw new Error(`old_str 在 ${path} 里没找到`);
    content = replace_all
      ? content.replaceAll(old_str, new_str)
      : content.replace(old_str, new_str);
    await writeFile(path, content, "utf8");
    return "OK";
  },
});

const bashTool = defineTool({
  name: "bash",
  description: "在工作目录里执行 bash 命令，同步返回 stdout / stderr",
  parameters: z.object({
    command: z.string().describe("要执行的 bash 命令"),
  }),
  invoke: async ({ command }, { signal, cwd }) => {
    const { stdout, stderr } = await execAsync(command, { cwd, signal, timeout: 10_000 });
    const out = (stdout || "") + (stderr ? `\n${stderr}` : "");
    return out.trim() || "(no output)";
  },
});

const tools: FunctionTool[] = [readFileTool, writeFileTool, strReplaceTool, bashTool];

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
          let result: string;
          try {
            const tool = tools.find((t) => t.name === call.function.name);
            if (!tool) throw new Error(`Tool ${call.function.name} not found`);
            const input = tool.parameters.parse(JSON.parse(call.function.arguments));
            const r = await tool.invoke(input, ctx);
            result = typeof r === "string" ? r : JSON.stringify(r);
          } catch (err) {
            // 单工具错误隔离：把异常包成 "Error: xxx" 的 tool_result，run 继续
            // 让 LLM 看到错误自己决定下一步（重试 / 换工具 / 放弃）
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
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

async function setupWorkspace(): Promise<string> {
  const dir = join(tmpdir(), `playground-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "README.md"),
    "# Demo Project\n\n## TODO\n\n这里有一行 TODO 等着被替换掉。\n",
    "utf8"
  );
  return dir;
}

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] 4 个 builtin 工具：read_file / write_file / str_replace / bash —— 都用 node:fs / child_process 直接实现");
  console.log("[dim] 单工具失败兜底：tool.invoke 抛错就被 _act 包成 'Error: xxx' tool_result 返回给 LLM，run 不会炸");
  console.log("[dim] ─────────────────────────");

  const workspace = await setupWorkspace();
  console.log("[dim]", `workspace = ${workspace}`);

  try {
    const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
    await agent.run(
      `工作目录是 ${workspace}。请把里面 README.md 中的 "TODO" 这一行整体替换成 "DONE: 已完成"，然后用 bash 的 cat 命令把最终内容打印出来给我看`,
      { signal, cwd: workspace }
    );
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
