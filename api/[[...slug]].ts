import { Hono } from "hono";
import { handle } from "hono/vercel";
import { streamSSE } from "hono/streaming";
import { run as runPart1 } from "../parts/02-part-1.js";
import { run as runPart2 } from "../parts/02-part-2.js";
import { run as runPart3 } from "../parts/02-part-3.js";
import { run as runPart4 } from "../parts/02-part-4.js";
import { run as runPart5 } from "../parts/02-part-5.js";
import { checkRateLimit } from "./_lib/rate-limit.js";

export const runtime = "edge";

type Runner = (ctx: { log: (line: string) => void; signal?: AbortSignal }) => Promise<void>;

const PART_RUNNERS: Record<string, Runner> = {
  "02-part-1": runPart1,
  "02-part-2": runPart2,
  "02-part-3": runPart3,
  "02-part-4": runPart4,
  "02-part-5": runPart5,
};

const app = new Hono().basePath("/api");

app.get("/health", (c) =>
  c.json({
    ok: true,
    parts: Object.keys(PART_RUNNERS),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  })
);

app.post("/run/:partId", async (c) => {
  const partId = c.req.param("partId");
  const runner = PART_RUNNERS[partId];
  if (!runner) return c.json({ error: `unknown partId: ${partId}` }, 404);

  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";

  const limit = parseInt(process.env.RUN_RATE_LIMIT_PER_DAY ?? "100", 10);
  const rl = checkRateLimit(ip, limit);
  if (!rl.ok) {
    return c.json(
      { error: `今日运行次数已用完（限额 ${limit}/IP/天）。明天再来 🌙` },
      429
    );
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return c.json(
      { error: "服务端未配置 DEEPSEEK_API_KEY，运行不了。请在 Vercel 项目 Settings > Environment Variables 加上。" },
      500
    );
  }

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      ac.abort("client disconnected");
    });

    const watchdog = setTimeout(() => ac.abort("max duration 55s reached"), 55_000);

    const log = async (line: string) => {
      if (aborted) return;
      await stream.writeSSE({
        event: "output",
        data: JSON.stringify({ stream: "stdout", chunk: line + "\n" }),
      });
    };

    try {
      await log(`\x1b[2m──── partId=${partId} · IP=${ip} · 今日剩余 ${rl.remaining} 次 ────\x1b[0m`);
      await runner({ log, signal: ac.signal });
      await stream.writeSSE({ event: "exit", data: JSON.stringify({ code: 0 }) });
    } catch (err: any) {
      if (!aborted) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: err?.message ?? String(err) }),
        });
      }
    } finally {
      clearTimeout(watchdog);
    }
  });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export default handle(app);
export const GET = handle(app);
export const POST = handle(app);
