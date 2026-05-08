import { run as runPart1 } from "../parts/02-part-1.js";
import { run as runPart2 } from "../parts/02-part-2.js";
import { run as runPart3 } from "../parts/02-part-3.js";
import { run as runPart4 } from "../parts/02-part-4.js";
import { run as runPart5 } from "../parts/02-part-5.js";
import { checkRateLimit } from "./_lib/rate-limit.js";

export const config = { runtime: "edge" };

type Runner = (ctx: { log: (line: string) => void; signal?: AbortSignal }) => Promise<void>;

const PART_RUNNERS: Record<string, Runner> = {
  "02-part-1": runPart1,
  "02-part-2": runPart2,
  "02-part-3": runPart3,
  "02-part-4": runPart4,
  "02-part-5": runPart5,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const partId = url.searchParams.get("partId") ?? "";
  const runner = PART_RUNNERS[partId];
  if (!runner) return jsonResponse({ error: `unknown partId: ${partId}` }, 404);

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  const limit = parseInt(process.env.RUN_RATE_LIMIT_PER_DAY ?? "100", 10);
  const rl = checkRateLimit(ip, limit);
  if (!rl.ok) {
    return jsonResponse(
      { error: `今日运行次数已用完（限额 ${limit}/IP/天）。明天再来 🌙` },
      429
    );
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return jsonResponse(
      { error: "服务端未配置 DEEPSEEK_API_KEY，请联系站点管理员。" },
      500
    );
  }

  const encoder = new TextEncoder();
  const ac = new AbortController();
  let aborted = false;

  req.signal.addEventListener("abort", () => {
    aborted = true;
    ac.abort("client disconnected");
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const watchdog = setTimeout(() => ac.abort("max duration 23s reached"), 23_000);

      const send = (event: string, data: unknown) => {
        if (aborted) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      const log = (line: string) => {
        send("output", { stream: "stdout", chunk: line + "\n" });
      };

      try {
        log(`\x1b[2m──── partId=${partId} · IP=${ip} · 今日剩余 ${rl.remaining} 次 ────\x1b[0m`);
        await runner({ log, signal: ac.signal });
        send("exit", { code: 0 });
      } catch (err: any) {
        if (!aborted) {
          send("error", { message: err?.message ?? String(err) });
        }
      } finally {
        clearTimeout(watchdog);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
