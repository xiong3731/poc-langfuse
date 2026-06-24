import OpenAI from "openai";
import type { McpTool } from "./mcp.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/** OpenAI 兼容客户端封装（默认指向 modelverse 的 glm-5.1）。 */
export class LlmClient {
  private client: OpenAI;
  readonly model: string;

  constructor() {
    this.client = new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL?.trim() || "https://api.modelverse.cn/v1",
      apiKey: process.env.OPENAI_API_KEY?.trim() || "",
    });
    this.model = process.env.LLM_MODEL?.trim() || "glm-5.1";
  }

  /** 把 MCP 工具转换成 OpenAI function tools 格式。 */
  static toChatTools(tools: McpTool[]): ChatTool[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  async chat(
    messages: ChatMessage[],
    tools: ChatTool[],
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? "auto" : undefined,
    });
  }
}
