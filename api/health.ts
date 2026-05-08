export const config = { runtime: "edge" };

export default function handler() {
  return Response.json({
    ok: true,
    parts: ["02-part-1", "02-part-2", "02-part-3", "02-part-4", "02-part-5"],
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
