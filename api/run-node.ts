import type { IncomingMessage, ServerResponse } from "node:http";
import { withConsoleEmitter } from "./_lib/console-als.js";
import { demo as demo03Part1 } from "../parts/03-part-1.js";
import { demo as demo03Part2 } from "../parts/03-part-2.js";
import { demo as demo03Part3 } from "../parts/03-part-3.js";
import { demo as demo03Part4 } from "../parts/03-part-4.js";
import { checkRateLimit } from "./_lib/rate-limit.js";

export const config = { runtime: "nodejs" };

type Runner = (options?: { signal?: AbortSignal }) => Promise<void>;

const PART_RUNNERS: Record<string, Runner> = {
  "03-part-1": demo03Part1,
  "03-part-2": demo03Part2,
  "03-part-3": demo03Part3,
  "03-part-4": demo03Part4,
};

function jsonReply(res: ServerResponse, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function pickHeader(value: string | string[] | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value[0] ?? "";
  return value;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "", "http://localhost");
  const partId = url.searchParams.get("partId") ?? "";
  const runner = PART_RUNNERS[partId];
  if (!runner) return jsonReply(res, { error: `unknown partId: ${partId}` }, 404);

  const ip =
    pickHeader(req.headers["x-forwarded-for"]).split(",")[0]?.trim() ||
    pickHeader(req.headers["x-real-ip"]) ||
    "unknown";

  const limit = parseInt(process.env.RUN_RATE_LIMIT_PER_DAY ?? "100", 10);
  const rl = checkRateLimit(ip, limit);
  if (!rl.ok) {
    return jsonReply(
      res,
      { error: `今日运行次数已用完（限额 ${limit}/IP/天）。明天再来 🌙` },
      429
    );
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return jsonReply(
      res,
      { error: "服务端未配置 DEEPSEEK_API_KEY，请联系站点管理员。" },
      500
    );
  }

  const ac = new AbortController();
  let aborted = false;

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");

  req.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      ac.abort("client disconnected");
    }
  });

  const watchdog = setTimeout(() => ac.abort("max duration 55s reached"), 55_000);

  const sendEvent = (event: string, data: unknown) => {
    if (aborted || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const emit = (chunk: string) => {
    if (aborted || res.writableEnded) return;
    sendEvent("output", { stream: "stdout", chunk });
  };

  try {
    emit(`\x1b[2m──── partId=${partId} · IP=${ip} · 今日剩余 ${rl.remaining} 次 · runtime=nodejs ────\x1b[0m\n`);
    await withConsoleEmitter(emit, () => runner({ signal: ac.signal }));
    sendEvent("exit", { code: 0 });
  } catch (err: any) {
    if (!aborted) {
      sendEvent("error", { message: err?.message ?? String(err) });
    }
  } finally {
    clearTimeout(watchdog);
    if (!res.writableEnded) res.end();
  }
}
