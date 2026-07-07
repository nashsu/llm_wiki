# LLM Wiki Python Backend

> **前端代码**：仍在原项目 `src/` 中，我们只改了其中 2 个文件。

---

## 1. 给谁看的

本文档面向**两类读者**：

- **原项目维护者** — 本文档将告诉你修改了哪些前端文件、新增了哪些后端 API、以及怎么接手。
- **其他 Python 贡献者** — 您可以直接阅读 `app/core/` 下的业务代码，所有函数都有类型注解和文档字符串。

---

## 2. 修改（以及添加）了哪些东西、原项目哪些没改

### 一句话概括

```
原项目: React 前端 → Tauri invoke() → Rust 命令 (42个) + Rust HTTP 服务器 (端口19828)
   ↓
现在:   React 前端 → fetch() HTTP → Python FastAPI (端口19828, Sidecar 进程)
```

### 我们改了的前端代码（只有 2 个文件）

| 文件 | 改动内容 | 行数 |
|------|---------|------|
| `src/commands/fs.ts` | 20 个 `invoke()` 全部替换为 HTTP `fetch()` | ~200 行 |
| `src/lib/embedding.ts` | 8 个向量操作 `invoke()` 替换为 HTTP `fetch()` | ~870 行 |

**其他 150+ 个前端文件（stores、components、lib 等）完全没动。**

### 我们改了的 Rust 代码（只有 1 行）

| 文件 | 改动 |
|------|------|
| `src-tauri/src/lib.rs` | 注释掉 `api_server::start_api_server()`，避免与 Python 后端端口冲突 |

### 我们新建的后端代码（Python，~100 个文件）

| 模块 | 路径 | 用途 |
|------|------|------|
| **API 路由层** | `app/api/routes/` (14 个文件) | 所有业务功能的 HTTP 端点 |
| **核心业务层** | `app/core/` (8 个子模块) | 摄入、LLM、图谱、搜索、聊天、Lint、研究、审核的逻辑实现 |
| **服务层** | `app/services/` (8 个文件) | 文件操作、配置管理、版本控制、向量存储 |
| **文档解析器** | `app/parsers/` (7 个文件) | PDF/DOCX/XLSX/PPTX/MD 插件式解析 |
| **测试** | `tests/` (18 个文件) | 598 个 pytest 测试 |

---

## 3. 修改初衷

| # | 痛点 | 原项目表现 | 怎么解决的 |
|---|------|-----------|--------------|
| 1 | **HTTP 服务器不稳定** | 自实现 `api_server.rs` (~1600行) 缺乏连接池和超时控制 | FastAPI + uvicorn |
| 2 | **崩溃后无法恢复** | `panic_guard.rs` 捕获 panic 后内部状态已损坏 | Python `try/except` 全面覆盖，异常分层处理 |
| 3 | **LLM 供应商硬编码，自定义性差** | `llm-providers.ts` 993 行，新增供应商需改前端代码 | 供应商配置存入 SQLite，运行时 API 动态增删改查 |
| 4 | **配置混合存储** | 全局偏好、API 密钥、项目设置混在一起 | 双层架构：全局 SQLite + 项目 `.llm-wiki/config.json`，关键配置跟随项目文件夹 |
| 5 | **摄入缓存跨平台失效** | USB 同步 raw/ 后换行符差异导致全量重新摄入 | SHA256 前规范化换行符 (CRLF→LF)，mtime 快速预检 |
| 6 | **提示词嵌入代码** | 所有 prompt 硬编码在 TS 文件中，无法自定义 | Jinja2 模板文件，用户可在项目中覆盖 |
| 7 | **无版本管理** | wiki/ 误操作无法回退 | Git 封装，可单独对raw和wiki文件夹进行版本控制，支持快照、分支、回退 |
| 8 | **无自动维护能力** | 批量去重/链接补全靠手工或脚本，失误风险大 | 内嵌 LangChain 智能体，协助用户自然语言批量维护 |

---

## 4. 怎么做的

### 架构迁移方式

以 **Sidecar 模式** 运行：Tauri Shell 在启动时 spawn 一个 Python 子进程运行 FastAPI 服务，前端通过 HTTP 调用该服务完成所有业务操作。

```
Tauri App 启动
  ├── WebView (React UI) → fetch() → http://127.0.0.1:19828
  ├── 系统托盘 (Rust 保留)
  └── Sidecar 进程管理器
       └── spawn → Python uvicorn (port 19828)
```

### 关键依赖选择

| 需要解决的问题 | 选择的库 | 替代了什么 |
|--------------|---------|-----------|
| HTTP 服务器 | FastAPI + uvicorn | 自实现 Rust `api_server.rs` |
| LLM 调用 | LangChain | 自实现 `llm-client.ts` |
| 向量数据库 | LanceDB Python SDK | Rust `vectorstore.rs` |
| 知识图谱 | networkx | 自实现图算法 (graphology) |
| PDF 解析 | PyMuPDF | Rust `pdf-extract` |
| 文件监听 | watchfiles | Rust `notify` |
| 文档解析 | python-docx / openpyxl / python-pptx | Rust 自实现解析器 |

---

## 5. 代码在哪、怎么调用、怎么维护

### 核心功能文件清单

```
app/core/maintenance/agent.py     # 维护 Agent (883行, 10个工具, 三阶段流程)
app/core/maintenance/dedup.py     # 语义去重
app/core/maintenance/wikilinks.py # WikiLink 补全
app/core/llm/factory.py           # LLM Factory (OpenAI/Anthropic/Google)
app/core/prompts/manager.py       # 提示词模板引擎 (Jinja2)
app/core/ingest/                   # 摄入管线 (7个文件)
app/core/chat/                     # 聊天 Agent (3个文件)
app/core/search/                   # 搜索引擎 (5个文件)
app/core/graph/                    # 知识图谱 (5个文件)
app/services/version_control.py   # Git 版本管理
app/services/chunk_vector_store.py # LanceDB 向量存储
app/parsers/                       # 插件式解析器 (7个文件)
```

### API 调用示例

**维护 Agent**（重点新功能）：

```bash
# Phase 1: 调查 — LLM 扫描 Wiki 生成操作方案
curl -X POST "http://127.0.0.1:19828/api/maintenance/{项目路径}/investigate" \
  -H "Content-Type: application/json" \
  -d '{"request":"把所有实体的中文标题改成英文"}'

# Phase 2: 预览 — dry-run 模拟执行，不修改任何文件
curl -X POST "http://127.0.0.1:19828/api/maintenance/{项目路径}/preview" \
  -H "Content-Type: application/json" \
  -d '{"plan":{...从investigate返回的plan...}}'

# Phase 3: 执行 — 自动创建 Git 快照后执行
curl -X POST "http://127.0.0.1:19828/api/maintenance/{项目路径}/execute" \
  -H "Content-Type: application/json" \
  -d '{"plan":{...},"confirmed":true}'
```

**LLM 供应商管理**：

```bash
curl -X POST "http://127.0.0.1:19828/api/providers" \
  -H "Content-Type: application/json" \
  -d '{"name":"我的代理","protocol":"openai","api_base":"...","api_key":"sk-...","default_model":"gpt-4o"}'
```

**版本管理**：

```bash
curl -X POST "http://127.0.0.1:19828/api/version/{项目路径}/snapshot" \
  -H "Content-Type: application/json" -d '{"name":"摄入前快照"}'

curl "http://127.0.0.1:19828/api/version/{项目路径}/snapshots"

curl -X POST "http://127.0.0.1:19828/api/version/{项目路径}/rollback" \
  -H "Content-Type: application/json" -d '{"snapshot_id":"abc123"}'
```

更多端点可在 http://127.0.0.1:19828/docs 交互式测试（Swagger UI）。

### 维护方式

```bash
# 运行全部 598 个测试
cd llm_wiki-backend-python
uv run pytest

# 以 debug 模式启动查看请求日志
uv run python run_server.py --port 19828 --log-level debug

# 添加新功能：新建 app/api/routes/xxx.py → 在 app/api/router.py 注册 → 写测试
```

---

## 6. 项目结构

> 假设 `llm_wiki-python` 已移动到 `llm_wiki-main` 下并改名为 `llm_wiki-backend-python`。

```
llm_wiki-main/                          # 原项目根目录（Tauri + React）
├── src/                                # 前端源代码
│   ├── commands/
│   │   └── fs.ts                       # ← 修改过 (invoke→fetch)
│   ├── lib/
│   │   ├── embedding.ts               # ← 修改过 (invoke→fetch)
│   │   ├── api-client.ts              # ← 新建 (HTTP 客户端封装)
│   │   └── tauri-fetch.ts             # ← 修改过 (插件fetch→原生fetch)
│   ├── stores/                         # ← 未修改
│   └── components/                     # ← 未修改
│
├── src-tauri/
│   └── src/
│       └── lib.rs                      # ← 注释掉1行 (api_server::start)
│
├── llm_wiki-backend-python/            # ← 本仓库 (Python 后端)
│   ├── app/
│   │   ├── main.py                     # FastAPI 入口
│   │   ├── config.py                   # 配置 (端口19828)
│   │   │
│   │   ├── api/
│   │   │   ├── router.py               # 路由聚合 (14模块)
│   │   │   └── routes/                 # API 端点 (14个文件)
│   │   │       ├── maintenance.py      # 维护 Agent (investigate/preview/execute)
│   │   │       ├── providers.py        # LLM 供应商管理
│   │   │       ├── version.py          # Git 版本管理
│   │   │       ├── chat.py             # 聊天 (SSE流式)
│   │   │       ├── ingest.py           # 摄入队列
│   │   │       ├── graph.py            # 知识图谱
│   │   │       ├── lint.py             # Wiki 结构检查
│   │   │       ├── research.py         # 深度研究
│   │   │       ├── review.py           # 审核系统
│   │   │       ├── files.py            # 文件操作
│   │   │       ├── projects.py         # 项目 CRUD
│   │   │       ├── config.py           # 配置管理
│   │   │       ├── vector.py           # 向量操作
│   │   │       ├── sidecar.py          # 健康检查
│   │   │       └── watcher.py          # 文件监听+剪藏
│   │   │
│   │   ├── core/                       # 业务核心
│   │   │   ├── maintenance/            # 维护 Agent (3个文件)
│   │   │   ├── llm/factory.py          # LLM 适配器
│   │   │   ├── prompts/                # 提示词模板 (9个.md文件)
│   │   │   ├── ingest/                 # 摄入管线 (7个文件)
│   │   │   ├── chat/                   # 聊天 Agent (3个文件)
│   │   │   ├── search/                 # 搜索引擎 (5个文件)
│   │   │   ├── graph/                  # 知识图谱 (5个文件)
│   │   │   ├── lint/                   # Lint 引擎 (2个文件)
│   │   │   ├── research/              # 深度研究 (2个文件)
│   │   │   └── review/                # 审核系统 (2个文件)
│   │   │
│   │   ├── services/                   # 服务层 (8个文件)
│   │   ├── parsers/                    # 文档解析器 (7个文件)
│   │   └── models/config.py            # 数据模型
│   │
│   ├── tests/                          # 598 个测试 (18个文件)
│   ├── run_server.py                   # 启动脚本
│   ├── pyproject.toml                  # 依赖 (89个包)
│   └── README.md                       # 本文件
│
├── package.json                        # ← 未修改
├── vite.config.ts                      # ← 未修改
├── .gitignore                          # 添加了 llm_wiki-backend-python/ 的忽略规则
└── README.md                           # 原项目 README（建议添加指向本文件的链接）
```

---

## 7. 无法继续的原因，请求原项目拥有者/其他开发者协助

### 我们无法继续的原因

1. **语言隔阂**：我不懂原项目的 TypeScript/Rust 代码，无法核查或修复 AI 编程工具造成的不完美，强行修改可能会导致项目破坏。虽然完成了 `invoke()`→`fetch()` 的机械替换，但我无法深入理解前端组件逻辑，无法确保每个边界情况都正确处理。
2. **业务复杂性**：原项目有大量复杂的交互逻辑（状态管理、异步队列、图谱可视化），这些需要原项目开发者验证和测试。
3. **测试环境**：没有真正的 Tauri 运行时和 Chrome 扩展环境，无法做端到端测试。

### 原项目拥有者需要做的事

| 优先级 | 事项 | 预计耗时 |
|--------|------|---------|
| **P0** | **审查 `src/commands/fs.ts` 的 git diff**，确认 20 个函数的 HTTP 映射都正确 | 30 分钟 |
| **P0** | **审查 `src/lib/embedding.ts` 的 git diff**，确认 8 个向量操作映射正确 | 20 分钟 |
| **P1** | 启动前后端（参见第 5 节），实际操作每个功能 | 1 小时 |
| **P1** | 通过 `/api/providers` API 配置您的 LLM 供应商和 API Key | 10 分钟 |
| **P2** | 补充 Python 端边缘测试用例 | 按需 |
| **P3** | 确认不再需要 Rust 后端后，删除 `src-tauri/src/commands/` | 30 分钟 |

核心维护点在 `llm_wiki-backend-python/app/core/` 目录下


### 关键依赖参考

| 包 | 文档 | 用途 |
|----|------|------|
| FastAPI | https://fastapi.tiangolo.com | API 框架 |
| LangChain | https://python.langchain.com | LLM 调用抽象 |
| networkx | https://networkx.org | 知识图谱 |
| LanceDB | https://lancedb.github.io | 向量数据库 |
| PyMuPDF | https://pymupdf.readthedocs.io | PDF 解析 |
| pytest | https://docs.pytest.org | 测试框架 |
