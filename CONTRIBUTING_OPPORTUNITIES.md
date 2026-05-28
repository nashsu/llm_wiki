# LLM Wiki 外部贡献者改进指南

> 基于对项目代码的深度分析，整理出适合不同水平外部贡献者的改进方向。
> 分析时间：2026-05-25

---

## 目录

0. [当前优先的外部贡献（2026-05-26）](#0-当前优先的外部贡献2026-05-26)
1. [如何阅读本指南](#1-如何阅读本指南)
2. [Good First Issues（入门友好）](#2-good-first-issues入门友好)
3. [Help Wanted（需要社区力量）](#3-help-wanted需要社区力量)
4. [Advanced Contributions（深度参与）](#4-advanced-contributions深度参与)
5. [技术债务与重构机会](#5-技术债务与重构机会)
6. [按技术领域分类](#6-按技术领域分类)
7. [提交贡献的最佳实践](#7-提交贡献的最佳实践)

---

## 0. 当前优先的外部贡献（2026-05-26）

> 这一节不是泛泛而谈的“可以做什么”，而是基于当前代码状态筛出来的、
> 更适合外部贡献者切入、且更可能被快速 review/合并的方向。

### 0.1 搜索性能：把关键词搜索从“全量扫 markdown”改成“预建索引”
**难度**：🟡 **影响面**：Core + Rust **预估工时**：1-3 周

当前关键词搜索在后端每次查询都会遍历 `wiki/` 下的 `.md` 文件并逐个读取内容，
规模一大就会直接拉高延迟：

- `src-tauri/src/commands/search.rs:123`
- `src-tauri/src/commands/search.rs:147`
- `src-tauri/src/commands/search.rs:160`

**为什么值得做**：
- 这是当前最明确的性能瓶颈
- 边界清楚，集中在搜索链路
- 做完后收益能被用户直接感知

**适合的贡献方式**：
1. 先补 benchmark / profiling，量化当前搜索延迟
2. 增加一个增量关键词索引（SQLite FTS / Tantivy / 其他轻量倒排索引）
3. 支持页面新增、删除、重写时的索引更新
4. 保持现有 hybrid 搜索接口不变，先只替换 token 搜索底座

**建议验收标准**：
- 搜索 API 兼容现有 `search_project`
- 中型 wiki 下搜索耗时明显下降
- 为“索引缺失 / 索引损坏 / 索引过期”提供回退路径

---

### 0.2 Embedding 吞吐优化：有限并发，而不是全串行
**难度**：🟡 **影响面**：Core + TS **预估工时**：3-7 天

当前 embedding 是逐页、逐 chunk 顺序发请求：

- `src/lib/ingest.ts:732`
- `src/lib/embedding.ts:345`
- `src/lib/embedding.ts:363`

**为什么值得做**：
- 大批量导入时吞吐几乎严格线性
- 任一慢 embedding 请求都会卡住整条 ingest 链
- 可以在不重写架构的前提下显著提速

**适合的贡献方式**：
1. 为 chunk embedding 增加有上限的并发（例如 2-4）
2. 为支持 batch embeddings 的 provider 增加批量请求路径
3. 保留现有失败重试和 oversize auto-halving 逻辑
4. 为 Settings 或 Activity Panel 暴露更清晰的 embedding 进度

**建议验收标准**：
- 不改变结果格式和 LanceDB upsert 行为
- 不引入同一页面的重复写入竞争
- real-llm / mock tests 至少补一个并发场景

---

### 0.3 Rust API Server：把 `chat` 从 501 变成可用接口
**难度**：🟡/🔴 **影响面**：Rust + Core **预估工时**：1-2 周

本地 API server 已有 `projects/files/search/graph/rescan`，但 `chat` 仍未实现：

- `src-tauri/src/api_server.rs:257`
- `src-tauri/src/api_server.rs:262`

**为什么值得做**：
- 这是“桌面应用”走向“可被外部 agent 调用的平台”的关键缺口
- 能直接提升脚本化、自动化、远程接入能力

**适合的贡献方式**：
1. 先抽取 WebView 里已有的共享 chat/RAG 逻辑
2. 在 Rust backend command 暴露一个统一入口
3. 让 `/api/v1/projects/:id/chat` 走同一条后端能力链
4. 补 API contract tests 与错误码约定

**风险提醒**：
- 这是高价值方向，但会碰前后端边界，不建议第一次贡献就大拆主流程

---

### 0.4 编译 warning 清理与小型 correctness 修复
**难度**：🟢 **影响面**：Rust **预估工时**：1-3 天

当前 `cargo check` 已通过，但仍有一批明确 warning：

- `src-tauri/src/clip_server.rs:45`
- `src-tauri/src/commands/fs.rs:483`
- `src-tauri/src/commands/fs.rs:486`
- `src-tauri/src/commands/fs.rs:568`
- `src-tauri/src/commands/fs.rs:584`
- `src-tauri/src/commands/fs.rs:819`

**为什么值得做**：
- 边界清楚，适合首次 PR
- review 成本低
- 能提升主分支健康度，建立信任

**适合的贡献方式**：
1. 清理未使用变量 / 无效模式匹配
2. 为不清晰逻辑补最小测试
3. 不顺手大改 unrelated 代码

---

### 0.5 测试补强：优先补“边界场景”，不要只加快照
**难度**：🟢/🟡 **影响面**：Tests **预估工时**：2-5 天

项目已有较多测试基础，外部贡献者更适合补“薄弱边界”，而不是重复已有 happy path。

**优先推荐的测试方向**：
1. 搜索 ranking / hybrid fallback 场景
2. ingest queue 中断恢复、取消、空结果失败路径
3. API server 无头集成测试
4. embedding 降级路径与 provider 兼容性测试

**相关入口**：
- `package.json` 中 `test:mocks` / `test:llm`
- `src/lib/*.test.ts`
- `src/lib/*.real-llm.test.ts`

---

### 0.6 队列与调度持久化：提升可观测性和恢复能力
**难度**：🟡 **影响面**：Core + TS **预估工时**：3-6 天

当前 ingest queue、dedup queue、scheduled import 都依赖 JSON 文件和模块级状态。
这类贡献不如搜索重构“显眼”，但很适合稳健型外部贡献者。

相关文件：
- `src/lib/ingest-queue.ts`
- `src/lib/dedup-queue.ts`
- `src/lib/scheduled-import.ts`

**适合的贡献方式**：
1. 为 queue/db 文件增加 schema version
2. 增强损坏文件恢复策略
3. 增加更清晰的 task telemetry / error metadata
4. 改善 retry / failed 状态的 UI 可见性

---

### 0.7 首次外部贡献的推荐顺序

如果你是第一次向这个项目发 PR，建议按这个顺序选题：

1. 清理 `cargo check` warning
2. 补一个搜索或队列的边界测试
3. 做 embedding 有限并发
4. 做关键词搜索 benchmark / profiling
5. 做搜索索引原型
6. 最后再碰 API `/chat`

---

## 1. 如何阅读本指南

每条改进建议包含：
- **难度**：🟢 简单 / 🟡 中等 / 🔴 困难
- **影响面**：UI / Core / Rust / Docs / Infra
- **预估工时**：粗略估计
- **相关文件**：便于快速定位代码

---

## 2. Good First Issues（入门友好）

### 2.1 添加更多文件类型的图标映射
**难度**：🟢 **影响面**：UI **预估工时**：1-2h

当前 `src/lib/file-types.ts` 缺少一些常见格式：
- `.jl` (Julia)、`.ex` / `.exs` (Elixir)、`.dart`、`.kt` 已有但 `.kts` 缺失
- `.graphql`、`.prisma`、`.proto`
- `.ipynb` (Jupyter Notebook)
- `.psd`、`.ai`、`.sketch` (设计文件)
- `.zip`、`.tar`、`.gz` (压缩文件)

**怎么做**：
1. 在 `EXT_MAP` 中添加扩展名到分类的映射
2. 在 `getCodeLanguage()` 中添加语法高亮映射
3. 如有对应图标需求，可在 UI 层添加分类图标

**相关文件**：`src/lib/file-types.ts`

---

### 2.2 替换原生 `window.alert/confirm` 为应用内 Dialog
**难度**：🟢 **影响面**：UI **预估工时**：2-4h

项目中有 **9 处**直接使用原生弹窗，破坏桌面应用体验：
- `src/components/sources/sources-view.tsx` (2 处 alert)
- `src/components/lint/lint-view.tsx` (1 处 confirm)
- `src/components/review/review-view.tsx` (1 处 alert)
- `src/components/layout/knowledge-tree.tsx` (1 处 alert)
- `src/components/layout/research-panel.tsx` (1 处 alert)
- `src/components/layout/activity-panel.tsx` (1 处 confirm)
- `src/App.tsx` (2 处 alert)

**怎么做**：
1. 已有 `src/components/ui/dialog.tsx` (shadcn/ui Dialog)
2. 封装一个 `useConfirmDialog()` hook 或全局 Alert 状态
3. 逐处替换，保持原有文案和交互逻辑

**相关文件**：上述 7 个文件 + `src/components/ui/dialog.tsx`

---

### 2.3 修复 i18n 遗漏的硬编码字符串
**难度**：🟢 **影响面**：UI **预估工时**：2-3h

通过扫描发现部分 UI 仍使用硬编码英文，未走 `react-i18next`：
- `window.alert` 和 `window.confirm` 中的文案
- 部分 `console.warn/error` 中的用户可见提示
- Graph 视图中部分 tooltip 和 label

**怎么做**：
1. 在 `src/i18n/en.json` 和 `src/i18n/zh.json` 中添加对应 key
2. 用 `useTranslation()` 的 `t()` 替换硬编码字符串
3. 运行 `npm run test:mocks` 确保不破坏测试

**相关文件**：`src/i18n/*.json` + 各组件文件

---

### 2.4 为 i18n 添加新语言支持
**难度**：🟢 **影响面**：UI **预估工时**：3-6h/语言

当前仅支持 **English + Chinese**。社区可贡献：
- 日本语 (ja) — README_JA.md 已存在，说明有日语用户基础
- 西班牙语 (es)、法语 (fr)、德语 (de)
- 韩语 (ko)

**怎么做**：
1. 复制 `src/i18n/en.json` 为目标语言文件
2. 翻译所有字符串（约 200-300 条）
3. 在 `src/i18n/index.ts` 中注册新语言
4. 在 Settings → Interface 中添加语言选项

**相关文件**：`src/i18n/*`

---

### 2.5 添加 `.typos.toml` 忽略项目特定术语
**难度**：🟢 **影响面**：Infra **预估工时**：30min

项目已使用 `typos` CLI 做拼写检查，但存在大量 false positives（如德语单词、越南语地名、数学符号）。可在项目根目录添加 `.typos.toml` 配置，减少噪音。

**参考配置**：
```toml
[default.extend-identifiers]
"BA" = "BA"
"Ba" = "Ba"
"Nd" = "Nd"
"ODF" = "ODF"
"odf" = "odf"

[default.extend-words]
"als" = "als"
"ein" = "ein"
"eine" = "eine"
"ist" = "ist"
"oder" = "oder"
"sie" = "sie"
"Vor" = "Vor"
"Alle" = "Alle"
"Nam" = "Nam"
"unparseable" = "unparseable"

[type.html]
extend-glob = []
check-file = false
```

**相关文件**：项目根目录（新建 `.typos.toml`）

---

### 2.6 添加 Issue/PR 模板
**难度**：🟢 **影响面**：Community **预估工时**：1h

当前 `.github/` 目录只有 workflows，缺少社区协作模板：
- Bug Report 模板
- Feature Request 模板
- PR 模板（含 checklist：测试通过、i18n 更新、文档更新）

**相关文件**：`.github/ISSUE_TEMPLATE/`、`.github/pull_request_template.md`

---

### 2.7 清理 `console.log/warn/error` 生产残留
**难度**：🟢 **影响面**：Core **预估工时**：2-3h

代码中有 **204 处** `console.*` 调用。虽然很多是合理的错误上报，但：
- 诊断性 `console.log`（如 `[ingest:diag]`）不应出现在生产构建
- 应统一为可开关的日志系统或 `import.meta.env.DEV` 守卫

**怎么做**：
1. 封装 `src/lib/logger.ts`：
   ```ts
   export const log = {
     debug: (...args: unknown[]) => { if (import.meta.env.DEV) console.log(...args) },
     warn: (...args: unknown[]) => console.warn(...args),
     error: (...args: unknown[]) => console.error(...args),
   }
   ```
2. 批量替换诊断日志为 `log.debug()`
3. 保留真正的错误上报（`warn/error`）

**相关文件**：全项目（可用脚本批量替换）

---

## 3. Help Wanted（需要社区力量）

### 3.1 添加更多 LLM Provider 预设
**难度**：🟡 **影响面**：Core **预估工时**：2-4h/Provider

当前 `src/components/settings/llm-presets.ts` 已有 OpenAI、Anthropic、DeepSeek 等预设，但缺少：
- **Groq**（高速推理）
- **Mistral AI**（Le Chat / Codestral）
- **Cerebras**（超快推理）
- **Fireworks AI**
- **Together AI**
- **OpenRouter**（统一网关）

**怎么做**：
1. 在 `llm-presets.ts` 的 `LLM_PRESETS` 数组中添加配置
2. 确保 `llm-providers.ts` 能正确解析 endpoint（大多数是 OpenAI-compatible）
3. 添加 provider 图标（如可用）
4. 更新设置界面的预设选择器

**相关文件**：`src/components/settings/llm-presets.ts`、`src/lib/llm-providers.ts`

---

### 3.2 为纯前端组件添加无障碍 (a11y) 改进
**难度**：🟡 **影响面**：UI **预估工时**：3-5h

当前 a11y 标记较少（仅 34 处 aria-*）。可改进点：
- **Graph 视图**：节点和边无法被屏幕阅读器感知
- **Sources 树**：缺少 `aria-expanded`、`aria-level`、`aria-setsize`
- **Activity Panel**：进度条缺少 `role="progressbar"`、`aria-valuenow`
- **Search 面板**：搜索结果列表缺少 `role="listbox"`、`aria-selected`
- **Color contrast**：部分文字与背景对比度可能低于 WCAG AA 标准

**怎么做**：
1. 为交互元素添加语义化 role 和 aria 属性
2. 确保键盘导航（Tab/Enter/Escape）在所有面板正常工作
3. 使用 axe-core 或 Lighthouse 做自动化 a11y 审计

**相关文件**：`src/components/**/*.tsx`

---

### 3.3 添加 CSV/TSV 结构化预览
**难度**：🟡 **影响面**：UI + Core **预估工时**：4-6h

当前 CSV 被归类为 `data`，在编辑器中按纯文本展示。可改进为：
- 表格形式预览（类似 Excel）
- 支持排序、搜索
- 分页（大 CSV 不卡顿）

**怎么做**：
1. 在 `src/components/editor/file-preview.tsx` 中添加 CSV 分支
2. 用轻量表格组件（如 `@tanstack/react-table` 或手写）渲染
3. Rust 后端 `fs.rs` 中已有 `calamine` 支持 Excel，CSV 可直接用 Rust 或前端解析
4. 注意大文件性能（>1MB CSV 应截断或虚拟滚动）

**相关文件**：`src/components/editor/file-preview.tsx`、`src/lib/file-types.ts`

---

### 3.4 为 Ingest 添加更多源文件格式支持
**难度**：🟡 **影响面**：Rust **预估工时**：4-8h/格式

| 格式 | 优先级 | 技术方案 |
|------|--------|----------|
| `.epub` | 高 | 电子书格式，可用 `epub` crate 或解压后解析 HTML |
| `.rtf` | 中 | 富文本格式，可用 `rtf-parser` 或直接当 text 读取 |
| `.html` / `.htm` | 高 | 本地网页保存，可用 `html2md` 或 Readability |
| `.tex` | 低 | LaTeX 源文件，可作为纯文本 + 特殊渲染 |
| `.ipynb` | 中 | Jupyter Notebook，解析 JSON 提取 markdown + code cells |

**怎么做**：
1. 在 `src-tauri/src/commands/fs.rs` 的 `read_file()` 匹配分支中添加新格式
2. 如有必要，添加 Rust crate 依赖
3. 在 `src/lib/file-types.ts` 中更新分类
4. 添加对应的测试用例

**相关文件**：`src-tauri/src/commands/fs.rs`、`src/lib/file-types.ts`

---

### 3.5 添加键盘快捷键系统
**难度**：🟡 **影响面**：UI **预估工时**：4-6h

当前应用缺少全局键盘快捷键：
- `Ctrl/Cmd + K`：快速打开 Search
- `Ctrl/Cmd + N`：新建对话
- `Ctrl/Cmd + Shift + I`：导入文件
- `Ctrl/Cmd + Shift + S`：保存到 Wiki
- `Ctrl/Cmd + B`：切换侧边栏
- `Escape`：关闭弹窗/面板

**怎么做**：
1. 创建 `src/lib/keyboard-shortcuts.ts` 统一管理快捷键
2. 使用 `document.addEventListener('keydown')` 或 `react-hotkeys-hook`
3. 在 Settings 中添加快捷键自定义界面（可选）
4. 注意与 Milkdown 编辑器的快捷键冲突

**相关文件**：新建 `src/lib/keyboard-shortcuts.ts`，修改 `src/App.tsx`

---

### 3.6 优化 Sources 树的大文件夹性能
**难度**：🟡 **影响面**：UI **预估工时**：3-5h

当前 Sources 树已有**渐进式加载**（`SOURCE_TREE_INITIAL_ROWS` + `IntersectionObserver`），但：
- 超过 1000 个文件时，展开/折叠操作仍可能卡顿
- 缺少虚拟滚动（Virtualized List）
- 搜索/过滤大文件夹时无 debounce

**怎么做**：
1. 引入 `@tanstack/react-virtual` 或 `react-window` 做虚拟滚动
2. 为过滤输入添加 `useDeferredValue` 或 debounce
3. 用 `useMemo` 缓存过滤后的树形结构

**相关文件**：`src/components/sources/sources-view.tsx`

---

### 3.7 为 API Server 添加 OpenAPI/Swagger 文档
**难度**：🟡 **影响面**：Docs + Rust **预估工时**：3-4h

当前本地 HTTP API (`src-tauri/src/api_server.rs`) 功能完善但缺少机器可读的文档：
- `GET /api/v1/health`
- `GET /api/v1/projects`
- `POST /api/v1/projects/{id}/search`
- `GET /api/v1/projects/{id}/graph`
- etc.

**怎么做**：
1. 使用 `utoipa` crate 从 Rust 代码生成 OpenAPI 3.0 spec
2. 在 `api_server.rs` 的 handler 函数上添加 `#[utoipa::path(...)]` 宏
3. 暴露 `/api/v1/docs` 端点提供 Swagger UI（可选嵌入 `swagger-ui-dist`）
4. 同步更新 README 中的 API 章节

**相关文件**：`src-tauri/src/api_server.rs`、`src-tauri/Cargo.toml`

---

### 3.8 为 Graph 视图导出功能
**难度**：🟡 **影响面**：UI **预估工时**：3-5h

用户希望将知识图谱导出为图片或数据文件：
- **PNG/SVG 导出**：sigma.js 支持 `sigma.toPNG()` 和 `sigma.toSVG()`
- **GEXF/GraphML 导出**：用于 Gephi、Cytoscape 等外部工具分析
- **CSV 节点/边列表**：便于做数据科学分析

**怎么做**：
1. 在 Graph 视图工具栏添加导出按钮
2. 使用 `graphology` 的导出工具（`graphology-gexf` 等）
3. 通过 Tauri `dialog` plugin 让用户选择保存路径
4. 大图的 PNG 导出注意内存占用

**相关文件**：`src/components/graph/graph-view.tsx`

---

## 4. Advanced Contributions（深度参与）

### 4.1 Ingest 流水线模块化拆分
**难度**：🔴 **影响面**：Core **预估工时**：8-15h

`src/lib/ingest.ts` 当前 **1833 行**，是项目中最大的单体 TS 文件：
- 包含分析、生成、缓存、图片提取、caption、sanitize、file block 解析等 10+ 个职责
- 测试文件 `ingest.*.test.ts` 也极其庞大

**拆分方向**：
```
ingest/
├── index.ts          # 公共接口（enqueueSourceIngest 等）
├── analyze.ts        # Step 1: LLM 分析源文件
├── generate.ts       # Step 2: LLM 生成 Wiki 页面
├── parse-blocks.ts   # FILE block 解析（已有独立文件）
├── cache.ts          # 已独立（ingest-cache.ts）
├── images.ts         # 图片提取与注入（可从 ingest.ts 抽出）
├── sanitize.ts       # 已独立（ingest-sanitize.ts）
└── helpers.ts        # 共享工具函数
```

**相关文件**：`src/lib/ingest.ts`、`src/lib/ingest-*.ts`

---

### 4.2 Rust `fs.rs` 模块化拆分
**难度**：🔴 **影响面**：Rust **预估工时**：10-20h

`src-tauri/src/commands/fs.rs` 当前 **2048 行**，职责过重：
- 文件读写（通用）
- PDF 文本提取
- Office 文档解析（DOCX/PPTX/XLSX/ODF）
- 缓存读写
- 文件系统遍历
- Wiki 页面关联查找

**拆分方向**：
```
commands/
├── fs.rs             # 基础文件操作（read/write/list）
├── extractors/
│   ├── pdf.rs        # PDF 提取
│   ├── office.rs     # Office 提取
│   └── cache.rs      # 预处理缓存
└── wiki_ops.rs       # Wiki 相关操作（find_related_wiki_pages 等）
```

**相关文件**：`src-tauri/src/commands/fs.rs`

---

### 4.3 添加 Plugin/Extension 系统
**难度**：🔴 **影响面**：Architecture **预估工时**：20-40h

当前应用是 monolithic 架构，外部开发者无法扩展功能。可设计轻量插件系统：
- **Ingest Plugin**：自定义文件格式解析器
- **Graph Plugin**：自定义布局算法或可视化
- **LLM Plugin**：自定义 Provider（无需修改核心代码）
- **Export Plugin**：自定义导出格式

**技术方案选项**：
- **方案 A**：JavaScript Plugin（前端 eval 或 Web Worker）— 风险高
- **方案 B**：WASM Plugin（Rust 编译为 WASM，通过 WASI 沙箱）— 较安全
- **方案 C**：外部 CLI Plugin（类似 Git LFS filter）— 最简单

**相关文件**：架构级改动，需先开 Discussion 讨论设计

---

### 4.4 向量搜索性能优化
**难度**：🔴 **影响面**：Rust + Core **预估工时**：10-15h

当前 LanceDB 向量搜索在 Wiki 超过 5000 页面时可能出现：
- 索引构建时间过长（阻塞 UI）
- 内存占用过高（全部向量驻留内存）
- 增量更新效率低（每次全量 re-index）

**优化方向**：
1. **异步索引构建**：将 `vector_upsert` 改为后台任务，不阻塞 ingest
2. **分区存储**：按类型（entity/concept/source）分表存储，减少单次搜索扫描量
3. **HNSW 索引**：如 LanceDB 支持，启用近似最近邻索引加速
4. **Embedding 缓存**：相同文本的 embedding 结果复用（已部分实现，可完善）

**相关文件**：`src-tauri/src/commands/vectorstore.rs`、`src/lib/embedding.ts`

---

### 4.5 为图可视化添加 WebGL 2 渲染后端
**难度**：🔴 **影响面**：UI **预估工时**：15-25h

当前 sigma.js 在 5000+ 节点时，Canvas 2D 渲染帧率下降明显。可探索：
- **sigma.js WebGL renderer**（如官方支持）
- 或迁移到 **deck.gl** / **Pixi.js** 做高性能图渲染
- 或按需渲染（viewport culling）+ 层级聚合（cluster on zoom out）

**相关文件**：`src/components/graph/graph-view.tsx`

---

### 4.6 多工作区/多窗口支持
**难度**：🔴 **影响面**：Architecture **预估工时**：15-30h

当前应用是单项目单窗口模式。用户反馈可能需要：
- 同时打开两个 Wiki 项目对比
- 弹出独立预览窗口
- 分离 Graph 视图为独立窗口

**技术挑战**：
1. Tauri 多窗口 API (`WebviewWindowBuilder`)
2. 窗口间状态同步（Tauri Event System）
3. 后端 API Server 和 Clip Server 的共享/隔离

**相关文件**：`src-tauri/src/lib.rs`、`src/App.tsx`

---

## 5. 技术债务与重构机会

### 5.1 统一错误处理与用户提示

当前错误处理分散：
- 有些用 `window.alert`
- 有些用 `console.error`
- 有些在 UI 中内联显示
- 有些静默吞掉（`catch { /* non-critical */ }`）

**建议**：引入 Toast/Notification 系统统一用户可见错误。

### 5.2 减少重复代码

通过扫描发现 `ingest-queue.ts` 和 `dedup-queue.ts` 几乎**镜像实现**（相同的 pause/resume/persist/retry 逻辑），可提取为 `src/lib/serial-queue.ts` 抽象基类。

### 5.3 类型定义集中化

部分类型分散在多个 store 文件中（如 `LlmConfig` 定义在 `wiki-store.ts`），可提取到 `src/types/` 目录统一管理。

### 5.4 减少组件文件大小

`graph-view.tsx` (1245 行) 包含：
- Sigma 容器配置
- ForceAtlas2 布局控制
- 社区检测 UI
- Insights 面板
- 搜索/过滤逻辑
- 导出逻辑（待实现）

可拆分为：`graph-renderer.tsx`、`graph-controls.tsx`、`graph-insights-panel.tsx`。

---

## 6. 按技术领域分类

### 前端 React/TypeScript
| 改进 | 难度 | 工时 |
|------|------|------|
| 替换 window.alert 为 Dialog | 🟢 | 2-4h |
| i18n 硬编码清理 | 🟢 | 2-3h |
| 新语言支持 | 🟢 | 3-6h |
| 键盘快捷键系统 | 🟡 | 4-6h |
| a11y 改进 | 🟡 | 3-5h |
| CSV 结构化预览 | 🟡 | 4-6h |
| Graph 导出功能 | 🟡 | 3-5h |
| Sources 树虚拟滚动 | 🟡 | 3-5h |
| Graph 视图拆分 | 🟡 | 4-6h |
| WebGL 渲染后端 | 🔴 | 15-25h |

### Rust / Tauri
| 改进 | 难度 | 工时 |
|------|------|------|
| 新文件格式解析 (epub/html) | 🟡 | 4-8h |
| OpenAPI/Swagger 文档 | 🟡 | 3-4h |
| fs.rs 模块化拆分 | 🔴 | 10-20h |
| 向量搜索性能优化 | 🔴 | 10-15h |
| 多窗口支持 | 🔴 | 15-30h |

### 核心算法 / LLM
| 改进 | 难度 | 工时 |
|------|------|------|
| 新 LLM Provider 预设 | 🟡 | 2-4h |
| Ingest 流水线拆分 | 🔴 | 8-15h |
| Plugin 系统设计 | 🔴 | 20-40h |

### 基础设施 / 社区
| 改进 | 难度 | 工时 |
|------|------|------|
| `.typos.toml` 配置 | 🟢 | 30min |
| Issue/PR 模板 | 🟢 | 1h |
| 统一日志系统 | 🟢 | 2-3h |
| 更多文件类型图标 | 🟢 | 1-2h |
| 测试覆盖率补充 | 🟡 | 3-10h |

---

## 7. 提交贡献的最佳实践

### 7.1 开始之前
1. **阅读 README**：了解项目架构和快速开始指南
2. **查看现有 Issues/PRs**：避免重复劳动
3. **开 Discussion 或 Issue**：对于大型改动（>8h），先与维护者对齐设计

### 7.2 代码规范
- **TypeScript**：严格模式已开启，避免 `any`
- **Rust**：遵循 `cargo fmt` 和 `cargo clippy`
- **Commit Message**：参考现有风格（`fix:`, `feat:`, `refactor:`, `docs:`）
- **i18n**：所有用户可见字符串必须走 `t()`，同步更新 `en.json` 和 `zh.json`

### 7.3 测试要求
- 新增功能必须附带测试（`.test.ts`）
- 运行 `npm run test:mocks` 确保通过
- 涉及 LLM 的功能可只写 mock 测试（real-llm 测试可选）
- Rust 修改需确保 `cargo test` 通过

### 7.4 PR Checklist
```markdown
- [ ] 代码通过 `npm run typecheck`
- [ ] 测试通过 `npm run test:mocks`
- [ ] i18n 字符串已更新（如适用）
- [ ] 文档已更新（README/CHANGELOG，如适用）
- [ ] Rust 代码通过 `cargo clippy`（如适用）
- [ ] 手动测试确认 UI 正常（如适用）
```

---

*本指南基于代码静态分析生成，具体优先级请与项目维护者确认。*
