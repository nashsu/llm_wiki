import { invoke } from "@tauri-apps/api/core"

export interface FeishuDetectResult {
  available: boolean
  cliPath: string
  version: string
  error: string
}

export interface FeishuSendResult {
  ok: boolean
  messageId: string
  error: string
}

export interface FeishuMyIdResult {
  ok: boolean
  openId: string
  name: string
  /** 与机器人/应用的私聊 chat_id（oc_ 开头），也当收件人用 */
  p2pChatId: string
  error: string
}

/** 飞书回复形式：
 * - "doc"：发布为飞书文档并回发链接
 * - "html"：用 AI（HTML 报告 Skill）生成单文件 HTML，作为文件消息发送
 * - "text"：纯文本消息（仅剔除推理块）
 */
export type FeishuReplyFormat = "doc" | "html" | "text"

export interface FeishuNotifyConfig {
  enabled: boolean
  /** open_id (ou_...) 私聊 或 chat_id (oc_...) 群聊 */
  recipientId: string
  /** 飞书遥控对话：常驻监听飞书消息并自动回复。 */
  bridgeEnabled: boolean
  /** 回复形式（机器人回复与聊天通知都生效）。
   *  旧字段 bridgeReplyAsDoc 已废弃：true→doc，false→text。 */
  replyFormat: FeishuReplyFormat
  /** 文档生成目录：飞书文件夹 token（我的空间根目录为空串）。 */
  bridgeDocFolder: string
  /** 文档模式：new=每次新建文档；fixed=覆盖固定文档；append=追加到固定文档。 */
  bridgeDocMode: "new" | "fixed" | "append"
  /** fixed/append 模式的目标文档 token（docx token）。 */
  bridgeDocTarget: string
  /** HTML 模式使用的 skill id（来自 `.llm-wiki/skills` 等扫描结果；空=不用 skill）。 */
  htmlSkillId: string
}

export const DEFAULT_FEISHU_CONFIG: FeishuNotifyConfig = {
  enabled: false,
  recipientId: "",
  bridgeEnabled: false,
  replyFormat: "doc",
  bridgeDocFolder: "",
  bridgeDocMode: "new",
  bridgeDocTarget: "",
  htmlSkillId: "",
}

/** 从任意文本里提取第一个合法的收件人 ID（open_id 或 chat_id）。 */
export function extractRecipientId(text: string): string | null {
  const match = /(ou_[A-Za-z0-9]+|oc_[A-Za-z0-9]+)/.exec(text)
  return match ? match[1] : null
}

/** 从文件夹 URL / 粘贴文本里提取文件夹 token（drive/folder/<token> 或裸 token）。 */
export function extractFeishuFolderToken(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const fromUrl = /drive\/folder\/([A-Za-z0-9]+)/.exec(trimmed)
  if (fromUrl) return fromUrl[1]
  // 裸 token：飞书 folder token 形如 27 位字母数字，排除明显是文档/消息的 token
  if (/^[A-Za-z0-9]{20,40}$/.test(trimmed)) return trimmed
  return null
}

/** 从文档 URL / 粘贴文本里提取 docx token。 */
export function extractFeishuDocToken(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const fromUrl = /docx\/([A-Za-z0-9]+)/.exec(trimmed)
  if (fromUrl) return fromUrl[1]
  if (/^[A-Za-z0-9]{20,40}$/.test(trimmed)) return trimmed
  return null
}

export function normalizeFeishuConfig(config?: Partial<FeishuNotifyConfig> | null): FeishuNotifyConfig {
  const rawRecipient = typeof config?.recipientId === "string" ? config.recipientId.trim() : ""
  // 容忍粘贴了整段聊天记录（提取其中的 ou_/oc_）；提取不到就视为无效清空，
  // 避免脏值残留导致聊天界面铃铛一直不可用。
  const recipientId = rawRecipient
    ? (extractRecipientId(rawRecipient) ?? "")
    : ""
  // 回复形式：优先用新字段 replyFormat；缺失时从废弃字段 bridgeReplyAsDoc 推导。
  let replyFormat: FeishuReplyFormat = "doc"
  if (config?.replyFormat === "doc" || config?.replyFormat === "html" || config?.replyFormat === "text") {
    replyFormat = config.replyFormat
  } else if (config && "bridgeReplyAsDoc" in config && config.bridgeReplyAsDoc === false) {
    replyFormat = "text"
  }
  return {
    enabled: config?.enabled === true,
    recipientId,
    bridgeEnabled: config?.bridgeEnabled === true,
    replyFormat,
    bridgeDocFolder:
      typeof config?.bridgeDocFolder === "string"
        ? (extractFeishuFolderToken(config.bridgeDocFolder) ?? "")
        : "",
    bridgeDocMode:
      config?.bridgeDocMode === "fixed" || config?.bridgeDocMode === "append"
        ? config.bridgeDocMode
        : "new",
    bridgeDocTarget:
      typeof config?.bridgeDocTarget === "string"
        ? (extractFeishuDocToken(config.bridgeDocTarget) ?? "")
        : "",
    htmlSkillId:
      typeof config?.htmlSkillId === "string" ? config.htmlSkillId.trim() : "",
  }
}

export function detectFeishu(): Promise<FeishuDetectResult> {
  return invoke<FeishuDetectResult>("feishu_detect")
}

export function sendFeishuMessage(recipientId: string, text: string): Promise<FeishuSendResult> {
  return invoke<FeishuSendResult>("feishu_send_message", { recipientId, text })
}

/** 目录连通性测试结果：成功时 url 为测试文档链接。 */
export interface FeishuDocFolderTestResult {
  ok: boolean
  url: string
  error: string
}

/** 在目标目录生成一篇极小测试文档，验证目录 token 与发布链路。 */
export function testFeishuDocFolder(folderToken: string): Promise<FeishuDocFolderTestResult> {
  return invoke<FeishuDocFolderTestResult>("feishu_test_doc_folder", { folderToken })
}

/** 目标文档只读校验结果：ok=true 时 title/url 为文档标题与链接。 */
export interface FeishuDocTargetTestResult {
  ok: boolean
  title: string
  url: string
  error: string
}

/** 只读校验固定文档 token（有效性与权限），不改动文档内容。 */
export function testFeishuDocTarget(docToken: string): Promise<FeishuDocTargetTestResult> {
  return invoke<FeishuDocTargetTestResult>("feishu_test_doc_target", { docToken })
}

/** Device Flow 授权第一步结果：verification_url 给用户浏览器打开确认。 */
export interface FeishuAuthBeginResult {
  ok: boolean
  verificationUrl: string
  userCode: string
  deviceCode: string
  error: string
}

/** 生成 Device Flow 授权链接（docs+drive+im 域）。 */
export function beginFeishuAuth(): Promise<FeishuAuthBeginResult> {
  return invoke<FeishuAuthBeginResult>("feishu_auth_begin")
}

/** Device Flow 授权第二步：用户浏览器确认后完成登录。 */
export function completeFeishuAuth(deviceCode: string): Promise<{ ok: boolean; error: string }> {
  return invoke<{ ok: boolean; error: string }>("feishu_auth_complete", { deviceCode })
}

/** 聊天通知文档发布结果。 */
export interface FeishuDocPublishResult {
  ok: boolean
  url: string
  error: string
}

/** 聊天通知「回复为飞书文档」：走与机器人相同的发布链路与文档设置。 */
export function publishFeishuChatReply(title: string, markdown: string): Promise<FeishuDocPublishResult> {
  return invoke<FeishuDocPublishResult>("feishu_publish_chat_reply", { title, markdown })
}

/** 只剔除 <think> 推理块，保留完整 markdown 原文（飞书纯文本通知用）。 */
export function stripThinkBlocks(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim()
}

/** 查询当前登录用户自己的 open_id，设置页一键填入收件人用。 */
export function getFeishuMyId(): Promise<FeishuMyIdResult> {
  return invoke<FeishuMyIdResult>("feishu_get_my_id")
}

/** 桥接（飞书遥控对话）运行状态。 */
export interface FeishuBridgeStatus {
  /** 用户是否已启用。 */
  running: boolean
  /** consume 子进程是否已就绪（连上飞书长连接）。 */
  ready: boolean
  /** 已成功处理并回发的消息条数。 */
  handled: number
  /** 最近一次错误，空表示无。 */
  lastError: string
  /** 最近一条入站消息摘要。 */
  lastMessage: string
  /** 回复时使用的项目 ID。 */
  projectId: string
  /** 是否有消息正在处理。 */
  busy: boolean
  /** 正在处理的消息摘要（busy 时有意义）。 */
  currentMessage: string
  /** 当前任务已耗时（秒）。 */
  currentElapsedSecs: number
  /** 排队等待处理的消息条数。 */
  pending: number
  /** 本轮请求注入的 skill id（空表示本模式不用 skill）。 */
  skillId: string
  /** 本轮该 skill 是否真的注入成功。 */
  skillApplied: boolean
  /** 本轮实际注入的 skill 条数。 */
  skillCount: number
}

/** 启动飞书遥控对话桥接；projectId 省略时用当前项目。 */
export function startFeishuBridge(projectId?: string): Promise<FeishuBridgeStatus> {
  return invoke<FeishuBridgeStatus>("feishu_bridge_start", { projectId: projectId ?? null })
}

export function stopFeishuBridge(): Promise<FeishuBridgeStatus> {
  return invoke<FeishuBridgeStatus>("feishu_bridge_stop")
}

export function getFeishuBridgeStatus(): Promise<FeishuBridgeStatus> {
  return invoke<FeishuBridgeStatus>("feishu_bridge_status")
}

/** HTML 文件发送结果。 */
export interface FeishuFileSendResult {
  ok: boolean
  messageId: string
  error: string
}

/**
 * 把一段内容作为文件发送到飞书（bot 身份）。
 * lark-cli 的 --file 只接受 cwd 相对路径，绝对路径被拒，
 * 所以后端会把内容写到临时目录并以临时目录为 cwd 调用 lark-cli。
 */
export function sendFeishuFile(
  recipientId: string,
  fileName: string,
  fileContent: string,
): Promise<FeishuFileSendResult> {
  return invoke<FeishuFileSendResult>("feishu_send_file", { recipientId, fileName, fileContent })
}

/** AI 生成 HTML 结果。 */
export interface FeishuHtmlGenerateResult {
  ok: boolean
  html: string
  error: string
}

/**
 * 用当前项目的 LLM 配置 + 设置里选中的 skill，
 * 把 markdown 回复转成单文件 HTML（可直接在浏览器打开）。
 * 失败时 ok=false，调用方应降级为文本/文档发送。
 */
export function generateFeishuHtml(
  projectPath: string,
  title: string,
  markdown: string,
  llmConfig: unknown,
): Promise<FeishuHtmlGenerateResult> {
  return invoke<FeishuHtmlGenerateResult>("feishu_generate_html", { projectPath, title, markdown, llmConfig })
}
