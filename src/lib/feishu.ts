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

export interface FeishuNotifyConfig {
  enabled: boolean
  /** open_id (ou_...) 私聊 或 chat_id (oc_...) 群聊 */
  recipientId: string
  /** 摘要长度：前 N 个字符 */
  summaryLength: number
}

export const DEFAULT_FEISHU_CONFIG: FeishuNotifyConfig = {
  enabled: false,
  recipientId: "",
  summaryLength: 200,
}

/** 从任意文本里提取第一个合法的收件人 ID（open_id 或 chat_id）。 */
export function extractRecipientId(text: string): string | null {
  const match = /(ou_[A-Za-z0-9]+|oc_[A-Za-z0-9]+)/.exec(text)
  return match ? match[1] : null
}

export function normalizeFeishuConfig(config?: Partial<FeishuNotifyConfig> | null): FeishuNotifyConfig {
  const length = Number(config?.summaryLength)
  const rawRecipient = typeof config?.recipientId === "string" ? config.recipientId.trim() : ""
  // 容忍粘贴了整段聊天记录（提取其中的 ou_/oc_）；提取不到就视为无效清空，
  // 避免脏值残留导致聊天界面铃铛一直不可用。
  const recipientId = rawRecipient
    ? (extractRecipientId(rawRecipient) ?? "")
    : ""
  return {
    enabled: config?.enabled === true,
    recipientId,
    summaryLength: Number.isFinite(length) && length >= 20 ? Math.min(4000, Math.floor(length)) : DEFAULT_FEISHU_CONFIG.summaryLength,
  }
}

export function detectFeishu(): Promise<FeishuDetectResult> {
  return invoke<FeishuDetectResult>("feishu_detect")
}

export function sendFeishuMessage(recipientId: string, text: string): Promise<FeishuSendResult> {
  return invoke<FeishuSendResult>("feishu_send_message", { recipientId, text })
}

/** 查询当前登录用户自己的 open_id，设置页一键填入收件人用。 */
export function getFeishuMyId(): Promise<FeishuMyIdResult> {
  return invoke<FeishuMyIdResult>("feishu_get_my_id")
}

/** 去掉 <think> 推理块、markdown 标记，压缩空白后截断到 maxChars。 */
export function buildReplySummary(content: string, maxChars: number): string {
  let text = content
    // 推理块整体剔除
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "")
    text = text.replace(/<\/?think>/g, "")
    // 常见 markdown 标记降噪
    text = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```+\w*\n?/g, ""))
    text = text.replace(/[*_`#>]+/g, "")
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    text = text.replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    // 压缩空白
    text = text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}
