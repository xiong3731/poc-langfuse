# poc-langfuse

Langfuse 最小化 POC：一个 TypeScript Agent 通过 **MCP** 协议驱动
[`kubernetes-mcp-server`](https://github.com/containers/kubernetes-mcp-server) 操作 K8s 集群，
并把**整个过程**（LLM 调用、工具调用、最终结果）完整记录到自托管的 **Langfuse** 中。

```
agent.ts (tsx)
  ├─ Langfuse client ── HTTP ──▶ langfuse-web:13000 (docker compose)
  ├─ OpenAI SDK     ── HTTP ──▶ api.modelverse.cn (glm-5.1)
  └─ MCP Client (stdio) ── docker run -i ──▶ kubernetes-mcp-server
                                               └─ /kubeconfig (ro) ──▶ k8s 集群
```

## 前置条件

- Docker + Docker Compose
- Node ≥ 20 与 **pnpm**
- 一个可用的 `~/.kube/config`（或通过 `KUBECONFIG` 指定）
- 一个 OpenAI 兼容的 LLM API key

## 快速开始

### 1. 启动 Langfuse 栈

```bash
docker compose up -d
docker compose ps          # 等所有服务 healthy（首次启动需拉镜像 + 跑迁移，约 1-2 分钟）
```

启动完成后：

- UI: <http://localhost:13000>，登录账号 `admin@example.com` / `password123`
- 健康检查：`curl http://localhost:13000/api/public/health`

org / project / 用户 / API key 都由 compose 里的 `LANGFUSE_INIT_*` 自动初始化，预置的 API key 与 `.env.example` 中的一致，**无需手动进 UI 创建**。

### 2. 配置并运行 Agent

```bash
pnpm install
cp .env.example .env        # 然后填入你的 OPENAI_API_KEY
pnpm start
```

控制台会打印：MCP 工具列表 → agent 逐轮调用 k8s 工具 → 每轮 token 使用（含 cache）→ 最终中文总结。

自定义任务：

```bash
TASK="查看 kube-system 下所有 pod 的状态" pnpm start
```

### 3. 查看 Trace

打开 <http://localhost:13000>，进入项目 **K8s MCP Agent**，可看到名为 `k8s-agent-run` 的 trace，内含：

- 每轮 LLM 调用（`generation`，含 input messages / output / token usage / cache token）
- 每次工具调用（`span`，含工具名 / 入参 / MCP 返回）
- trace 级别的输入（任务）与输出（最终回答）

## 配置项（`.env`）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | Langfuse 地址 | `http://localhost:13000` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | API key（与 compose INIT 一致） | `pk-lf-0000...` / `sk-lf-0000...` |
| `OPENAI_BASE_URL` | LLM 接口地址 | `https://api.modelverse.cn/v1` |
| `OPENAI_API_KEY` | LLM key | （必填） |
| `LLM_MODEL` | 模型名 | `glm-5.1` |
| `MCP_IMAGE` | MCP server 镜像 | `ghcr.io/containers/kubernetes-mcp-server:v0.0.63` |
| `KUBECONFIG` | kubeconfig 路径，留空用 `~/.kube/config` | （空） |
| `TASK` | agent 任务 | 列出所有 namespace ... |
| `MAX_TURNS` | 最大循环轮数 | `10` |

## 端口映射

所有端口统一使用 1xxxx 范围，避免与宿主机常用端口冲突：

| 服务 | 主机端口 | 说明 |
| --- | --- | --- |
| Langfuse Web | `13000` | UI + API 入口 |
| Langfuse Worker | `13030` | 内部 worker（仅 localhost） |
| PostgreSQL | `15433` | 元数据（仅 localhost） |
| Redis | `16379` | 队列和缓存（仅 localhost） |
| ClickHouse HTTP | `18123` | 分析数据库（仅 localhost） |
| ClickHouse Native | `19000` | 分析数据库（仅 localhost） |
| MinIO API | `19090` | 对象存储 |
| MinIO Console | `19091` | MinIO UI（仅 localhost） |

## 架构说明

Langfuse 自托管栈由 4 个存储组件组成，各司其职：

```
客户端 SDK 上报 trace
       ↓
  Langfuse Web
  ├─ 立即写入 MinIO（原始事件持久化）
  └─ 写入 Redis 队列引用
       ↓
  Langfuse Worker（异步）
  ├─ 从 Redis 读取队列
  ├─ 从 MinIO 读取原始事件
  └─ 处理后写入 ClickHouse
       ↓
  UI 查询
  ├─ PostgreSQL → 用户/项目/配置
  ├─ Redis      → 缓存的 API key 和 prompt
  ├─ ClickHouse → trace 数据和统计
  └─ MinIO      → 多模态内容
```

### PostgreSQL — 事务性元数据

存储需要强一致性的元数据：用户账号、组织/项目、API key、提示词模板（prompts）、数据集、评分规则等配置信息。

### ClickHouse — 分析型观测数据

存储所有观测数据：Trace、Generation（LLM 调用）、Span（工具调用）、Scores。列式存储，适合大规模时间序列查询和聚合统计（token 用量、延迟分布、成本分析等）。

### Redis — 队列与缓存

- **队列**：存储指向 MinIO 中待处理事件的引用，Worker 据此消费
- **缓存**：API key、prompt 热缓存，避免每次请求查数据库
- **速率限制计数器**

### MinIO — 对象存储

- **events/**：所有原始事件的第一落地点，提供数据可恢复性（即使 ClickHouse 宕机数据也不丢）
- **media/**：多模态内容（图片、音频、视频）和大型导出文件

## ⚠️ 本地集群的 kubeconfig

MCP server 跑在 Docker 容器里，使用 `--network host` 模式以访问宿主机网络。
如果你的 kubeconfig 指向 `127.0.0.1` / `localhost`（如 kind / minikube），这个模式下可以直接访问，无需修改。

远程集群（云上 EKS/GKE/ACK 等）同样没有问题。

## 关闭

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 连同数据一起删除
```
