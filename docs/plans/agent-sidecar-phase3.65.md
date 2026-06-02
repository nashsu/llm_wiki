# Phase 3.65: Agent 产品化能力补齐

> 类型：Phase 实施计划 | 创建：2026-05-31 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 3.6 计划](./agent-sidecar-phase3.6.md)

## 目标

Phase 3.6 完成了 Claude Agent SDK 原生能力的透传。但对比 Notion Custom AI 上的公开 LLM Wiki Skill，llm_wiki Agent 在产品化层面还有 5 个 gap：

1. Ingest 缺乏 dedup/安全校验
2. Lint 没有 Agent 驱动的修复闭环
3. 缺乏事件触发系统
4. 缺乏 Property Autofill Agent
5. 缺乏多 Agent 编排链

Phase 3.65 补齐这些 gap。

边界：

- Phase 3.65 做后端能力，不做 UI
- 每个 PR 保证现有测试通过、类型检查干净
- Phase 3.7 代码重构可与此 Phase 并行

## 依赖关系

```
Phase 3.6 (已完成)
    │
    ├─→ PR 3.65-A: ingest dedup ─────┐
    │   (独立，仅改 ingest.ts)          │
    │                                  │
    ├─→ PR 3.65-B: lint 闭环 ←────────┘
    │   (依赖现有 lint/ 模块)
    │
    ├─→ PR 3.65-C: file-watch trigger ←── PR 3.65-B
    │   (依赖 file_sync watcher)      │   (lint report 生成后 trigger fixer)
    │       │
    │       ├─→ PR 3.65-D: autofill agent
    │       │   (ingest 后回调 trigger status/tag 补填)
    │       │
    │       └─→ PR 3.65-E: 多 Agent 编排链
    │           (依赖 trigger + subagents)
    │
    └─→ Phase 3.7 (代码重构，与功能 PR 并行无依赖)

          Phase 4 (Agent UI)
              └─→ 消费 trigger 按钮 + lint report 面板
```

### 执行顺序

```
A ──→ B ──→ C ──→ D ──→ E
```

---

## PR 3.65-A：Ingest dedup 强化

对应 gap #5。在所有创建操作前加三层校验：

1. **Summary source URL 查重**：创建 summary 前按 source URL 查已存在的 summary，匹配则跳过
2. **Concept 归一化去重**：创建 concept/entity 前做 exact match + fuzzy match，匹配则追加引用到已有页面
3. **低质量页面跳过**：导航页、目录页、标题为通用占位符的页面自动跳过

改动范围：仅 `src/lib/ingest.ts`（可能涉及 `ingest-cache.ts` 和 `dedup.ts`）。

风险：LOW。

---

## PR 3.65-B：Lint 闭环

对应 gap #4。将现有 `src/lib/lint/` 从纯函数调用升级为 Agent 驱动的修复闭环：

1. Lint agent run → 生成结构化报告（已有基础）
2. Report 中区分 auto-fix 项 vs human 项
3. Fixer agent 自动消费 report 中的 auto-fix 项
4. Fix 完成后追加修复日志到 report

改动范围：`src/lib/lint/`、新增 `src/lib/agent/agent-lint-fixer.ts`。

风险：MEDIUM — 涉及自动修改 wiki 文件。

---

## PR 3.65-C：File-watch → Agent 自动触发

对应 gap #1（触发系统 1/2）。利用现有 `file_sync.rs` 的 watcher 架构：

1. 源文件变更事件 → 检查是否需要 re-ingest
2. Lint report 生成事件 → 自动 trigger fixer agent
3. 事件优先级队列，防止并发冲突

改动范围：`src-tauri/src/commands/file_sync.rs`、新增 trigger bridge。

风险：MEDIUM — 涉及 Rust 侧事件总线。

---

## PR 3.65-D：Property Autofill Agent

对应 gap #3。挂载到 ingest 完成回调链：

1. **Status autofill**：concept/entity Draft 满 7 天 + 内容完整 → Under Review；被 ≥2 summary 引用 → Reviewed
2. **Tag autofill**：空 Tags 的 concept/entity → 读内容自动赋 1-3 标签

改动范围：新增 `src/lib/agent/agent-autofill.ts` + ingest 回调注入。

风险：LOW — 纯读+写属性，不涉及内容修改。

---

## PR 3.65-E：多 Agent 编排链

对应 gap #2。利用 PR E 已透传的 subagents 能力：

1. 定义内置 subagent 定义：`wiki-compiler` / `wiki-linter` / `wiki-fixer` / `wiki-synthesizer` / `wiki-qa`
2. Pipeline schema：定义 Agent 间的串/并行关系 + 数据流转
3. Pipeline executor：按 schema 编排执行

改动范围：新增 `src/lib/agent/agent-pipeline.ts`、`src/lib/agent/agent-pipeline.test.ts`。

风险：MEDIUM — 新模块，但纯 TypeScript，不涉及 Rust。

---

## 验收标准

Phase 3.65 完成时：

- Ingest 创建前有 dedup + 低质量跳过
- Lint → Fixer 自动修复闭环运行
- 文件变更能自动触发 re-ingest 和 lint
- concept/entity 创建时自动获得 Status 和 Tags
- 5 个内置 Agent 可通过 pipeline schema 编排执行
- `npm run typecheck` 通过
- `npm run test:mocks` 通过
- `cargo test` 通过
- `npx gitnexus detect_changes` 影响面符合预期

## 不纳入 Phase 3.65

- Recurrence scheduler（`cron` 式定时触发，依赖 C 的 trigger 框架完成后单独做，或并入 Phase 4）
- Agent UI 按钮/面板
- 正式多 Agent 权限隔离
- Sidecar 单文件打包

## 与其他 Phase 的关系

- **Phase 3.7**：可与 3.65 并行，互不阻塞
- **Phase 4**：消费 3.65 的 trigger/lint/编排能力，加上 UI
