# Phase 2: Agent Sidecar 自定义 MCP 工具

> 类型：Phase 实施计划 | 创建：2026-05-27 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 1 计划](./agent-sidecar-phase1.md)

> 完成记录：Phase 2 已合并到 `main`。核心能力包括 Wiki MCP 工具、内部 Agent API token 注入、受控 Wiki 写入边界、写入后 `wiki_changed` 事件传播。

## 目标

在 Phase 1 已打通 React → Rust → Node sidecar → Claude Agent SDK 的基础上，给 Agent 注册 LLM Wiki 专属 MCP 工具，让 Agent 能读取、检索、理解并受控更新当前 Wiki。

Phase 2 不做正式 Agent UI。Phase 2 的重点是工具协议、数据通道、文件系统边界、写入后接入现有 Lint/Fixer 防线。

## 关键决策

LLM Wiki 的内容质量防线已经是 Lint / Fixer / Review 流程。Agent 写入 Wiki 内容不需要额外再做一层“沙盒草稿 + 人审合并”的强制流程，否则会和产品现有治理链路重复。

Phase 2 的安全边界只负责防系统级事故：
- 不写 `wiki/` 之外
- 不碰 `.llm-wiki/` 内部状态
- 不写 `raw/sources/`
- 不删除目录
- 不改隐藏文件
- 限制单次写入大小和文件数量
- 写入后触发现有 dirty/refresh/Lint 入口

内容写得好不好，交给现有 Lint/Fixer 后续发现和修复。

## 调研结论

### 当前代码现状

GitNexus 索引状态：
- `llm_wiki` 当前索引：7345 symbols，300 execution flows
- `streamAgent` 只有 `handleTestAgent` 一个上游调用，Phase 2 改动前端入口风险低
- `agent_spawn` 是 Tauri IPC command，图里无普通 TS 上游调用属正常
- `createRequestHandler` 只被 `sidecar/src/main.ts` 和 `core.node.ts` 调用，适合扩展 sidecar 核心逻辑
- `readFile` / `writeFile` 是高复用前端 Tauri wrapper，不应为 sidecar 直接复用
- `search_project_inner` 已被 Rust 本地 API 复用，可提供 keyword/vector/hybrid 检索

已有可复用能力：
- `src-tauri/src/api_server.rs`
  - `GET /api/v1/projects`
  - `GET /api/v1/projects/{id}/files`
  - `GET /api/v1/projects/{id}/files/content`
  - `POST /api/v1/projects/{id}/search`
  - `GET /api/v1/projects/{id}/graph`
  - `POST /api/v1/projects/{id}/sources/rescan`
- 本地 API 已有：
  - `127.0.0.1:19828` 绑定
  - token / unauthenticated 模式
  - project id / path / current project 解析
  - path traversal 防护
  - public path 白名单
  - 搜索复用后端 hybrid retrieval
  - API real-LLM 测试覆盖

关键架构判断：
- sidecar 运行在 Node 进程里，不能直接调用 WebView 的 TS `invoke()` wrapper
- 不应在 sidecar 里重写搜索、图谱、文件读取逻辑
- 读类工具应调用现有本地 HTTP API，复用 Rust 后端能力
- 写类工具目前没有本地 API endpoint；Phase 2 在 sidecar 内做受控文件写入，边界是 path whitelist + operation limit

### Claude Agent SDK 约束

基于官方文档和当前安装包 `@anthropic-ai/claude-agent-sdk@0.3.150`：
- `query()` 是主入口，返回流式 `SDKMessage`
- `createSdkMcpServer()` 可创建同进程 MCP server
- `tool()` 定义工具：name、description、zod schema、handler
- 自定义 MCP server 通过 `options.mcpServers` 传给 `query()`
- MCP 工具名格式：`mcp__<server-name>__<tool-name>`
- MCP 工具需要权限；推荐用 `allowedTools` 精确放行
- `tools: []` 可移除所有内置 Claude Code 工具，只保留 MCP 工具
- `permissionMode: "bypassPermissions"` 会放开过多权限，不适合作为 Phase 2 默认
- tool annotations 是提示，不是安全边界
- 工具 handler 应捕获错误并返回 `is_error: true`，避免整个 `query()` 崩掉

参考：
- https://code.claude.com/docs/en/agent-sdk/custom-tools
- https://code.claude.com/docs/en/agent-sdk/mcp
- https://code.claude.com/docs/en/agent-sdk/typescript

## 范围

### Phase 2A：只读工具，默认启用

这些工具可作为 Phase 2 的生产完成口径：

| 工具 | 作用 | 数据通道 | 默认权限 |
|------|------|----------|----------|
| `list_projects` | 查看可用项目和 current project | 本地 HTTP API | allowed |
| `list_pages` | 列出 wiki/source/public 文件树 | 本地 HTTP API | allowed |
| `read_page` | 读取 wiki/purpose/schema/source 文本内容 | 本地 HTTP API | allowed |
| `search_pages` | keyword/vector/hybrid 搜索 Wiki | 本地 HTTP API | allowed |
| `get_graph` | 获取 Wiki 图谱节点/边 | 本地 HTTP API | allowed |

### Phase 2B：写工具，默认可写 Wiki

这些工具允许真实写入 `wiki/**/*.md`，但只允许小范围、可恢复、可被 Lint/Fixer 后续处理的 Wiki 内容变更：

| 工具 | 作用 | 默认行为 | 写入边界 |
|------|------|----------|----------|
| `update_page` | 更新已有 Wiki 页面 | 真实写入 | 只允许 `wiki/**/*.md`，单文件大小限制，不允许清空 |
| `create_entity` | 创建实体页面 | 真实写入 | 只允许新建 `wiki/entities/*.md`，不覆盖 |
| `create_concept` | 创建概念页面 | 真实写入 | 只允许新建 `wiki/concepts/*.md`，不覆盖 |

`dryRun` 保留为工具参数，方便调试和让 Agent 先预览，但不是默认强制路径。

## 设计

### 数据面

读类工具走本地 HTTP API：

```
Agent tool handler
  → fetch("http://127.0.0.1:19828/api/v1/...")
  → Rust api_server.rs
  → 现有 search / file / graph 实现
```

写类工具走 sidecar 内部受控文件写：

```
Agent tool handler
  → validate rel path / project path / mode / expectedHash
  → enforce size/count/non-empty limits
  → fs.writeFile
  → return changed path + old/new hash
  → mark wiki dirty / trigger refresh hooks
```

原因：
- 搜索必须复用 Rust `search_project_inner`，避免 sidecar 重写检索
- 读取必须复用 Rust API 的 public path 白名单
- 写入没有现成 API；Phase 2 先做最窄写入面，内容质量交给现有 Lint/Fixer

### Agent 请求扩展

Rust / TS / sidecar 的 request options 增加 Wiki tool 上下文：

```typescript
interface AgentRequestOptions {
  systemPrompt?: string
  cwd?: string
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  apiKey?: string
  baseUrl?: string
  persistSession?: boolean

  projectId?: string
  projectPath?: string
  apiServerBaseUrl?: string
  apiToken?: string
  enableWikiTools?: boolean
  enableWriteTools?: boolean
  maxWriteBytes?: number
  maxFilesChanged?: number
}
```

约束：
- `apiToken` 只传进 sidecar 内存，不写日志、不进入 prompt、不进入 stdout
- Rust optional fields 必须继续 `skip_serializing_if = "Option::is_none"`
- sidecar 继续 `omitNullish()` 防御 null/undefined

### Sidecar 模块拆分

新增：

```
src-tauri/sidecar/src/
├── wiki-api.ts        # 本地 API client：auth header、URL 拼接、错误归一
├── wiki-paths.ts      # safe path / slug / hash / diff helpers
├── wiki-tools.ts      # createLlmWikiMcpServer(context)
└── wiki-tools.node.ts # Node tests
```

修改：

```
src-tauri/sidecar/src/core.ts
src-tauri/sidecar/src/types.ts
src-tauri/src/commands/agent.rs
src/lib/agent/agent-types.ts
src/lib/agent/agent-transport.ts
src/components/chat/chat-panel.tsx
```

### SDK query options

Phase 1 当前用了：

```typescript
permissionMode: "bypassPermissions",
allowDangerouslySkipPermissions: true,
```

Phase 2 应改为：

```typescript
const wikiServer = createLlmWikiMcpServer(context)

const options = {
  tools: [],
  mcpServers: {
    llm_wiki: wikiServer,
  },
  allowedTools: [
    "mcp__llm_wiki__list_projects",
    "mcp__llm_wiki__list_pages",
    "mcp__llm_wiki__read_page",
    "mcp__llm_wiki__search_pages",
    "mcp__llm_wiki__get_graph",
    "mcp__llm_wiki__update_page",
    "mcp__llm_wiki__create_entity",
    "mcp__llm_wiki__create_concept",
  ],
}
```

如果用户关闭 Agent 写入能力，则从 `allowedTools` 里移除写工具：

```typescript
const allowedTools = enableWriteTools
  ? [...readTools, ...writeTools]
  : readTools
```

## 工具规格

### `list_projects`

用途：让 Agent 确认当前项目和可用项目。

输入：

```typescript
{}
```

调用：

```http
GET /api/v1/projects
```

输出：

```typescript
{
  ok: true
  currentProject?: { id: string; name: string; path: string }
  projects: Array<{ id: string; name: string; path: string; current?: boolean }>
}
```

### `list_pages`

用途：查看 Wiki 或 source 文件树。

输入：

```typescript
{
  root?: "wiki" | "sources" | "all"
  recursive?: boolean
  maxFiles?: number
}
```

约束：
- `maxFiles` 默认 500，最大 5000
- 返回内容只包含 path/name/isDir/size，不返回正文

调用：

```http
GET /api/v1/projects/{projectId}/files?root=wiki&recursive=true&maxFiles=500
```

### `read_page`

用途：读取单个页面或公开文本文件。

输入：

```typescript
{
  path: string
}
```

允许路径：
- `purpose.md`
- `schema.md`
- `wiki/**/*.md`
- `raw/sources/**/*.{md,txt,csv,json,yaml,yml,xml,html,rtf,log}`

输出：

```typescript
{
  path: string
  content: string
}
```

同时返回 resource block：

```typescript
{
  type: "resource",
  resource: {
    uri: "llm-wiki://current/wiki/foo.md",
    mimeType: "text/markdown",
    text: content
  }
}
```

### `search_pages`

用途：让 Agent 通过现有后端检索 Wiki。

输入：

```typescript
{
  query: string
  topK?: number
  includeContent?: boolean
}
```

约束：
- query 非空
- topK 默认 8，最大 20
- includeContent 默认 true，方便 Agent 直接引用内容

调用：

```http
POST /api/v1/projects/{projectId}/search
{
  "query": "...",
  "topK": 8,
  "includeContent": true
}
```

输出保留：
- `mode`
- `tokenHits`
- `vectorHits`
- `results[].path`
- `results[].title`
- `results[].score`
- `results[].content`
- `results[].vectorScore`

### `get_graph`

用途：让 Agent 理解页面关系和邻居节点。

输入：

```typescript
{
  q?: string
  limit?: number
}
```

调用：

```http
GET /api/v1/projects/{projectId}/graph?q=...&limit=...
```

约束：
- limit 默认 200，最大 1000
- Phase 2 只返回 API 原始节点/边，不做前端布局

### `update_page`

用途：受控更新已有 Wiki 页面。

输入：

```typescript
{
  path: string
  contents: string
  mode?: "replace" | "append"
  expectedSha256?: string
  dryRun?: boolean
}
```

约束：
- 只允许 `wiki/**/*.md`
- 不允许 dot path、绝对路径、`..`
- 默认真实写入；`dryRun: true` 时只返回预览
- `enableWriteTools === false` 时拒绝真实写入
- 文件必须已存在
- 不允许把文件写成空内容或极短占位内容
- 若传 `expectedSha256`，必须匹配当前文件
- 单文件写入默认上限 256KB，可由 `maxWriteBytes` 收紧
- 返回 changed path、old/new hash、diff summary，不在工具结果中回显超大全文

### `create_entity`

用途：创建新的实体页面。

输入：

```typescript
{
  name: string
  summary: string
  aliases?: string[]
  sources?: string[]
  pathHint?: string
  dryRun?: boolean
}
```

默认路径：

```text
wiki/entities/<slug>.md
```

生成 frontmatter：

```yaml
---
title: <name>
type: entity
aliases: []
sources: []
---
```

约束：
- 不覆盖已有文件；冲突返回 `is_error: true`
- 默认真实写入；`dryRun: true` 时只返回目标路径和内容预览
- 只允许写入 `wiki/entities/*.md`

### `create_concept`

用途：创建新的概念页面。

输入：

```typescript
{
  name: string
  explanation: string
  related?: string[]
  sources?: string[]
  pathHint?: string
  dryRun?: boolean
}
```

默认路径：

```text
wiki/concepts/<slug>.md
```

约束同 `create_entity`。

## 安全边界

必须实现：
- 不使用 `permissionMode: "bypassPermissions"` 作为默认
- 默认 `tools: []`，移除内置 Claude Code 工具
- 只用 `allowedTools` 精确放行 LLM Wiki MCP 工具
- read tools 只走本地 API，复用 Rust path whitelist
- write tools 只允许 `wiki/**/*.md`
- create tools 只允许写入固定子目录，且不覆盖已有文件
- update tools 不允许清空文件、不允许超大写入
- 不允许 delete / rename / directory write
- 所有写入必须校验 projectPath canonical path
- 写入后返回 old/new hash，触发现有 refresh/dirty/Lint 后续链路
- 所有工具错误返回 `is_error: true`，不抛到 `query()` 外层
- 所有日志过滤 token / apiKey / Authorization header
- 工具结果限制大小，防止把整个 vault 塞进上下文

Phase 2 不做：
- 用户交互式批准弹窗
- Hook-based permission policy
- 强制沙盒草稿 + 人审合并
- 正式工具调用 UI
- session resume/fork
- sidecar binary 打包

## 实施步骤

| 步骤 | 内容 | 文件 | 预计 |
|------|------|------|------|
| 1 | 扩展 request options，传 project/API/tool flags | Rust + TS types | 1h |
| 2 | 实现 sidecar Wiki API client | `wiki-api.ts` | 1.5h |
| 3 | 实现 path/hash/diff helpers | `wiki-paths.ts` | 1.5h |
| 4 | 实现 read-only MCP tools | `wiki-tools.ts` | 3h |
| 5 | 集成 `createSdkMcpServer()` 到 `core.ts` | `core.ts` | 1.5h |
| 6 | 前端 Test Agent 传 current project/API token | `chat-panel.tsx` | 1h |
| 7 | 实现 bounded write tools + refresh hook | `wiki-tools.ts` | 3h |
| 8 | 补 Node + Rust 测试 | `*.node.ts`, `agent.rs` | 3h |
| 9 | dev app 手动验证 | app | 1h |
| **总计** |  |  | **~16.5h** |

## 测试计划

### Node sidecar tests

新增 `src-tauri/sidecar/src/wiki-tools.node.ts`：
- `search_pages` 调用正确 URL、method、body
- `read_page` URL encode path
- auth header 使用 `Authorization: Bearer <token>`
- token 不出现在错误文本和日志中
- API 非 2xx 返回 `is_error: true`
- `list_pages` clamp `maxFiles`
- `update_page` 写入 `wiki/**/*.md`，返回 old/new hash
- `update_page dryRun` 不写文件，返回 diff summary
- `update_page` 在 `enableWriteTools:false` 时拒绝真实写入
- `update_page` 拒绝空内容、超大内容、非 md、`raw/sources`、`.llm-wiki`
- path traversal / absolute path / dot segment 被拒绝
- `create_entity` slug 稳定，真实写入固定目录，不覆盖已有文件
- 写入后触发 refresh/dirty 回调

### Rust tests

扩展 `src-tauri/src/commands/agent.rs`：
- 新 optional fields 缺省不序列化
- present fields camelCase
- `apiToken` 不参与 debug log

### Existing tests

必须跑：

```bash
npm --prefix src-tauri/sidecar exec tsc -- --noEmit
npm --prefix src-tauri/sidecar test
cargo test --manifest-path src-tauri/Cargo.toml commands::agent::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
npm run test:mocks
```

可选真实 API 测试：

```bash
npx vitest run src/lib/api-server.real-llm.test.ts
```

### 手动验证

1. 打开 dev app
2. 确认 API Server enabled，有 token 或 allow unauthenticated
3. 点击 Test Agent
4. prompt 改为：
   - “搜索当前 Wiki 里关于 X 的内容，并引用页面路径”
   - “读取 purpose.md，总结这个 Wiki 的目标”
   - “列出图谱里最相关的 5 个节点”
5. 观察：
   - sidecar 不崩
   - SDK `system init` 中出现 `llm_wiki` MCP server
   - tool_use / tool_result 消息流经 stdout → Rust emit → frontend `onMessage`
   - Agent 回复包含真实 wiki path
   - token 不出现在 stdout/stderr/console

写工具手动验证：
- “创建一个关于 X 的 entity 页面”
- 期望真实写入 `wiki/entities/<slug>.md`
- App file tree / graph refresh 后能看到新页面
- Lint/Fixer 可继续发现格式、链接、孤立节点等内容问题

## 完成标准

Phase 2 完成后：
- Agent 能调用 `list_projects`
- Agent 能调用 `list_pages`
- Agent 能调用 `read_page`
- Agent 能调用 `search_pages`，搜索复用现有 hybrid backend
- Agent 能调用 `get_graph`
- SDK options 不再默认 bypass 全部权限
- write tools 能真实写入 `wiki/**/*.md`，并受 path/size/operation 边界限制
- 写入后能触发现有 refresh/dirty/Lint 后续链路
- 单元测试覆盖工具成功、失败、安全边界
- dev app 能完成一次真实 Wiki 检索问答

不作为 Phase 2 完成标准：
- 正式 Agent UI
- 工具调用可视化
- 用户审批弹窗
- 成本统计面板
- session 持久化

## 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| API disabled/token missing 导致工具全失败 | 中 | `list_projects`/health 先给明确错误；前端传 apiConfig |
| `bypassPermissions` 继续存在导致过宽权限 | 高 | Phase 2 第一步改为 `tools: []` + `allowedTools` |
| 写工具误写文件 | 高 | path whitelist；canonical path；禁止 raw/.llm-wiki/隐藏文件；expected hash |
| Agent 生成内容质量差 | 中 | 不重复审核；交给现有 Lint/Fixer/Review 流程发现和修复 |
| 单次写入过大或清空页面 | 高 | maxWriteBytes；非空校验；maxFilesChanged；hash 返回 |
| 工具结果太大挤爆上下文 | 中 | topK/maxFiles/content length clamp |
| token 泄漏到日志 | 高 | API client 错误脱敏；测试覆盖 |
| sidecar 直接依赖 API 端口 | 低 | 使用 `apiServerBaseUrl` 传参，默认 `127.0.0.1:19828` |

## 后续衔接

Phase 3：
- PreToolUse hook 做路径/操作策略补强，不做默认人审
- PostToolUse hook 记录变更、触发 Lint/Fixer 提示
- Stop hook 总结工具调用和 Wiki 变更
- 用户配置工具白名单/黑名单

Phase 4：
- 正式 Agent 模式 UI
- tool_use/tool_result 可视化
- result 中 cost/turns 面板

Phase 5：
- sidecar binary 打包
- `startup()` 预热
- session resume/fork
