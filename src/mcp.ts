import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** MCP 工具的精简描述，用于喂给 LLM。 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 封装 kubernetes-mcp-server：通过 `docker run -i` 以 stdio 方式拉起容器，
 * kubeconfig 只读挂载进容器。
 */
export class McpClient {
  private client: Client;
  private transport: StdioClientTransport;

  constructor() {
    const kubeconfig = process.env.KUBECONFIG?.trim() || join(homedir(), ".kube", "config");
    const image =
      process.env.MCP_IMAGE?.trim() || "ghcr.io/containers/kubernetes-mcp-server:v0.0.63";

    const args = [
      "run",
      "-i",
      "--rm",
      "-v",
      `${kubeconfig}:/kubeconfig:ro`,
      "-e",
      "KUBECONFIG=/kubeconfig",
      image,
    ];

    console.log(`[mcp] docker ${args.join(" ")}`);

    this.transport = new StdioClientTransport({
      command: "docker",
      args,
      // 让容器的 stderr 透传到当前进程，便于排查镜像/挂载问题。
      stderr: "inherit",
    });
    this.client = new Client({ name: "k8s-mcp-agent", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /** 列出全部工具（处理分页）。 */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.client.listTools(cursor ? { cursor } : {});
      for (const t of res.tools) {
        tools.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
        });
      }
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  }

  /** 调用工具，返回拼接后的文本内容。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
    const text = content
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join("\n");
    if (res.isError) {
      return `工具执行出错: ${text}`;
    }
    return text || "(无输出)";
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
