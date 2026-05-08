import Anthropic from "@anthropic-ai/sdk";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

interface Tool {
  name: string;
  description: string;
  parameters: any;
}

interface InvokeParams {
  messages: Message[];
  tools: Tool[];
  signal?: AbortSignal;
}

export class AnthropicProvider {
  private client: Anthropic;
  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async invoke({ messages, tools, signal }: InvokeParams): Promise<Message> {
    const sysMessage = messages.find((m) => m.role === "system");
    const sysText =
      sysMessage?.content
        .filter((c) => c.type === "text")
        .map((c: any) => c.text)
        .join("") ?? "";

    const apiMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => this.toAnthropicMessage(m));

    const resp = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        system: sysText || undefined,
        messages: apiMessages as any,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      },
      { signal }
    );

    const blocks: ContentBlock[] = [];
    for (const b of resp.content) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text });
      else if (b.type === "tool_use")
        blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    return { role: "assistant", content: blocks };
  }

  private toAnthropicMessage(m: Message) {
    if (m.role === "tool") {
      return {
        role: "user" as const,
        content: m.content
          .filter((c) => c.type === "tool_result")
          .map((c: any) => ({
            type: "tool_result" as const,
            tool_use_id: c.tool_use_id,
            content: c.content,
          })),
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant" as const,
        content: m.content.map((c) => {
          if (c.type === "text") return { type: "text" as const, text: c.text };
          if (c.type === "tool_use")
            return { type: "tool_use" as const, id: c.id, name: c.name, input: c.input };
          throw new Error("unsupported assistant block: " + (c as any).type);
        }),
      };
    }
    return {
      role: "user" as const,
      content: m.content
        .filter((c) => c.type === "text")
        .map((c: any) => ({ type: "text" as const, text: c.text })),
    };
  }
}
