export type SSEEvent =
  | { type: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export type RunHandle = {
  abort: () => void;
  done: Promise<void>;
};

export function runPart(
  partId: string,
  onEvent: (event: SSEEvent) => void
): RunHandle {
  const ac = new AbortController();
  const done = (async () => {
    let resp: Response;
    try {
      const endpoint = partId.startsWith("03-") ? "/api/run-node" : "/api/run";
      resp = await fetch(`${endpoint}?partId=${encodeURIComponent(partId)}`, {
        method: "POST",
        signal: ac.signal,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: any) {
      if (ac.signal.aborted) return;
      onEvent({ type: "error", message: `网络错误：${err?.message ?? err}` });
      return;
    }

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      let message = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        if (j.error) message = j.error;
      } catch {
        if (text) message += `: ${text.slice(0, 200)}`;
      }
      onEvent({ type: "error", message });
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err: any) {
        if (ac.signal.aborted) return;
        onEvent({ type: "error", message: `读取流失败：${err?.message ?? err}` });
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const raw of events) {
        const ev = parseSSE(raw);
        if (!ev) continue;
        if (ev.event === "output") {
          try {
            const data = JSON.parse(ev.data);
            onEvent({ type: "output", stream: data.stream, chunk: data.chunk });
          } catch {
            // ignore parse fail
          }
        } else if (ev.event === "exit") {
          try {
            const data = JSON.parse(ev.data);
            onEvent({ type: "exit", code: data.code });
          } catch {
            onEvent({ type: "exit", code: 0 });
          }
        } else if (ev.event === "error") {
          try {
            const data = JSON.parse(ev.data);
            onEvent({ type: "error", message: data.message });
          } catch {
            onEvent({ type: "error", message: ev.data });
          }
        }
      }
    }
  })();

  return { abort: () => ac.abort(), done };
}

function parseSSE(raw: string): { event: string; data: string } | null {
  const lines = raw.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length && event === "message") return null;
  return { event, data: dataLines.join("\n") };
}
