# Agent Sidecar — 基于 Claude Agent SDK 的智能代理系统

> 类型：总规划 | 创建：2026-05-27 | 状态：进行中

## 概述

为 LLM Wiki 引入 Agent 能力，通过 Node.js sidecar 进程集成 Claude Agent SDK，实现工具调用、多轮对话、自定义 MCP 工具、Hooks 等高级能力。最终目标是让 Wiki 不仅是知识库，还是一个能主动研究和更新知识的智能代理。

## 为什么不直接用已有的 `claude` CLI 集成

项目已有 Claude CLI 和 Codex CLI 集成（纯文本对话），但 Agent SDK 的 `query()` 提供了关键额外能力：

- `createSdkMcpServer()` — in-process 自定义工具，不需要额外进程
- Hooks（PreToolUse/PostToolUse/Stop）— 控制工具执行行为
- Subagents — 并行 Agent 协同
- `startup()` 预热 — 消除冷启动
- `maxTurns` / `maxBudgetUsd` — 精细成本控制
- Session 管理 — resume/fork

直接用 `claude` CLI 只能做纯文本对话，无法定义自定义工具和 hooks。

## 通信架构

```
[React Frontend]
    ↕ invoke("agent_spawn", {streamId, prompt, options})
    ↕ invoke("agent_kill", {streamId})
    ↕ listen("agent:{streamId}") → SDKMessage JSON
    ↕ listen("agent:{streamId}:done") → {code, cost}
[Rust Backend — commands/agent.rs]
    ↕ stdin/stdout pipes (JSON-lines)
[Node.js Sidecar — sidecar/src/main.ts]
    ↕ query() → AsyncGenerator<SDKMessage>
[Claude Code Binary (bundled with SDK)]
    ↕ HTTPS
[Anthropic API / OpenRouter / LiteLLM / 任意 Messages API 兼容后端]
```

**关键决策：复用现有 CLI transport 模式（stdin/stdout JSON-lines + Tauri emit/listen），不加 WebSocket 或 HTTP 依赖。**

## 关键决策

### Agent 写入策略

Agent 写 Wiki 不走强制“沙盒草稿 + 人审合并”流程。LLM Wiki 已有 Lint / Fixer / Review 作为内容质量防线，Agent 写入的质量问题应交给这些既有链路处理。

Agent 写入只做系统级安全边界：
- 只允许写 `wiki/**/*.md`
- 不允许写 `.llm-wiki/`、`raw/sources/`、隐藏文件、项目外路径
- 不允许删除目录或大面积破坏
- 限制单次写入大小和文件数量
- 写入后触发 refresh/dirty/Lint 后续链路

Claude Agent SDK sandbox 可作为以后增强 Claude Code 内置工具隔离的辅助手段，但不是 Agent 写 Wiki 的主设计。

## Phase 路线图

### Phase 1: 骨架 + 端到端通信 — 已完成
- Sidecar 进程管理（spawn/kill）
- Rust bridge（agent_spawn / agent_kill / agent_detect）
- 前端 transport（streamAgent）
- 基础流式文本输出
- 详见 [Phase 1 计划](./agent-sidecar-phase1.md)

### Phase 2: 自定义 MCP 工具 — 已完成
- `createSdkMcpServer()` 注册 Wiki 专属工具
- `read_page` — 读取 Wiki 页面内容
- `search_pages` — 语义搜索 Wiki 页面
- `update_page` — Agent 主动更新 Wiki 内容
- `create_entity` / `create_concept` — 创建新的知识条目
- 写工具默认允许真实写入 `wiki/**/*.md`，内容质量交给 Lint/Fixer，安全只限制路径和操作边界
- 详见 [Phase 2 计划](./agent-sidecar-phase2.md)

### Phase 3: Hooks & 权限控制 — 已完成
- PreToolUse hook — 工具执行前补强路径/操作策略，不做默认人审
- PostToolUse hook — 工具执行后记录变更，触发 Lint/Fixer 提示
- Stop hook — Agent 完成后自动总结
- 用户可配置的工具白名单/黑名单
- 详见 [Phase 3 计划](./agent-sidecar-phase3.md)

### Phase 3.5: Agent Tool Parity — 已完成
- 补齐普通 LLM 已有的 LLM Wiki 业务能力
- Agent 可调用 Chat RAG context、Save to Wiki、ingest、多模态 caption、lint/fixer、wikilink enrichment、deep research、dedup/review/provider test
- 建立 sidecar ↔ WebView app tool bridge，复用现有业务模块，不在 sidecar 重写算法
- 完成 tool schema cleanup，补强 MCP schema / runtime validation / tests
- 详见 [Phase 3.5 计划](./agent-sidecar-phase3.5.md)

### Phase 3.6: Agent SDK Parity — 已完成
- 补齐 Claude Agent SDK 原生能力底座
- Session resume / continue / fork
- SDK 原生 `canUseTool` 审批协议和完整 permission modes
- File checkpoint / rewind、sandbox 配置通道
- Structured output、thinking/effort/taskBudget、partial/hook/prompt suggestion/subagent 事件
- Subagents、skills、plugins 透传
- 详见 [Phase 3.6 计划](./agent-sidecar-phase3.6.md)

### Phase 3.7: 代码结构重构
- Commands 模块拆分为 file_ops/、search/、agent_cli/ 三个子模块
- ingest.ts 拆分为 ingest-prompts.ts、ingest-chunk.ts、ingest-write.ts + 入口编排
- 纯结构搬迁，不改业务逻辑，保持公共 API 表面不变
- 详见 [Phase 3.7 计划](./agent-sidecar-phase3.7.md)

### Phase 4: Agent UI 集成
- 替换临时 Test Agent 按钮为正式 UI
- Agent 对话模式切换（普通 LLM / Agent）
- 工具调用过程可视化（展示 Agent 正在做什么）
- 多轮对话历史（含工具调用记录）
- Session resume/fork、权限审批、checkpoint rewind 的用户交互
- 成本/用量统计面板

### Phase 5: 打包 & 优化
- Sidecar 编译为单文件 binary（`bun build --compile`）
- `startup()` 预热消除冷启动
- 并发 Agent 支持（多 streamId）
- 长期 session 存储整理、清理、迁移
- 资源使用限制（CPU/内存/时间）

## 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| Sidecar 语言 | Node.js + TypeScript | Claude Agent SDK 官方支持 |
| 进程通信 | stdin/stdout JSON-lines | 复用现有模式，无额外依赖 |
| 前端通信 | Tauri emit/listen | 已有成熟实现 |
| Sidecar 打包 | bun build --compile | 单文件分发，无运行时依赖 |
| API 兼容 | baseUrl + apiKey 透传 | 支持 Anthropic / OpenRouter / LiteLLM / Bedrock 等 |

## 风险

| 风险 | 缓解 |
|------|------|
| SDK 首次 spawn 慢（2-5s） | Phase 5 用 startup() 预热 |
| 双层子进程开销 | Node 只是薄 wrapper，实际工作在 Claude binary |
| 非 Anthropic 模型兼容性 | baseUrl 透传，兼容任意 Messages API 后端 |
| Sidecar 崩溃无响应 | Rust 端超时检测 + done 事件 |
