# Phase 1: Agent Sidecar 骨架 + 端到端通信

> 类型：Phase 实施计划 | 创建：2026-05-27 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)

## 目标

搭建 Agent Sidecar 的最小可运行骨架，验证从 React 前端到 LLM API 的完整通信链路。

## 验证标准

Phase 1 完成后能做什么：

| 标准 | 状态 | 结果 |
|------|------|------|
| Chat 面板点 "Test Agent" → React 调用 `streamAgent()` | ✅ 已完成 | dev app 手动验证通过 |
| Rust spawn sidecar → Node.js 进程启动 | ✅ 已完成 | `agent_spawn` 可启动 sidecar |
| Sidecar 调用 `query()` → Claude Code binary 发 API 请求 | ✅ 已完成 | sidecar 手动测试 + dev app 验证通过 |
| 流式返回 → SDKMessage 逐行经 stdout → Rust emit → React listen → 渲染到 chat | ✅ 已完成 | chat 可收到并渲染 Agent 回复 |
| 完成 → 显示 cost + turns 统计 | 🟡 部分完成 | SDK result 可收到；正式 UI 展示留到后续阶段 |
| 取消 → AbortController → agent_kill → 子进程终止 | ✅ 已完成 | transport + Rust 命令 + sidecar abort cleanup 已覆盖 |

## 文件清单

### 新建文件

```
src-tauri/sidecar/
├── package.json                 # @anthropic-ai/claude-agent-sdk + zod
├── package-lock.json            # sidecar 依赖锁定
├── tsconfig.json                # TypeScript 配置
├── src/
│   ├── main.ts                  # 入口：stdin 读取请求 → query() → stdout 输出
│   ├── core.ts                  # 可测试核心逻辑：请求处理 / nullish 过滤 / abort cleanup
│   ├── core.node.ts             # Node test runner 覆盖 sidecar 协议
│   └── types.ts                 # AgentRequest / AgentMessage 类型

src-tauri/src/commands/agent.rs  # agent_spawn / agent_kill / agent_detect

src/lib/agent/
├── agent-transport.ts           # streamAgent() — invoke + listen 通信层
└── agent-types.ts               # SDKMessage 类型定义（前端用）
```

### 修改文件

| 文件 | 改动 | 状态 |
|------|------|------|
| `src-tauri/src/lib.rs` | 注册 AgentState + agent commands | ✅ 已完成 |
| `src-tauri/src/commands/mod.rs` | 添加 `mod agent` | ✅ 已完成 |
| `src/components/chat/chat-panel.tsx` | 临时 Test Agent 按钮 | ✅ 已完成 |

## 通信协议

### 请求格式（stdin → sidecar）

```typescript
interface AgentRequest {
  type: "query"
  streamId: string
  prompt: string
  options: {
    systemPrompt?: string
    cwd?: string
    model?: string
    maxTurns?: number
    maxBudgetUsd?: number
    apiKey?: string
    baseUrl?: string
    persistSession?: boolean
  }
}
```

### 响应格式（sidecar → stdout）

```typescript
interface AgentMessage {
  streamId: string
  type: "system" | "assistant" | "user" | "result" | "error"
  data: SDKMessage
}
```

## 实施进度

| 步骤 | 内容 | 状态 | 备注 |
|------|------|------|------|
| 1 | 创建 sidecar 项目 + 安装依赖 | ✅ | `sidecar/package.json`, `sidecar/tsconfig.json` |
| 2 | 实现 sidecar main.ts | ✅ | stdin → query() → stdout，手动测试通过 |
| 3 | 实现 Rust agent commands | ✅ | `commands/agent.rs`，struct-based 参数 |
| 4 | 注册到 lib.rs | ✅ | AgentState + agent commands |
| 5 | 实现 TypeScript transport | ✅ | `agent-transport.ts` + `agent-types.ts` |
| 6 | Chat 面板 Test Agent 按钮 | ✅ | 临时验证按钮 |
| 7 | 端到端测试 + debug | ✅ | `null.toString` 已修复；dev app 端到端验证通过；补 sidecar/Rust 单测 |

## 问题处理记录

### 已修复：invoke("agent_spawn") 导致 null.toString() 错误

**现象**：点击 "Test Agent" 按钮后，UI 显示：
```
Agent error: Cannot read properties of null (reading 'toString')
```
堆栈追踪到 `agent-transport.ts` → `finishWith` → Tauri IPC 层 (`user-script`)。

**根因**：
- Rust `Option::None` 被序列化为 JSON `null`
- sidecar 把 `null` 透传给 Agent SDK `query()`
- SDK 内部对可选字段调用 `.toString()`，触发崩溃

**修复**：
- `AgentRequestOptions` 的可选字段添加 `#[serde(skip_serializing_if = "Option::is_none")]`
- sidecar 增加 `omitNullish()`，调用 SDK 前过滤 `null` / `undefined`
- ready signal 从 stdout 改到 stderr，避免污染 JSON-lines
- 补 sidecar 协议测试和 Rust 序列化测试

**已确认正常的部分**：
- LiteLLM proxy 在 localhost:4000 正常运行
- Sidecar 文件存在于正确路径 (`src-tauri/sidecar/src/main.ts`)
- Node.js v25.9.0 可用，`--experimental-strip-types` 正常
- Sidecar 手动测试通过（直接 `echo ... | node --experimental-strip-types sidecar/src/main.ts`）
- Rust 二进制是最新的（编译于代码修改后）
- dev app 点击 "Test Agent" 端到端通过

### 其他已修复 BUG

- `finalizeStream()` 无参调用导致 null.toString() 崩溃 → 改为 `finalizeStream("")`
- sidecar ready log 写 stdout 污染协议输出 → 改为 stderr
- sidecar abort/error cleanup 缺测试 → 增加 `core.node.ts`
- Rust option 序列化缺测试 → 增加 `agent.rs` 单测

## 估时

| 步骤 | 原估 | 实际 |
|------|------|------|
| Step 1-6 | 8h | ~8h |
| Step 7 (测试+debug) | 1.5h | ~2.5h |
| **总计** | **~9.5h** | **~10.5h** |

## 验证记录

- `npm --prefix src-tauri/sidecar exec tsc -- --noEmit` ✅
- `npm --prefix src-tauri/sidecar test` ✅
- `cargo test --manifest-path src-tauri/Cargo.toml commands::agent::tests -- --nocapture` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `npm run test:mocks` ✅
- dev app 手动点击 "Test Agent" ✅
- `npm run typecheck` ⚠️ 被既有无关错误阻塞：`src/lib/lint-fixer.ts:331 'detail' is declared but its value is never read`

## Sidecar 打包（开发模式）

Phase 1 用 `node --experimental-strip-types src/main.ts` 直接运行。

Rust 端查找策略：
```rust
fn find_sidecar_command() -> Result<Vec<String>, String> {
    // Dev mode
    Ok(vec!["node", "--experimental-strip-types", "${cwd}/sidecar/src/main.ts"])
}
```

Phase 5 再用 `bun build --compile` 打成单文件。
