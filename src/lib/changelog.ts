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
    version: "0.6.4",
    date: "2026-07-16",
    highlights: {
      en: [
        "Added EPUB and MOBI source support so ebooks can be imported, previewed, and ingested into a project.",
        "Added support for the official local MinerU API, including configurable service endpoints and Pipeline mode.",
        "Added ZIP-based project export and import for migrating wiki content, source files, and project state.",
        "Added deterministic wiki index rebuilding from the pages currently stored in the project.",
        "Added configurable LLM request timeouts for long-running cloud models and local services.",
        "Expanded Firecrawl configuration with API key authentication and custom service URLs.",
        "Added a persistent collapsible knowledge sidebar that preserves more space for the active workspace.",
        "Added Czech as an AI output language option.",
        "Improved existing features and fixed bugs across document import, frontmatter handling, source links, knowledge graphs, missing-page checks, and cross-platform compatibility.",
      ],
      zh: [
        "新增 EPUB 和 MOBI 原始资料支持，电子书可直接导入、预览并摄取到项目中。",
        "新增官方 Local MinerU API 支持，可配置服务地址并使用 Pipeline 模式。",
        "新增 ZIP 项目导出与导入功能，可迁移 Wiki 内容、原始资料和项目状态。",
        "新增 Wiki 索引重建功能，可根据项目中现有页面确定性生成索引。",
        "新增 LLM 请求超时时间设置，适配耗时较长的云端模型和本地服务。",
        "扩展 Firecrawl 配置，支持 API Key 鉴权和自定义服务地址。",
        "新增可持久保存状态的知识库侧栏折叠功能，为当前工作区释放更多空间。",
        "新增捷克语 AI 输出语言选项。",
        "优化现有功能并修复文档导入、Frontmatter、来源链接、知识图谱、缺失页面检查和跨平台兼容等问题。",
      ],
    },
  },
  {
    version: "0.6.1",
    date: "2026-07-10",
    highlights: {
      en: [
        "Improved Agent context so selected files, Skills, project knowledge, and retrieval evidence remain available throughout a turn.",
        "Expanded Hybrid Search with adaptive keyword, vector, and knowledge-graph retrieval, including graph-aware references and an interactive local graph preview.",
        "Added Agent file activity with per-file change summaries, diffs, and guarded undo when the file has not changed again.",
        "Improved generated output handling with consolidated output browsing, automatic previews, enlarged viewing, and support for common document, image, and web formats.",
        "Added file history comparison and restore controls for recorded project file versions.",
        "Improved Agent loop convergence by limiting duplicate retrieval, budgeting tool iterations, and producing a final answer before the retrieval budget is exhausted.",
      ],
      zh: [
        "增强 Agent 上下文能力，选中的文件、Skill、项目知识和检索证据可在整轮执行中持续使用。",
        "扩展 Hybrid Search：自适应融合关键词、向量与知识图谱召回，并新增图谱引用和可交互的局部知识图谱预览。",
        "新增 Agent 文件修改记录，支持按文件查看变更摘要、Diff，以及在文件未被再次修改时安全撤销。",
        "完善生成物体验：支持集中浏览、自动预览、放大查看，以及常见文档、图片和网页格式预览。",
        "新增文件历史比较和恢复功能，可查看并恢复已记录的项目文件版本。",
        "优化 Agent 工具循环：限制重复检索、控制工具调用预算，并在检索预算耗尽前主动生成最终回答。",
      ],
    },
  },
  {
    version: "0.6.0",
    date: "2026-07-08",
    highlights: {
      en: [
        "Rebuilt Chat Agent on the Rust backend for more reliable tool execution, session handling, cancellation, permissions, and LLM streaming.",
        "Added Agent tools and Skill workflows, including wiki/source/graph/web search, workspace file generation, shell execution, user input forms, skill discovery, and per-conversation skill selection.",
        "Improved generated output handling with a dedicated output panel, previews, enlarged modal viewing, and quick access to the output folder.",
        "Improved Chat and Skill UI with a dedicated Skill management entry, slash skill completion, Mermaid diagram rendering, and better conversation isolation.",
        "Strengthened path sandboxing, workspace restrictions, command approval, hidden/sensitive file filtering, and Windows/Linux path compatibility.",
        "Expanded test coverage across the Rust Agent, tools, skills, search providers, chat sessions, layout, and Mermaid rendering.",
      ],
      zh: [
        "重构 Chat Agent 底座：核心逻辑迁移到 Rust 后端，提升工具执行、会话、取消、权限和 LLM 流式调用的稳定性。",
        "新增 Agent 工具与 Skill 工作流：支持 Wiki/Source/Graph/Web 检索、workspace 文件生成、shell 执行、用户交互表单、Skill 发现和每会话 Skill 选择。",
        "完善生成物体验：生成文件会独立展示，支持右侧生成物面板、预览、弹窗放大和快速打开输出目录。",
        "优化 Chat 与 Skill UI：新增独立 Skill 管理入口、/skill 补全、Mermaid 图表渲染，并修复会话内容串扰问题。",
        "增强安全与跨平台兼容：加强路径沙箱、workspace 限制、命令审批、隐藏/敏感文件过滤，以及 Windows/Linux 路径兼容。",
        "补充 Rust Agent、工具调用、Skill、搜索 Provider、Chat 会话、布局和 Mermaid 渲染相关测试。",
      ],
    },
  },
  {
    version: "0.5.2",
    date: "2026-06-25",
    highlights: {
      en: [
        "Fixed knowledge graph node previews so clicked pages open in the graph-side preview panel instead of switching to the Wiki page.",
      ],
      zh: [
        "修复知识图谱节点预览：点击页面节点时会在图谱右侧预览栏打开，不再跳转到 Wiki 页面。",
      ],
    },
  },
  {
    version: "0.5.1",
    date: "2026-06-24",
    highlights: {
      en: [
        "Added Chat Agent modes, persisted tool progress, and project file tools for local inspection.",
        "Improved reasoning-model handling so chat can recover when an endpoint returns thinking text but no final answer.",
      ],
      zh: [
        "新增聊天 Agent 模式、持久化工具调用进度，并加入项目文件查看工具。",
        "改进推理模型兼容性：当端点只返回思考内容而没有最终回答时，聊天会自动兜底恢复。",
      ],
    },
  },
  {
    version: "0.5.0",
    date: "2026-06-24",
    highlights: {
      en: [
        "Added the new chat Agent flow with query understanding, local/wiki graph tools, external search tools, and visible tool progress.",
        "Improved chat references with an in-chat preview panel, resizable preview width, source snippets, and persisted search toggles.",
        "Improved Agent routing by using each project overview to decide when local wiki search should be preferred over external search.",
        "Removed the Intel macOS release build from GitHub Actions.",
      ],
      zh: [
        "新增聊天 Agent 流程，支持问题理解、本地 Wiki/图谱工具、外部搜索工具，以及可见的工具调用进度。",
        "改进聊天引用体验：支持对话内引用预览、可调预览宽度、来源片段展示，以及搜索开关持久化。",
        "改进 Agent 路由判断：使用每个项目的 overview 来判断何时优先搜索当前知识库而不是外部网页。",
        "移除 GitHub Actions 中的 Intel Mac 发布构建。",
      ],
    },
  },
  {
    version: "0.4.26",
    date: "2026-06-23",
    highlights: {
      en: [
        "Merged recent community PR fixes and cleaned up release documentation.",
        "Fixed release build issues around bundled resources and PDFium binaries.",
        "Added Intel x86_64 macOS client support to the release build.",
      ],
      zh: [
        "合并近期社区 PR 修复，并清理发布文档。",
        "修复发布构建中随包资源和 PDFium 二进制相关问题。",
        "新增 Intel x86_64 Mac 客户端的发布构建支持。",
      ],
    },
  },
  {
    version: "0.4.25",
    date: "2026-06-23",
    highlights: {
      en: [
        "Added Firecrawl as a Web Search provider with friendlier handling for anonymous search limits.",
        "Fixed a batch of reported UI, import, search, and provider compatibility bugs.",
        "Improved release build preparation for bundled MCP resources.",
      ],
      zh: [
        "新增 Firecrawl 网页搜索 Provider，并优化匿名搜索受限时的提示。",
        "修复一批用户反馈的界面、导入、搜索和 Provider 兼容性问题。",
        "改进发布构建中 MCP 随包资源的准备流程。",
      ],
    },
  },
  {
    version: "0.4.24",
    date: "2026-06-16",
    highlights: {
      en: [
        "Improved project creation visibility, lint repair suggestions, zoom controls, autosave, and review persistence across project switches.",
        "Fixed vector index cleanup, Unicode page IDs, duplicate scan prefiltering, and local embedding requests so indexes and rebuilds stay accurate.",
        "Improved MCP and local CLI provider reliability, including MCP version reporting and running Codex CLI from the project root.",
        "Improved language prompts so technical names, model names, tool names, and code identifiers are preserved more reliably.",
        "Hardened Windows startup with a native title bar, earlier API startup, and a visible startup-error fallback instead of a blank window.",
      ],
      zh: [
        "改进项目创建字段可见性、检查修复建议、缩放控制、自动保存，以及切换项目后的待审阅项保留。",
        "修复向量索引清理、Unicode 页面 ID、重复扫描预筛选和本地 Embedding 请求，确保索引与重建结果更准确。",
        "改进 MCP 与本地 CLI Provider 稳定性，包括 MCP 版本显示，以及从项目根目录运行 Codex CLI。",
        "改进语言提示词，更可靠地保留技术名、模型名、工具名和代码标识符。",
        "增强 Windows 启动稳定性：使用原生标题栏、提前启动 API，并在前端启动失败时显示错误信息而不是白屏。",
      ],
    },
  },
  {
    version: "0.4.23",
    date: "2026-06-08",
    highlights: {
      en: [
        "Added Doubao embedding compatibility and improved embedding rebuild safety.",
        "Fixed dedup scan hangs, Codex CLI PATH detection from login shells, and several ingest / scheduled import reliability issues.",
      ],
      zh: [
        "新增 Doubao Embedding 兼容，并提升 Embedding 重建过程的安全性。",
        "修复去重扫描卡住、Codex CLI 登录 shell PATH 检测，以及多处摄取和定时导入稳定性问题。",
      ],
    },
  },
  {
    version: "0.4.22",
    date: "2026-06-08",
    highlights: {
      en: [
        "Improved MinerU PDF previews by extracting images from MinerU result archives and rewriting them into Markdown image links.",
        "Converted MinerU HTML tables inside Markdown output into Markdown tables for cleaner preview and ingest.",
        "Hardened MinerU image handling for spaces, parentheses, path traversal, duplicate names, and partial image-save failures.",
      ],
      zh: [
        "改进 MinerU PDF 预览：从 MinerU 结果压缩包提取图片，并重写为 Markdown 图片引用。",
        "将 MinerU Markdown 输出中的 HTML 表格转换为 Markdown 表格，让预览和摄取更干净。",
        "强化 MinerU 图片处理，覆盖空格、括号、路径穿越、重名图片和图片保存部分失败等边界。",
      ],
    },
  },
  {
    version: "0.4.21",
    date: "2026-06-07",
    highlights: {
      en: [
        "Improved chat image support with safer local image handling, MiniMax M3 provider compatibility, and GLM vision model compatibility.",
        "Improved MinerU PDF parsing, local CLI provider resolution, API/MCP settings, and source/image ingestion reliability.",
        "Closed a batch of fixed GitHub issues covering source monitoring, scrolling, long-document ingest, editing, and provider compatibility.",
      ],
      zh: [
        "改进 AI 对话图片支持，增强本地图片处理安全性，并扩展 MiniMax M3 Provider 与 GLM 多模态模型兼容。",
        "优化 MinerU PDF 解析、本地 CLI Provider 解析、API/MCP 设置，以及资料与图片摄取稳定性。",
        "集中处理并关闭一批已修复的 GitHub issue，覆盖资料监控、滚动、长文档摄取、编辑保存和 Provider 兼容。",
      ],
    },
  },
  {
    version: "0.4.20",
    date: "2026-06-04",
    highlights: {
      en: [
        "Fixed the macOS titlebar so it keeps native window dragging while following light and dark mode.",
      ],
      zh: [
        "修复 macOS 顶部标题栏：保留系统原生拖动，同时跟随亮色和暗色模式。",
      ],
    },
  },
  {
    version: "0.4.19",
    date: "2026-06-03",
    highlights: {
      en: [
        "Fixed the macOS traffic-light titlebar drag area while keeping Windows and Linux on their native window controls.",
      ],
      zh: [
        "修复 macOS 顶部红黄绿按钮区域无法拖动窗口的问题，同时保持 Windows 和 Linux 使用原生窗口控制。",
      ],
    },
  },
  {
    version: "0.4.18",
    date: "2026-06-03",
    highlights: {
      en: [
        "Fixed close-window behavior on macOS and restored a clear Quit / Hide Window confirmation when asking before close.",
        "Improved Linux compatibility so the window minimizes instead of hiding when system tray support is unavailable.",
      ],
      zh: [
        "修复 macOS 关闭窗口行为，并在询问模式下恢复清晰的「退出 / 隐藏窗口」确认。",
        "改进 Linux 兼容性：系统托盘不可用时改为最小化，避免窗口隐藏后无法恢复。",
      ],
    },
  },
  {
    version: "0.4.17",
    date: "2026-06-03",
    highlights: {
      en: [
        "Added a local MCP server for agent clients, using the same project, search, graph, and file APIs as the desktop app.",
        "Updated Settings to manage API + MCP access together, including token guidance and a copyable MCP client configuration.",
      ],
      zh: [
        "新增本地 MCP 服务，方便智能体客户端通过与桌面端一致的项目、搜索、图谱和文件接口访问 LLM Wiki。",
        "设置中新增 API + MCP 管理入口，包含访问开关、token 提示和可复制的 MCP 客户端配置。",
      ],
    },
  },
  {
    version: "0.4.16",
    date: "2026-05-29",
    highlights: {
      en: [
        "Improved knowledge graph performance for large projects with worker-based layout and lighter rendering updates.",
        "Fixed graph search rendering errors and stabilized graph controls during filtering and search.",
      ],
      zh: [
        "优化大型项目的知识图谱性能，使用后台布局计算并减少渲染更新开销。",
        "修复图谱搜索时的渲染报错，并提升筛选和搜索过程中的图谱稳定性。",
      ],
    },
  },
  {
    version: "0.4.15",
    date: "2026-05-28",
    highlights: {
      en: [
        "Added AnyTXT as an external information source for Chat and Deep Research, with source labels and snippet previews.",
        "Added legacy Word .doc support for source import, text extraction, ingest, and preview.",
        "Improved source import, monitoring, chat search controls, graph controls, wiki generation reliability, and Mermaid rendering stability.",
        "Fixed raw-source preview, scrolling, editing, embedding configuration, and lint persistence issues.",
      ],
      zh: [
        "新增 AnyTXT 作为 AI 对话和 Deep Research 的外部信息源，并支持来源标记和片段预览。",
        "新增旧版 Word .doc 支持，可用于资料导入、文本提取、摄取和预览。",
        "改进资料导入与监控、对话搜索开关、关系图控制、Wiki 生成可靠性和 Mermaid 渲染稳定性。",
        "修复原始资料预览、滚动、编辑保存、Embedding 配置和检查结果持久化相关问题。",
      ],
    },
  },
  {
    version: "0.4.14",
    date: "2026-05-26",
    highlights: {
      en: [
        "Deep Research can now use AnyTXT local file search alongside web search, with configurable research sources.",
        "Improved long-document ingestion with more resilient chunked analysis and follow-up research suggestions.",
        "Fixed provider compatibility and Windows path handling issues.",
      ],
      zh: [
        "Deep Research 现在可结合 AnyTXT 本地文件搜索和网页搜索，并支持配置研究信息来源。",
        "改进长文档导入：分块分析更稳，并优化补充研究建议生成。",
        "修复 Provider 兼容性和 Windows 路径处理相关问题。",
      ],
    },
  },
  {
    version: "0.4.13",
    date: "2026-05-24",
    highlights: {
      en: [
        "Improved local API and search reliability, including shared backend search behavior.",
        "Fixed source handling edge cases for nested folders, non-English paths, and Windows compatibility.",
        "Fixed search provider configuration and Codex CLI Windows behavior issues.",
      ],
      zh: [
        "改进本地 API 与搜索稳定性，包括统一后端搜索能力。",
        "修复嵌套资料文件夹、非英文路径和 Windows 兼容相关的资料处理问题。",
        "修复搜索 Provider 配置和 Codex CLI 在 Windows 下的体验问题。",
      ],
    },
  },
  {
    version: "0.4.12",
    date: "2026-05-19",
    highlights: {
      en: [
        "Fixed SearXNG web search configuration so self-hosted instances work without requiring an API key.",
      ],
      zh: [
        "修复 SearXNG 网页搜索配置：自托管实例不再被错误要求填写 API Key。",
      ],
    },
  },
  {
    version: "0.4.11",
    date: "2026-05-19",
    highlights: {
      en: [
        "Added a local API server for project files, search, graph data, and source rescans, with configurable access control in Settings.",
        "Unified UI and API search on the Rust backend with keyword and vector retrieval.",
        "Added Knowledge Graph search with a compact expandable search control and improved empty-result stability.",
      ],
      zh: [
        "新增本地 API Server，可通过接口访问项目文件、搜索、关系图数据和资料重扫，并可在设置中配置访问控制。",
        "UI 搜索和 API 搜索统一到 Rust 后端，支持关键词与向量检索。",
        "关系图新增搜索功能，默认使用紧凑的可展开搜索按钮，并改进无结果时的稳定性。",
      ],
    },
  },
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
