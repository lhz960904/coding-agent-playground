import OpenAI from "openai";
import { z } from "zod";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

interface ToolContext {
  signal?: AbortSignal;
  cwd?: string;
  sessions: SessionManager;
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

interface Session {
  process: ChildProcess;
  command: string;
  output: string;
  done: boolean;
  exitCode: number | null;
}

class SessionManager {
  private sessions = new Map<string, Session>();

  start(command: string, cwd?: string): { id: string; pid: number | undefined } {
    const id = `bg_${Math.random().toString(36).slice(2, 10)}`;
    const proc = spawn("bash", ["-c", command], { cwd });
    const session: Session = { process: proc, command, output: "", done: false, exitCode: null };
    this.sessions.set(id, session);

    proc.stdout?.on("data", (chunk: Buffer) => { session.output += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { session.output += chunk.toString(); });
    proc.on("exit", (code) => {
      session.done = true;
      session.exitCode = code;
    });

    return { id, pid: proc.pid };
  }

  read(id: string, since = 0): { output: string; done: boolean; exitCode: number | null; nextOffset: number } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      output: s.output.slice(since),
      done: s.done,
      exitCode: s.exitCode,
      nextOffset: s.output.length,
    };
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.process.kill("SIGKILL");
    return true;
  }

  killAll() {
    for (const s of this.sessions.values()) {
      try { s.process.kill("SIGKILL"); } catch {}
    }
    this.sessions.clear();
  }
}

const bashTool = defineTool({
  name: "bash",
  description:
    "执行 bash 命令。默认前台同步返回 stdout/stderr。" +
    "对长任务（dev server / watch / tail 日志）传 run_in_background:true，会立即返回 session_id，输出累积到后台缓冲。" +
    "之后用 bash_output 读取，用 kill_shell 关停。",
  parameters: z.object({
    command: z.string().describe("要执行的 bash 命令"),
    run_in_background: z
      .boolean()
      .optional()
      .default(false)
      .describe("true 则后台跑，立即返回 session_id；false（默认）前台同步等待"),
  }),
  invoke: async ({ command, run_in_background }, { signal, cwd, sessions }) => {
    if (run_in_background) {
      const { id, pid } = sessions.start(command, cwd);
      return `started session=${id} pid=${pid}. 用 bash_output 读输出，用 kill_shell 关停。`;
    }
    const { stdout, stderr } = await execAsync(command, { cwd, signal, timeout: 10_000 });
    const out = (stdout || "") + (stderr ? `\n${stderr}` : "");
    return out.trim() || "(no output)";
  },
});

const bashOutputTool = defineTool({
  name: "bash_output",
  description:
    "读后台 session 累积的输出。可选 since_offset 只读最近增量；不传则读全部。返回 done 标志判断进程是否退出。",
  parameters: z.object({
    session_id: z.string(),
    since_offset: z.number().optional().describe("上次调用返回的 nextOffset，传它可以只读增量输出"),
  }),
  invoke: async ({ session_id, since_offset }, { sessions }) => {
    const r = sessions.read(session_id, since_offset ?? 0);
    if (!r) return `session not found: ${session_id}`;
    return JSON.stringify(r);
  },
});

const killShellTool = defineTool({
  name: "kill_shell",
  description: "向后台 session 发 SIGKILL 终止它",
  parameters: z.object({
    session_id: z.string(),
  }),
  invoke: async ({ session_id }, { sessions }) => {
    const ok = sessions.kill(session_id);
    return ok ? `killed ${session_id}` : `session not found: ${session_id}`;
  },
});

const tools: FunctionTool[] = [bashTool, bashOutputTool, killShellTool];

export class Agent {
  private client: OpenAI;
  private messages: any[] = [];

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" });
  }

  async run(input: string, ctx: ToolContext) {
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

export async function demo({ signal }: { signal?: AbortSignal } = {}) {
  console.log("[dim] 长任务 bash —— run_in_background:true 立即返回 session_id，agent 用 bash_output 轮询。");
  console.log("[dim] 模拟启动一个慢热的服务（4 秒后才打印 'Listening on :3000'），看 agent 怎么轮询直到看见 ready。");
  console.log("[dim] ─────────────────────────");

  const sessions = new SessionManager();

  try {
    const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
    await agent.run(
      "请用 bash(run_in_background=true) 启动这条命令：'echo starting && sleep 4 && echo \"Listening on :3000\"'，" +
      "拿到 session_id 后用 bash_output 轮询它（每次间隔大约 1-2 秒），" +
      "等到输出里出现 'Listening' 字样就告诉我服务起来了，然后调 kill_shell 关掉它。",
      { signal, sessions }
    );
  } finally {
    sessions.killAll();
  }
}
