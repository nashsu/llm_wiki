/**
 * Changelog shown in Settings → Changelog. Hardcoded rather than
 * pulled from GitHub Releases so it works offline and stays under
 * version control with the code that ships the changes.
 *
 * Conventions:
 *   - Newest version first (the UI renders in array order).
 *   - Each entry has both `en` and `zh` highlight lists; the
 *     section picks whichever matches the current i18n language.
 *   - Only user-visible changes belong here. Internal refactors,
 *     CI tweaks, and pure test work go in commit messages, not
 *     here — keep this readable for end users.
 *   - When releasing a new version: prepend a new entry with the
 *     same shape, then bump package.json / tauri.conf.json /
 *     Cargo.toml / Cargo.lock as usual.
 */

export interface ChangelogEntry {
  version: string
  date: string // YYYY-MM-DD
  highlights: {
    en: string[]
    zh: string[]
  }
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.4.10",
    date: "2026-05-14",
    highlights: {
      en: [
        "Added configurable source folder monitoring, manual source-folder refresh, and Gemini native embeddings support.",
        "Fixed source sync, embedding provider compatibility, and settings localization issues.",
      ],
      zh: [
        "新增可配置的资料文件夹监控、手动刷新资料文件夹，以及 Gemini 原生向量嵌入支持。",
        "修复资料同步、向量 provider 兼容性和设置页本地化相关问题。",
      ],
    },
  },
  {
    version: "0.4.9",
    date: "2026-05-11",
    highlights: {
      en: ["Fixed Windows compatibility issues around file paths, source sync, and file deletion."],
      zh: ["修复 Windows 下文件路径、原始资料同步和文件删除相关的兼容性问题。"],
    },
  },
  {
    version: "0.4.8",
    date: "2026-05-11",
    highlights: {
      en: [
        "Project file sync is more complete: external changes in raw sources can be detected, queued persistently, retried, and routed through the same source add/delete lifecycle as in-app actions.",
        "Source cleanup is more reliable when raw files are deleted outside the app: related wiki pages, index entries, wikilinks, and `related:` references are cleaned consistently, including path-style `.md` links.",
        "Web search adds SearXNG as a provider, with per-provider configuration and selectable SearXNG search categories.",
        "Large raw-source folders are easier to browse: the Sources page now renders the file tree progressively while scrolling.",
        "OpenAI GPT-5 / o-series ingest compatibility is improved by using the supported completion-token parameter shape and avoiding unsupported sampling knobs.",
      ],
      zh: [
        "项目文件同步更完整：外部修改 raw sources 后可被检测、持久化排队、重试，并统一走应用内相同的 source 添加/删除生命周期。",
        "外部删除原始文件后的清理更可靠：相关 wiki 页面、index 条目、正文 wikilink 和 `related:` 引用会一致清理，也覆盖带路径和 `.md` 后缀的引用。",
        "网页搜索新增 SearXNG Provider，支持独立配置并选择 SearXNG 搜索分类。",
        "原始资料目录较大时更易浏览：Sources 页面现在会随滚动渐进渲染文件树。",
        "改进 OpenAI GPT-5 / o-series 的 ingest 兼容性：使用支持的 completion token 参数，并避免发送不支持的采样参数。",
      ],
    },
  },
  {
    version: "0.4.7",
    date: "2026-05-06",
    highlights: {
      en: [
        "Web search now supports multiple providers: Tavily and SerpApi can be configured separately, with independent API keys and SerpApi search-engine selection.",
        "Reasoning-model support is improved across providers: thinking controls are available in LLM settings, structured ingest avoids reasoning-only failures, and chat can show model thinking when an endpoint streams it.",
        "Knowledge graph exploration is cleaner with filters, structural-node hiding, right-click node hide, and reset controls.",
        "Persian (Farsi) is now available as an output language, with better auto-detection from Arabic, RTL rendering, and per-project target-language preferences.",
      ],
      zh: [
        "网页搜索支持多 Provider：Tavily 和 SerpApi 可分别配置，API Key 独立保存，并支持选择 SerpApi 搜索引擎。",
        "推理型模型支持增强：LLM 设置里新增 thinking / reasoning 控制，结构化导入会避免只输出思考不输出正文的问题，聊天中也能显示模型流式返回的思考过程。",
        "关系图新增过滤能力：可隐藏结构性节点、按节点/连接过滤、右键隐藏单个节点，并可一键重置。",
        "新增 Persian (Farsi) 输出语言支持：自动检测可更好地区分 Persian 和 Arabic，内容按 RTL 显示，Target Language 也改为按项目独立保存。",
      ],
    },
  },
  {
    version: "0.4.6",
    date: "2026-05-01",
    highlights: {
      en: [
        "Right-click delete in the Knowledge tree for entity / concept pages, with full reference cleanup: every body `[[wikilink]]`, `index.md` listing entry, and `related:` frontmatter array pointing at the deleted page is rewritten in the same pass — no more dangling refs left behind for the FrontmatterPanel to flag with a warning icon.",
        "Mermaid diagrams now render in chat: any ` ```mermaid ` fenced code block in an LLM reply renders as an SVG (lazy-loaded so the diagram engine is only fetched when first encountered). Click a diagram to enlarge with zoom controls; Esc to close.",
        "Wiki pages whose frontmatter was wrapped in a stray ```yaml … ``` code fence now render correctly: the orphan closing ``` no longer hijacks the body into one giant un-formatted code block.",
        "Windows: Claude Code CLI provider works again. Detection and chat spawn now resolve through the same path lookup (claude.cmd → claude.exe → claude), so Settings showing \"installed\" matches what chat can actually spawn.",
        "Fixed: switching the UI language in Settings → Interface, saving, then editing any other settings field and saving again no longer silently reverts the UI back to the previous language.",
        "All file-delete paths (Sources view source delete, Lint view orphan delete, Knowledge tree right-click) now use the same cleanup helper, so deleting via any of them gets the full sweep — no more inconsistent behaviour where one path cleaned wikilinks but left `related:` frontmatter pointing at the void.",
      ],
      zh: [
        "Knowledge 知识树新增右键删除 entity / concept 页面：删除时自动清理所有引用 —— 文中的 `[[wikilink]]`、`index.md` 的目录条目、其它页面 frontmatter `related:` 数组里指向被删页的 slug，全都在同一步重写干净，不再留断链让 FrontmatterPanel 显示警告图标。",
        "聊天中支持渲染 Mermaid 图：LLM 回复里的 ` ```mermaid ` 代码块会渲染成 SVG（懒加载，只有遇到第一个图才下载渲染引擎）。点击图可放大查看，支持缩放控制和 Esc 关闭。",
        "frontmatter 被错误包在 ```yaml … ``` 代码栅栏里的 wiki 页现在能正常渲染：之前下半部全部被孤立的闭 fence 当成一个未关闭的代码块，标题、列表、表格全都不上样式。",
        "Windows 下 Claude Code CLI 再次可用：探测和 chat 启动现在走同一套路径解析（claude.cmd → claude.exe → claude），不会再出现「Settings 检测到已安装但实际 chat 启动失败」的怪现象。",
        "修复：在 Settings → Interface 切换 UI 语言保存后，再编辑其它设置并保存，UI 不会再被静默切回原来的语言。",
        "所有删除入口（Sources 删原始文档、Lint 删孤儿页、Knowledge 树右键）现在都走同一个清理辅助函数，任意路径删除都会触发完整清扫 —— 不会再有一条路径清掉 wikilink 但漏掉 `related:` 留下断引的不一致。",
      ],
    },
  },
  {
    version: "0.4.5",
    date: "2026-04-30",
    highlights: {
      en: [
        "Settings → Network: global HTTP/HTTPS proxy with live apply (no app restart needed). Local addresses bypass the proxy by default so Ollama / LM Studio / LAN-deployed LLMs keep working.",
        "Settings → Maintenance: new \"Detect duplicate entities / concepts\" tool. The LLM scans every wiki page and surfaces likely-duplicate groups (English vs Chinese name, plural vs singular, abbreviation vs full form). You confirm each group before merging; merges run through a persistent serial queue with up to 3 automatic retries, survives app restart, and supports cancel / retry from the UI.",
        "Re-ingesting an entity / concept page that already exists now preserves earlier contributions: an LLM merge step combines old + new bodies instead of clobbering, with length / structure sanity checks and a backup snapshot on fallback.",
        "Frontmatter tags / related fields are now union-merged across re-ingests (previously only sources was protected — earlier-contributed tags and links silently disappeared).",
        "Wiki pages whose frontmatter was wrapped in a stray ```yaml … ``` code fence now render correctly: the orphan closing ``` no longer hijacks the body into one giant un-formatted code block.",
        "Better Claude Code CLI error reporting: the bare \"exit 1\" message is replaced by the actual subprocess stderr / unparsed stdout, so authentication failures and other startup errors are visible instead of opaque.",
        "Better diagnostic when a model produces lots of \"thinking\" text but never any answer (some Kimi / Qwen-style endpoints stream `reasoning` only and emit no `content` — previously this surfaced as \"analysis Not available\" with no clue why).",
      ],
      zh: [
        "设置里新增「网络」面板，可配置全局 HTTP/HTTPS 代理，保存即时生效不需要重启应用。本地地址默认不走代理，Ollama / LM Studio / 局域网 LLM 不受影响。",
        "设置里新增「维护」面板，包含「检测重复实体 / 概念」工具：LLM 扫描全部 wiki 页面，把可能指向同一主题但用了不同名字的页面分组（中英对照、单复数、缩写与全称等），每组确认后再合并。合并任务进入持久化串行队列，自动重试最多 3 次，应用重启不丢，UI 支持取消和重试。",
        "重新 ingest 同名 entity / concept 页时，由 LLM 把新旧版本合并成一份完整内容，不再直接覆盖丢失之前的贡献；包含长度/结构 sanity 检查，失败时自动备份原版本。",
        "frontmatter 的 tags / related 字段现在跨多次 ingest 自动并集合并（之前只保护 sources，导致旧文档贡献的 tag 和关联会悄悄消失）。",
        "frontmatter 被错误包在 ```yaml … ``` 代码栅栏里的 wiki 页现在能正常渲染：之前页面下半部全部被孤立的闭 fence 当成一个未关闭的代码块，标题、列表、表格全都不上样式。",
        "Claude Code CLI 的报错信息更详细：不再只显示「exit 1」，而是把子进程实际的 stderr / 未解析的 stdout 展示出来，鉴权失败等启动问题终于看得见。",
        "改进诊断：模型只输出 reasoning 但不输出 content 的情况（部分 Kimi / Qwen 端点的流式接口只发 reasoning_content）现在会明确报告，而不是丢出令人摸不着头脑的「analysis Not available」。",
      ],
    },
  },
  {
    version: "0.4.4",
    date: "2026-04-28",
    highlights: {
      en: [
        "Native ARM64 Linux builds — .deb and .AppImage now ship for aarch64 (Raspberry Pi, ARM cloud instances, Apple Silicon Linux VMs).",
        "Visual frontmatter panel for wiki pages: type-coded chips for entity / concept / query, clickable source and related cards that navigate directly to the linked file or page.",
        "Read-mode default for wiki pages — Obsidian-style [[wikilinks]] render as proper clickable links instead of raw bracketed text. Edit toggle in the top-right keeps the WYSIWYG editor available when needed.",
        "LLM-generated wiki pages no longer get wrapped in a stray ```yaml ... ``` code fence (prompt rewrite + write-time sanitizer + read-time fallback).",
        "IME composition Enter no longer triggers chat / search / research submit when typing under a Chinese / Japanese / Korean input method.",
        'Selecting Claude Code CLI provider in Settings (the "no API key" option) now works across ingest, sweep, lint, chat, sources, and the clip watcher — previously it failed with "LLM not configured" everywhere.',
      ],
      zh: [
        "新增原生 ARM64 Linux 构建（.deb / .AppImage），覆盖树莓派、ARM 云实例、Apple Silicon Linux 虚拟机等。",
        "Wiki 页面顶部新增可视化 frontmatter 面板：实体 / 概念 / 查询用色块徽章区分，源文件和相关页面用可点击卡片，单击跳转。",
        "Wiki 页面默认进入阅读模式，Obsidian 风格的 [[wikilink]] 渲染成蓝色可点链接而不是字面括号文本；右上角 Edit 按钮可切回 WYSIWYG 编辑器。",
        "LLM 生成的 wiki 页面不再被错误地包在 ```yaml ... ``` 代码栅栏里（prompt 改写 + 写盘清洗 + 读取兜底三层防御）。",
        "中日韩输入法选词时按 Enter 不再误触发聊天 / 搜索 / 研究的提交。",
        "选用 Claude Code CLI provider（无需 API key）后，导入、聊天、语义 lint、sweep、剪藏导入等所有功能都能正常工作（此前各处都误报 LLM 未配置）。",
      ],
    },
  },
  {
    version: "0.4.3",
    date: "2026-04-28",
    highlights: {
      en: [
        "Fixed Ollama connection failure when configured to a LAN-deployed instance (e.g. http://192.168.x.x:11434). The Origin header is now sent as http://localhost regardless of server address, so Ollama's default OLLAMA_ORIGINS allowlist accepts it.",
      ],
      zh: [
        "修复使用局域网内 Ollama 服务（如 http://192.168.x.x:11434）时连接失败的问题。Origin 请求头现在固定为 http://localhost，匹配 Ollama 默认的 OLLAMA_ORIGINS 白名单。",
      ],
    },
  },
  {
    version: "0.4.2",
    date: "2026-04-28",
    highlights: {
      en: [
        "Project creation dialog now requires picking an AI output language up front — the previous Auto default surprised users with mixed-language output.",
        "Deleting a project actually removes it from the recent list now (previously the auto-open flow re-added it on next launch).",
      ],
      zh: [
        "创建项目时必须显式选择 AI 输出语言（之前 Auto 默认值会让生成内容混杂语言）。",
        "删除项目后真正从最近列表里移除（之前重启应用会被自动重新打开流程加回来）。",
      ],
    },
  },
  {
    version: "0.4.1",
    date: "2026-04-27",
    highlights: {
      en: [
        "Polished the update-available notification banner; the download link now opens in the system browser.",
        "Settings gear and About row keep showing a small red dot when an update is available, even after dismissing the top banner.",
      ],
      zh: [
        "新版本提醒 banner 优化样式，下载链接用系统浏览器打开。",
        "有可用更新时，设置齿轮按钮和 About 行会显示小红点，即使关闭顶部 banner 也仍然提示。",
      ],
    },
  },
  {
    version: "0.4.0",
    date: "2026-04-26",
    highlights: {
      en: [
        "Multimodal ingest: extract embedded images from PDF / docx / pptx and caption them with a vision model so the wiki page references each image with semantic alt text instead of empty placeholders.",
        "Image-aware search: results page splits into Pages and Images sections, clicking a thumbnail opens a lightbox and a Jump-to-source button navigates directly into the original document at the right location.",
        "Folder import + recursive cascade delete with two-stage inline confirmation (no more accidental folder loss from a single misclick).",
      ],
      zh: [
        "多模态导入：从 PDF / docx / pptx 抽出内嵌图片并用视觉模型生成描述，wiki 页面引用图片时带上语义 alt 文本。",
        "搜索结果新增图片分区：缩略图点击打开 lightbox，跳转到源文档按钮直达图片在原文中的位置。",
        "支持文件夹批量导入和递归级联删除（删除按钮采用两段式确认，避免误删整个文件夹）。",
      ],
    },
  },
]
