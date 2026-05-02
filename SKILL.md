---
name: llm-wiki-nashsu
version: 0.4.6-skill
author: nashsu (GUI→Skill 适配: bid-sys team)
license: MIT
description: |
  基于 nashsu/llm_wiki 后端逻辑提取的知识库技能（无 GUI）。
  核心算法包括：4 信号图谱相关度模型、Louvain 社区检测、图谱洞察（惊人连接+知识缺口）、
  RRF 混合搜索（BM25+向量）、深度研究（网络搜索+自动消化）、异步审核队列。
  触发条件：用户明确提到知识库、wiki、图谱分析、深度研究，或要求对已初始化的知识库执行
  消化、搜索、健康检查等操作。
metadata:
  hermes:
    tags:
      - knowledge-base
      - wiki
      - graph-analysis
      - deep-research
      - semantic-search
  origin: nashsu/llm_wiki (GUI stripped, backend extracted)
  runtime: node >= 20
  adapted_from: https://github.com/nashsu/llm_wiki
---

# llm-wiki-nashsu — 高级知识库后端技能

> 从 nashsu/llm_wiki 提取的后端逻辑，去除 Tauri GUI 后适配为 Hermes Skill。
> 与 llm-wiki-skill 相比，本技能具有**显著更强的图谱分析能力**，但需要 Node.js 运行时。

## 核心差异化能力

| 能力 | 本技能 | llm-wiki-skill |
|------|-------|----------------|
| **图谱相关度** | 4 信号模型（直接链接×3 + 来源重叠×4 + Adamic-Adar×1.5 + 类型亲和×1）| 3 信号模型（共引强度 + 来源重叠 + 类型亲和度）|
| **社区检测** | Louvain 算法 + 凝聚度评分 | Louvain 算法（graph-analysis.js）|
| **图谱洞察** | 惊人连接 + 知识缺口 + 桥节点检测 | 惊人连接 + 桥节点 + 孤立节点 + 稀疏社区（大图自动降级）|
| **搜索** | RRF 混合（BM25 + 向量） | Grep + 别名展开 + 段落上限 |
| **深度研究** | 网络搜索→LLM 综合→自动消化 | 无 |
| **审核队列** | 异步异步 sweep-reviews 系统 | 无 |
| **图像处理** | 视觉 API 图像标注管线 | 无 |
| **数字山水可视化** | 无（sigma.js 通用图谱）| ✅ 东方编辑部 × 数字山水风交互式 HTML |
| **置信度标注** | 无 | ✅ EXTRACTED / INFERRED / AMBIGUOUS / UNVERIFIED |
| **SessionStart hook** | 无 | ✅ 会话自动注入 wiki 上下文 |

---

## Script Directory

Scripts located in `skill/` subdirectory relative to this SKILL.md.

**Path Resolution**:
1. `SKILL_DIR` = this SKILL.md's directory
2. Script path = `${SKILL_DIR}/skill/<command>`

---

## 依赖要求

```
node >= 20
npm >= 9
```

**可选依赖（启用向量搜索）**：
- 配置 `EMBEDDING_API_BASE` 和 `EMBEDDING_MODEL` 环境变量（OpenAI 兼容端点）

---

## 工作流命令

### 1. init — 初始化知识库

```bash
node ${SKILL_DIR}/skill/cli.js init <wiki_root> [topic] [lang]
```

**参数**：
- `wiki_root`：wiki 工作目录（绝对路径）
- `topic`：知识库主题（可选，默认 "My Knowledge Base"）
- `lang`：语言（可选，`zh`|`en`，默认 `en`）

**产物**：
```
<wiki_root>/
├── wiki/
│   ├── entities/
│   ├── concepts/
│   ├── sources/
│   ├── queries/
│   └── index.md
├── raw/
└── .wiki-config.json
```

---

### 2. ingest — 消化素材

```bash
node ${SKILL_DIR}/skill/cli.js ingest <wiki_root> <file_path> [--llm-api-key=KEY]
```

**参数**：
- `wiki_root`：wiki 工作目录
- `file_path`：待消化的文件路径（支持 .md / .txt；PDF/DOCX 需先转为文本）
- `--llm-api-key`：LLM API Key（也可通过 `OPENAI_API_KEY` 环境变量传入）

**处理流程**（源自 `ingest.ts`）：
1. **Step 1**：LLM 分析素材 → 生成结构化 JSON（实体、概念、关系）
2. **Step 2**：基于 JSON 生成 wiki 页面：
   - `wiki/sources/{slug}.md` — 素材摘要页（含 `sources: []` frontmatter）
   - `wiki/entities/{name}.md` — 实体页（仅限新实体）
   - `wiki/concepts/{name}.md` — 概念页（仅限新概念）
3. **自动消化**：生成的页面自动进入 wiki 图谱（下次 graph 命令时生效）
4. **审核标记**：LLM 自动标记需人工判断的条目（`review: true` frontmatter）

**产物示例**：
```json
{
  "status": "success",
  "pages": [
    "wiki/sources/2026-04-30-企业资质证书.md",
    "wiki/entities/市政公用工程施工总承包壹级.md"
  ],
  "reviews_pending": 1
}
```

---

### 3. batch-ingest — 批量消化

```bash
node ${SKILL_DIR}/skill/cli.js batch-ingest <wiki_root> <dir_path>
```

按目录递归处理所有 `.md`/`.txt` 文件，保留目录结构作为分类上下文。
失败不阻塞后续文件（标记失败项，继续）。

---

### 4. search — 智能搜索

```bash
node ${SKILL_DIR}/skill/cli.js search <wiki_root> <query> [--limit=20]
```

**算法**（源自 `search.ts`，18KB）：
1. **BM25 词法搜索**：中文 CJK bigram 分词 + 停用词过滤 + 精确词组匹配加权
2. **向量语义搜索**（可选）：LanceDB ANN 检索（需配置嵌入端点）
3. **RRF 融合**：倒数秩融合（K=60），避免量纲不一致

**输出**：JSON 格式检索结果（path, title, snippet, score, images）

---

### 5. graph — 构建知识图谱

```bash
node ${SKILL_DIR}/skill/cli.js graph <wiki_root> [--output=graph-data.json]
```

**算法**（源自 `wiki-graph.ts` + `graph-relevance.ts`）：
1. **读取所有 wiki 页面**，提取标题、类型、wikilink
2. **4 信号相关度计算**（每条边）：
   - 直接链接（weight 3.0）
   - 来源重叠（weight 4.0，基于 `sources: []` frontmatter）
   - Adamic-Adar 共同邻居（weight 1.5）
   - 类型亲和度（weight 1.0）
3. **Louvain 社区检测**（graphology-communities-louvain）：
   - 自动聚类，计算每个社区凝聚度（实际边/可能边）
   - 低凝聚度社区（<0.15）标记为警告
4. **输出**：`graph-data.json`（nodes + edges + communities）

**输出格式**：
```json
{
  "nodes": [{ "id": "xxx", "label": "...", "type": "entity", "linkCount": 5, "community": 0 }],
  "edges": [{ "source": "xxx", "target": "yyy", "weight": 7.2 }],
  "communities": [{ "id": 0, "nodeCount": 12, "cohesion": 0.24, "topNodes": ["..."] }]
}
```

---

### 6. insights — 图谱洞察

```bash
node ${SKILL_DIR}/skill/cli.js insights <wiki_root>
```

**算法**（源自 `graph-insights.ts`，193 行）：
1. **惊人连接**（Surprising Connections）：
   - 跨社区边 +3，跨类型边 +2，边缘↔枢纽耦合 +2，弱连接 +1
   - 阈值 ≥3 才输出
2. **知识缺口**（Knowledge Gaps）：
   - 孤立节点（degree ≤1）
   - 稀疏社区（cohesion <0.15 且 ≥3 节点）
   - 桥节点（连接 ≥3 个社区）

**输出**：Markdown 格式洞察报告

---

### 7. deep-research — 深度研究

```bash
node ${SKILL_DIR}/skill/cli.js deep-research <wiki_root> <topic> [--queries="q1|q2|q3"]
```

**流程**（源自 `deep-research.ts`，244 行）：
1. **网络搜索**：多查询并行搜索（Tavily API），URL 去重合并
2. **LLM 综合**：搜索结果 → wiki 页面（带 `[[wikilink]]` 交叉引用）
3. **保存**：`wiki/queries/research-{slug}-{date}.md`
4. **自动消化**：研究结果自动 ingest，提取实体/概念

**环境变量**：`TAVILY_API_KEY`（或 `SERPER_API_KEY`）

---

### 8. lint — 健康检查

```bash
node ${SKILL_DIR}/skill/cli.js lint <wiki_root>
```

**检查项**（源自 `lint.ts`）：
- 孤立页面（无入链且无出链）
- 断链（`[[wikilink]]` 指向不存在的页面）
- 过短页面（< 100 字）
- 语言不一致（frontmatter `lang` 与内容不符）
- 重复内容（相似度过高的页面）

---

### 9. sweep-reviews — 处理审核队列

```bash
node ${SKILL_DIR}/skill/cli.js sweep-reviews <wiki_root>
```

**功能**（源自 `sweep-reviews.ts`，14KB）：
- 扫描所有 `review: true` 的 wiki 页面
- 基于规则匹配 + LLM 语义判断自动解决
- 预定义动作：Create Page / Skip（防止 LLM 幻觉任意动作）

---

### 10. status — 知识库状态

```bash
node ${SKILL_DIR}/skill/cli.js status <wiki_root>
```

**输出**：JSON 格式统计（页面数、实体数、概念数、源数、待审核数）

---

## 配置环境变量

| 变量 | 用途 | 示例 |
|------|------|------|
| `OPENAI_API_KEY` | LLM API Key（OpenAI/Anthropic 兼容）| `sk-...` |
| `OPENAI_API_BASE` | 自定义 LLM 端点（Ollama/代理）| `http://localhost:11434/v1` |
| `LLM_MODEL` | 模型名称 | `gpt-4o` / `claude-3-5-sonnet` |
| `EMBEDDING_API_BASE` | 嵌入端点（可选，启用向量搜索）| `http://localhost:11434/v1` |
| `EMBEDDING_MODEL` | 嵌入模型（可选）| `text-embedding-3-small` |
| `TAVILY_API_KEY` | 深度研究搜索 API（可选）| `tvly-...` |

---

## 与 llm-wiki-skill 的关键互补

本技能建议**配合** llm-wiki-skill 使用而非替代：

| 场景 | 推荐方案 |
|------|---------|
| 日常 ingest（速度优先）| llm-wiki-skill（Shell，零开销，SHA256 缓存）|
| 高精度图谱分析（Adamic-Adar） | 本技能（graph + insights 命令，4 信号模型）|
| RRF 混合搜索 | 本技能（search 命令，BM25+向量）|
| 深度研究专项 | 本技能（deep-research 命令）|
| 基础图谱分析与可视化 | llm-wiki-skill（3 信号 + Louvain + 数字山水 HTML）|
| 中文内容源（微信/知乎/小红书）| llm-wiki-skill |
| Hermes Runtime 集成 | llm-wiki-skill（已有 HERMES.md + SessionStart hook）|
| 本技能 Hermes 集成 | 参见 HERMES.md（需手动适配）|

---

## 安装

```bash
# 安装 CLI 依赖
cd ${SKILL_DIR}/skill
npm install

# 验证安装
node cli.js --version
```
