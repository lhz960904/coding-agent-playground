export default function handler() {
  return Response.json({
    ok: true,
    parts: [
      "02-part-1", "02-part-2", "02-part-3", "02-part-4", "02-part-5",
      "03-part-1", "03-part-2", "03-part-3", "03-part-4",
      "04-part-1", "04-part-2", "04-part-3", "04-part-4",
    ],
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ? "custom" : "default",
  });
}
