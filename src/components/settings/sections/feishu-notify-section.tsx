import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bell, MessageCircle, RefreshCw, Send, UserRound } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import {
  detectFeishu,
  extractRecipientId,
  getFeishuBridgeStatus,
  getFeishuMyId,
  sendFeishuMessage,
  type FeishuBridgeStatus,
  type FeishuDetectResult,
} from "@/lib/feishu"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function FeishuNotifySection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [detect, setDetect] = useState<FeishuDetectResult | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [testState, setTestState] = useState<"idle" | "sending" | "ok" | "fail">("idle")
  const [testError, setTestError] = useState("")
  const [myIdState, setMyIdState] = useState<"idle" | "loading" | "ok" | "fail">("idle")
  const [myIdError, setMyIdError] = useState("")
  const [bridgeStatus, setBridgeStatus] = useState<FeishuBridgeStatus | null>(null)

  // 桥接状态轮询：开关打开时每 5s 刷新一次，实时反映 ready/handled。
  useEffect(() => {
    if (!draft.feishuConfig.bridgeEnabled) {
      setBridgeStatus(null)
      return
    }
    let cancelled = false
    const poll = async () => {
      try {
        const status = await getFeishuBridgeStatus()
        if (!cancelled) setBridgeStatus(status)
      } catch {
        // 桥接未启动时忽略
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [draft.feishuConfig.bridgeEnabled])

  const runDetect = useCallback(async () => {
    setDetecting(true)
    try {
      const result = await detectFeishu()
      setDetect(result)
    } catch (err) {
      setDetect({
        available: false,
        cliPath: "",
        version: "",
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void runDetect()
  }, [runDetect])

  const recipientValid =
    draft.feishuConfig.recipientId.startsWith("ou_") || draft.feishuConfig.recipientId.startsWith("oc_")

  // 粘贴整段聊天记录时，自动提取其中的 ou_/oc_ 令牌
  const handleRecipientChange = useCallback(
    (raw: string) => {
      const extracted = extractRecipientId(raw)
      setDraft("feishuConfig", {
        ...draft.feishuConfig,
        recipientId: extracted ?? raw,
      })
      setTestState("idle")
    },
    [draft.feishuConfig, setDraft],
  )

  const fetchMyId = useCallback(async () => {
    setMyIdState("loading")
    setMyIdError("")
    try {
      const result = await getFeishuMyId()
      if (result.ok && result.openId) {
        setDraft("feishuConfig", { ...draft.feishuConfig, recipientId: result.openId })
        setMyIdState("ok")
        setTestState("idle")
      } else {
        setMyIdState("fail")
        setMyIdError(result.error || "no open_id in response")
      }
    } catch (err) {
      setMyIdState("fail")
      setMyIdError(err instanceof Error ? err.message : String(err))
    }
  }, [draft.feishuConfig, setDraft])

  const sendTest = useCallback(async () => {
    setTestState("sending")
    setTestError("")
    try {
      const result = await sendFeishuMessage(
        draft.feishuConfig.recipientId,
        t("settings.sections.feishu.testMessage", { defaultValue: "[LLM Wiki] 飞书通知测试成功" }),
      )
      if (result.ok) {
        setTestState("ok")
      } else {
        setTestState("fail")
        setTestError(result.error)
      }
    } catch (err) {
      setTestState("fail")
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }, [draft.feishuConfig.recipientId, t])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Bell className="h-5 w-5" />
          {t("settings.sections.feishu.title", { defaultValue: "飞书通知" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.feishu.description", {
            defaultValue: "AI 回复完成后，自动把摘要推送到飞书。依赖本机 lark-cli（Trae 飞书插件目录或 PATH）。",
          })}
        </p>
      </div>

      {/* 环境检测 */}
      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {t("settings.sections.feishu.environment", { defaultValue: "环境检测" })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void runDetect()}
            disabled={detecting}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${detecting ? "animate-spin" : ""}`} />
            {t("settings.sections.feishu.redetect", { defaultValue: "重新检测" })}
          </Button>
        </div>
        {detect === null ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.feishu.detecting", { defaultValue: "检测中…" })}
          </p>
        ) : detect.available ? (
          <p className="break-all text-xs text-emerald-600 dark:text-emerald-400">
            ✓ lark-cli {detect.version} — {detect.cliPath}
          </p>
        ) : (
          <p className="text-xs text-destructive">✗ {detect.error}</p>
        )}
      </div>

      {/* 总开关 */}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.feishuConfig.enabled}
          onChange={(e) =>
            setDraft("feishuConfig", { ...draft.feishuConfig, enabled: e.target.checked })
          }
          className="mt-0.5 h-4 w-4"
        />
        <div className="space-y-1">
          <span className="text-sm">
            {t("settings.sections.feishu.enable", { defaultValue: "启用飞书通知" })}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.feishu.enableHint", {
              defaultValue: "开启后，聊天界面的铃铛开关可用；铃铛打开时每条 AI 回复都会推送。",
            })}
          </p>
        </div>
      </label>

      {/* 飞书遥控对话（双向） */}
      <div className="space-y-3 rounded-md border border-border p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={draft.feishuConfig.bridgeEnabled}
            onChange={(e) =>
              setDraft("feishuConfig", { ...draft.feishuConfig, bridgeEnabled: e.target.checked })
            }
            className="mt-0.5 h-4 w-4"
          />
          <div className="space-y-1">
            <span className="flex items-center gap-1.5 text-sm">
              <MessageCircle className="h-3.5 w-3.5" />
              {t("settings.sections.feishu.bridgeEnable", { defaultValue: "启用飞书遥控对话" })}
            </span>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.feishu.bridgeEnableHint", {
                defaultValue:
                  "常驻监听你发来的飞书消息，用当前项目直接回复你（走与聊天界面完全相同的 AI 链路）。保存设置后生效，占用极低。",
              })}
            </p>
          </div>
        </label>
        {draft.feishuConfig.bridgeEnabled && (
          <div className="space-y-1 rounded border border-border bg-muted/30 p-2 text-xs">
            {bridgeStatus === null ? (
              <p className="text-muted-foreground">
                {t("settings.sections.feishu.bridgeChecking", { defaultValue: "读取状态中…" })}
              </p>
            ) : (
              <>
                <p className={bridgeStatus.ready ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                  {bridgeStatus.ready
                    ? t("settings.sections.feishu.bridgeReady", { defaultValue: "✓ 已连接，正在监听飞书消息" })
                    : t("settings.sections.feishu.bridgeWaiting", { defaultValue: "… 正在连接飞书长连接" })}
                </p>
                <p className="text-muted-foreground">
                  {t("settings.sections.feishu.bridgeHandled", {
                    defaultValue: "已回复 {{count}} 条 · 项目 {{project}}",
                    count: bridgeStatus.handled,
                    project: bridgeStatus.projectId,
                  })}
                </p>
                {bridgeStatus.lastMessage && (
                  <p className="break-all text-muted-foreground">
                    {t("settings.sections.feishu.bridgeLast", { defaultValue: "最近收到：" })}
                    {bridgeStatus.lastMessage}
                  </p>
                )}
                {bridgeStatus.lastError && (
                  <p className="break-all text-destructive">✗ {bridgeStatus.lastError}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* 收件人 */}
      <div className="space-y-2">
        <Label>{t("settings.sections.feishu.recipient", { defaultValue: "收件人 ID" })}</Label>
        <div className="flex gap-2">
          <input
            type="text"
            value={draft.feishuConfig.recipientId}
            onChange={(e) => handleRecipientChange(e.target.value)}
            placeholder="ou_xxx（私聊 open_id）或 oc_xxx（群 chat_id）"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchMyId()}
            disabled={myIdState === "loading" || !detect?.available}
            className="h-9 shrink-0 gap-1.5 whitespace-nowrap"
            title={t("settings.sections.feishu.getMyIdHint", {
              defaultValue:
                "读取本机 lark-cli 已登录的用户身份并填入（发给谁就填谁的 ID，这里填你自己）",
            })}
          >
            <UserRound className="h-3.5 w-3.5" />
            {myIdState === "loading"
              ? t("settings.sections.feishu.getMyIdLoading", { defaultValue: "查询中…" })
              : t("settings.sections.feishu.getMyId", { defaultValue: "获取我的 ID" })}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.feishu.recipientHint", {
            defaultValue:
              "发给谁就填谁的 ID：open_id（ou_ 开头）私聊指定人；chat_id（oc_ 开头）发到指定群。「获取我的 ID」= 推送给你自己。",
          })}
        </p>
        {draft.feishuConfig.recipientId.trim() !== "" && !recipientValid && (
          <p className="break-all text-xs text-destructive">
            {t("settings.sections.feishu.recipientInvalid", {
              defaultValue:
                "收件人 ID 无效：必须以 ou_ 或 oc_ 开头。若刚粘贴了聊天内容，请只保留其中的 ID。",
            })}
          </p>
        )}
        {myIdState === "ok" && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            ✓ {t("settings.sections.feishu.getMyIdOk", { defaultValue: "已填入你的 open_id" })}
          </p>
        )}
        {myIdState === "fail" && (
          <p className="break-all text-xs text-destructive">
            ✗ {myIdError}
            <span className="mt-1 block text-muted-foreground">
              {t("settings.sections.feishu.noIdentityHint", {
                defaultValue:
                  "本机 lark-cli 没有已登录用户。请先在 Trae 里登录飞书（或执行 lark-cli auth login），再回来重试；也可直接手动粘贴收件人 ID。",
              })}
            </span>
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void sendTest()}
          disabled={!recipientValid || !detect?.available || testState === "sending"}
          className="gap-1.5"
        >
          <Send className="h-3.5 w-3.5" />
          {testState === "sending"
            ? t("settings.sections.feishu.sending", { defaultValue: "发送中…" })
            : t("settings.sections.feishu.sendTest", { defaultValue: "发送测试消息" })}
        </Button>
        {!recipientValid && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.feishu.testDisabledHint", {
              defaultValue: "先填入 ou_/oc_ 开头的收件人 ID（或点「获取我的 ID」），才能发送测试消息。",
            })}
          </p>
        )}
        {testState === "ok" && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            ✓ {t("settings.sections.feishu.testSent", { defaultValue: "已发送，请查收飞书消息" })}
          </p>
        )}
        {testState === "fail" && (
          <p className="break-all text-xs text-destructive">
            ✗ {testError}
            {(testError.includes("cross app") || testError.includes("need_user_authorization")) && (
              <span className="mt-1 block text-muted-foreground">
                {t("settings.sections.feishu.crossAppHint", {
                  defaultValue:
                    "该 ID 与当前 lark-cli 凭证不匹配（open_id 是应用维度的）。点「获取我的 ID」重新获取即可。",
                })}
              </span>
            )}
          </p>
        )}
      </div>

      {/* 摘要长度 */}
      <div className="space-y-2">
        <Label>{t("settings.sections.feishu.summaryLength", { defaultValue: "摘要长度（前 N 字符）" })}</Label>
        <input
          type="number"
          min={20}
          max={4000}
          step={20}
          value={draft.feishuConfig.summaryLength}
          onChange={(e) =>
            setDraft("feishuConfig", {
              ...draft.feishuConfig,
              summaryLength: Number(e.target.value) || 200,
            })
          }
          className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.feishu.summaryLengthHint", {
            defaultValue: "超出部分截断，默认 200。发送前会剔除推理块和 markdown 标记。",
          })}
        </p>
      </div>
    </div>
  )
}
