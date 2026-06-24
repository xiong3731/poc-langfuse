# poc-langfuse

Langfuse 最小化 POC：一个 TypeScript Agent 通过 **MCP** 协议驱动
[`kubernetes-mcp-server`](https://github.com/containers/kubernetes-mcp-server) 操作 K8s 集群，
并把**整个过程**（LLM 调用、工具调用、最终结果）完整记录到自托管的 **Langfuse** 中。

```
agent.ts (tsx)
  ├─ Langfuse client ── HTTP ──▶ langfuse-web:3000 (docker compose)
  ├─ OpenAI SDK     ── HTTP ──▶ api.modelverse.cn (glm-5.1)
  └─ MCP Client (stdio) ── docker run -i ──▶ kubernetes-mcp-server
                                                 └─ /kubeconfig (ro) ──▶ k8s 集群
```

## 前置条件

- Docker + Docker Compose
- Node ≥ 20 与 **pnpm**
- 一个可用的 `~/.kube/config`（或通过 `KUBECONFIG` 指定）
- 一个 OpenAI 兼容的 LLM API key

## 1. 启动 Langfuse 栈

```bash
docker compose up -d
docker compose ps          # 等所有服务 healthy（首次启动需拉镜像 + 跑迁移，约 1-2 分钟）
```

启动完成后：

- UI: <http://localhost:3000> ，登录账号 `admin@example.com` / `password123`
- 健康检查：`curl http://localhost:3000/api/public/health`

org / project / 用户 / API key 都由 compose 里的 `LANGFUSE_INIT_*` 自动初始化，
预置的 API key 与 `.env.example` 中的一致，**无需手动进 UI 创建**。

## 2. 配置并运行 Agent

```bash
pnpm install
cp .env.example .env        # 然后填入你的 OPENAI_API_KEY
pnpm start
```

控制台会打印：MCP 工具列表 → agent 逐轮调用 k8s 工具 → 最终中文总结。

自定义任务：

```bash
TASK="查看 kube-system 下所有 pod 的状态" pnpm start
```

## 3. 查看 Trace

打开 <http://localhost:3000>，进入项目 **K8s MCP Agent**，可看到名为 `k8s-agent-run`
的 trace，内含：

- 每轮 LLM 调用（`generation`，含 input messages / output / token usage）
- 每次工具调用（`span`，含工具名 / 入参 / MCP 返回）
- trace 级别的输入（任务）与输出（最终回答）

## 配置项（`.env`）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | Langfuse 地址 | `http://localhost:3000` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | API key（与 compose INIT 一致） | `pk-lf-0000...` / `sk-lf-0000...` |
| `OPENAI_BASE_URL` | LLM 接口地址 | `https://api.modelverse.cn/v1` |
| `OPENAI_API_KEY` | LLM key | （必填） |
| `LLM_MODEL` | 模型名 | `glm-5.1` |
| `MCP_IMAGE` | MCP server 镜像 | `ghcr.io/containers/kubernetes-mcp-server:v0.0.63` |
| `KUBECONFIG` | kubeconfig 路径，留空用 `~/.kube/config` | （空） |
| `TASK` | agent 任务 | 列出所有 namespace ... |
| `MAX_TURNS` | 最大循环轮数 | `10` |

## ⚠️ 注意：本地集群的 kubeconfig

MCP server 跑在 Docker 容器里。如果你的 kubeconfig 指向 `127.0.0.1` / `localhost`
（如 kind / minikube / Docker Desktop K8s），容器内部无法访问宿主机的 localhost，需要：

- 把 server 地址改成 `https://host.docker.internal:<port>`，或
- 让 MCP 容器使用宿主网络（Linux 上 `docker run --network host`，见 `src/mcp.ts`）。

远程集群（云上 EKS/GKE/ACK 等）没有此问题。

## 关闭

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 连同数据一起删除
```
