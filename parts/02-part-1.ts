import OpenAI from "openai";

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "查询某个城市的天气",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

const toolImpls: Record<string, (input: any) => Promise<string>> = {
  get_weather: async ({ city }) => {
    await new Promise((r) => setTimeout(r, 300));
    return `${city} 今天 25°C 晴`;
  },
};

export class Agent {
  private client: OpenAI;
  private messages: any[] = [];

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com/v1",
    });
  }

  async run(input: string) {
    console.log("[user]", input);
    this.messages.push({ role: "user", content: input });

    while (true) {
      console.log("[step] 调用 deepseek-chat ...");
      const resp = await this.client.chat.completions.create({
        model: "deepseek-chat",
        messages: this.messages,
        tools,
      });
      const assistant = resp.choices[0].message;
      this.messages.push(assistant);

      if (!assistant.tool_calls?.length) {
        console.log("[assistant]", assistant.content ?? "");
        return;
      }

      const summary = assistant.tool_calls
        .map((c: any) => `${c.function.name}(${c.function.arguments})`)
        .join(", ");
      console.log("[tool_calls]", summary);

      const toolMsgs = await Promise.all(
        assistant.tool_calls.map(async (call: any) => {
          const args = JSON.parse(call.function.arguments);
          const result = await toolImpls[call.function.name](args);
          console.log("[tool_result]", `${call.function.name}: ${result}`);
          return { role: "tool" as const, tool_call_id: call.id, content: result };
        })
      );
      this.messages.push(...toolMsgs);
    }
  }
}

export async function demo() {
  const agent = new Agent(process.env.DEEPSEEK_API_KEY ?? "");
  await agent.run("北京和上海今天天气怎么样？");
}
