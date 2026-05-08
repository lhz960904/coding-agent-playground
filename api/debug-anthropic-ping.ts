export const config = { runtime: "edge" };

export default async function handler() {
  const t0 = Date.now();
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({}),
    });
    const text = await resp.text();
    return Response.json({
      ok: resp.ok,
      status: resp.status,
      ms: Date.now() - t0,
      body: text.slice(0, 200),
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      ms: Date.now() - t0,
      error: err?.message ?? String(err),
    });
  }
}
