# llm-wiki-nashsu — Hermes Skill 入口

> **适配状态**：⚠️ 部分适配（需完成 GUI→CLI 工程改造后方可完整使用）
> **当前可用**：graph、insights、search 命令（无需 LLM）
> **待完成**：ingest、deep-research 命令（需替换 Tauri IPC → Node.js fs）

## 触发条件

加载本技能当用户明确提到：
- "图谱分析"、"知识图谱"、"图谱洞察"
- "深度研究"
- "知识缺口"、"惊人连接"

## 与 llm-wiki-skill 的关系

本技能**补充** llm-wiki-skill，提供更高级的图谱分析能力：
- llm-wiki-skill：负责日常 ingest、Hermes 调度、中文内容源
- llm-wiki-nashsu：负责高级图谱分析、深度研究

## 主要工作流

详见 `SKILL.md`。

## 安装路径

```bash
# Hermes 安装
bash install.sh --platform hermes

# 直接使用
node skill/cli.js graph <wiki_root>
node skill/cli.js insights <wiki_root>
node skill/cli.js search <wiki_root> <query>
```

## 注意事项

- Node.js >= 20 运行时必须可用
- 中文素材源（微信/知乎/小红书）请使用 llm-wiki-skill
- ingest 功能目前需要完成 Tauri IPC 替换工程（约 10-13 人日）
