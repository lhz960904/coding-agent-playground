export const config = { runtime: "edge" };

export default async function handler() {
  const t0 = Date.now();
  try {
    const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 10,
      }),
    });
    const text = await resp.text();
    return Response.json({
      ok: resp.ok,
      status: resp.status,
      ms: Date.now() - t0,
      body: text.slice(0, 400),
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      ms: Date.now() - t0,
      error: err?.message ?? String(err),
      stack: err?.stack?.split("\n").slice(0, 3),
    });
  }
}
