# Phase 3: Agent Sidecar Hooks、权限策略与写入后治理

> 类型：Phase 实施计划 | 创建：2026-05-28 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 2 计划](./agent-sidecar-phase2.md)

## 目标

Phase 3 在 Phase 2 已有 Wiki MCP 工具基础上，补齐 Agent 执行过程的控制面：

- 用 Claude Agent SDK hooks 记录和约束工具调用
- 用明确权限模式区分 Wiki 工具免询问与 Claude Code 内置工具询问
- Agent 写入 Wiki 后接入现有 Lint/Fixer 提示链路
- 把工具调用、写入、Stop 总结事件稳定传回前端，为 Phase 4 正式 UI 做数据准备

Phase 3 不做正式 Agent UI，不做强制“沙盒草稿 + 人审合并”，不重做 Wiki 内容审核。内容质量继续交给现有 Lint/Fixer/Review。

## 当前代码与 GitNexus 结论

GitNexus 索引：

- repo：`llm_wiki`
- HEAD：`8da6b856ff562558b2ac3ca0add27655cb7314b6`
- index：7538 symbols，14044 relationships，300 flows

相关数据流：

```text
React Chat
  -> streamAgent()
  -> Tauri invoke("agent_spawn")
  -> Rust agent_spawn()
  -> Node sidecar createRequestHandler()
  -> Claude Agent SDK query()
  -> createLlmWikiMcpServer()
  -> wiki tools
  -> local API / controlled fs write
  -> sidecar send({ type: "message" | "wiki_changed" | "done" | "error" })
  -> frontend callbacks
```

GitNexus 影响面：

| 目标 | 直接上游 | 影响流程 | 风险 |
|------|----------|----------|------|
| `createRequestHandler` | `src-tauri/sidecar/src/main.ts`, `core.node.ts` | 0 | LOW |
| `createLlmWikiMcpServer` | `createRequestHandler` | 0 | LOW |
| `agent_spawn` | Tauri command，无普通代码上游 | 0 | LOW |
| `streamAgent` | `handleTestAgent` | 1 | LOW |

判断：

- Phase 3 主要改 sidecar `query()` options、hooks、transport event schema，范围可控。
- 真正风险不是调用面，而是权限语义：`allowedTools` 只是预批准，不等于禁用其他工具。
- 产品目标不是禁用 Claude Code 能力，而是 Wiki 工具免询问、Claude Code 内置工具按 SDK 权限机制询问。

## 官方文档结论

参考：

- https://docs.anthropic.com/en/docs/claude-code/sdk/custom-tools
- https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-permissions
- https://docs.anthropic.com/en/docs/claude-code/sdk/typescript
- https://docs.anthropic.com/en/docs/claude-code/hooks

关键点：

- `createSdkMcpServer()` 支持 in-process MCP 工具，适合当前 Node sidecar。
- MCP 工具名是 `mcp__<server>__<tool>`，当前 `mcp__llm_wiki__...` 命名正确。
- `allowedTools` 是 auto-allow 列表；要限制可用工具，仍要设置 `tools`。
- `tools: []` 会移除内置工具；Phase 3 默认不应使用它。
- `permissionMode: "default"` 保留标准权限行为，危险操作会询问。
- `permissionMode: "dontAsk"` 表示不弹权限，未预批工具直接拒绝；只适合用户明确选择“免询问但只允许预批工具”的受限模式。
- `permissionMode: "bypassPermissions"` 会跳过权限检查，不适合默认使用。
- `hooks` 支持 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`Stop` 等事件。
- TS SDK type 已确认：
  - `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`
  - `PreToolUse` 可返回 `permissionDecision`、`permissionDecisionReason`、`updatedInput`
  - `PostToolUse` 可返回 `additionalContext`、`updatedToolOutput`
  - `Stop` 输入带 `last_assistant_message`
  - `canUseTool` 可作更底层权限回调，但 Phase 3 先不用，避免把 UI 授权问题提前做复杂

## 范围

### Phase 3A：权限模式分层

目标：Agent 默认具备 Claude Code 的完整能力，但 Wiki 工具直接可用，其他敏感能力按 SDK 权限机制询问。

实现：

- `createRequestHandler()` 生成 SDK options 时：
  - 默认不设置 `tools: []`，保留 Claude Code 内置工具
  - `allowedTools` 精确列出 Wiki read/write 工具，让 Wiki 工具免询问
  - 默认 `permissionMode: "default"`，让内置工具继续走 SDK 标准权限询问
  - 不设置 `allowDangerouslySkipPermissions`
- 当 `enableWikiTools === false`：
  - `allowedTools: []`
  - 保留 Claude Code 内置工具
  - `permissionMode: "default"`
  - 允许 Agent 使用 Claude Code 能力，但 Wiki MCP 工具不可用
- 保留 `enableWriteTools`：
  - `true`：read + write tools 进入 `allowedTools`
  - `false`：只允许 read tools
- 新增可选运行模式：
  - `permissionPolicy: "default"`：默认；Wiki 工具免询问，内置工具询问
  - `permissionPolicy: "restricted"`：只允许预批工具，使用 `tools: []` + `permissionMode: "dontAsk"`
  - `permissionPolicy: "bypass"`：明确用户选择后才使用 `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`

不做：

- 不自己重做权限弹窗，优先复用 SDK 权限机制
- 默认不关闭 Claude Code 内置 `Read/Edit/Bash`
- 默认不使用 `bypassPermissions`

### Phase 3B：Hook 管线

新增 sidecar 模块：

```text
src-tauri/sidecar/src/
├── agent-hooks.ts       # createLlmWikiHooks(context)
├── agent-events.ts      # hook/tool event payload schema helpers
└── agent-policy.ts      # allowed tool policy helpers
```

`createRequestHandler()` 负责把 hooks 注入 `query()`：

```typescript
const hooks = createLlmWikiHooks({
  streamId: req.streamId,
  projectPath: req.options.projectPath,
  enableWriteTools,
  maxWriteBytes: req.options.maxWriteBytes,
  maxFilesChanged: req.options.maxFilesChanged,
  send,
});
```

Hook 设计：

| Hook | 用途 | 行为 |
|------|------|------|
| `PreToolUse` | 工具调用前策略补强 | Wiki 写工具做轻量输入检查；内置工具不在 hook 里强行 deny，交给 SDK 权限机制 |
| `PostToolUse` | 工具调用后记录 | 发送 `tool_event`，记录 tool name、duration、ok/error |
| `PostToolUseFailure` | 工具失败记录 | 发送失败事件，便于 UI 显示 |
| `PostToolBatch` | 批次级汇总 | 汇总一轮并发工具调用，给后续 UI 用 |
| `Stop` | Agent 完成总结 | 发送 `agent_summary`，包含最后回答、写入列表、工具统计 |

注意：

- 写入安全边界仍在 `wiki-tools.ts` 的 handler 内执行。
- `PreToolUse` 是补强和可观测入口，不替代 `assertWikiMarkdownPath()`、`assertWritableContents()`、`maxFilesChanged`。
- Hook 不做人审，不阻塞正常 Wiki 写入。

### Phase 3C：写入后 Lint/Fixer 接入

目标：Agent 写完后让用户知道 Wiki 需要走现有治理链路。

Phase 3 只做“触发/提示”，不自动修内容。

实现策略：

- `wiki_changed` 事件保持现有行为：刷新文件树。
- 新增 `agent_action_required` 事件：
  - `kind: "lint_recommended"`
  - `paths: string[]`
  - `reason: "agent_write"`
- 前端收到后：
  - 标记当前 Wiki 有 Agent 写入后的待检查状态
  - 复用现有 Lint 入口提示用户运行

可选增强：

- 若现有 store 已有“dirty/source changed”机制，接入同一路径。
- 不在 Phase 3 自动跑 Fixer，避免 Agent 写入后又立刻 AI 改 AI。

### Phase 3D：事件协议扩展

当前事件：

```typescript
type AgentMessage =
  | "message"
  | "error"
  | "done"
  | "wiki_changed"
```

Phase 3 增加：

```typescript
type AgentMessage =
  | "message"
  | "error"
  | "done"
  | "wiki_changed"
  | "tool_event"
  | "agent_summary"
  | "agent_action_required"
```

Payload：

```typescript
interface AgentToolEventPayload {
  phase: "pre" | "post" | "failure" | "batch";
  toolName: string;
  toolUseId?: string;
  ok?: boolean;
  durationMs?: number;
  inputPreview?: Record<string, unknown>;
  error?: string;
}

interface AgentSummaryPayload {
  lastAssistantMessage?: string;
  changedPaths: string[];
  toolCalls: number;
  failedToolCalls: number;
}

interface AgentActionRequiredPayload {
  kind: "lint_recommended";
  paths: string[];
  reason: "agent_write";
}
```

约束：

- 不把 `apiToken`、`apiKey`、完整大文件内容放进事件。
- `inputPreview` 只保留路径、模式、dryRun、query 等安全字段。
- 对 `contents` 只记录长度和 sha256，不记录正文。

### Phase 3E：测试

Sidecar 单测：

- `createRequestHandler`：
  - 有 Wiki tools 时传 `permissionMode: "dontAsk"`
  - `tools: []` 保持
  - read-only 模式只放行 read tools
  - write-enabled 模式放行 read + write tools
  - 不设置 `allowDangerouslySkipPermissions`
- `agent-policy.ts`：
  - 非 `mcp__llm_wiki__*` 工具 deny
  - write disabled 时 write tool deny
  - write enabled 时 read/write allow
- `agent-hooks.ts`：
  - `PreToolUse` 发送 `tool_event`
  - `PostToolUse` 发送 `tool_event`
  - `PostToolUseFailure` 发送失败事件
  - `Stop` 生成 `agent_summary`
  - 写入后生成 `agent_action_required`
- `agent-transport.test.ts`：
  - 新事件能传到 callbacks
  - 未认识事件不打断普通消息流

Rust 单测：

- 若新增 `AgentRequestOptions` 字段：
  - `skip_serializing_if = "Option::is_none"`
  - camelCase 序列化
  - absent optional 不输出 `null`

验证命令：

```bash
npm --prefix src-tauri/sidecar exec tsc -- --noEmit
npm --prefix src-tauri/sidecar test
cargo check --manifest-path src-tauri/Cargo.toml
npm run test:mocks
```

## 实施步骤

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1 | 抽出工具权限列表和策略 | `src-tauri/sidecar/src/agent-policy.ts`, `core.ts` |
| 2 | SDK options 收紧权限 | `src-tauri/sidecar/src/core.ts`, `core.node.ts` |
| 3 | 新增 hooks 工厂 | `src-tauri/sidecar/src/agent-hooks.ts` |
| 4 | 新增事件类型 | `src-tauri/sidecar/src/types.ts`, `src/lib/agent/agent-types.ts` |
| 5 | transport 处理新事件 | `src/lib/agent/agent-transport.ts` |
| 6 | chat panel 最小接入 | `src/components/chat/chat-panel.tsx` |
| 7 | 测试覆盖 | sidecar node tests、frontend mock tests、Rust serialization tests |
| 8 | GitNexus detect changes | 确认影响范围只落在 Agent sidecar 相关 flow |

## 验收标准

- Agent 默认保留 Claude Code 内置工具能力。
- Wiki MCP 工具默认免询问。
- Claude Code 内置工具默认按 SDK 权限机制询问。
- Agent 可正常调用 Wiki read tools。
- `enableWriteTools=false` 时写工具被拒绝。
- `enableWriteTools=true` 时写工具仍受 Phase 2 路径/大小/文件数限制。
- Agent 写入后：
  - 前端收到 `wiki_changed`
  - 前端收到 `agent_action_required: lint_recommended`
  - 文件树刷新不回归
- Stop 后前端收到 `agent_summary`。
- sidecar stdout 仍只输出 SDK JSON-lines，ready/log 仍走 stderr。
- 不泄露 `apiKey` / `apiToken` / 大段文件内容。
- TypeScript、Rust、mock tests 通过。

## 风险与处理

| 风险 | 等级 | 处理 |
|------|------|------|
| SDK hook 输出格式理解偏差 | MEDIUM | 以本地 `@anthropic-ai/claude-agent-sdk@0.3.150` types 为准，先单测捕获 options shape |
| `allowedTools` 被误认为禁用工具 | MEDIUM | 文档明确：默认仅用于 Wiki 工具免询问，不用于关闭内置工具 |
| Hook 里重复路径校验导致逻辑漂移 | MEDIUM | Hook 只做补强，硬边界仍在 `wiki-tools.ts` |
| 新事件破坏前端流式输出 | LOW | transport 对未知事件宽容，已有 message/done 逻辑不动 |
| 自动 Lint/Fixer 过度打扰 | LOW | Phase 3 只提示，不自动修 |

## 不纳入 Phase 3

- 正式 Agent UI
- 工具调用可视化完整面板
- 会话管理、resume/fork
- sidecar binary 打包
- `startup()` 预热
- 内部 RPC 通道替换 HTTP API
- sandbox 草稿/人审合并流程
- 自动运行 Fixer

这些继续放到 Phase 4/5 或未来方案。

## PR 拆分建议

Phase 3 建议一个 PR 完成，但按 commit 分层：

1. `agent-policy`: 收紧 SDK permission options
2. `agent-hooks`: 增加 hook 管线和事件
3. `agent-transport`: 前端事件类型与最小接入
4. `tests`: sidecar / transport / Rust serialization 覆盖

如果开发中发现 `chat-panel.tsx` 改动明显变大，把 UI 展示部分拆到 Phase 4，Phase 3 只保留 callbacks 和 console/debug 可见事件。
