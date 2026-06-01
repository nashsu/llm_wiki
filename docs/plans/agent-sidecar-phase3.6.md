# Phase 3.6: Agent SDK Parity — 补齐 Claude Agent SDK 原生能力

> 类型：Phase 实施计划 | 创建：2026-05-29 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 3.5 计划](./agent-sidecar-phase3.5.md)

## 目标

Phase 3.6 的目标是：在 Phase 4 正式 UI 前，把 Claude Agent SDK 已经提供、但 LLM Wiki Agent 还没有透出的原生能力补齐。

Phase 3.5 解决的是“普通 LLM 能做的 LLM Wiki 业务，Agent 也能做”。Phase 3.6 解决的是“Claude Agent SDK 原生能做的 Agent 能力，LLM Wiki 也能接住”。

边界：

- Phase 3.6 做协议、transport、sidecar options、事件、测试。
- Phase 3.6 不做正式 UI。
- Phase 4 再把这些底座能力做成按钮、面板、时间线、设置项。

## 官方能力来源

参考：

- TypeScript SDK: https://code.claude.com/docs/en/agent-sdk/typescript
- Sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- File checkpointing: https://code.claude.com/docs/en/agent-sdk/file-checkpointing
- Structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Skills: https://code.claude.com/docs/en/agent-sdk/skills
- Plugins: https://code.claude.com/docs/en/agent-sdk/plugins

当前依赖版本：

```text
@anthropic-ai/claude-agent-sdk 0.3.x
```

当前代码已经使用：

- `query()`
- `createSdkMcpServer()`
- MCP tools
- hooks
- `allowedTools`
- `permissionMode`
- `maxTurns`
- `maxBudgetUsd`
- `abortController`
- `env`

当前还没有产品化：

- session resume / continue / fork
- SDK 原生 `canUseTool`
- 完整 permission modes
- file checkpoint / rewind
- structured output
- sandbox option
- `thinking` / `effort` / `taskBudget`
- `includePartialMessages` / `includeHookEvents` / `promptSuggestions`
- subagents
- skills / plugins
- SDK session metadata / title

## 当前实现审计

当前前端入口：

```text
src/lib/agent/agent-transport.ts::streamAgent()
```

当前 Rust bridge：

```text
src-tauri/src/commands/agent.rs::agent_spawn()
src-tauri/src/commands/agent.rs::build_agent_request()
```

当前 sidecar：

```text
src-tauri/sidecar/src/core.ts::createRequestHandler()
```

当前 transport options 只有：

```text
systemPrompt
cwd
model
maxTurns
maxBudgetUsd
apiKey
baseUrl
permissionPolicy
projectId
projectPath
apiServerBaseUrl
apiToken
enableWikiTools
enableWriteTools
maxWriteBytes
maxFilesChanged
```

`createRequestHandler()` 目前固定：

```text
persistSession: false
permissionPolicy: default | restricted | bypass
allowedTools: LLM Wiki tool allow list
mcpServers: llm_wiki
hooks: createLlmWikiHooks()
```

因此 Agent 能力底座还没有和 SDK 完整对齐。

## 设计原则

### 1. Phase 3.6 只补底座，不做 UI

所有新增能力必须能通过 transport options / callbacks / events 使用。Phase 4 再决定如何展示。

### 2. 不破坏 Phase 3.5 的 Wiki 工具边界

SDK 原生能力可以增强 Agent，但不能绕过 LLM Wiki 已有安全边界：

- Wiki 写入仍只走受控工具或明确 permission policy。
- App bridge 工具仍复用现有业务模块。
- 内部 API token 仍只给 Agent sidecar，不暴露给模型文本。

### 3. 权限要分两层

第一层：Claude Agent SDK 原生权限。

- `permissionMode`
- `canUseTool`
- `allowedTools`
- `disallowedTools`
- `permissionPromptToolName`

第二层：LLM Wiki 业务边界。

- `enableWikiTools`
- `enableWriteTools`
- `maxWriteBytes`
- `maxFilesChanged`
- path guards
- lint recommended / review 后续链路

两层都要保留。SDK 权限解决“Claude Code 能不能调用工具”，LLM Wiki 边界解决“Wiki 内容和项目文件不能乱写”。

### 4. Session 是 Agent 成为一等公民的基础

普通 Chat 有 conversation history。Agent 也必须有 sessionId / resume / fork 机制。否则 Phase 4 做出来仍然只是一次性工具调用。

## 能力清单

### P0：Phase 4 前必须完成

#### Session resume / continue / fork

SDK 能力：

- `sessionId`
- `resume`
- `continue`
- `forkSession`
- `resumeSessionAt`
- `persistSession`
- `title`

建议 transport 输入：

```ts
interface AgentSessionOptions {
  sessionId?: string;
  resume?: string;
  continueSession?: boolean;
  forkSession?: boolean;
  resumeSessionAt?: string;
  persistSession?: boolean;
  title?: string;
}
```

注意：`continue` 是 JS 保留字附近的易混字段，前端建议用 `continueSession`，sidecar 再映射成 SDK 的 `continue`。

建议输出：

```ts
interface AgentResultMetadata {
  sessionId?: string;
  totalCostUsd?: number;
  durationMs?: number;
  usage?: unknown;
}
```

验收：

- 新 Agent query 能指定 `sessionId`。
- 能 resume 上一次 Agent session。
- 能 fork 已有 session 到新 session。
- `result.session_id` 能回传到前端。
- `persistSession: false` 仍可用于临时任务。

GitNexus 影响关注：

- impact `streamAgent`
- impact `AgentTransportOptions`
- impact `AgentSpawnArgs`
- impact `AgentRequestOptions`
- impact `createRequestHandler`

#### SDK permission modes + canUseTool 协议

SDK 能力：

- `permissionMode`: `default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto`
- `canUseTool`
- `allowedTools`
- `disallowedTools`
- `permissionPromptToolName`

当前自定义 `restricted` 应改成产品层 alias：

```text
restricted = permissionMode: dontAsk + tools: [] + 仅允许预授权 Wiki tools
```

建议新增事件：

```ts
type AgentPermissionRequestEvent = {
  requestId: string;
  toolName: string;
  inputPreview: Record<string, unknown>;
  suggestions?: unknown[];
};

type AgentPermissionDecision =
  | { behavior: "allow"; scope: "once" | "session" | "always"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; reason?: string };
```

建议新增 Tauri command：

```text
agent_permission_response(streamId, requestId, decision)
```

sidecar 需要维护 pending permission promise，类似现有 app tool bridge。

验收：

- Agent 调用非预授权工具时能发出 permission request。
- 前端可以 allow once / deny。
- `plan` 模式不执行写入工具。
- `acceptEdits` 能自动接受文件编辑类操作，但仍不绕过 LLM Wiki path guards。
- `auto` 模式可透传 SDK。

GitNexus 影响关注：

- impact `buildPermissionOptions`
- impact `createLlmWikiHooks`
- impact `createRequestHandler`
- impact `streamAgent`
- impact `agent_tool_response`

#### File checkpoint / rewind

SDK 能力：

- `enableFileCheckpointing`
- rewind files at user-message boundary

建议 transport 输入：

```ts
enableFileCheckpointing?: boolean;
```

建议新增 command：

```text
agent_rewind_files(streamId/sessionId, messageId?)
```

实现注意：

- SDK checkpoint 主要覆盖 Claude Code 内置工具改动。
- LLM Wiki app bridge 写入仍要保留现有 `wiki_changed` / `lint_recommended`。
- 对 app bridge 写入，如果 SDK checkpoint 无法覆盖，需要记录 `oldSha256` / backup 路径，作为后续增强。

验收：

- 开启 checkpoint 后，Agent 内置文件编辑可以 rewind。
- rewind 后前端收到 `wiki_changed` 或等价刷新事件。
- 未开启 checkpoint 时 rewind 返回结构化错误。

GitNexus 影响关注：

- impact `agent_spawn`
- impact `agent_kill`
- impact `streamAgent`
- impact `createRequestHandler`
- impact `writePage`

### P1：建议 Phase 3.6 完成

#### Structured output

SDK 能力：

- `outputFormat`
- JSON Schema structured output

建议 transport 输入：

```ts
outputFormat?: {
  type: "json_schema";
  schema: Record<string, unknown>;
};
```

用途：

- Agent 任务计划
- review 结果
- research 结构化摘要
- UI 可解析的 action list

验收：

- `outputFormat` 能从前端传到 SDK。
- result 中结构化内容能回传。
- schema 无效时返回结构化错误，不让 sidecar crash。

#### Thinking / effort / taskBudget

SDK 能力：

- `thinking`
- `effort`
- `taskBudget`
- deprecated `maxThinkingTokens`

建议 transport 输入：

```ts
thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" };
effort?: "low" | "medium" | "high" | "xhigh" | "max";
taskBudget?: { total: number };
```

验收：

- 能透传 thinking / effort。
- 能透传 taskBudget。
- 结果 usage / cost 不丢失。

#### SDK 原生事件增强

SDK 能力：

- `includePartialMessages`
- `includeHookEvents`
- `promptSuggestions`
- `agentProgressSummaries`
- `forwardSubagentText`

建议 transport 输入：

```ts
includePartialMessages?: boolean;
includeHookEvents?: boolean;
promptSuggestions?: boolean;
agentProgressSummaries?: boolean;
forwardSubagentText?: boolean;
```

建议新增前端 callback：

```ts
onPromptSuggestion?: (payload: unknown) => void;
onPartialMessage?: (payload: unknown) => void;
onHookEvent?: (payload: unknown) => void;
onSubagentEvent?: (payload: unknown) => void;
```

验收：

- 事件不被 `streamAgent` 丢弃。
- 未识别 SDK message 至少进入 `onMessage`。
- Phase 4 可以直接消费这些事件。

#### Sandbox option

SDK 能力：

- `sandbox`

建议 transport 输入：

```ts
sandbox?: {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  failIfUnavailable?: boolean;
  network?: Record<string, unknown>;
};
```

设计决定：

- sandbox 是 Claude Code 内置工具执行隔离层。
- sandbox 不替代 LLM Wiki path guards。
- 默认关闭。
- 如果用户开启 sandbox，`failIfUnavailable` 默认 true，避免静默降级成无 sandbox。

验收：

- sandbox options 能透传 SDK。
- 不支持平台返回结构化错误。
- Wiki MCP tools 不因 sandbox 开启而失去内部 API token。

### P2：可放 Phase 3.6 后半段

#### Subagents

SDK 能力：

- `agents`
- `agent`
- subagent progress summaries

建议先内置少量 LLM Wiki 子代理定义：

```text
wiki-researcher
wiki-reviewer
wiki-ingester
```

不做 UI 管理，只做 transport 和测试。

验收：

- 能定义 `agents`。
- 能指定主 `agent`。
- subagent 输出不会破坏主消息流。

#### Skills / plugins

SDK 能力：

- `skills`
- `plugins`

建议：

- Phase 3.6 只做透传。
- 后续再考虑把 LLM Wiki 写作规范、lint 修复规范、研究规范沉淀为 skill。

验收：

- `skills: "all"` / `skills: string[]` 能透传。
- local plugin config 能透传。
- 不把 secrets 写进 skill/plugin 文件。

## PR 拆分计划

Phase 3.6 不做单个大 PR。建议拆 5 个 PR。

### PR A：Session 底座

范围：

- 扩展 `AgentTransportOptions`
- 扩展 Rust `AgentSpawnArgs` / `AgentRequestOptions`
- sidecar 透传 `sessionId` / `resume` / `continue` / `forkSession` / `resumeSessionAt` / `persistSession` / `title`
- result session metadata 回传
- transport 测试
- sidecar 测试

不做：

- 不做 session 列表 UI
- 不做正式 Agent chat UI

风险：MEDIUM。

### PR B：权限模式 + canUseTool 审批协议

范围：

- 扩展 permission mode 到 SDK 完整集合
- `restricted` 改成产品 alias
- sidecar 实现 `canUseTool`
- 新增 permission request / response 消息协议
- 新增 Rust command 写回 permission decision
- 测试 allow / deny / timeout / kill cleanup

不做：

- 不做正式审批弹窗 UI
- 不做权限设置页

风险：HIGH。权限链路是核心安全面。

### PR C：Checkpoint / rewind + sandbox

范围：

- 透传 `enableFileCheckpointing`
- 新增 rewind command 或等价协议
- 透传 `sandbox`
- sandbox unavailable 返回结构化错误
- 刷新 wiki tree / dataVersion
- 测试 checkpoint disabled / enabled paths

不做：

- 不做可视化 diff
- 不做复杂备份管理 UI

风险：HIGH。涉及文件恢复语义。

### PR D：Structured output + events + cost controls

范围：

- 透传 `outputFormat`
- 透传 `thinking` / `effort` / `taskBudget`
- 透传 `includePartialMessages` / `includeHookEvents` / `promptSuggestions` / `agentProgressSummaries` / `forwardSubagentText`
- 前端类型补齐
- 回传 usage / cost / prompt suggestion
- 测试 unknown SDK message 不丢失

不做：

- 不做成本面板 UI
- 不做 prompt suggestion UI

风险：MEDIUM。

### PR E：Subagents + skills/plugins

范围：

- 透传 `agent` / `agents`
- 透传 `skills`
- 透传 local `plugins`
- 可选内置 `wiki-researcher` / `wiki-reviewer` / `wiki-ingester`
- 测试 subagent event passthrough

不做：

- 不做子代理管理 UI
- 不做 skill 编辑器

风险：MEDIUM。

## 验收标准

Phase 3.6 完成时：

- Agent 能 resume/fork/continue session。
- Agent result 能稳定回传 sessionId、usage、cost。
- Agent 支持 SDK 完整 permission modes。
- Agent 支持 SDK `canUseTool` 审批协议。
- Agent 支持 checkpoint / rewind。
- Agent 支持 sandbox option 透传。
- Agent 支持 structured output。
- Agent 支持 thinking / effort / taskBudget。
- Agent 不丢 partial/hook/prompt suggestion/subagent 事件。
- Agent 能透传 subagents / skills / plugins。
- 所有新增 options 都有 Rust serialization null-safety。
- sidecar kill 时清理 pending app tool / permission promise。
- `npm run typecheck` 通过。
- `npm run test:mocks` 通过。
- `npm --prefix src-tauri/sidecar test` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml commands::agent::tests -- --nocapture` 通过。
- `npx gitnexus detect_changes` 确认影响范围符合预期。

## 不纳入 Phase 3.6

- 正式 Agent UI。
- Agent / 普通 LLM 模式切换 UI。
- 工具调用时间线 UI。
- permission prompt 弹窗 UI。
- session 列表 / fork 按钮 UI。
- checkpoint diff 查看器。
- 成本统计面板。
- sidecar 单文件打包。
- `startup()` 预热。

这些继续放 Phase 4 / Phase 5。

## GitNexus 使用要求

开发 Phase 3.6 时必须遵守：

- 修改任何现有函数前先跑 `gitnexus impact`。
- 高风险模块必须先报告影响面：
  - `streamAgent`
  - `AgentTransportOptions`
  - `AgentSpawnArgs`
  - `AgentRequestOptions`
  - `agent_spawn`
  - `agent_tool_response`
  - `createRequestHandler`
  - `buildPermissionOptions`
  - `createLlmWikiHooks`
  - `writePage`
- 每个 PR 提交前跑 `gitnexus detect_changes`。
- 如果 GitNexus 显示 HIGH/CRITICAL，拆 PR 或先做协议抽取测试。

## 最终判断

Phase 3.6 是必要阶段。否则 Phase 4 做出正式 UI 后，Agent 仍然只是“能调用 Wiki 工具的临时 agent”，而不是完整承接 Claude Agent SDK 能力的一等公民。

正确顺序：

```text
Phase 3.5：补齐 LLM Wiki 业务工具能力
Phase 3.6：补齐 Claude Agent SDK 原生能力
Phase 4：正式 Agent UI
Phase 5：打包、预热、长期稳定性
```
