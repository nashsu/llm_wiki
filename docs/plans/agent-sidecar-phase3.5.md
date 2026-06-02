# Phase 3.5: Agent Tool Parity — 补齐普通 LLM 已有能力

> 类型：Phase 实施计划 | 创建：2026-05-28 | 状态：已完成
> 上级：[Agent Sidecar 总规划](./agent-sidecar-roadmap.md)
> 前置：[Phase 3 计划](./agent-sidecar-phase3.md)

## 目标

Phase 3.5 的目标是：在 Phase 4 正式 UI 前，先把 LLM Wiki 现有普通 LLM 能做的功能模块补给 Agent。

原则很简单：

- 普通 LLM 已有的 LLM Wiki 业务能力，Agent 必须也能调用。
- Agent 不是绕过现有业务链路直接乱写文件，而是复用 LLM Wiki 已有的 ingest、lint、fixer、deep research、dedup、多模态等模块。
- UI 先不做。Phase 3.5 只补工具、后端通道、事件和测试，为 Phase 4 UI 提供稳定能力面。
- 多模态不是附属功能。Agent 必须能触发图片提取、caption、cache、source summary 注入、re-embed 这条现有链路。

## 完成记录

Phase 3.5 已按拆分计划完成并合并：

| PR | 内容 | 状态 |
|----|------|------|
| #6 | 公共业务服务层抽取 | 已合并 |
| #7 | Agent tool bridge + 基础 parity 工具 | 已合并 |
| #8 | `ingest_source` + 多模态 parity | 已合并 |
| #9 | Deep Research parity | 已合并 |
| #10 | Dedup / review / 辅助工具收尾 | 已合并 |
| #11 | Agent tool schema cleanup | 已合并 |

Phase 3.5 之后追加 [Phase 3.6](./agent-sidecar-phase3.6.md)，专门补齐 Claude Agent SDK 原生能力。Phase 4 继续保持 UI 层定位。

## 当前结论

当前 Agent 已有基础工具：

```text
list_projects
list_pages
read_page
search_pages
get_graph
update_page
create_entity
create_concept
```

这些覆盖了“读、搜、看图谱、简单写”。但普通 LLM 现在还通过 `streamChat()` 驱动了更多业务模块：

- 普通 Chat RAG 问答
- ingest / autoIngest
- executeIngestWrites
- semantic lint
- lint fixer
- deep research
- wikilink enrichment
- duplicate detection / merge
- vision caption / image caption pipeline
- optimize research topic
- review sweep
- provider connection test

所以当前 Agent 能力还不等价。Phase 3.5 要补的是业务工具层，而不是 UI。

## GitNexus 调研记录

GitNexus repo：`llm_wiki`

当前索引：

```text
HEAD: b4b1330
symbols: 7584
processes: 300
status: up-to-date
```

使用过的 GitNexus 查询：

```text
context(streamChat)
query("normal LLM modules streamChat autoIngest executeIngestWrites runSemanticLint fixLintResult deep research dedup enrich wikilinks caption images")
query("Agent sidecar wiki tools createLlmWikiTools createRequestHandler streamAgent permission hooks")
```

`streamChat` 的主要上游调用：

| 模块 | 入口符号 | 文件 |
|------|----------|------|
| Chat RAG | `handleSend` | `src/components/chat/chat-panel.tsx` |
| ingest | `autoIngestImpl`, `startIngest`, `executeIngestWrites`, `buildPageMerger` | `src/lib/ingest.ts` |
| Lint | `runSemanticLint` | `src/lib/lint.ts` |
| Fixer | `fixBrokenLink`, `fixNoOutlinks`, `applyLlmFix` | `src/lib/lint-fixer.ts` |
| Deep Research | `rewriteAnyTxtQueries`, `executeResearch` | `src/lib/deep-research.ts` |
| Wikilinks | `enrichWithWikilinks` | `src/lib/enrich-wikilinks.ts` |
| Dedup | `buildDedupLlmCall`, `executeMerge` | `src/lib/dedup-runner.ts` |
| Vision | `captionImage` | `src/lib/vision-caption.ts` |
| Review sweep | `judgeBatch` | `src/lib/sweep-reviews.ts` |
| Connection test | `testLlmConnection`, `testLlmFunction` | `src/lib/connection-tests.ts` |

当前 Agent 数据流：

```text
handleTestAgent()
  -> streamAgent()
  -> invoke("agent_spawn")
  -> agent_spawn()
  -> sidecar createRequestHandler()
  -> Claude Agent SDK query()
  -> createLlmWikiMcpServer()
  -> createLlmWikiTools()
  -> local API / controlled fs write
```

当前 Agent 工具面集中在：

```text
src-tauri/sidecar/src/wiki-tools.ts
src-tauri/sidecar/src/wiki-api.ts
src-tauri/sidecar/src/agent-policy.ts
src-tauri/sidecar/src/agent-hooks.ts
src-tauri/sidecar/src/core.ts
```

关键差距：普通 LLM 的高级业务模块多数在 WebView TypeScript 层，Agent sidecar 目前只能通过本地 Rust API 获取很窄的一组能力。Phase 3.5 要么把这些业务能力迁到可调用服务层，要么在 WebView 和 sidecar 之间增加受控 tool bridge。不能让 Agent 直接复刻一份散落逻辑。

## 设计决策

### 1. 优先复用现有业务模块，不重写算法

例如：

- `ingest_source` 应调用现有 `autoIngest` 逻辑，而不是让 Agent 自己 read/write 一堆页面。
- `run_lint` 应调用 `runStructuralLint` / `runSemanticLint`。
- `fix_lint_result` 应调用 `fixLintResult`。
- `caption_source_images` 应复用现有 image caption pipeline。
- `save_query_page` 应复用普通 “Save to Wiki” 的 index/log/autoIngest 语义。

### 2. 建一个 Agent tool service 层作为单一入口

新增建议：

```text
src/lib/agent/agent-tool-service.ts
```

职责：

- 把普通 LLM 已有业务模块封装成稳定函数。
- 输入输出使用可序列化 JSON。
- 统一处理 projectPath、llmConfig、searchConfig、multimodalConfig。
- 统一发出文件变更、activity、dirty/lint recommended 事件。

不要把这些逻辑直接堆进 React component，也不要在 sidecar 里重新实现一份。

### 3. Sidecar 通过受控桥接调用业务工具

当前 sidecar 在 Node 进程里，不能直接 import WebView TS 模块。Phase 3.5 有两个可选实现路径：

#### 方案 A：扩展 Rust local API server

新增 API：

```text
POST /api/v1/projects/{projectId}/agent-tools/{toolName}
GET  /api/v1/projects/{projectId}/agent-tools/{taskId}
```

优点：

- sidecar 已经通过 local API 调 Wiki read/search/graph。
- 权限 token、projectId、HTTP 结构已有。
- 工具可异步化，适合 ingest/deep research/多模态长任务。

缺点：

- 现有很多业务逻辑在 WebView TS 层，不在 Rust 层。
- 直接迁移到 Rust 成本高，不适合作为第一步。

#### 方案 B：Tauri command + event bridge

新增 Tauri command：

```text
agent_tool_call(args)
agent_tool_status(taskId)
```

sidecar 不能直接 invoke Tauri command，所以需要 Rust agent bridge 在 sidecar 和 WebView command 之间转发。

优点：

- 可复用现有 WebView TS 业务逻辑。
- 迁移成本低。
- 更符合 Phase 3.5 “补齐模块，不重写系统”的目标。

缺点：

- sidecar -> Rust -> WebView -> Rust/FS 的链路更复杂。
- 要设计超时、取消、事件转发。

#### 推荐

Phase 3.5 先用 **方案 B** 做能力补齐。后续如果某些模块需要后台化或稳定 API，再把它们迁到 Rust local API server。

## 工具清单

### P0：必须在 UI 前完成

#### `build_answer_context`

用途：让 Agent 能复用普通 Chat 的确定性 RAG 上下文构建。

普通 LLM 现有能力：

- greeting bypass
- 读取 `purpose.md` / `wiki/index.md`
- `searchWiki`
- graph expansion
- context budget 裁剪
- queryRefs
- 输出语言约束

建议输入：

```ts
{
  query: string;
  maxPages?: number;
  includeContent?: boolean;
}
```

建议输出：

```ts
{
  purpose?: string;
  indexExcerpt?: string;
  pages: Array<{ title: string; path: string; content?: string; priority: number }>;
  queryRefs: Array<{ title: string; path: string }>;
  outputLanguage: string;
}
```

实现建议：

- 从 `chat-panel.tsx` 中抽出纯函数到 `src/lib/wiki-answer-context.ts`。
- `handleSend` 和 Agent tool 同用一套函数。

GitNexus 影响关注：

- 修改前必须 impact：`handleSend`, `searchWiki`, `buildRetrievalGraph`, `computeContextBudget`。
- 风险预计：MEDIUM，因为 Chat 主链路会复用新抽取函数。

#### `save_query_page`

用途：让 Agent 保存问答/研究结果时，走普通 Save to Wiki 的完整业务规则。

普通 LLM 现有能力：

- 清理 hidden comments / thinking blocks
- 生成 `wiki/queries/*.md`
- 写 frontmatter
- 更新 `wiki/index.md`
- 写 `wiki/log.md`
- 刷新 tree / dataVersion
- 触发 `autoIngest`

建议输入：

```ts
{
  title?: string;
  content: string;
  tags?: string[];
  autoIngest?: boolean;
}
```

建议输出：

```ts
{
  path: string;
  indexUpdated: boolean;
  logUpdated: boolean;
  autoIngestTaskId?: string;
}
```

实现建议：

- 把 `chat-message.tsx` 的 `handleSave` 业务逻辑抽到 `src/lib/save-query-page.ts`。
- `chat-message.tsx`、`review-view.tsx`、Agent tool 共用。

GitNexus 影响关注：

- 修改前 impact：`handleSave`, `ReviewView`, `autoIngest`。
- 风险预计：MEDIUM，因为会动保存路径和 index/log 更新逻辑。

#### `ingest_source`

用途：让 Agent 对 raw source 执行完整 ingest，而不是手写 Wiki 页面。

普通 LLM 现有能力：

- cache check
- source identity
- source summary slug
- analysis/generation/review
- FILE block parse
- page merge
- source frontmatter canonicalize
- fallback source summary
- review items
- ingest cache
- 多模态图片流程

建议输入：

```ts
{
  sourcePath: string;
  folderContext?: string;
  force?: boolean;
}
```

建议输出：

```ts
{
  taskId: string;
  status: "queued" | "running" | "done" | "error";
  writtenPaths?: string[];
  warnings?: string[];
}
```

实现建议：

- 第一版可同步调用 `autoIngest()`，但工具输出必须支持 taskId。
- 如果 `autoIngest()` 时间长，Agent tool 先返回 taskId，后续用 `get_agent_task_status` 查询。
- 多模态必须包含在 `autoIngest()` 现有链路中，不另做简化版。

GitNexus 影响关注：

- 修改前 impact：`autoIngest`, `autoIngestImpl`, `processNext`, `extractAndSaveSourceImages`, `captionMarkdownImages`。
- 风险预计：HIGH。需要先报告影响面，再分小 PR。

#### `run_lint`

用途：让 Agent 能主动检查 Wiki 质量。

普通 LLM 现有能力：

- `runStructuralLint`
- `runSemanticLint`

建议输入：

```ts
{
  semantic?: boolean;
  pages?: string[];
}
```

建议输出：

```ts
{
  results: LintResult[];
  structuralCount: number;
  semanticCount: number;
}
```

实现建议：

- 封装现有 lint 函数。
- 第一版可以全量 lint；按页面 scope 可后续优化。

GitNexus 影响关注：

- 修改前 impact：`runStructuralLint`, `runSemanticLint`。
- 风险预计：LOW/MEDIUM。

#### `fix_lint_result`

用途：让 Agent 能调用现有 fixer 修复 lint 结果。

普通 LLM 现有能力：

- broken link fix
- no outlinks fix
- semantic fix
- orphan 处理策略

建议输入：

```ts
{
  result: LintResult;
  dryRun?: boolean;
}
```

建议输出：

```ts
{
  fixed: boolean;
  changedPaths: string[];
}
```

实现建议：

- 调用 `fixLintResult`。
- 第一版不暴露 `fixAll` 给 Agent 自动批量跑，避免大面积改动；提供 `fix_all_lint_results` 时必须有 limit。

GitNexus 影响关注：

- 修改前 impact：`fixLintResult`, `fixAllLintResults`, `applyLlmFix`。
- 风险预计：MEDIUM。

### P1：Agent 等价体验必需

#### `enrich_wikilinks`

用途：让 Agent 写完页面后复用安全 wikilink enrichment。

普通 LLM 现有能力：

- LLM 只输出 term -> target JSON
- 代码只替换首个匹配
- 不让 LLM 重写整页

建议输入：

```ts
{
  path: string;
}
```

建议输出：

```ts
{
  path: string;
  changed: boolean;
  insertedLinks: number;
}
```

实现建议：

- 调用 `enrichWithWikilinks`。
- 可在 `update_page/create_entity/create_concept` 后由 Agent 自己调用，也可后续在 hook 中提示。

GitNexus 影响关注：

- 修改前 impact：`enrichWithWikilinks`。
- 风险预计：LOW。

#### `run_deep_research`

用途：让 Agent 使用 LLM Wiki 现有 deep research，而不是自己用 Bash/Web 瞎搜。

普通 LLM 现有能力：

- web search
- AnyTXT local search
- AnyTXT query rewrite
- source dedup
- synthesis
- 保存 query page
- autoIngest research result

建议输入：

```ts
{
  topic: string;
  searchQueries?: string[];
  sourceMode?: "web" | "anytxt" | "both";
}
```

建议输出：

```ts
{
  taskId: string;
  status: "queued" | "searching" | "synthesizing" | "saving" | "done" | "error";
  savedPath?: string;
}
```

实现建议：

- 封装 `queueResearch` / `executeResearch`。
- 暴露 `get_agent_task_status` 查询进度。
- 不把搜索 API key 传给 sidecar；由 App 内部配置读取。

GitNexus 影响关注：

- 修改前 impact：`queueResearch`, `executeResearch`, `collectResearchSources`, `rewriteAnyTxtQueries`。
- 风险预计：MEDIUM/HIGH，因为涉及外部搜索、任务队列、保存和 autoIngest。

#### `detect_duplicates`

用途：让 Agent 能识别重复实体/页面。

普通 LLM 现有能力：

- 加载 entity summaries / wiki pages
- LLM 判断 duplicate groups
- not-duplicate storage

建议输入：

```ts
{
  scope?: "entities" | "concepts" | "all";
}
```

建议输出：

```ts
{
  groups: DuplicateGroup[];
}
```

实现建议：

- 调用 `runDuplicateDetection` 或底层 `detectDuplicateGroups`。

GitNexus 影响关注：

- 修改前 impact：`runDuplicateDetection`, `detectDuplicateGroups`, `loadAllEntitySummaries`。
- 风险预计：MEDIUM。

#### `merge_duplicate_group`

用途：让 Agent 能合并重复页面，但必须走现有 merge 规则。

普通 LLM 现有能力：

- canonical page
- rewritten references
- backup
- index rewrite
- not duplicate 记录

建议输入：

```ts
{
  slugs: string[];
  canonicalSlug?: string;
  dryRun?: boolean;
}
```

建议输出：

```ts
{
  canonicalPath: string;
  removedPaths: string[];
  rewrittenPaths: string[];
  backupPaths: string[];
}
```

实现建议：

- 调用 `executeMerge` / `mergeDuplicateGroup`。
- 默认要求 `dryRun` 先跑；真实 merge 依赖 Agent 权限模式和用户设置。

GitNexus 影响关注：

- 修改前 impact：`executeMerge`, `mergeDuplicateGroup`, `rewriteCrossReferences`, `rewriteIndexMd`。
- 风险预计：HIGH。建议单独 PR。

### P2：补齐边界与辅助能力

#### `caption_source_images`

用途：让 Agent 显式触发多模态图片处理。

普通 LLM 现有能力：

- source image extraction
- vision caption
- caption cache
- source summary injection
- image content进入搜索/embedding

建议输入：

```ts
{
  sourcePath: string;
  forceRecaption?: boolean;
}
```

建议输出：

```ts
{
  sourceSummaryPath: string;
  imagesFound: number;
  captionsCreated: number;
  cacheHits: number;
}
```

实现建议：

- 优先通过 `ingest_source` 覆盖。
- 单独工具用于用户明确要求“给这个 source 的图重新 caption”。
- 必须复用 `extractAndSaveSourceImages`, `captionMarkdownImages`, `injectImagesIntoSourceSummary`, `reembedSourceSummary`。

GitNexus 影响关注：

- 修改前 impact：`captionImage`, `captionMarkdownImages`, `extractAndSaveSourceImages`, `injectImagesIntoSourceSummary`。
- 风险预计：HIGH。多模态涉及 LLM 调用、文件写入、cache、embedding。

#### `optimize_research_topic`

用途：让 Agent 复用已有研究主题优化。

建议输入：

```ts
{
  topic: string;
}
```

建议输出：

```ts
{
  optimizedTopic: string;
  suggestedQueries: string[];
}
```

实现建议：

- 调用 `optimizeResearchTopic`。

#### `sweep_reviews`

用途：让 Agent 能处理 review item 队列或提出修复建议。

建议输入：

```ts
{
  limit?: number;
}
```

建议输出：

```ts
{
  reviewed: number;
  actions: Array<{ id: string; recommendation: string }>;
}
```

实现建议：

- 第一版只读/建议，不自动 resolve。
- 后续再考虑 `apply_review_action`。

#### `test_provider_connection`

用途：让 Agent 能在用户要求排查模型配置时复用现有连接测试。

建议输入：

```ts
{
  kind: "llm" | "embedding";
}
```

建议输出：

```ts
{
  ok: boolean;
  message: string;
}
```

实现建议：

- 调用 `testLlmConnection` / `testEmbeddingConnection`。

## 新事件类型

Phase 3 已有：

```ts
tool_event
agent_summary
agent_action_required
wiki_changed
```

Phase 3.5 建议补：

```ts
agent_task_started
agent_task_progress
agent_task_done
agent_task_error
```

用途：

- ingest / deep research / caption / dedup merge 都是长任务。
- Agent 需要拿到 taskId，并能轮询状态。
- Phase 4 UI 可直接展示任务进度。

建议 payload：

```ts
interface AgentTaskEventPayload {
  taskId: string;
  toolName: string;
  status: "queued" | "running" | "done" | "error";
  detail?: string;
  progress?: { done: number; total: number };
  changedPaths?: string[];
  error?: string;
}
```

## 权限与写入边界

沿用 Phase 3 决策：

- Wiki read tools 默认免询问。
- Wiki write tools 默认可用，但只允许写 Wiki 受控路径。
- Claude Code 内置工具默认仍走 SDK 权限询问。

Phase 3.5 新增分级：

| 工具组 | 默认策略 | 说明 |
|--------|----------|------|
| read/search/context | auto-allow | 不改文件 |
| save_query/enrich/lint read | auto-allow | 改动可控或只读 |
| ingest_source/caption_source_images | auto-allow when write tools enabled | 会写多文件，但复用现有业务链路 |
| fix_lint_result | write tools enabled | 单项修复 |
| run_deep_research | write tools enabled | 会访问外部搜索并写 query page |
| merge_duplicate_group | 默认 dryRun；真实 merge 需要额外策略 | 大面积改引用，风险高 |

必须保留：

- path guard
- maxWriteBytes
- maxFilesChanged
- changedPaths tracking
- onWikiChanged
- lint recommended

但对 `ingest_source`、`run_deep_research` 这种“业务批处理”工具，`maxFilesChanged` 不能简单套用当前单工具默认 3。需要单独配置：

```ts
maxAgentTaskFilesChanged?: number;
maxAgentTaskBytesWritten?: number;
```

默认建议：

```text
maxAgentTaskFilesChanged = 20
maxAgentTaskBytesWritten = 2MB
```

## 实施步骤

### Step 1：抽出普通 LLM 业务服务层

新增：

```text
src/lib/agent/agent-tool-service.ts
src/lib/wiki-answer-context.ts
src/lib/save-query-page.ts
```

工作：

- 从 `chat-panel.tsx` 抽 `build_answer_context` 可复用逻辑。
- 从 `chat-message.tsx` / `review-view.tsx` 抽 `save_query_page` 可复用逻辑。
- 定义 `AgentToolServiceContext`：

```ts
interface AgentToolServiceContext {
  projectPath: string;
  llmConfig: LlmConfig;
  searchConfig: SearchApiConfig;
  multimodalConfig: MultimodalConfig;
  signal?: AbortSignal;
  onProgress?: (event: AgentTaskEventPayload) => void;
}
```

GitNexus 必做：

- impact `handleSend`
- impact `handleSave`
- impact `autoIngest`

### Step 2：新增 Agent tool bridge

新增：

```text
src/lib/agent/agent-tool-registry.ts
src-tauri/src/commands/agent_tool.rs
src-tauri/sidecar/src/app-tools.ts
```

目标：

- sidecar MCP tool 调用 `app-tools.ts`
- Rust bridge 转发到 App tool service
- App tool service 调用 WebView 现有业务模块
- 结果通过 JSON 返回 sidecar

注意：

- 所有工具必须有 zod schema。
- 所有工具结果必须可 JSON 序列化。
- 长任务返回 taskId，不能让 sidecar 长时间阻塞。

### Step 3：P0 工具落地

实现：

```text
build_answer_context
save_query_page
ingest_source
run_lint
fix_lint_result
```

测试：

- unit test：tool schema、path guard、dryRun
- integration mock：sidecar tool -> bridge -> service
- existing tests：`npm run test:mocks`
- sidecar tests：`npm --prefix src-tauri/sidecar test`
- Rust tests：agent command tests

### Step 4：多模态工具落地

实现：

```text
caption_source_images
```

要求：

- 复用现有 multimodal config。
- 复用 caption cache。
- 复用 source summary injection。
- caption 后能触发 re-embed 或返回 `embedding_recommended`。
- 不能只做“读图片并让 Agent 描述”，必须走 LLM Wiki 多模态索引链路。

测试：

- mock caption pipeline：图片计数、cache hit、source summary marker。
- real-LLM gated test：保留现有 `RUN_LLM_TESTS=1` 风格。

### Step 5：P1 工具落地

实现：

```text
enrich_wikilinks
run_deep_research
detect_duplicates
merge_duplicate_group
```

注意：

- `merge_duplicate_group` 真实执行建议单独开 PR。
- deep research 涉及外部搜索，不要把搜索 API key 暴露给 sidecar。

### Step 6：P2 辅助工具落地

实现：

```text
optimize_research_topic
sweep_reviews
test_provider_connection
get_agent_task_status
```

## PR 拆分计划

Phase 3.5 必须拆成 5 个 PR，不做单个大 PR。每个 PR 都要在提交前跑 GitNexus impact / detect changes，并在 PR 描述里写清影响范围。

### PR A：公共业务服务层抽取

目标：先把普通 LLM 已有业务逻辑抽成可复用模块，不接 Agent tool bridge。

范围：

- 新增 `src/lib/wiki-answer-context.ts`
- 新增 `src/lib/save-query-page.ts`
- 可选新增 `src/lib/agent/agent-tool-service.ts` 的类型骨架
- `handleSend` 改为调用 `buildAnswerContext`
- `chat-message.tsx` / `review-view.tsx` 改为调用 `saveQueryPage`

不做：

- 不新增 sidecar 工具
- 不新增 Agent UI
- 不改 ingest / 多模态

GitNexus 必跑：

- impact `handleSend`
- impact `handleSave`
- impact `searchWiki`
- detect changes

验收：

- 普通 Chat RAG 输出不回归
- Save to Wiki 仍更新 query page、index、log
- 现有测试通过

风险：MEDIUM

### PR B：Agent tool bridge + 基础 parity 工具

目标：打通 Agent 调用 App 业务工具的通道，并先接低风险工具。

范围：

- 新增 Agent tool bridge / registry
- sidecar 新增 app-level MCP tools：
  - `build_answer_context`
  - `save_query_page`
  - `run_lint`
  - `fix_lint_result`
  - `enrich_wikilinks`
- 新增 task/event 基础协议：
  - `agent_task_started`
  - `agent_task_progress`
  - `agent_task_done`
  - `agent_task_error`

不做：

- 不做 `ingest_source`
- 不做 deep research
- 不做 dedup merge
- 不做正式 UI

GitNexus 必跑：

- impact `createLlmWikiTools`
- impact `createRequestHandler`
- impact `runSemanticLint`
- impact `fixLintResult`
- impact `enrichWithWikilinks`
- detect changes

验收：

- Agent 能构建普通 Chat 同款 RAG context
- Agent 能保存 query page
- Agent 能跑 lint
- Agent 能修复单条 lint
- Agent 能补 wikilinks
- 写入后发 `wiki_changed` / `lint_recommended`

风险：MEDIUM

### PR C：ingest_source + 多模态 parity

目标：让 Agent 拥有普通 LLM ingest 能力，特别是多模态能力。

范围：

- 新增 `ingest_source`
- 新增 `caption_source_images`
- 接入现有：
  - `autoIngest`
  - ingest cache
  - source identity / source summary slug
  - page merge
  - review item parse
  - `extractAndSaveSourceImages`
  - `captionMarkdownImages`
  - caption cache
  - source summary image injection
  - re-embed / embedding recommended 事件
- 长任务必须走 taskId + progress 事件

不做：

- 不做 deep research
- 不做 dedup merge
- 不做 UI

GitNexus 必跑：

- impact `autoIngest`
- impact `autoIngestImpl`
- impact `executeIngestWrites`
- impact `extractAndSaveSourceImages`
- impact `captionMarkdownImages`
- impact `captionImage`
- detect changes

验收：

- Agent 能 ingest raw source
- Agent ingest 走现有 cache / merge / review 逻辑
- Agent ingest 能处理图片：提取、caption、cache、注入 source summary
- 多模态关闭时不 caption
- 多模态开启时 caption 进入 wiki，可被搜索/embedding 后续链路使用

风险：HIGH。该 PR 必须重点 review。

### PR D：Deep Research parity

目标：让 Agent 能调用 LLM Wiki 现有 deep research 工作流。

范围：

- 新增 `run_deep_research`
- 新增 `collect_research_sources`
- 新增 `get_agent_task_status` 或复用 PR B task status
- 接入现有：
  - web search
  - AnyTXT search
  - AnyTXT query rewrite
  - synthesis
  - save query page
  - autoIngest research result

不做：

- 不做 dedup merge
- 不暴露搜索 API key 给 sidecar
- 不做 UI

GitNexus 必跑：

- impact `queueResearch`
- impact `executeResearch`
- impact `collectResearchSources`
- impact `rewriteAnyTxtQueries`
- detect changes

验收：

- Agent 能启动 deep research
- 能返回 taskId 和状态
- 完成后保存 `wiki/queries/*`
- 完成后触发 ingest
- 外部搜索失败时返回结构化错误，不让 Agent 卡死

风险：HIGH。涉及外部网络、搜索配置和长任务。

### PR E：Dedup / review / 辅助工具收尾

目标：补齐剩余普通 LLM 辅助能力。

范围：

- 新增 `detect_duplicates`
- 新增 `merge_duplicate_group`
- 新增 `optimize_research_topic`
- 新增 `sweep_reviews`
- 新增 `test_provider_connection`
- `merge_duplicate_group` 默认先 `dryRun`
- 真实 merge 需要明确 permission policy / write tools enabled

不做：

- 不做正式 UI
- 不做无保护批量 merge

GitNexus 必跑：

- impact `runDuplicateDetection`
- impact `executeMerge`
- impact `mergeDuplicateGroup`
- impact `rewriteCrossReferences`
- impact `rewriteIndexMd`
- impact `optimizeResearchTopic`
- impact `judgeBatch`
- impact `testLlmConnection`
- detect changes

验收：

- Agent 能检测重复页面
- Agent 能 dryRun 合并方案
- 真实 merge 受权限和写入限制约束
- Agent 能优化研究主题
- Agent 能扫 review item
- Agent 能测试 provider 连接

风险：MEDIUM/HIGH。dedup merge 是主要风险点。

### 拆分原则

- PR A 先合，避免 Agent 改动和普通 LLM 重构混在一起。
- PR B 后合，建立 bridge 和低风险工具。
- PR C 单独做，因为 ingest + 多模态是高风险核心能力。
- PR D 单独做，因为 deep research 有外部搜索和长任务。
- PR E 最后做，处理 dedup/review/provider 这些辅助能力。
- PR E 合并后、Phase 4 UI 前做一次 Agent tool schema cleanup：统一检查所有 MCP/app bridge 工具的 zod schema、tool description、runtime validation 和测试；重点把 `run_deep_research` 的 `topic` 与 `searchQueries`/`queries` “至少一个必填”从运行时校验补强到 schema/描述层，避免 Agent 因参数约束不清误调用。
- 任一 PR 的 GitNexus impact 达到 HIGH/CRITICAL，必须继续拆小。

## 验收标准

Phase 3.5 完成时，Agent 至少能做到：

- 回答 Wiki 问题时可调用普通 Chat 同款 RAG context。
- 保存回答为 query page，并更新 index/log。
- 对 raw source 执行完整 ingest。
- ingest 包含多模态图片提取、caption、cache、source summary 注入。
- 跑 structural/semantic lint。
- 调用 fixer 修复单条 lint。
- 给页面补 wikilinks。
- 跑 deep research 并保存/ingest 结果。
- 检测重复页面。
- dryRun 合并重复页面，真实 merge 有明确权限策略。
- 所有写入都发 `wiki_changed`。
- 写入后发 `lint_recommended` 或等价 action_required。
- `npm run test:mocks` 通过。
- `npm --prefix src-tauri/sidecar test` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml commands::agent::tests -- --nocapture` 通过。
- `npx gitnexus detect_changes` 确认影响范围符合预期。

## 不纳入 Phase 3.5

- 正式 Agent UI。
- 权限切换按钮。
- 工具调用可视化。
- Agent SDK 原生 session resume/fork。
- sidecar 单文件打包。
- `startup()` 预热。

这些继续放 Phase 3.6 / Phase 4 / Phase 5。

## 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 抽取 Chat RAG 影响普通问答 | MEDIUM | 先抽纯函数，保持输入输出快照测试 |
| Save to Wiki 抽取导致 index/log 回归 | MEDIUM | 用现有保存路径做回归测试 |
| ingest_source 长任务阻塞 Agent | HIGH | taskId + progress 事件，不长时间阻塞 sidecar |
| 多模态成本高/慢 | HIGH | 复用现有 toggle、cache、concurrency |
| dedup merge 大面积改引用 | HIGH | 默认 dryRun，真实执行单独权限策略 |
| sidecar/WebView bridge 复杂 | MEDIUM | 所有工具统一 registry，禁止散落 IPC |
| 重复实现业务规则 | HIGH | 只封装现有模块，不在 sidecar 重写 ingest/lint/dedup |

## GitNexus 使用要求

开发 Phase 3.5 时必须遵守：

- 修改任何现有函数前先跑 `gitnexus impact`。
- 高风险模块必须在动手前报告影响面：
  - `autoIngest`
  - `executeIngestWrites`
  - `handleSend`
  - `fixLintResult`
  - `executeResearch`
  - `executeMerge`
  - `captionImage`
  - `captionMarkdownImages`
- 每个 PR 提交前跑 `gitnexus detect_changes`。
- 如果 GitNexus 显示 HIGH/CRITICAL，拆 PR 或先做抽取测试。

## 最终判断

Phase 3.5 是必要阶段。否则 Phase 4 做出 Agent UI 后，会出现“普通 LLM 能 ingest、能多模态、能 lint/fix、能 deep research，但 Agent 只能读写页面”的产品断层。

正确顺序：

```text
Phase 3.5：补齐 Agent 工具能力
Phase 3.6：补齐 Claude Agent SDK 原生能力
Phase 4：正式 UI
Phase 5：打包、预热、长期稳定性
```
