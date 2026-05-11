# Draft / 底稿 v1 设计实施计划

状态：RALPLAN 共识计划（非交互模式）
范围：只设计第一阶段 Draft / 底稿功能；不实现模板匹配、DOCX/PDF 导出、长文项目、diff guard。

## 1. RALPLAN-DR Summary

### Principles

1. Draft 必须是用户显式创建的正式工作资产，不从 Chat 自动生成。
2. Draft 属于项目本地状态，持久化在项目 `.llm-wiki` 内，但前端不暴露 JSON 文件夹。
3. Draft 创建时复制正文和 references，成为 durable snapshot，不依赖易失的 Chat 临时引用状态。
4. UI 必须贴合现有左侧功能栏、内容区、Zustand store、Tauri 文件读写模式。
5. v1 必须小而闭环：创建、列表、查看、编辑、删除、持久化、引用展示。

### Decision Drivers

1. 人类用户工作流：Chat 回答 → 设为底稿 → 左侧 Drafts 管理。
2. 数据安全：项目切换、自动保存、重新打开项目不能串数据或丢数据。
3. 清晰边界：Draft 不污染 Wiki/Search/Graph；保存到 Wiki 和导出是后续显式动作。

### Viable Options

| Option | Pros | Cons | Decision |
|---|---|---|---|
| 左侧 Drafts 入口 + `.llm-wiki/drafts.json` | 符合用户认可的演示；项目内持久化；不污染 wiki；改动可控 | 增加 store/hydration/autosave 面 | Chosen |
| Chat 右侧临时 Draft 面板 | UI 更轻 | 生命周期太像 Chat 附属物；弱化“底稿管理”心智 | Rejected |
| Draft 直接保存为 `wiki/` Markdown | 复用文件树和编辑器 | 未完成内容污染 Wiki/Search/Graph，违背工作中底稿语义 | Rejected for v1 |
| `.llm-wiki/drafts/*.json` 每稿一文件 | 后续版本/附件扩展更强 | v1 文件生命周期更复杂 | Deferred |

## 2. 架构结论（ADR）

### Decision

实现 Draft / 底稿 v1 为一个左侧功能栏中的一等入口 `Drafts`，数据保存在项目目录：

```text
{project}/.llm-wiki/drafts.json
```

前端展示为 Drafts 工作区，而不是展示 `.llm-wiki` 文件夹或 `drafts.json`。

### Drivers

- 用户需要把 Chat 中满意的回复固化为“可继续加工的正式底稿”。
- Draft 必须保留引用来源，服务未来模板、导出和审计。
- 普通 Chat 默认行为不能被模板、导出、任务系统污染。
- 实现应复用现有 app patterns，避免迁移 pkm-tool 结构。

### Alternatives considered

- Chat 附属面板：初期轻，但不利于长期管理多份底稿。
- Wiki Markdown 草稿：可见性强，但会污染 Wiki 语义。
- 每 Draft 单文件：更适合版本化后期，不适合 v1 最小闭环。

### Consequences

- 新增一个 project-scoped draft store 和持久化文件。
- 需要认真处理 project switch + debounced autosave。
- 为后续 version history/export/diff guard 留出清晰数据锚点。

## 3. 用户视角功能逻辑

### 3.1 创建底稿

1. 用户在 Chat 中收到一条 assistant 回复。
2. 回复 action row 显示：复制、保存到 Wiki、设为底稿、重新生成。
3. 用户点击“设为底稿”。
4. 系统复制该 message 的正文、references、会话来源、时间戳。
5. 系统提示“已设为底稿”。
6. 左侧 Drafts 入口出现数量提示或高亮。
7. 用户进入 Drafts 页面管理底稿。

### 3.2 管理底稿

Drafts 页面保持现有 UI 风格：左侧列表 + 主内容区。

列表显示：

- 标题
- 更新时间
- 引用数量
- 来源标签：来自 Chat

详情显示：

- 可编辑标题
- 可编辑 Markdown 正文
- 引用来源列表
- 来源会话/消息时间/内容 hash 等元信息
- 删除按钮

v1 不做导出按钮主流程；可以不展示未来按钮，避免伪完成。

## 4. 数据模型

新增 `src/stores/draft-store.ts`：

```ts
import type { MessageReference, DisplayMessage } from "@/stores/chat-store"

export interface DraftRecord {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
  status: "draft"
  references?: MessageReference[]
  source: {
    kind: "chat-message"
    conversationId: string
    messageId: string
    messageTimestamp: number
    contentHash: string
  }
}
```

注意：`messageId` 只能作为 advisory provenance，因为当前 Chat ID 由内存计数生成。真正更稳的来源锚点是 `conversationId + messageTimestamp + contentHash`。

持久化 envelope：

```json
{
  "version": 1,
  "drafts": []
}
```

加载策略：

- 文件不存在：返回空数组。
- JSON 损坏：返回空数组，不让 UI 崩溃；可 console warn。
- 未来版本：保守忽略未知字段。

## 5. 前端融合设计

### 5.1 左侧功能栏

修改 `src/components/layout/icon-sidebar.tsx`：

- 增加 Drafts 导航项。
- 使用与现有 nav item 相同的 Tooltip、active state、badge 视觉。
- 图标建议：`NotebookText` 或 `FilePenLine`（lucide-react 已在用）。

### 5.2 路由状态

修改 `src/stores/wiki-store.ts`：

- `activeView` union 增加 `"drafts"`。

修改 `src/components/layout/content-area.tsx`：

- 显式处理 `activeView === "drafts"`，渲染 `<DraftsView />`。
- 不要依赖 default fallback，避免错误回到 Chat。

### 5.3 Chat message action

修改 `src/components/chat/chat-message.tsx`：

- 仅 assistant message 显示“设为底稿”。
- 该按钮必须接收完整 `DisplayMessage`，不能只传 content。
- 创建 Draft 后可切换按钮状态为“已设为底稿”或保持可重复创建但给出明确反馈；v1 推荐防重复：同一 message 内容 hash 已存在时提示“已存在底稿”。

### 5.4 References 复用

当前 references panel 在 `chat-message.tsx` 内部。建议抽出：

```text
src/components/references/cited-references-panel.tsx
```

规则：

- Chat 仍可支持 `lastQueryPages` fallback。
- DraftsView 只使用 DraftRecord 内复制的 `references`。
- Draft 不依赖 transient `lastQueryPages`。

### 5.5 DraftsView

新增：

```text
src/components/drafts/drafts-view.tsx
```

可选拆分：

```text
src/components/drafts/draft-list.tsx
src/components/drafts/draft-editor.tsx
```

UI 风格：

- 用现有 border、muted、scroll area、button 风格。
- 不做复杂富文本，v1 用 textarea 或现有 markdown 预览/编辑风格即可。
- 空态文案：提示“从 Chat 回复点击设为底稿”。

## 6. 后端 / 文件逻辑

无需新增 Rust command。复用 `src/commands/fs.ts`：

- `readFile`
- `writeFile`
- `createDirectory`

持久化建议放在新文件而不是继续膨胀 `persist.ts`：

```text
src/lib/draft-persist.ts
```

导出：

```ts
loadDrafts(projectPath: string): Promise<DraftRecord[]>
saveDrafts(projectPath: string, drafts: DraftRecord[]): Promise<void>
```

内部确保：

```text
{project}/.llm-wiki
```

存在。

## 7. 生命周期与自动保存

这是 Critic 认为最高风险的部分。

### 7.1 Project open

修改 `src/App.tsx`：

- 打开项目后加载 drafts。
- 使用 silent hydration，避免刚 load 触发 autosave 覆盖磁盘。

### 7.2 Project reset / switch

修改 `src/lib/reset-project-state.ts`：

- 清空 draft store。
- 清空时必须 silent，避免把空 draft 写入旧项目或新项目。

### 7.3 Autosave

修改 `src/lib/auto-save.ts`：

- Draft 创建和删除：立即 flush。
- Draft 内容/标题编辑：debounced save。
- 计时器创建时捕获 project path。
- 计时器触发时再次读取当前 project path；不一致则 abort。
- reset/switch 时清理 pending draft timer。

建议 store 支持：

```ts
isHydrating: boolean
setDrafts(drafts, { silent: true })
clearDrafts({ silent: true })
```

## 8. 实施步骤

1. 新增 Draft 类型和 Zustand store：`src/stores/draft-store.ts`。
2. 新增持久化 helper：`src/lib/draft-persist.ts`。
3. 接入 App 打开项目加载与 reset 清理：`src/App.tsx`、`src/lib/reset-project-state.ts`。
4. 接入 autosave：`src/lib/auto-save.ts`。
5. 扩展 activeView 和左侧导航：`src/stores/wiki-store.ts`、`src/components/layout/icon-sidebar.tsx`。
6. 扩展内容区路由：`src/components/layout/content-area.tsx`。
7. 抽出 references 组件，并更新 Chat 使用：`src/components/chat/chat-message.tsx` + `src/components/references/...`。
8. 添加 Chat “设为底稿”按钮，创建 Draft 时复制完整 message 数据。
9. 新增 Drafts UI：`src/components/drafts/drafts-view.tsx`。
10. 更新 i18n：`src/i18n/en.json`、`src/i18n/zh.json`。
11. 添加测试：store、persist、autosave race、i18n parity、build。

## 9. Acceptance Criteria

1. Assistant message 显示“设为底稿”，user message 不显示。
2. 点击后创建 Draft，正文与原 message 一致。
3. Draft references 与原 assistant message references 一致。
4. Draft 保存在 `{project}/.llm-wiki/drafts.json`。
5. 重启/重新打开项目后 Draft 仍存在。
6. 切换项目不会显示上一项目 Draft。
7. pending autosave 不会写入错误项目。
8. 删除 Draft 后立即从 UI 消失，并在重新打开后仍删除。
9. 普通 Chat 的发送、streaming、Copy、Save to Wiki、Regenerate、references panel 行为不变。
10. 中英文 i18n key 保持 parity。

## 10. Verification Plan

建议命令：

```powershell
npm run test -- src/i18n/i18n-parity.test.ts
npm run test -- src/stores/draft-store.test.ts src/lib/draft-persist.test.ts
npm run build
```

实际执行时按 repo test 命名调整。

必须覆盖：

- `createDraftFromMessage` 复制 content/references/source。
- missing/corrupt drafts file fallback。
- versioned persistence roundtrip。
- silent hydration/reset 不触发保存。
- project path guarded debounce。
- create/delete immediate flush。
- Drafts activeView route。

手工 smoke：

1. 打开项目 A。
2. Chat 生成带 references 的回复。
3. 设为底稿。
4. 打开 Drafts，看见正文和 references。
5. 修改标题/正文，等待自动保存。
6. 重启或重新打开 A，确认仍存在。
7. 切换项目 B，确认 A 的 Draft 不出现。
8. 切回 A，确认 Draft 仍在。
9. 删除 Draft，重启确认删除持久化。

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| 自动保存串项目 | timer 捕获 path，触发时比对当前 path |
| hydration 覆盖磁盘 | silent setDrafts / suppressPersistence |
| messageId 不稳定 | messageId 仅 advisory，增加 contentHash/timestamp |
| references 逻辑重复 | 抽共享组件，Draft 不用 lastQueryPages |
| v1 范围膨胀 | 不做模板、导出、长文、diff guard |
| Draft 与 Wiki 概念混淆 | `.llm-wiki` 存储；UI 叫 Drafts，不进文件树 |

## 12. Available Agent Types Roster

- `executor`：实现 store/persistence/UI wiring。
- `test-automator`：补单元和集成测试。
- `reviewer`：检查回归、项目切换安全、UI 一致性。
- `verifier`：最终验证验收标准与测试证据。
- `designer`：如后续需要更精细 UI，可审 Drafts 页面布局。

## 13. Follow-up Staffing Guidance

### `$ralph` 路径

适合单主线推进。建议顺序：

1. executor 实现 store + persist + lifecycle。
2. executor 实现 sidebar/content/chat action/DraftsView。
3. test-automator 加测试。
4. verifier 跑 build/test/smoke。

### `$team` 路径

适合并行：

- Lane A executor：`draft-store.ts`、`draft-persist.ts`、lifecycle/autosave。
- Lane B executor：sidebar/content/chat action/DraftsView。
- Lane C test-automator：store/persist/autosave/i18n tests。
- Lane D reviewer/verifier：最终 review。

Launch hint：

```text
$team implement .omx/plans/draft-feature-ui-integration-plan.md
```

Team verification path：

- team 先证明 unit/integration/build 通过；
- Ralph 或 verifier 再做项目切换与 UI smoke 验证。

## 14. Goal-Mode Follow-up Suggestions

- `$ultragoal`：如果希望把 Draft v1 作为 durable goal 分阶段完成。
- `$performance-goal`：不适用；本任务不是性能优化。
- `$autoresearch-goal`：不适用；本任务不是研究交付。

## 15. Applied Architect/Critic Hardening

- 明确 `messageId` 不可作为 durable identity。
- 明确 DraftsView 不依赖 `lastQueryPages`。
- 明确 project-switch debounced save 是最高风险。
- 明确 create/delete 需要立即 flush，edit 才 debounce。
- 明确不把 Draft 暴露为文件树文件夹。
