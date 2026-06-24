import "dotenv/config";
import { Langfuse } from "langfuse";
import { McpClient } from "./mcp.js";
import { LlmClient, type ChatMessage } from "./llm.js";

const SYSTEM_PROMPT = `你是一个 Kubernetes 运维助手。你可以调用提供的工具来查询和操作 Kubernetes 集群。
请根据用户的任务，自主决定调用哪些工具，并在获取到足够信息后给出清晰的中文总结。
不要编造集群信息——所有结论都必须来自工具返回的真实数据。`;

async function main() {
  const task =
    process.env.TASK?.trim() ||
    "列出集群里所有的 namespace，并简要说明每个 namespace 大致是做什么用的";
  const maxTurns = Number(process.env.MAX_TURNS) || 10;

  // --- 初始化三方客户端 ---
  const langfuse = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL || "http://localhost:3000",
  });
  const llm = new LlmClient();
  const mcp = new McpClient();

  // --- 整个 agent 运行 = 一个 trace ---
  const trace = langfuse.trace({
    name: "k8s-agent-run",
    input: task,
    metadata: { model: llm.model, maxTurns },
    tags: ["k8s", "mcp", "poc"],
  });

  let finalOutput = "";

  try {
    console.log("[mcp] 连接 kubernetes-mcp-server ...");
    await mcp.connect();
    const mcpTools = await mcp.listTools();
    console.log(`[mcp] 可用工具 (${mcpTools.length}):`, mcpTools.map((t) => t.name).join(", "));
    trace.update({ metadata: { model: llm.model, maxTurns, toolCount: mcpTools.length } });

    const chatTools = LlmClient.toChatTools(mcpTools);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    for (let turn = 1; turn <= maxTurns; turn++) {
      console.log(`\n===== 第 ${turn} 轮 =====`);

      // --- LLM 调用，记录为 generation ---
      const generation = trace.generation({
        name: `llm-turn-${turn}`,
        model: llm.model,
        input: messages,
      });
      const completion = await llm.chat(messages, chatTools);
      const choice = completion.choices[0];
      const assistantMsg = choice.message;
      generation.end({
        output: assistantMsg,
        usageDetails: completion.usage
          ? {
              input: completion.usage.prompt_tokens,
              output: completion.usage.completion_tokens,
              total: completion.usage.total_tokens,
            }
          : undefined,
      });

      messages.push(assistantMsg as ChatMessage);

      const toolCalls = assistantMsg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // 没有工具调用 => 最终回答
        finalOutput = assistantMsg.content ?? "";
        console.log("[llm] 最终回答:\n" + finalOutput);
        break;
      }

      // --- 逐个执行工具调用，每个记录为 span ---
      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const fnName = call.function.name;
        let fnArgs: Record<string, unknown> = {};
        try {
          fnArgs = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          fnArgs = {};
        }

        console.log(`[tool] 调用 ${fnName}(${JSON.stringify(fnArgs)})`);
        const span = trace.span({
          name: `tool:${fnName}`,
          input: fnArgs,
        });

        let result: string;
        try {
          result = await mcp.callTool(fnName, fnArgs);
        } catch (err) {
          result = `工具调用异常: ${(err as Error).message}`;
        }
        span.end({ output: result });

        const preview = result.length > 300 ? result.slice(0, 300) + " ..." : result;
        console.log(`[tool] 结果: ${preview}`);

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      if (turn === maxTurns) {
        finalOutput = "(达到最大轮数上限，未得到最终回答)";
        console.log("[agent] " + finalOutput);
      }
    }

    trace.update({ output: finalOutput });
  } catch (err) {
    const msg = (err as Error).stack || String(err);
    console.error("[agent] 运行失败:\n" + msg);
    trace.update({ output: `运行失败: ${msg}`, metadata: { error: true } });
  } finally {
    await mcp.close().catch(() => {});
    await langfuse.flushAsync();
    await langfuse.shutdownAsync();
    console.log("\n[langfuse] trace 已上报，打开 UI 查看：" + (process.env.LANGFUSE_BASE_URL || "http://localhost:3000"));
  }
}

main();
