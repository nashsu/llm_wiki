# Phase 3.7: 代码结构重构 — Commands 模块拆分 + ingest.ts 拆分

> 类型：Phase 实施计划 | 创建：2026-05-30 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 3.6 计划](./agent-sidecar-phase3.6.md)

## 目标

Phase 3.7 的目标是：在 Phase 3.6 完成后、Phase 4 正式 UI 前，对两个高符号密度、低内聚度的核心模块进行结构拆分，降低后续开发的复杂度和冲突风险。

- **Commands 模块**（Rust）：423 符号、68% 内聚度、11154 行，拆为 3 个子模块。
- **ingest.ts**（TypeScript）：66 函数、2558 行，拆为 4 个文件。

边界：

- Phase 3.7 只做文件搬迁和 import 路径更新，不改任何业务逻辑。
- Phase 3.7 不新增功能、不改行为、不改 API 签名。
- 每个 PR 完成后 `pnpm test` + `pnpm lint` + `cargo test` 必须全绿。

## 为什么需要这个 Phase

### Commands 模块

当前 `src-tauri/src/commands/` 是 9 个平坦文件的扁平结构：

| 文件 | 行数 | 符号数 | 职责 |
|---|---|---|---|
| `file_sync.rs` | 1810 | 81 | 文件 watcher、快照、队列 |
| `fs.rs` | 2062 | 59 | 文件系统操作、关联页面 |
| `search.rs` | 1119 | 36 | keyword/vector/hybrid 搜索 |
| `vectorstore.rs` | 1018 | 35 | 向量存储 CRUD |
| `extract_images.rs` | 972 | 19 | 图片提取 |
| `agent.rs` | 610 | 9 | sidecar 管理 |
| `codex_cli.rs` | 327 | 8 | codex CLI transport |
| `claude_cli.rs` | 341 | — | claude CLI transport |
| `project.rs` | 328 | 6 | 项目管理 |

问题：

1. **file_sync.rs 是全局枢纽**。GitNexus 图谱显示 8 个文件都调用它（主要是 `new` 构造函数，12 个调用者），但这些调用者之间并无内聚关系。
2. **职责混杂**。文件操作、搜索、向量存储、Agent 管理平铺在同一层，68% 内聚度说明近 1/3 的符号跨域耦合。
3. **Phase 3.6 之后 agent.rs 增长**。Phase 3.6 的 5 个 PR 都修改了 `agent.rs`，它从 Phase 3.5 的 ~400 行增长到 610 行，后续 Phase 4 还会继续增长。

### ingest.ts

66 个函数挤在一个文件里。GitNexus 图谱确认了 5 个内聚域：

| 域 | 行范围 | 函数数 | 职责 |
|---|---|---|---|
| Prompt 构建 | 1361–1620 | 6 | `buildAnalysisPrompt`、`buildGenerationPrompt`、`buildReviewSuggestionPrompt` |
| 分块 + 长文 | 1623–1935 | 18 | `splitSourceIntoSemanticChunks`、`analyzeLongSourceInChunks`、checkpoint 管理 |
| 写入 + 页面 | 1137–1285 | 6 | `writeFileBlocks`、`buildPageMerger`、`backupExistingPage` |
| 编排入口 | 2282–2558 | 4 | `startIngest`、`executeIngestWrites`、`conversationHistory` |
| 配置 + 来源 | 79–530 | 10 | `autoIngest`、`captionSourceImages`、`isSafeIngestPath` |

问题：prompt 构建是纯函数、分块是独立算法、写入是磁盘操作，三者零交叉，却挤在同一文件。改一行 prompt 模板要翻 2000 行。

## 设计原则

### 1. 只搬迁，不改逻辑

所有拆分操作仅涉及：
- 文件切割（从大文件提取函数到新文件）
- `use` / `import` 路径更新
- `mod.rs` / `pub mod` 更新
- re-export 保持公共 API 不变

不涉及：函数签名变更、算法变更、新增函数、删除函数。

### 2. 保持公共 API 表面不变

`commands/mod.rs` 的 `pub mod` 声明更新后，对外 re-export 保持一致。外部调用方（`api_server.rs`、`clip_server.rs`、`proxy.rs`、`lib.rs`）的 import 路径尽可能不改——通过子模块 `mod.rs` 的 re-export 实现。

`ingest.ts` 拆分后，`ingest.ts` 作为入口文件 re-export 所有公共符号。外部调用方（`agent-app-tools.ts`、`chat-panel.tsx`、`deep-research.ts`、`lint-fixer.ts`、`ingest-queue.ts`）的 import 路径不变。

### 3. 每个 PR 独立可验证

每个 PR 完成后必须通过全部测试。不依赖后续 PR。

### 4. Phase 3.6 影响优先

Phase 3.6 已合并的代码（特别是 `commands/agent.rs`、`agent-transport.ts`、`agent-types.ts`）不做拆分候选。拆分只涉及 Phase 3.6 未触及的稳定模块。

## Commands 模块拆分设计

### 现状依赖关系（GitNexus 图谱）

```
fs.rs ──────27调用──→ file_sync.rs
extract_images.rs ──8──→ file_sync.rs
search.rs ──5──→ file_sync.rs
vectorstore.rs ──5──→ file_sync.rs
project.rs ──3──→ file_sync.rs
codex_cli.rs ──2──→ file_sync.rs
claude_cli.rs ──2──→ file_sync.rs
agent.rs ──1──→ file_sync.rs
extract_images.rs ──6──→ fs.rs
search.rs ──1──→ vectorstore.rs
```

外部调用：
- `api_server.rs` → file_sync(11)、search(5)
- `clip_server.rs` → file_sync(2)
- `proxy.rs` → file_sync(1)
- `lib.rs` → fs(1)

### 目标结构

```
src-tauri/src/commands/
├── mod.rs                  (re-export 子模块)
├── project.rs              (保持不变, 328行)
├── file_ops/
│   ├── mod.rs              (pub mod + re-export)
│   ├── file_sync.rs        (1810行, 不变)
│   ├── fs.rs               (2062行, 不变)
│   └── extract_images.rs   (972行, 不变)
├── search/
│   ├── mod.rs              (pub mod + re-export)
│   ├── search.rs           (1119行, 不变)
│   └── vectorstore.rs      (1018行, 不变)
└── agent_cli/
    ├── mod.rs              (pub mod + re-export)
    ├── agent.rs            (610行, 不变)
    ├── codex_cli.rs        (327行, 不变)
    └── claude_cli.rs       (341行, 不变)
```

### 子模块划分理由

**file_ops/** — 文件系统操作群

- fs.rs 重度依赖 file_sync.rs（27 次调用）
- extract_images.rs 依赖 file_sync.rs（8 次）+ fs.rs（6 次）
- 三者形成紧密内聚群，GitNexus 内聚度分析确认

**search/** — 搜索 + 向量存储

- search.rs 依赖 vectorstore.rs（1 次调用）
- 两者共享"检索"职责，与文件操作独立
- 都只轻度调用 file_sync（各 5 次），仅用于路径查找

**agent_cli/** — 外部进程管理

- agent.rs、codex_cli.rs、claude_cli.rs 都是"管理外部 CLI/SDK 进程"
- 都只轻度调用 file_sync（1-2 次）
- Phase 3.6 后 agent.rs 已 610 行，Phase 4 还会增长，独立模块更清晰

**project.rs** — 留在根目录

- 仅 328 行、6 符号，职责独立
- 不搬迁，避免不必要的变更

### mod.rs 更新方案

`commands/mod.rs` 从：

```rust
pub mod agent;
pub mod claude_cli;
pub mod codex_cli;
pub mod extract_images;
pub mod file_sync;
pub mod fs;
pub mod project;
pub mod search;
pub mod vectorstore;
```

改为：

```rust
pub mod agent_cli;
pub mod file_ops;
pub mod project;
pub mod search;

// 保持向后兼容的 re-export
pub use agent_cli::*;
pub use file_ops::*;
pub use search::*;
```

`agent_cli/mod.rs`:

```rust
pub mod agent;
pub mod claude_cli;
pub mod codex_cli;
```

`file_ops/mod.rs`:

```rust
pub mod extract_images;
pub mod file_sync;
pub mod fs;
```

`search/mod.rs`:

```rust
pub mod search;
pub mod vectorstore;
```

### 外部调用方影响

通过 `pub use *` re-export，以下文件**不需要改 import 路径**：

- `api_server.rs` — 调用 `crate::commands::file_sync::*`、`crate::commands::search::*`
- `clip_server.rs` — 调用 `crate::commands::file_sync::*`
- `proxy.rs` — 调用 `crate::commands::file_sync::*`
- `lib.rs` — 调用 `crate::commands::fs::*`

所有路径通过 `pub use` 自动解析，零外部变更。

## ingest.ts 拆分设计

### 现状依赖关系（GitNexus 图谱）

outgoing（ingest.ts 调用谁）：
- `path-utils.ts`（19 次）— 最频繁
- `commands/fs.ts`（18 次）— Tauri command bridge
- `source-identity.ts`（8 次）
- `llm-client.ts`（5 次）
- `extract-source-images.ts`（5 次）
- `context-budget.ts`（3 次）
- `image-caption-pipeline.ts`（3 次）

incoming（谁调用 ingest.ts）：
- `agent-app-tools.ts`（`startIngest`）
- `chat-panel.tsx`（`autoIngest`）
- `deep-research.ts`（`startIngest`）
- `lint-fixer.ts`（`writeFileBlocks`）
- `ingest-queue.ts`（`autoIngest`）
- `save-query-page.ts`（类型 import）

### 目标结构

```
src/lib/
├── ingest.ts               (入口编排, ~600行, re-export 全部公共符号)
├── ingest-prompts.ts       (prompt 构建, ~260行)
├── ingest-chunk.ts         (分块 + 长文分析, ~310行)
├── ingest-write.ts         (写入 + 页面管理, ~250行)
├── ingest-cache.test.ts    (已有, 不变)
├── ingest-parse.test.ts    (已有, 不变)
├── ingest.prompt.test.ts   (已有, 不变)
├── ...其余已有测试文件不变
```

### 各文件函数分配

**ingest-prompts.ts** (~260行) — 纯函数，零副作用

```
导出:
  buildAnalysisPrompt          (L1361–1407)
  buildGenerationPrompt        (L1412–1562)
  buildReviewSuggestionPrompt  (L1564–1621)

内部:
  parseReviewBlocks            (L1284–1347)
  countFileBlocks              (L1347–1348)
  shouldRunDedicatedReviewStage (L1351–1359)
```

依赖: `context-budget.ts`、`output-language.ts`（均为只读调用）

**ingest-chunk.ts** (~310行) — 分块算法 + 长文 LLM 分析

```
导出:
  splitSourceIntoSemanticChunks    (L1745–1785)
  analyzeLongSourceInChunks        (L1937–2073)
  computeIngestSourceBudget        (L1639–1649)
  computeIngestGenerationMaxTokens (L1651–1657)

内部:
  semanticBlocks                   (L1687–1693)
  currentHeadingPath               (L1693)
  flushParagraph                   (L1694–1729)
  overlapSuffix                    (L1730–1744)
  splitOversizedBlock              (L1663–1686)
  trimLongText                     (L1787–1791)
  flush                            (L1759–1764)
  hashTextHex                      (L1792–1803)
  longSourceCheckpointPath         (L1805–1812)
  isCompatibleLongSourceCheckpoint (L1813–1838)
  loadLongSourceCheckpoint         (L1839–1852)
  saveLongSourceCheckpoint         (L1853–1861)
  clearLongSourceCheckpoint        (L1862–1872)
  extractMarkedSection             (L1873–1878)
  buildChunkAnalysisSystemPrompt   (L1879–1912)
  buildChunkAnalysisUserPrompt     (L1913–1935)
```

依赖: `llm-client.ts`（streamChat）、`ingest-prompts.ts`（chunk prompt）、`ingest-cache.ts`

**ingest-write.ts** (~250行) — 磁盘写入操作

```
导出:
  writeFileBlocks       (L1157–1265)
  buildPageMerger       (L2073–2151)
  backupExistingPage    (L2151–2175)
  reembedSourceSummary  (L2257–2280)
  executeIngestWrites   (L2372–2395)

内部:
  backup               (L1265–1283)
  visit                (L1137–1156)
```

依赖: `commands/fs.ts`（Tauri bridge）、`embedding.ts`、`path-utils.ts`

**ingest.ts** (瘦身至 ~600行) — 入口编排

```
保留:
  startIngest                    (L2282–2371, 总入口)
  autoIngest / autoIngestImpl    (L340–530)
  captionSourceImages            (L371–412)
  活动跟踪: onProgress/onToken/onDone/onError/analysisActivity/generationActivity
  内容校验: canonicalizeSourcesField/deduped/migrateLegacySourceSummaryIfSafe
  source管理: matchingRawSourceIdentities
  配置: resolveCaptionConfig/isSafeIngestPath/isWindowsSafePathSegment
  类型: conversationHistory (L2396)
  工具: getStore/tryReadFile/clampNumber/parseFileBlocks

新增:
  re-export 所有从 ingest-prompts/chunk/write 导出的公共符号
```

依赖: `ingest-prompts.ts`、`ingest-chunk.ts`、`ingest-write.ts` + 原有依赖

### 依赖图（拆分后）

```
ingest.ts (入口编排)
  ├──→ ingest-prompts.ts     (纯函数, 零副作用)
  ├──→ ingest-chunk.ts       (分块 + 长文, 调 LLM)
  │      └──→ ingest-prompts.ts (chunk prompt builder)
  └──→ ingest-write.ts       (写磁盘)
         └──→ commands/fs.ts  (Tauri bridge)
```

单向依赖，无循环。

### 外部调用方影响

通过 `ingest.ts` re-export 全部公共符号，以下文件**不需要改 import 路径**：

- `agent-app-tools.ts` — `import { startIngest } from '../ingest'`
- `chat-panel.tsx` — `import { autoIngest } from '../ingest'`
- `deep-research.ts` — `import { startIngest } from '../ingest'`
- `ingest-queue.ts` — `import { autoIngest } from '../ingest'`
- `save-query-page.ts` — 类型 import

**唯一例外**：`lint-fixer.ts` 直接调用 `writeFileBlocks`。如果 re-export 覆盖则无需改；否则更新为 `import { writeFileBlocks } from './ingest-write'`（1 处变更）。

## PR 拆分计划

Phase 3.7 拆 4 个 PR。顺序固定，前后依赖。

### PR 1：ingest-prompts.ts 提取

范围：
- 从 `ingest.ts` 提取 6 个函数到 `ingest-prompts.ts`
- `ingest.ts` 添加 `import * from './ingest-prompts'` + re-export
- 移动相关测试用例到 `ingest-prompts.test.ts`（如有独立 prompt 测试）
- 验证 `ingest.prompt.test.ts` 仍然通过

风险：LOW。纯函数提取，零副作用。

验证：
- `pnpm test`
- `pnpm lint`
- `npm run typecheck`（如果可用）

### PR 2：ingest-chunk.ts + ingest-write.ts 提取

范围：
- 从 `ingest.ts` 提取 18 个分块函数到 `ingest-chunk.ts`
- 从 `ingest.ts` 提取 6 个写入函数到 `ingest-write.ts`
- `ingest.ts` 添加 import + re-export
- 更新 `lint-fixer.ts` 的 import 路径（如果 re-export 不覆盖）

风险：LOW-MEDIUM。函数数量多但都是搬迁，不改逻辑。

验证：
- `pnpm test`
- `pnpm lint`
- 重点验证 `ingest.prompt.test.ts`、`ingest.scenarios.test.ts`、`ingest.real-llm.test.ts`

### PR 3：Commands file_ops/ + search/ 子模块

范围：
- 创建 `commands/file_ops/mod.rs`，移入 `file_sync.rs` + `fs.rs` + `extract_images.rs`
- 创建 `commands/search/mod.rs`，移入 `search.rs` + `vectorstore.rs`
- 更新 `commands/mod.rs`（`pub mod file_ops` + `pub mod search` + re-export）
- 更新各子模块 `mod.rs` 内部 `use` 路径（文件间调用）

风险：MEDIUM。Rust 模块路径变更，需要仔细处理 `use crate::commands::*` 路径。

需更新的内部 `use` 路径（文件间调用）：
- `fs.rs` → `file_sync.rs` 的 27 处调用（同子模块，路径不变或改为 `super::file_sync`）
- `extract_images.rs` → `file_sync.rs`(8) + `fs.rs`(6)（同子模块）
- `search.rs` → `file_sync.rs`(5) + `vectorstore.rs`(1)（跨子模块需调整）
- `vectorstore.rs` → `file_sync.rs`(5)（跨子模块需调整）

外部调用方通过 `pub use` re-export，路径不变。

验证：
- `cargo check`
- `cargo test --manifest-path src-tauri/Cargo.toml`

### PR 4：Commands agent_cli/ 子模块

范围：
- 创建 `commands/agent_cli/mod.rs`，移入 `agent.rs` + `codex_cli.rs` + `claude_cli.rs`
- 更新 `commands/mod.rs`（`pub mod agent_cli` + re-export）
- 更新子模块内部 `use` 路径

风险：LOW。三个文件都是轻度依赖 file_sync（1-2 次调用），搬迁简单。

验证：
- `cargo check`
- `cargo test --manifest-path src-tauri/Cargo.toml commands::agent::tests`

## 验收标准

Phase 3.7 完成时：

- `src/lib/ingest.ts` 从 2558 行降至 ~600 行
- `src/lib/ingest-prompts.ts`、`ingest-chunk.ts`、`ingest-write.ts` 各自独立存在
- `src-tauri/src/commands/` 下新增 `file_ops/`、`search/`、`agent_cli/` 三个子目录
- 所有外部 import 路径不变（通过 re-export）
- `pnpm test` 全绿
- `pnpm lint` 无新增错误
- `cargo check` 通过
- `cargo test` 全绿
- `npm run typecheck` 通过（如果可用）
- `npx gitnexus detect_changes` 确认仅涉及预期符号
- 无业务逻辑变更、无函数签名变更、无行为变更

## 不纳入 Phase 3.7

- 新功能开发
- API 签名变更
- Phase 4 UI 工作
- Issue #3（Agent 内部 RPC 通道）— 这是未来架构探索，可能影响 `agent.rs` 职责边界，放 Phase 4+ 评估
- Issue #2（React key warnings）— 独立 bug fix，不依赖本 Phase
- `ingest.ts` 中配置/来源管理函数的进一步拆分 — 当前 600 行已合理，不值得再拆

## 上游同步 Issues 与 Phase 3.7 的顺序关系

PR #39 合并后遗留 5 个上游同步 issue（#40–#44）。以下是它们与 Phase 3.7 的耦合分析和推荐顺序。

### 可随时做（无耦合）

| Issue | 描述 | 与 Phase 3.7 关系 |
|-------|------|-------------------|
| #40 | Embedding extraHeaders UI | 零耦合，纯 UI 加法，改 `embedding-section.tsx` + draft 类型 |
| #41 | Graph nodeScale/graphSpacing sliders | 零耦合，纯 UI 加法，改 `graph-view.tsx` |

这两个可以在 Phase 3.7 期间穿插做，也可以之后做。

### Phase 3.7 之后做（有耦合，但可控）

| Issue | 描述 | 耦合点 | 说明 |
|-------|------|--------|------|
| #42 | Lint persistence | 无直接文件重叠 | 但引入新 store（`lint-store.ts`），如果 Phase 3.7 统一了 store 组织方式，之后按规范写更干净 |
| #43 | Source import + graph UX | `ingest.ts`（+75 行） | 改动在 `autoIngestImpl`（396–530 行），Phase 3.7 提取的是 1361–2280 行的函数，区域不重叠。但搬迁后行号变动大，先做完 Phase 3.7 再 cherry-pick 更安全 |
| #44 | AnyTXT chat integration | 无直接文件重叠 | 改 `chat-panel.tsx`（8 处冲突），与 Phase 3.7 无关，但冲突复杂度高，放后面集中处理 |

### 推荐顺序

```
Phase 3.7 PR 1-2 (ingest.ts 拆分)
  → #43 (source import + graph UX, 此时 ingest.ts 已稳定)
  → Phase 3.7 PR 3-4 (Rust 子模块)
  → #42 (lint persistence)
  → #44 (AnyTXT chat)
```

#40、#41 可在任意间隙插入。

### 唯一需注意的点

Cherry-pick #43 时，`ingest.ts` 的三路合并可能因 Phase 3.7 的行号变动而匹配失败。缓解：#43 的改动集中在 `autoIngestImpl` 区域（配置/来源管理函数），Phase 3.7 不搬迁该区域，冲突概率低。如果合并不顺利，手动 resolve 即可。

## 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Rust 模块路径变更导致编译失败 | MEDIUM | PR 3/4 各自独立可编译，逐文件验证 |
| ingest re-export 遗漏导致类型错误 | LOW | 完整运行 `pnpm test` + `typecheck` |
| Phase 3.6 未合并 PR 造成 rebase 冲突 | LOW | 本 Phase 在 3.6 全部合并后启动 |
| 测试覆盖不足导致隐式回归 | LOW | 9 个 ingest 测试文件 + Rust cargo test |
| 上游 issue #43 与 ingest.ts 拆分的行号偏移 | LOW | #43 改动在 autoIngestImpl 区域，Phase 3.7 不搬迁该区域；如果不顺利可手动 resolve |

## GitNexus 使用要求

开发 Phase 3.7 时遵守：

- 搬迁前对每个被移动的文件跑 `gitnexus impact` 确认影响面。
- 每个 PR 提交前跑 `gitnexus detect_changes` 验证仅涉及预期符号。
- 如果搬迁过程中发现隐藏的跨模块耦合（如未被图谱捕获的 `use` 路径），先修复 import 再继续。
