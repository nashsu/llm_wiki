# Phase 4: Agent UI 集成

> 类型：Phase 实施计划 | 创建：2026-06-02 | 状态：待开始
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 3.7 计划](./agent-sidecar-phase3.7.md)

## 目标

Phase 1–3.7 完成了 Agent Sidecar 的全部后端能力底座：sidecar 进程管理、MCP 工具、hooks、权限策略、tool parity、SDK 原生能力透传、产品化补齐、代码重构。但前端只有临时的 QA hook 集成，用户无法正式使用 Agent 能力。

Phase 4 的目标是：把后端已有的 Agent 能力暴露为可用的正式 UI，让用户能在 Chat 面板中无缝切换普通 LLM 对话和 Agent 对话。

边界：

- Phase 4 **只做前端 UI 和 store 层适配**。后端 Rust/Sidecar 不新增能力（已有全部所需事件和 API）。
- Phase 4 做 i18n（现有 app 使用 i18next，所有 Agent UI 标签必须支持）。
- Phase 4 不做移动端适配（Tauri 桌面应用，当前无移动端目标）。
- Phase 4 不做 sandbox 配置 UI（sandbox 参数已通过 `AgentTransportOptions` 透传，但配置面板放 Phase 5 或更后）。
- Phase 4 不重做 LLM Provider 设置 UI（已有 `llm-provider-section.tsx`，Agent 复用同一 provider 配置）。

## 当前代码与 GitNexus 结论

GitNexus 索引：348 文件, 8572 symbols, 15771 relationships, 300 flows。索引新鲜（HEAD `f69e6fb`）。

### 后端已就绪（Phase 1–3.7 产物）

| 文件 | 行数 | 职责 | Phase 4 是否直接使用 |
|---|---|---|---|
| `src/lib/agent/agent-transport.ts` | 372 | `streamAgent()` — 完整 SDK 调用，支持所有参数 | 是，核心调用入口 |
| `src/lib/agent/agent-types.ts` | 272 | 15+ 事件类型：tool event, permission request, wiki changed, summary, task event, subagent event, rewind, action required | 是，类型定义直接复用 |
| `src/lib/agent/agent-app-tools.ts` | 670 | App tool bridge — wiki 操作、ingest、lint、deep research、dedup 等 | 间接，agent 调用时自动触发 |
| `src/lib/agent/agent-autofill.ts` | 358 | Property autofill agent | 间接 |
| `src/lib/agent/agent-pipeline.ts` | 302 | Multi-agent pipeline（wiki-compiler/linter/fixer/synthesizer/qa） | Phase 4 暂不暴露 pipeline UI |
| `src/lib/agent/agent-qa-hook.ts` | 415 | QA 自动回答 hook | 继续使用，但不再是唯一 Agent 入口 |
| `src-tauri/sidecar/src/wiki-tools.ts` | 382–746 | `createLlmWikiTools` — 全部 MCP 工具注册 | 间接 |
| `src-tauri/sidecar/src/agent-hooks.ts` | — | PreToolUse/PostToolUse/Stop hooks | 间接 |
| `src-tauri/sidecar/src/agent-policy.ts` | — | 权限策略 | 间接 |
| `src-tauri/sidecar/src/permission-bridge.ts` | — | 权限桥接 | 间接 |

### 前端现状

| 文件 | 行数 | 现状 | Phase 4 需要变更 |
|---|---|---|---|
| `src/stores/chat-store.ts` | 237 | `mode: "chat" \| "ingest"`，无 agent 模式 | **扩展 mode + 新增 agent 状态** |
| `src/components/chat/chat-panel.tsx` | 595 | 仅 import `agent-qa-hook`，无 Agent UI | **重写为支持 Agent 模式** |
| `src/components/layout/content-area.tsx` | 28 | switch on `activeView`，default 为 ChatPanel | 不变（Agent UI 嵌在 ChatPanel 内） |
| `src/components/layout/icon-sidebar.tsx` | 154 | NAV_ITEMS: wiki/sources/search/graph/lint/review | 不变（Agent 不是独立 view，在 Chat 内切换） |
| `src/stores/wiki-store.ts` | — | `activeView: "wiki" \| "sources" \| ... \| "settings"` | 不变 |
| `src/components/ui/` | — | button, dialog, input, label, resizable, scroll-area, separator, tooltip | 新组件复用 |

### 后端已有的事件类型（前端需处理）

`AgentCallbacks` 定义了 16 个回调，Phase 4 需要全部接入 UI：

| 回调 | 数据来源 | UI 表现 |
|---|---|---|
| `onMessage` | SDKAssistantMessage | 追加到对话流（文本 + tool_use blocks） |
| `onToken` | string (streaming text) | 实时追加 streaming content |
| `onDone` | SDKResultMessage | 结束流，显示 cost/duration/turns |
| `onError` | Error | 错误提示 |
| `onWikiChanged` | path, operation, sha256 | 文件变更通知（toast/inline） |
| `onToolEvent` | phase, toolName, ok, durationMs, inputPreview | 工具调用 timeline 卡片 |
| `onAgentSummary` | changedPaths, toolCalls, failedToolCalls | 对话结束总结卡片 |
| `onActionRequired` | kind, paths, reason | lint 推荐提示 |
| `onTaskEvent` | taskId, toolName, progress | 任务进度条 |
| `onPermissionRequest` | requestId, toolName, inputPreview, title, description | **权限审批 Modal** |
| `onRewindFiles` | messageId | 文件回滚确认 |
| `onPromptSuggestion` | unknown | 快捷操作建议 |
| `onPartialMessage` | unknown | 部分消息预览 |
| `onHookEvent` | unknown | hook 事件日志 |
| `onSubagentEvent` | unknown | subagent 状态（Phase 4 简化展示） |
| `onAgentProgressSummary` | unknown | 进度摘要 |

## 关键设计决策

### 1. Agent 模式在 Chat 内切换，不新增独立 View

**理由**：
- Agent 对话和 LLM 对话共用对话历史、conversation 管理、消息列表
- 用户心智模型是「同个聊天，换个更强的后端」，不是「去另一个页面」
- `icon-sidebar` 的 NAV_ITEMS 已有 6 项，不增加视觉负担

**实现**：
- `chat-store.ts` 的 `mode` 从 `"chat" | "ingest"` 扩展为 `"chat" | "agent" | "ingest"`
- `ChatPanel` 顶部增加模式切换控件（与现有 ingest toggle 同级）
- Agent 模式下 `handleSend` 走 `streamAgent()` 而非 `streamChat()`

### 2. DisplayMessage 扩展而非新建 AgentMessage

**理由**：
- 对话历史需要混合显示普通 LLM 消息和 Agent 消息
- 用户切换模式后，之前的消息仍需正常渲染
- 避免维护两套消息类型

**设计**：扩展 `DisplayMessage`：

```typescript
interface DisplayMessage {
  // ... 现有字段不变
  mode?: "chat" | "agent"  // 标记消息来源模式
  agentSessionId?: string   // Agent session ID，用于 resume/fork
  toolCalls?: AgentToolCallRecord[]  // 工具调用记录
  costUsd?: number          // 本条消息成本
  inputTokens?: number
  outputTokens?: number
  durationMs?: number       // Agent 执行时长
  numTurns?: number         // Agent 轮次
}

interface AgentToolCallRecord {
  toolName: string
  toolUseId: string
  phase: "pre" | "post" | "failure"
  ok?: boolean
  durationMs?: number
  inputPreview?: Record<string, unknown>
  error?: string
}
```

### 3. 权限审批用 Modal，阻断式

**理由**：
- `onPermissionRequest` 返回 `AgentPermissionDecision`，Agent 等待决策后才继续
- 用户需要看到工具名、输入预览、被阻止路径等信息才能判断
- 非阻断（toast）会导致 Agent 超时或用户错过

**实现**：
- 新建 `src/components/chat/agent-permission-dialog.tsx`
- 使用现有 `dialog.tsx` UI primitive
- 展示：tool name, display name, description, input preview, blocked path
- 操作：Allow (temporary/permanent), Deny (temporary/permanent), Deny + Interrupt
- 超时策略：60 秒无操作自动 deny

### 4. 工具调用可视化用可折叠 Timeline

**理由**：
- Agent 单次对话可能触发 10–50 个工具调用，inline 展示会淹没文本
- 用户需要看到「Agent 正在做什么」但不需要看每个工具的完整输入

**实现**：
- 新建 `src/components/chat/agent-tool-timeline.tsx`
- 每个工具调用是一个 timeline 节点：icon + tool name + 状态 + 耗时
- 展开可看 inputPreview / output
- 进行中的工具调用显示 spinner
- 失败的工具调用显示红色 + error 信息
- 支持整体折叠/展开

### 5. 成本统计嵌在对话内，不独立面板

**理由**：
- 成本与单次 Agent 对话强绑定，放在对话流内最自然
- 独立面板需要额外的 view 切换，增加复杂度
- Phase 4 先做 inline 展示，Phase 5 可以扩展为统计面板

**实现**：
- Agent 消息末尾（`onDone` 后）显示小结卡片：cost, tokens, turns, duration
- Conversation sidebar 显示累计成本
- 不做图表/历史趋势（Phase 5+）

### 6. Session 管理通过 Conversation 元数据

**理由**：
- Claude Agent SDK 的 session resume/fork 需要 `sessionId` + `resumeSessionAt`
- 这些数据需要持久化到 conversation 级别，否则重启后丢失
- 与现有 conversation 管理（创建/删除/重命名）集成最自然

**实现**：
- `Conversation` 接口新增 `agentSessionId?: string`
- Agent 对话结束后 `onDone` 回调提取 `session_id` 存入 conversation
- 下次在同一 conversation 发送消息时，自动带上 `resume: agentSessionId`
- Conversation sidebar 右键菜单增加「Fork Session」选项

## 不纳入 Phase 4

- **Multi-Agent Pipeline UI** — `agent-pipeline.ts` 已就绪但 UI 入口放 Phase 5
- **Sandbox 配置 UI** — `AgentTransportOptions.sandbox` 参数已有，但配置面板放 Phase 5
- **Subagent 详细可视化** — `onSubagentEvent` 仅做简化展示（文字状态），详细 UI 放 Phase 5
- **Issue #3（Agent 内部 RPC 通道）** — roadmap 提到放 Phase 4+ 评估，当前架构（stdin/stdout JSON-lines）已够用，Phase 4 不引入新通信层
- **Issue #2（React key warnings）** — 独立 bug fix，不依赖 Phase 4，可在任意时间修
- **成本统计面板/图表** — Phase 4 只做 inline 展示，详细统计放 Phase 5
- **Agent 对话导出/分享** — 放 Phase 5+
- **Agent 对话搜索** — 放 Phase 5+

## PR 拆分计划

Phase 4 拆 6 个 PR。顺序固定，前后依赖。

### PR A：数据模型 + Store 扩展

范围：
- 扩展 `DisplayMessage`（新增 `mode`, `agentSessionId`, `toolCalls`, `costUsd`, `inputTokens`, `outputTokens`, `durationMs`, `numTurns` 字段）
- 扩展 `Conversation`（新增 `agentSessionId` 字段）
- 扩展 `chat-store.ts` 的 `mode` 类型为 `"chat" | "agent" | "ingest"`
- `chat-store.ts` 新增 agent 相关 actions：`setAgentToolCalls`, `updateAgentProgress`, `finalizeAgentStream`
- 更新 `persist.ts` 序列化/反序列化逻辑，兼容新字段
- 添加 i18n key 定义（`agent.*` namespace）
- 更新现有单元测试 + 新增 store 扩展测试

风险：LOW。纯数据层扩展，不改 UI。

验证：
- `pnpm test`
- `pnpm lint`
- `npm run typecheck`

### PR B：Agent 消息渲染组件

范围：
- 新建 `src/components/chat/agent-tool-timeline.tsx` — 工具调用 timeline 组件
  - 每个节点：tool icon + name + 状态 badge（pending/running/done/failed）+ 耗时
  - 展开/折叠 inputPreview 和 error
  - Spinner 动画 for running 状态
  - 整体折叠/展开控制
- 新建 `src/components/chat/agent-cost-card.tsx` — 成本/统计小结卡片
  - cost_usd, input_tokens, output_tokens, turns, duration
  - 使用现有 UI primitives（无新依赖）
- 修改 `ChatPanel` 消息渲染逻辑：
  - `mode === "agent"` 的消息支持渲染 tool_use/tool_result blocks
  - `toolCalls` 非空时渲染 `AgentToolTimeline`
  - Agent 消息结束后渲染 `AgentCostCard`
  - 普通 LLM 消息（`mode === "chat"` 或无 mode）保持原有渲染
- i18n：所有 Agent UI 标签使用 `t("agent.*")`

风险：LOW。新组件 + 条件渲染，不改现有逻辑。

验证：
- `pnpm test`
- `pnpm lint`
- UI 手动验证（`pnpm dev` 启动 Tauri app，本 PR 起需边调 UI 边测试）：
  - 普通 LLM 对话渲染不受影响（回归）
  - 构造 mock Agent 消息（含 tool_use + tool_result blocks），验证 timeline 卡片正确渲染：
    - 每个工具节点显示 tool name + 状态 badge + 耗时
    - spinner 状态正确显示
    - 展开/折叠 inputPreview 和 error 正常工作
    - 整体折叠/展开控制生效
  - AgentCostCard 在 Agent 消息结束后正确显示 cost/tokens/turns/duration
  - 窄窗口（800px）下 timeline 不溢出，自动折叠
  - i18n 切换（中/英文）后标签正确

### PR C：权限审批 Dialog

范围：
- 新建 `src/components/chat/agent-permission-dialog.tsx`
  - 使用 `dialog.tsx` UI primitive
  - 展示：tool displayName/name, description, input preview (JSON 格式化), blocked path
  - 操作按钮：Allow Temporary, Allow Permanent, Deny, Deny + Interrupt
  - 60 秒超时自动 deny
  - keyboard shortcuts: Enter=allow, Escape=deny
- `streamAgent` 的 `onPermissionRequest` 回调实现：
  - 弹出 Permission Dialog
  - 等待用户决策
  - 返回 `AgentPermissionDecision`
- `chat-store.ts` 新增 permission pending 状态管理
- i18n：permission 相关标签

风险：MEDIUM。阻断式交互，需要处理超时、并发请求、用户关闭窗口等边界情况。

验证：
- `pnpm test`
- `pnpm lint`
- UI 手动验证（`pnpm dev` 启动 Tauri app）：
  - 模拟 `onPermissionRequest` 回调，dialog 正确弹出并展示 tool name / description / input preview / blocked path
  - 点击 Allow Temporary / Allow Permanent / Deny / Deny+Interrupt 返回正确 decision
  - 60 秒无操作自动 deny
  - Enter 键触发 allow，Escape 键触发 deny
  - dialog 内 JSON input preview 格式化正确，长文本可滚动
  - 小窗口（800px）下 dialog 不溢出，按钮可点击

### PR D：Agent 模式切换 + streamAgent 集成

范围：
- `ChatPanel` 顶部增加模式切换控件：
  - 现有 `mode: "chat" | "ingest"` toggle 扩展为三态：Chat / Agent / Ingest
  - 使用 lucide-react 图标区分（Bot for agent, MessageSquare for chat, Upload for ingest）
  - Agent 模式下显示配置摘要（当前 model, permission policy）
- `ChatPanel` 的 `handleSend` 重写：
  - `mode === "chat"` → 现有 `streamChat()` 逻辑不变
  - `mode === "agent"` → `streamAgent()` + 全部 callbacks 接入
  - `mode === "ingest"` → 现有 ingest 逻辑不变
- Agent callbacks 接入：
  - `onToken` → `appendStreamToken`
  - `onMessage` → 解析 content blocks，更新 toolCalls 状态
  - `onDone` → `finalizeAgentStream`，提取 session_id, cost, usage
  - `onError` → 错误提示
  - `onWikiChanged` → toast 通知 + 刷新 wiki store
  - `onToolEvent` → 更新 timeline 状态
  - `onPermissionRequest` → PR C 的 dialog
  - `onAgentSummary` → 渲染总结卡片
  - `onActionRequired` → lint 推荐提示
- `AgentTransportOptions` 配置：
  - model: 复用 `wiki-store` 的 LLM provider 配置
  - apiKey/baseUrl: 从 wiki-store 读取
  - enableWikiTools: true
  - enableWriteTools: true (default, 用户可在设置里关闭)
  - permissionPolicy: "default" (default)
  - projectId/projectPath: 从 wiki-store 读取
  - apiServerBaseUrl/apiToken: 从 api-server 配置读取

风险：MEDIUM-HIGH。核心集成点，涉及 handleSend 重写和多回调协调。

验证：
- `pnpm test`
- `pnpm lint`
- UI 手动验证（`pnpm dev` 启动 Tauri app，连接真实 sidecar，本 PR 为端到端联调起点）：
  - **模式切换**：Chat / Agent / Ingest 三态切换正常，图标区分清晰，切换后配置摘要正确显示
  - **Chat 模式回归**：切换回 Chat 模式后 `streamChat()` 完全正常，消息渲染无异常
  - **Agent 基础流**：发送简单 prompt（如 "hello"），streaming 文本实时显示，结束后 cost card 出现
  - **工具调用流**：发送会触发工具的 prompt（如 "search wiki for X"），timeline 实时更新：
    - 工具调用中 → spinner + tool name
    - 工具完成 → 绿色 check + 耗时
    - 工具失败 → 红色 + error 展开可见
  - **权限 dialog**：Agent 调用需权限工具时 dialog 阻断式弹出，决策后 Agent 继续执行
  - **Wiki 变更**：Agent 创建/更新 wiki 页面后 toast 通知出现，文件树自动刷新
  - **多轮对话**：连续发送 3+ 条消息，timeline 和 cost card 正确累加
  - **取消操作**：Agent 执行中点击取消，sidecar 正确 kill，UI 恢复可输入状态

### PR E：Session 管理 + Wiki 变更处理

范围：
- Session resume：
  - Agent `onDone` 回调提取 `session_id` → 存入 `Conversation.agentSessionId`
  - 下次 `handleSend` 检测到 `agentSessionId` 存在 → 自动带 `resume: sessionId`
  - Conversation 切换时重置 agent 状态
- Session fork：
  - Conversation sidebar 右键菜单增加「Fork Session」
  - Fork = 新建 conversation + 复制 `agentSessionId` + 发送时带 `forkSession: true`
  - Fork 后新 conversation 获得独立 session
- Wiki 变更处理：
  - `onWikiChanged` → 调用 `useWikiStore.getState().refreshFileTree()`
  - 变更消息 inline 显示（"Agent 更新了 wiki/page.md"）
  - 变更后自动触发 dirty 标记 → Lint 入队
- File checkpoint/rewind：
  - `onRewindFiles` → 显示确认 dialog（"回滚到此消息前的文件状态？"）
  - 确认后调用 rewind API
- Session 持久化：
  - `persist.ts` 序列化 `agentSessionId`
  - App 重启后 session 可恢复

风险：MEDIUM。Session 管理涉及跨 conversation 状态和持久化。

验证：
- `pnpm test`
- `pnpm lint`
- UI 手动验证（`pnpm dev` 启动 Tauri app）：
  - **Session resume**：Agent 对话 → 关闭 app → 重新打开 → 同一 conversation 发消息 → Agent 自动带 `resume` 继续上文
  - **Session fork**：右键 conversation → Fork Session → 新 conversation 建立 → 两条对话独立，互不干扰
  - **Wiki 变更通知**：Agent 更新 wiki 后 inline 消息显示 "Agent 更新了 wiki/page.md"
  - **File rewind**：Agent 消息后点击 rewind → 确认 dialog 弹出 → 确认后文件回滚
  - **持久化**：conversation 列表刷新后 agentSessionId 不丢失

### PR F：收尾 + E2E 验证

范围：
- `agent-qa-hook.ts` 适配：现有 QA hook 在 Agent 模式下的行为（跳过 or 集成）
- Agent 模式下禁用 ingest 模式的冲突逻辑
- 错误处理完善：
  - sidecar 启动失败 → 显示「Agent 不可用」提示
  - API key 缺失 → 提示配置
  - 超时 → 显示重试按钮
- Loading states：
  - Agent 连接中 → spinner
  - Agent 执行中 → 可取消按钮
- 响应式布局：
  - Agent tool timeline 在窄窗口下正确折叠
  - Permission dialog 在小窗口下不溢出
- i18n 审查：所有 Agent 相关文本都有 i18n key
- E2E 验收清单执行（见下方验收标准）

风险：LOW。收尾集成，不新增核心功能。

验证：
- `pnpm test`
- `pnpm lint`
- UI 手动验证（完整 E2E 流程）：
  - **错误处理**：停止 sidecar → 发消息 → 显示「Agent 不可用」提示；删除 API key → 显示配置提示
  - **Loading 状态**：Agent 连接中 → spinner；执行中 → 可取消按钮；取消后 UI 恢复
  - **窄窗口**：800px 宽度下 timeline 折叠、permission dialog 不溢出、mode 切换控件不截断
  - **回归**：走一遍 Chat / Ingest 模式的完整流程，确认无影响
  - **i18n**：中英文切换后所有 Agent UI 文本正确翻译，无遗漏 key
- 完整 E2E 验收清单（验收标准节）

## 依赖关系

```
PR A (数据模型)
  ├──→ PR B (消息渲染)
  │      └──→ PR D (模式切换 + streamAgent) ←── PR C (权限 dialog) 可并行
  │               └──→ PR E (Session 管理)
  └──→ PR F (收尾) ← 依赖 PR D + E
```

PR B 和 PR C 可并行开发（无文件重叠）。PR D 依赖 B 和 C 都完成。

## 上游 Issues 与 Phase 4 的关系

| Issue | 描述 | 与 Phase 4 关系 | 建议 |
|-------|------|----------------|------|
| #3 | Agent 内部 RPC 通道 | Phase 4 不需要新通信层，stdin/stdout JSON-lines 已够用 | 放 Phase 5 评估 |
| #2 | React key warnings | 独立 bug fix，与 Phase 4 无耦合 | 随时可做 |
| #40 | Embedding extraHeaders UI | 零耦合，纯 UI 加法 | 随时可做 |
| #41 | Graph nodeScale/graphSpacing sliders | 零耦合 | 随时可做 |
| #42 | Lint persistence | 与 Phase 4 无直接重叠 | PR A 之后做更安全 |
| #43 | Source import + graph UX | 与 Phase 4 无直接重叠 | 随时可做 |
| #44 | AnyTXT chat integration | 改 `chat-panel.tsx`，Phase 4 也改此文件 | Phase 4 PR D 之后再做 #44 |

## 验收标准

Phase 4 完成时：

- [ ] Chat 面板顶部显示模式切换控件（Chat / Agent / Ingest）
- [ ] 切换到 Agent 模式后，发送消息走 `streamAgent()` 路径
- [ ] Agent 文本响应实时 streaming 显示
- [ ] 工具调用以 timeline 形式展示（tool name + 状态 + 耗时，可展开详情）
- [ ] 工具调用进行中显示 spinner，完成显示绿色，失败显示红色 + error
- [ ] 工具调用 timeline 可整体折叠/展开
- [ ] 需要权限的工具调用弹出 Modal，用户可 Allow/Deny
- [ ] 权限 Modal 60 秒超时自动 Deny
- [ ] Agent 对话结束后显示成本卡片（cost, tokens, turns, duration）
- [ ] Agent 写入 wiki 后文件树自动刷新
- [ ] Agent session ID 自动持久化到 conversation
- [ ] 重新打开 app 后 Agent session 可 resume
- [ ] Conversation sidebar 支持 Fork Session
- [ ] File checkpoint rewind 有确认 dialog
- [ ] 普通 Chat 模式完全不受影响（回归测试）
- [ ] 所有 Agent UI 文本有 i18n key
- [ ] `pnpm test` 全绿
- [ ] `pnpm lint` 无新增错误
- [ ] `npm run typecheck` 通过
- [ ] `npx gitnexus detect_changes` 确认仅涉及预期符号

## 数据流总览

```
[用户输入]
    ↓
ChatPanel.handleSend()
    ↓ mode === "agent"
streamAgent(prompt, options, callbacks)
    ↓ invoke("agent_spawn", {streamId, prompt, ...})
    ↓ stdin/stdout JSON-lines
[Rust → Node.js Sidecar → Claude Agent SDK → API]
    ↓
事件流回前端:
  onToken → streamingContent (实时文本)
  onToolEvent → toolCalls[] → AgentToolTimeline
  onPermissionRequest → AgentPermissionDialog → AgentPermissionDecision
  onWikiChanged → refreshFileTree + toast
  onDone → finalizeAgentStream → AgentCostCard + session persist
  onAgentSummary → 总结卡片
```

## 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Agent 长对话（50+ 工具调用）渲染性能 | MEDIUM | timeline 虚拟化 + 默认折叠已完成的工具 |
| 权限 dialog 超时与 Agent 超时竞态 | MEDIUM | dialog 超时 < Agent 超时，明确 deny 行为 |
| Session resume 失败（sidecar 崩溃/重启） | LOW-MEDIUM | 优雅降级：resume 失败自动转为新 session + 提示用户 |
| `handleSend` 重写引入 LLM 回归 | MEDIUM | PR D 只改 mode 分支，chat/ingest 逻辑不变；回归测试覆盖 |
| DisplayMessage 扩展导致 persist 兼容问题 | LOW | 新字段全部 optional，旧数据自动兼容 |
| Agent tool call 并发请求（多个 permission dialog） | LOW | queue 串行展示，一次只弹一个 dialog |
| i18n key 遗漏 | LOW | PR F 收尾时做完整审查 |

## GitNexus 使用要求

- PR A 前：`gitnexus impact({target: "DisplayMessage", direction: "upstream"})` 确认 DisplayMessage 的所有消费者
- PR A 前：`gitnexus impact({target: "useChatStore", direction: "upstream"})` 确认 chat-store 的所有消费者
- PR D 前：`gitnexus impact({target: "streamAgent", direction: "downstream"})` 确认 streamAgent 的调用链
- 每个 PR 提交前：`gitnexus detect_changes` 验证仅涉及预期符号
- 如果引入新耦合，先修复 import 再继续
