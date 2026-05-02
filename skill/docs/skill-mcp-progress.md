# llm_wiki Node.js Skill + MCP Server — 方案与进度

> 文档生成日期：2026-05-02  
> 状态：**进行中** — ingest / deep-research 实现中，PR 待更新

---

## 一、背景与目标

### 项目来源

[nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) 是一个基于 Tauri v2（Rust + React/TypeScript）的桌面应用，核心功能是把本地源文件（Markdown/PDF/DOCX）通过 LLM 自动整理成结构化 Wiki。

### 需求

bid-sys 项目需要其后台核心逻辑，但 **不需要 GUI（Tauri 桌面应用）**，目标是：

1. **Node.js Skill** — 纯命令行可调用的 wiki 管理工具
2. **MCP Server** — 将 wiki 操作暴露为 AI 可调用的工具（供 Claude Desktop / VS Code Copilot Chat 使用）
3. **贡献 MCP** — 向 nashsu/llm_wiki 提交 PR，将 MCP 服务器作为官方插件

---

## 二、架构分析

### nashsu/llm_wiki 技术栈

```
llm_wiki/
├── src/              # React + TypeScript 前端（GUI 层）
│   ├── lib/          # 核心业务逻辑（纯 TypeScript）⬅ 我们需要的
│   ├── stores/       # Zustand React 状态管理
│   └── commands/     # Tauri IPC 桥接层
├── src-tauri/        # Rust 后端（文件 I/O、PDF 提取、系统集成）
```

### 两个注入点

所有 `src/lib/*.ts` 通过两个抽象层与 Tauri 交互：

| 原始导入 | 功能 | Node.js 替代 |
|---------|------|-------------|
| `@/commands/fs` | 文件读写/列举 | `shims/fs-node.ts` |
| `@/stores/*` | 应用状态（LLM 配置等）| `shims/stores-node.ts` |

Tauri HTTP 代理（`tauri-fetch.ts`）已内置 `isNodeEnv` 检测，直接降级到 `globalThis.fetch`，无需额外适配。

---

## 三、实现方案

### 方案选择：自包含副本（Self-Contained Copy）

将 `src/lib/*.ts` 复制并修补到 `skill/src/lib/`，修改所有 `@/` 路径别名为相对路径，完全独立于原始项目结构。

**优点：** 不依赖 tsconfig 路径别名，构建简单，易于移植  
**缺点：** 需手工同步上游更新

### 目录结构

```
skill/
├── src/
│   ├── cli.ts             # CLI 入口（8 个命令）
│   ├── mcp-server.ts      # MCP 服务器（7 个工具）
│   ├── lib/               # 从 nashsu/llm_wiki 移植的核心库
│   │   ├── graph-relevance.ts
│   │   ├── wiki-graph.ts
│   │   ├── graph-insights.ts
│   │   ├── search.ts
│   │   ├── path-utils.ts
│   │   ├── llm-client.ts        # LLM SSE 流式调用
│   │   ├── detect-language.ts   # Unicode 脚本语言检测
│   │   ├── output-language.ts   # 输出语言指令构建
│   │   ├── frontmatter.ts       # YAML frontmatter 解析器
│   │   ├── sources-merge.ts     # Frontmatter 数组字段合并
│   │   ├── page-merge.ts        # Wiki 页面内容合并（LLM）
│   │   ├── ingest-sanitize.ts   # LLM 输出清理
│   │   ├── ingest-cache.ts      # SHA256 内容缓存
│   │   ├── project-mutex.ts     # 按项目路径的异步互斥锁
│   │   ├── ingest.ts            # 核心 ingest 流水线（待完成）
│   │   └── web-search.ts        # Tavily 搜索 API
│   ├── shims/             # Tauri → Node.js 适配层
│   │   ├── fs-node.ts
│   │   ├── stores-node.ts
│   │   └── embedding-stub.ts
│   └── types/
│       └── wiki.ts
├── package.json
└── tsconfig.json

mcp-server/               # 独立 MCP 包（用于 PR 提交）
├── src/index.ts
├── package.json
└── README.md
```

---

## 四、功能清单

### CLI 命令

| 命令 | 状态 | 说明 |
|------|------|------|
| `status` | ✅ | 统计 wiki 页面数量/类型 |
| `search <query>` | ✅ | BM25+RRF 全文搜索 |
| `graph` | ✅ | 构建并输出知识图谱（Louvain 社区检测）|
| `insights` | ✅ | 发现意外关联 + 知识盲点 |
| `lint` | ✅ | 检测孤立页面/断链/缺失字段 |
| `init` | ✅ | 初始化 wiki 目录结构 |
| `ingest <file>` | 🔄 | LLM 自动摄入源文件 → wiki 页面 |
| `deep-research <topic>` | 🔄 | 网络搜索 → LLM 综合 → 自动摄入 |

### MCP 工具

| 工具 | 状态 | 说明 |
|------|------|------|
| `wiki_status` | ✅ | 获取 wiki 统计 |
| `wiki_search` | ✅ | 搜索 wiki 页面 |
| `wiki_graph` | ✅ | 获取知识图谱 |
| `wiki_insights` | ✅ | 获取 AI 见解 |
| `wiki_lint` | ✅ | 检查 wiki 健康度 |
| `wiki_ingest` | 🔄 | 摄入源文件 |
| `wiki_deep_research` | 🔄 | 深度研究 |

---

## 五、环境变量配置

```bash
# LLM 配置（ingest / deep-research 必需）
export LLM_PROVIDER=openai          # openai | anthropic | ollama | deepseek
export OPENAI_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini
export LLM_BASE_URL=                # 自定义端点（可选）

# 网络搜索（deep-research 必需）
export TAVILY_API_KEY=tvly-...

# 输出语言（可选，默认 auto 自动检测）
export WIKI_OUTPUT_LANGUAGE=auto    # auto | English | Chinese | Japanese | ...

# 调试
export SKILL_VERBOSE=1              # 输出详细日志到 stderr
```

---

## 六、依赖

```json
{
  "dependencies": {
    "graphology": "^0.25.4",
    "graphology-communities-louvain": "^2.0.0",
    "@modelcontextprotocol/sdk": "^1.1.0",
    "js-yaml": "^4.1.0"
  }
}
```

---

## 七、开发进度

### 已完成

- [x] 分析 nashsu/llm_wiki 架构，识别 Tauri 注入点
- [x] 创建 `shims/fs-node.ts` — Tauri IPC → Node.js fs 适配
- [x] 创建 `shims/stores-node.ts` — Zustand → 模块级状态，支持 env 配置 LLM
- [x] 创建 `shims/embedding-stub.ts` — 向量搜索优雅降级
- [x] 移植并修补所有图谱库（graph-relevance, wiki-graph, graph-insights）
- [x] 移植搜索库（BM25+RRF，向量可选）
- [x] 移植 path-utils（纯工具函数）
- [x] 实现 CLI 6 个命令：status/search/graph/insights/lint/init
- [x] 实现 MCP 服务器 5 个工具
- [x] npm install + tsc 构建通过
- [x] 端到端测试：合成 wiki 数据验证所有命令
- [x] Fork nashsu/llm_wiki → toughhou/llm_wiki
- [x] 移植 llm-client.ts（OpenAI 兼容 SSE 流式调用）
- [x] 移植 detect-language.ts（Unicode 脚本检测）
- [x] 移植 output-language.ts
- [x] 移植 frontmatter.ts（js-yaml 解析）
- [x] 移植 sources-merge.ts（数组字段合并）
- [x] 移植 page-merge.ts（LLM 辅助页面合并）
- [x] 移植 ingest-sanitize.ts（LLM 输出清洗）
- [x] 移植 ingest-cache.ts（SHA256 增量缓存）
- [x] 移植 project-mutex.ts（并发保护）
- [x] 移植 web-search.ts（Tavily API）
- [x] 提交 PR #117 到 nashsu/llm_wiki

### 进行中

- [ ] 完成 ingest.ts — 两阶段 LLM 流水线（分析 → 生成 → 写文件）
- [ ] 完成 deep-research.ts — 网络搜索 → LLM 综合 → auto-ingest
- [ ] CLI 添加 ingest / deep-research 命令
- [ ] MCP 服务器添加 wiki_ingest / wiki_deep_research 工具
- [ ] 端到端测试（需真实 LLM API Key）
- [ ] 更新 PR #117

### 待完成

- [ ] sweep-reviews（批量审核 wiki 页面）
- [ ] 嵌入向量搜索（可选，需 embedding API）

---

## 八、PR 提交记录

| PR | 仓库 | 分支 | 状态 |
|----|------|------|------|
| #117 | nashsu/llm_wiki | feat/mcp-server | 开放中，待更新 |

---

## 九、本地测试方法

```bash
cd skill && npm install && npm run build

# 测试基础命令
node dist/cli.js status /path/to/wiki-project
node dist/cli.js search "machine learning" /path/to/wiki-project
node dist/cli.js graph /path/to/wiki-project
node dist/cli.js insights /path/to/wiki-project
node dist/cli.js lint /path/to/wiki-project

# 测试 ingest（需 LLM API Key）
export OPENAI_API_KEY=sk-xxx
node dist/cli.js ingest /path/to/source.md /path/to/wiki-project

# 测试 deep-research（需 LLM + Tavily）
export TAVILY_API_KEY=tvly-xxx
node dist/cli.js deep-research "transformer architecture" /path/to/wiki-project

# 启动 MCP 服务器
node dist/mcp-server.js
```

---

## 十、相关资源

- 上游仓库：https://github.com/nashsu/llm_wiki
- 本仓库（fork）：https://github.com/toughhou/llm_wiki
- PR #117：https://github.com/nashsu/llm_wiki/pull/117
- bid-sys 项目：https://github.com/toughhou/bid-sys
