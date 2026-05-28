# LLM Wiki 项目学习路径

> 基于对 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 的深度代码分析，整理出系统化的学习路径。
> 生成时间：2026-05-25

---

## 目录

1. [项目概览](#1-项目概览)
2. [前置知识要求](#2-前置知识要求)
3. [学习阶段总览](#3-学习阶段总览)
4. [阶段一：技术栈基础](#4-阶段一技术栈基础)
5. [阶段二：前端架构与状态管理](#5-阶段二前端架构与状态管理)
6. [阶段三：LLM 集成与流式处理](#6-阶段三llm-集成与流式处理)
7. [阶段四：知识图谱与图算法](#7-阶段四知识图谱与图算法)
8. [阶段五：搜索与向量检索](#8-阶段五搜索与向量检索)
9. [阶段六：Rust 后端与桌面应用](#9-阶段六rust-后端与桌面应用)
10. [阶段七：数据持久化与队列系统](#10-阶段七数据持久化与队列系统)
11. [阶段八：测试策略与质量保障](#11-阶段八测试策略与质量保障)
12. [阶段九：高级主题与工程实践](#12-阶段九高级主题与工程实践)
13. [推荐学习顺序](#13-推荐学习顺序)
14. [实战练习建议](#14-实战练习建议)

---

## 1. 项目概览

**LLM Wiki** 是一个基于 Tauri v2 + React + Rust 构建的跨平台桌面知识库应用。核心功能是将用户的文档通过 LLM 自动转化为结构化、互联的 Wiki 知识网络。

### 核心特性

- **双步思维链 Ingest**：LLM 先分析后生成，带 SHA256 增量缓存
- **4 信号知识图谱**：直接链接、源重叠、Adamic-Adar、类型亲和度
- **Louvain 社区检测**：自动发现知识聚类
- **混合搜索**：关键词分词 + 向量语义检索 (LanceDB)
- **多 LLM Provider 支持**：OpenAI, Anthropic, Google, Azure, Ollama, Custom
- **Chrome Web Clipper**：一键网页捕获
- **本地 HTTP API**：127.0.0.1:19828，支持 AI Agent 集成

### 技术栈全景

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite |
| UI | shadcn/ui + Tailwind CSS v4 |
| 编辑器 | Milkdown (ProseMirror) |
| 状态管理 | Zustand |
| 图可视化 | sigma.js + graphology + ForceAtlas2 |
| 搜索 | Tokenized + Vector (LanceDB) |
| i18n | react-i18next |
| 测试 | Vitest + fast-check |

---

## 2. 前置知识要求

### 必备基础

- **TypeScript/JavaScript**：中级水平，理解泛型、类型推断、异步编程
- **React**：Hooks、组件生命周期、Context API
- **Rust**：基础语法、所有权、生命周期、错误处理 (`Result<T, E>`)
- **Git**：分支管理、合并、基本工作流

### 加分项

- 图论基础（节点、边、邻接矩阵）
- 信息检索基础（TF-IDF、向量空间模型）
- LLM API 使用经验（OpenAI/Claude）

---

## 3. 学习阶段总览

```
阶段一 (1-2周) → 阶段二 (1-2周) → 阶段三 (2-3周)
     ↓                ↓                ↓
阶段六 (2周)  → 阶段四 (1-2周) → 阶段五 (1-2周)
     ↓                ↓                ↓
阶段七 (1周)  → 阶段八 (1周)   → 阶段九 (持续)
```

---

## 4. 阶段一：技术栈基础

### 4.1 Tauri v2 桌面应用框架

**学习目标**：理解 Tauri 的架构模式（Rust 后端 + Web 前端）

**核心文件**：
- `src-tauri/src/lib.rs` — Tauri 应用入口，命令注册、插件初始化
- `src-tauri/src/main.rs` — 二进制入口
- `src-tauri/Cargo.toml` — Rust 依赖管理

**学习要点**：
1. `tauri::Builder` 配置模式
2. `#[tauri::command]` 宏定义前后端通信接口
3. `invoke_handler` 注册前端可调用的 Rust 命令
4. Tauri v2 插件系统 (`tauri-plugin-http`, `tauri-plugin-store`, `tauri-plugin-dialog`)
5. 窗口事件处理（macOS close-to-hide vs Windows/Linux 确认退出）

**参考代码**：
```rust
// src-tauri/src/lib.rs 核心模式
tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .setup(|app| { /* 初始化逻辑 */ })
    .invoke_handler(tauri::generate_handler![...])
    .on_window_event(|window, event| { /* 窗口事件 */ })
```

### 4.2 Vite + React 19 + TypeScript

**学习目标**：掌握现代前端构建工具链

**核心文件**：
- `vite.config.ts` — Vite 配置，含 Tauri 开发适配
- `tsconfig.json` / `tsconfig.app.json` — TypeScript 配置

**学习要点**：
1. `defineConfig` 中的环境变量注入（`__APP_VERSION__`）
2. `resolve.alias` 路径别名配置 (`@/ → ./src`)
3. Vite 测试环境配置 (`test.environment: "node"`)
4. TypeScript 严格模式与模块解析

### 4.3 Tailwind CSS v4 + shadcn/ui

**学习目标**：理解原子化 CSS 与组件库集成

**核心文件**：
- `components.json` — shadcn/ui 配置
- `src/components/ui/*.tsx` — 基础 UI 组件

**学习要点**：
1. Tailwind v4 的新特性（与 v3 的区别）
2. `class-variance-authority` (CVA) 组件变体管理
3. `tailwind-merge` + `clsx` 类名合并模式
4. shadcn/ui 的可复制组件模式（非 npm 包，直接复制源码）

---

## 5. 阶段二：前端架构与状态管理

### 5.1 Zustand 状态管理

**学习目标**：掌握轻量级全局状态管理

**核心文件**：
- `src/stores/wiki-store.ts` — 核心 Wiki 状态
- `src/stores/chat-store.ts` — 聊天状态
- `src/stores/activity-store.ts` — 活动面板状态
- `src/stores/review-store.ts` — Review 队列状态
- `src/stores/research-store.ts` — 深度研究状态

**学习要点**：
1. `create()` 函数创建 Store
2. Selector 模式避免不必要的重渲染 (`useWikiStore((s) => s.project)`)
3. Store 组合与派生状态
4. 状态持久化策略（与 `project-store.ts` 配合）

**参考代码**：
```typescript
import { create } from "zustand"

interface WikiStore {
  project: WikiProject | null
  fileTree: FileNode[]
  setProject: (p: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
}

export const useWikiStore = create<WikiStore>((set) => ({
  project: null,
  fileTree: [],
  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree }),
}))
```

### 5.2 组件架构与布局

**学习目标**：理解复杂桌面应用的组件组织

**核心文件**：
- `src/App.tsx` — 应用根组件，项目加载生命周期
- `src/components/layout/app-layout.tsx` — 三栏布局（可拖拽调整）
- `src/components/layout/icon-sidebar.tsx` — 图标侧边栏导航

**学习要点**：
1. **三栏布局模式**：左（知识树/文件树）+ 中（聊天）+ 右（预览）
2. **可拖拽面板实现**：`useRef` + mouse event 监听 + `userSelect: none`
3. **Error Boundary**：`src/components/error-boundary.tsx` 错误边界处理
4. **条件渲染**：基于 `activeView` 的状态驱动视图切换

### 5.3 Milkdown 编辑器集成

**学习目标**：理解 ProseMirror 架构的 Markdown 编辑器

**核心文件**：
- `src/components/editor/wiki-editor.tsx`
- `src/components/editor/wiki-reader.tsx`

**学习要点**：
1. Milkdown 的插件化架构
2. `@milkdown/plugin-math` KaTeX 数学公式支持
3. 自定义主题集成 (`@milkdown/theme-nord`)

---

## 6. 阶段三：LLM 集成与流式处理

### 6.1 多 Provider LLM 客户端

**学习目标**：抽象多供应商 LLM API 差异

**核心文件**：
- `src/lib/llm-client.ts` — 统一流式聊天接口
- `src/lib/llm-providers.ts` — Provider 配置与请求构建
- `src/lib/tauri-fetch.ts` — Tauri HTTP 封装

**学习要点**：
1. **统一接口设计**：`streamChat(config, messages, callbacks, signal)`
2. **Provider 抽象**：每个 provider 实现 `buildBody()`、`buildHeaders()`、`parseStream()`
3. **流式响应解析**：SSE (Server-Sent Events) 格式解析
4. **AbortController 超时控制**：30 分钟超长超时 + 用户取消
5. **Reasoning Token 处理**：DeepSeek/QwQ 的 `<think>` 块检测与流式展示

**参考代码**（流式解析模式）：
```typescript
const DECODER = new TextDecoder()

function parseLines(chunk: Uint8Array, buffer: string): [string[], string] {
  const text = buffer + DECODER.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}
```

### 6.2 CLI 子进程传输

**学习目标**：集成 Claude Code / Codex CLI 作为 LLM Provider

**核心文件**：
- `src/lib/claude-cli-transport.ts`
- `src/lib/codex-cli-transport.ts`
- `src-tauri/src/commands/claude_cli.rs`
- `src-tauri/src/commands/codex_cli.rs`

**学习要点**：
1. **子进程管理**：`tokio::process::Command` 启动 CLI
2. **行级流式输出**：stdout 逐行读取，实时返回前端
3. **进程生命周期管理**：spawn / kill / 状态检测
4. **跨平台路径解析**：`which` crate 查找可执行文件

### 6.3 上下文预算管理

**学习目标**：LLM 上下文窗口的智能分配

**核心文件**：
- `src/lib/context-budget.ts`

**学习要点**：
1. **预算分配策略**：Index 5% + Pages 50% + History+System ~30% + Response Reserve 15%
2. **Per-page 截断**：`maxPageSize = max(PER_PAGE_FLOOR, pageBudget * PER_PAGE_FRAC)`
3. **可配置 Context Window**：4K ~ 1M tokens 滑杆配置
4. **降级策略**：小配置下的最小可用保证

---

## 7. 阶段四：知识图谱与图算法

### 7.1 图数据模型构建

**学习目标**：从 Markdown 文件构建图结构

**核心文件**：
- `src/lib/graph-relevance.ts` — 图构建与相关性计算
- `src/lib/wiki-graph.ts` — 图数据模型 + 社区检测

**学习要点**：
1. **节点模型**：`RetrievalNode` = id + title + type + sources + outLinks + inLinks
2. **边提取**：Wikilink 正则 `\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]`
3. **Frontmatter 解析**：YAML 解析 title, type, sources 数组
4. **模块级缓存**：`cachedGraph` 避免重复构建

### 7.2 4-Signal 相关性模型

**学习目标**：多信号融合的图相关性算法

**核心文件**：`src/lib/graph-relevance.ts`

**学习要点**：

| 信号 | 权重 | 计算方式 |
|------|------|----------|
| Direct Link | ×3.0 | `[[wikilinks]]` 直接链接 |
| Source Overlap | ×4.0 | Frontmatter `sources[]` 共享源 |
| Adamic-Adar | ×1.5 | 共享邻居的加权相似度 |
| Type Affinity | ×1.0 | 同类型页面亲和度矩阵 |

**算法细节**：
- Adamic-Adar: `score = Σ(1 / log(|N(u)|))`，共享邻居的度越小权重越高
- 2-hop 遍历 + 衰减因子
- 相关性分数归一化与阈值过滤

### 7.3 Louvain 社区检测

**学习目标**：图聚类算法在知识管理中的应用

**核心文件**：`src/lib/wiki-graph.ts`

**学习要点**：
1. **graphology-communities-louvain** 库使用
2. **Resolution 参数调优**：控制社区粒度
3. **Cohesion 计算**：`intraEdges / possibleEdges`
4. **社区信息展示**：Top nodes、Member count、Cohesion score

### 7.4 图可视化 (sigma.js)

**学习目标**：大规模图的前端渲染

**核心文件**：`src/components/graph/graph-view.tsx`

**学习要点**：
1. **sigma.js + @react-sigma/core** React 集成
2. **ForceAtlas2 布局**：`graphology-layout-forceatlas2`
3. **节点样式**：颜色（按类型/社区）、大小（√linkCount）
4. **边样式**：粗细/颜色按相关性权重（绿=强，灰=弱）
5. **交互**：Hover 高亮邻居、Zoom 控制、位置缓存

---

## 8. 阶段五：搜索与向量检索

### 8.1 分词搜索

**学习目标**：CJK/英文混合文本检索

**核心文件**：
- `src/lib/search.ts` — 前端搜索接口
- `src-tauri/src/commands/search.rs` — Rust 后端搜索实现

**学习要点**：
1. **英文分词**：空格分隔 + 停用词过滤
2. **CJK Bigram 分词**：`每个 → [每个, 个…]` + 单字补充
3. **停用词表**：中英文混合停用词
4. **评分机制**：
   - 标题匹配加成 (+50~200)
   - 内容词频加成 (per occurrence +20, max 10)
   - Token 权重：Title ×5, Content ×1

**参考代码**（CJK Bigram）：
```typescript
const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
if (hasCJK && token.length > 2) {
  const chars = [...token]
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars[i] + chars[i + 1])  // Bigram
  }
  for (const ch of chars) {
    if (!STOP_WORDS.has(ch)) tokens.push(ch)  // 单字
  }
  tokens.push(token)  // 完整词
}
```

### 8.2 向量语义搜索

**学习目标**：Embedding-based 语义检索

**核心文件**：
- `src/lib/embedding.ts` — Embedding 生成与管理
- `src-tauri/src/commands/vectorstore.rs` — LanceDB 向量存储

**学习要点**：
1. **OpenAI-compatible Embedding API**：`/v1/embeddings`
2. **LanceDB**：Rust 嵌入式向量数据库
3. **文本分块**：`text-chunker.ts` 配置 (targetChars: 1000, overlap: 200)
4. **混合检索 RRF**：Reciprocal Rank Fusion 合并关键词+向量结果
5. **Cosine Similarity**：余弦相似度计算

### 8.3 检索管道设计

**学习目标**：多阶段检索架构

```
Phase 1: Tokenized Search (关键词)
  ↓
Phase 1.5: Vector Search (语义，可选)
  ↓
Phase 2: Graph Expansion (图相关性扩展)
  ↓
Phase 3: Budget Control (上下文预算分配)
  ↓
Phase 4: Context Assembly (组装 LLM 上下文)
```

---

## 9. 阶段六：Rust 后端与桌面应用

### 9.1 Tauri Commands 模式

**学习目标**：Rust 命令的设计与实现

**核心文件**：
- `src-tauri/src/commands/fs.rs` — 文件系统操作
- `src-tauri/src/commands/search.rs` — 搜索命令
- `src-tauri/src/commands/project.rs` — 项目管理

**学习要点**：
1. **`#[tauri::command]`** 宏标记
2. **`spawn_blocking`**：同步 I/O（PDF/Office 解析）放到阻塞线程池
3. **`run_guarded`** / **`run_guarded_async`**：Panic 捕获，防止单文件错误崩溃整个应用
4. **文件类型检测与分发**：根据扩展名路由到不同解析器

### 9.2 多格式文档解析

**学习目标**：PDF/Office/图片等格式处理

**核心文件**：`src-tauri/src/commands/fs.rs`

**学习要点**：

| 格式 | 解析方法 | Rust Crate |
|------|----------|------------|
| PDF | pdfium-render (FFI) | `pdfium-render` |
| DOCX | XML 结构化解析 | `docx-rs` |
| PPTX | ZIP + XML 提取 | `zip` |
| XLSX/ODS | 表格数据提取 | `calamine` |
| ODT/ODP | ZIP 文本提取 | `zip` |
| 图片 | 元数据展示 | `image` |

**缓存策略**：`.cache/{filename}.txt` 预处理缓存

### 9.3 内嵌 HTTP API Server

**学习目标**：桌面应用内嵌 REST API

**核心文件**：`src-tauri/src/api_server.rs`

**学习要点**：
1. **`tiny_http`** 库构建轻量 HTTP 服务器
2. **端口冲突处理**：自动重试绑定 (port 19828)
3. **速率限制**：滑动窗口限流 (120 req/s)
4. **并发控制**：最大 64 个在途请求
5. **Panic 隔离**：每个请求在 `catch_unwind` 中执行
6. **路径安全**：防止目录遍历攻击 (`../` 过滤)

### 9.4 向量存储 (LanceDB)

**学习目标**：Rust 中的向量数据库操作

**核心文件**：`src-tauri/src/commands/vectorstore.rs`

**学习要点**：
1. **Arrow 数据模型**：`arrow-array` + `arrow-schema`
2. **向量表设计**：page-level + chunk-level 双表结构
3. **CRUD 操作**：Upsert / Search / Delete / Count
4. **Embedding 超时**：8 秒超时回退

### 9.5 Panic Guard 模式

**学习目标**：Rust 错误处理的最佳实践

**核心文件**：`src-tauri/src/panic_guard.rs`

**学习要点**：
- 用 `std::panic::catch_unwind` 捕获第三方库 panic
- 将 panic 转为 `Result<T, String>` 返回给前端
- `panic = "unwind"` 的 release 配置（非 abort）

---

## 10. 阶段七：数据持久化与队列系统

### 10.1 持久化队列设计

**学习目标**：可靠的任务队列实现

**核心文件**：
- `src/lib/ingest-queue.ts` — Ingest 队列
- `src/lib/dedup-queue.ts` — 去重合并队列

**学习要点**：
1. **队列状态**：pending → processing → done / failed
2. **持久化**：JSON 文件存盘 (`{project}/.llm-wiki/queue.json`)
3. **重试策略**：最多 3 次自动重试
4. **项目隔离**：按 `projectId` 隔离队列
5. **取消支持**：`AbortController` 中断处理
6. **串行处理**：防止并发文件写入冲突

### 10.2 项目状态管理

**学习目标**：多项目配置持久化

**核心文件**：`src/lib/project-store.ts`

**学习要点**：
1. **Tauri Store Plugin**：`tauri-plugin-store` 键值存储
2. **配置分层**：App 级 (全局) + Project 级 (项目内)
3. **最近项目列表**：快速切换
4. **LLM 配置持久化**：Provider / API Key / Model / Context Size

### 10.3 自动保存机制

**学习目标**：前端状态自动持久化

**核心文件**：`src/lib/auto-save.ts`

**学习要点**：
1. **防抖保存**：变更后延迟写入
2. **批量合并**：减少 I/O 次数
3. **错误恢复**：写入失败不重试，避免循环

---

## 11. 阶段八：测试策略与质量保障

### 11.1 测试金字塔

**学习目标**：全面的测试覆盖策略

```
        /\  E2E / Integration (real-llm)
       /  \     ↓ 慢，成本高
      /----\  Scenarios (业务场景)
     /------\ Property-based (fast-check)
    /--------\ Unit Tests (vitest)
```

### 11.2 单元测试

**核心文件**：`*.test.ts` 遍布各模块

**学习要点**：
1. **Vitest** 测试框架配置 (`vite.config.ts` 中 `test.environment: "node"`)
2. **测试文件命名**：`{module}.test.ts` / `{module}.property.test.ts`
3. **Mock 策略**：`mock-stream-chat.ts` 模拟 LLM 流式响应

### 11.3 属性测试 (Property-based Testing)

**学习目标**：基于 fast-check 的随机测试

**核心文件**：
- `src/lib/path-utils.property.test.ts`
- `src/lib/review-utils.property.test.ts`

**学习要点**：
1. **Arbitrary 生成**：随机输入数据生成
2. **不变量断言**：对任意输入都成立的性质
3. **Shrink 缩小**：失败时自动最小化复现用例

### 11.4 场景测试 (Scenario Testing)

**学习目标**：业务场景端到端测试

**核心文件**：`src/test-helpers/scenarios/*.ts`

**学习要点**：
1. **Scenario DSL**：定义输入→操作→断言的场景
2. **Materialize**：将场景转化为实际文件系统状态
3. **LLM 场景测试**：`*.real-llm.test.ts` 使用真实 LLM API

### 11.5 Real-LLM 集成测试

**学习目标**：与真实 LLM 的集成验证

**核心文件**：`*.real-llm.test.ts`

**学习要点**：
1. **环境隔离**：`.env.test.local` 加载 API Key
2. **超时配置**：长耗时测试（LLM 调用）
3. **串行执行**：`--no-file-parallelism` 避免并发费用爆炸
4. **条件跳过**：无 API Key 时优雅跳过

---

## 12. 阶段九：高级主题与工程实践

### 12.1 Ingest 流水线设计

**学习目标**：复杂的 LLM 驱动数据处理管道

**核心文件**：`src/lib/ingest.ts` (1833 行)

**学习要点**：
1. **双步 Ingest**：
   - Step 1: Analysis（LLM 分析源文件 → 结构化分析）
   - Step 2: Generation（LLM 基于分析生成 Wiki 页面）
2. **增量缓存**：SHA256 内容哈希，未变更文件跳过
3. **文件块解析**：`---FILE: path---\ncontent\n---END FILE---` 格式
4. **路径安全**：防止 `../../../etc/passwd` 等路径遍历
5. **Source Identity**：稳定的源文件标识与映射
6. **图片提取与 Caption**：PDF/Office 图片提取 → VLM Caption 生成

### 12.2 国际化 (i18n)

**学习目标**：多语言桌面应用

**核心文件**：`src/i18n/index.ts`

**学习要点**：
1. **react-i18next** 集成
2. **语言检测**：`detectLanguage.ts` 基于字符集和关键词
3. **双语界面**：English + Chinese
4. **语言指令**：LLM Prompt 中注入语言要求

### 12.3 跨平台兼容

**学习目标**：Windows / macOS / Linux 差异处理

**学习要点**：
1. **路径规范化**：`normalizePath()` 统一正反斜杠
2. **Unicode 安全**：字符级切片（防 CJK 截断）
3. **macOS 特性**：Close → Hide（Dock 图标恢复）
4. **Windows/Linux**：退出确认对话框
5. **CI/CD**：GitHub Actions 多平台构建

### 12.4 Chrome Extension (Web Clipper)

**学习目标**：浏览器扩展开发

**核心目录**：`extension/`

**学习要点**：
1. **Manifest V3**：Chrome 扩展清单
2. **Readability.js**：文章正文提取
3. **Turndown.js**：HTML → Markdown 转换
4. **本地 HTTP 通信**：Extension ↔ App (port 19827)
5. **Project Picker**：多项目选择

### 12.5 代码组织模式

**学习目标**：大型前端项目的目录结构

```
src/
├── commands/        # Tauri 命令封装（前端侧）
├── components/      # React 组件（按功能分组）
│   ├── chat/        # 聊天相关
│   ├── editor/      # 编辑器
│   ├── graph/       # 图谱
│   ├── layout/      # 布局
│   ├── settings/    # 设置
│   └── ui/          # 基础 UI 组件
├── lib/             # 业务逻辑（核心！）
│   ├── __tests__/   # 集成测试
│   ├── ingest*.ts   # Ingest 流水线
│   ├── graph*.ts    # 图算法
│   ├── search*.ts   # 搜索
│   ├── llm*.ts      # LLM 客户端
│   └── ...          # 其他业务模块
├── stores/          # Zustand 状态管理
├── test-helpers/    # 测试工具与场景
├── types/           # TypeScript 类型定义
├── i18n/            # 国际化
└── App.tsx          # 应用入口
```

---

## 13. 推荐学习顺序

### 快速上手路径（2 周）

适合想快速理解项目全貌的开发者：

1. **Day 1-2**: 技术栈基础（Tauri + Vite + React）
2. **Day 3-4**: 状态管理（Zustand）+ 组件架构
3. **Day 5-7**: LLM 客户端（llm-client.ts, llm-providers.ts）
4. **Day 8-10**: 搜索系统（search.ts + Rust search.rs）
5. **Day 11-14**: Ingest 流水线（ingest.ts）

### 深度学习路径（6-8 周）

适合想全面掌握项目工程实践的开发者：

| 周次 | 主题 | 核心产出 |
|------|------|----------|
| 1 | Tauri + Rust 基础 | 能独立添加一个 Tauri Command |
| 2 | React + Zustand 架构 | 理解状态流，能添加新 Store |
| 3 | LLM 流式处理 | 能集成新的 LLM Provider |
| 4 | 搜索与分词 | 理解 RRF，能优化搜索评分 |
| 5 | 图算法 | 能修改相关性权重或添加新信号 |
| 6 | Rust 后端 | 能添加文件格式支持或 API 端点 |
| 7 | 队列与持久化 | 能设计新的任务队列 |
| 8 | 测试与优化 | 能编写 Property-based 测试 |

---

## 14. 实战练习建议

### 练习 1：添加新 LLM Provider
**目标**：在 `llm-providers.ts` 中添加一个自定义 Provider（如 Groq 或 Mistral）
**涉及**：Provider 配置、请求构建、流式解析

### 练习 2：优化图相关性算法
**目标**：在 `graph-relevance.ts` 中添加第 5 个信号（如 TF-IDF 内容相似度）
**涉及**：图遍历、权重计算、缓存策略

### 练习 3：实现新的文件格式支持
**目标**：在 `fs.rs` 中添加 `.epub` 格式解析
**涉及**：Rust 文件类型检测、第三方 crate 集成、缓存

### 练习 4：扩展 Chrome Extension
**目标**：在 Extension 中添加右键菜单"添加到 Wiki"
**涉及**：Manifest V3、Content Script、Background Service Worker

### 练习 5：添加新的图布局算法
**目标**：在 `graph-view.tsx` 中切换 ForceAtlas2 和 circular 布局
**涉及**：sigma.js 布局、React 状态同步、动画过渡

### 练习 6：编写 Property-based 测试
**目标**：为 `tokenizeQuery` 函数编写 fast-check 属性测试
**涉及**：Arbitrary 生成、不变量定义、Shrink 验证

### 练习 7：实现本地 Embedding 端点
**目标**：在 `embedding.ts` 中添加 Ollama Embedding 支持
**涉及**：HTTP 请求、向量验证、错误回退

---

## 附录：关键文件速查表

| 主题 | 文件路径 | 说明 |
|------|----------|------|
| Tauri 入口 | `src-tauri/src/lib.rs` | 应用初始化、命令注册 |
| Tauri 命令 | `src-tauri/src/commands/fs.rs` | 文件读写、格式解析 |
| API Server | `src-tauri/src/api_server.rs` | HTTP API、速率限制 |
| 向量存储 | `src-tauri/src/commands/vectorstore.rs` | LanceDB 向量操作 |
| 搜索后端 | `src-tauri/src/commands/search.rs` | 关键词+向量搜索 |
| 前端入口 | `src/App.tsx` | 项目加载、初始化 |
| 布局组件 | `src/components/layout/app-layout.tsx` | 三栏拖拽布局 |
| 状态管理 | `src/stores/wiki-store.ts` | 全局状态 |
| LLM 客户端 | `src/lib/llm-client.ts` | 统一流式接口 |
| Provider | `src/lib/llm-providers.ts` | 多供应商配置 |
| Ingest | `src/lib/ingest.ts` | 双步 Ingest 流水线 |
| 图相关性 | `src/lib/graph-relevance.ts` | 4-Signal 模型 |
| 图可视化 | `src/components/graph/graph-view.tsx` | sigma.js 渲染 |
| 搜索前端 | `src/lib/search.ts` | 分词搜索接口 |
| Embedding | `src/lib/embedding.ts` | 向量生成 |
| 上下文预算 | `src/lib/context-budget.ts` | 预算分配算法 |
| 队列系统 | `src/lib/ingest-queue.ts` | 持久化任务队列 |
| i18n | `src/i18n/index.ts` | 国际化配置 |
| Vite 配置 | `vite.config.ts` | 构建配置 |

---

*本文档由代码分析自动生成，建议结合实际代码阅读以获得最佳学习效果。*
