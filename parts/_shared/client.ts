import OpenAI from "openai";

export type ResolvedClient = {
  client: OpenAI;
  model: string;
  label: string;
  baseURL: string;
};

export function makeClient(): ResolvedClient {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      label: "Anthropic (OpenAI-compat endpoint)",
      model: "claude-haiku-4-5",
      baseURL: "https://api.anthropic.com/v1/",
      client: new OpenAI({
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseURL: "https://api.anthropic.com/v1/",
      }),
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      label: "DeepSeek",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      }),
    };
  }
  throw new Error("既没有 ANTHROPIC_API_KEY 也没有 DEEPSEEK_API_KEY");
}
