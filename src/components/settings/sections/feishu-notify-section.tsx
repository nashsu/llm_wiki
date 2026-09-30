import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bell, MessageCircle, RefreshCw, Send, UserRound } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import {
  beginFeishuAuth,
  completeFeishuAuth,
  detectFeishu,
  extractFeishuDocToken,
  extractFeishuFolderToken,
  extractRecipientId,
  getFeishuBridgeStatus,
  getFeishuMyId,
  sendFeishuMessage,
  testFeishuDocFolder,
  testFeishuDocTarget,
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
  const [folderTestState, setFolderTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle")
  const [folderTestInfo, setFolderTestInfo] = useState("")
  const [docTestState, setDocTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle")
  const [docTestInfo, setDocTestInfo] = useState("")
  // Device Flow 用户凭证授权（发布文档需要用户身份）
  const [authLink, setAuthLink] = useState<{ url: string; userCode: string; deviceCode: string } | null>(null)
  const [authState, setAuthState] = useState<"idle" | "linking" | "waiting" | "completing" | "ok" | "fail">("idle")
  const [authError, setAuthError] = useState("")

  const genAuthLink = useCallback(async () => {
    setAuthState("linking")
    setAuthError("")
    setAuthLink(null)
    try {
      const r = await beginFeishuAuth()
      if (r.ok) {
        setAuthLink({ url: r.verificationUrl, userCode: r.userCode, deviceCode: r.deviceCode })
        setAuthState("waiting")
      } else {
        setAuthState("fail")
        setAuthError(r.error)
      }
    } catch (err) {
      setAuthState("fail")
      setAuthError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const finishAuth = useCallback(async () => {
    if (!authLink) return
    setAuthState("completing")
    setAuthError("")
    try {
      const r = await completeFeishuAuth(authLink.deviceCode)
      if (r.ok) {
        setAuthState("ok")
      } else {
        setAuthState("fail")
        setAuthError(r.error)
      }
    } catch (err) {
      setAuthState("fail")
      setAuthError(err instanceof Error ? err.message : String(err))
    }
  }, [authLink])

  // 目标文档只读校验：不写入内容，返回文档标题确认指向正确
  const testDocTarget = useCallback(async () => {
    setDocTestState("testing")
    setDocTestInfo("")
    try {
      const result = await testFeishuDocTarget(draft.feishuConfig.bridgeDocTarget)
      if (result.ok) {
        setDocTestState("ok")
        setDocTestInfo(result.title ? `${result.title}|${result.url}` : result.url)
      } else {
        setDocTestState("fail")
        setDocTestInfo(result.error)
      }
    } catch (err) {
      setDocTestState("fail")
      setDocTestInfo(err instanceof Error ? err.message : String(err))
    }
  }, [draft.feishuConfig.bridgeDocTarget])

  // 目录连通性测试：走与真实回复相同的发布链路，在目标目录生成一篇测试文档
  const testDocFolder = useCallback(async () => {
    setFolderTestState("testing")
    setFolderTestInfo("")
    try {
      const result = await testFeishuDocFolder(draft.feishuConfig.bridgeDocFolder)
      if (result.ok) {
        setFolderTestState("ok")
        setFolderTestInfo(result.url)
      } else {
        setFolderTestState("fail")
        setFolderTestInfo(result.error)
      }
    } catch (err) {
      setFolderTestState("fail")
      setFolderTestInfo(err instanceof Error ? err.message : String(err))
    }
  }, [draft.feishuConfig.bridgeDocFolder])

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
          <>
          <label className="flex items-start gap-2 pl-1">
            <input
              type="checkbox"
              checked={draft.feishuConfig.bridgeReplyAsDoc}
              onChange={(e) =>
                setDraft("feishuConfig", { ...draft.feishuConfig, bridgeReplyAsDoc: e.target.checked })
              }
              className="mt-0.5 h-4 w-4"
            />
            <div className="space-y-1">
              <span className="text-sm">
                {t("settings.sections.feishu.bridgeReplyDoc", { defaultValue: "回复为飞书文档" })}
              </span>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.feishu.bridgeReplyDocHint", {
                  defaultValue:
                    "开启后，机器人回复和聊天界面的飞书通知都改为「发布全文飞书文档 + 回发链接」（表格/mermaid 可用，走下方目录/模式设置）；关闭后发纯文本——机器人发全文，聊天通知也发完整原文（仅剔除推理块）。依赖本机 lark-cli 用户凭证，发布失败自动降级为纯文本。",
                })}
              </p>
            </div>
          </label>
          {draft.feishuConfig.bridgeReplyAsDoc && (
            <div className="space-y-3 rounded border border-border bg-muted/20 p-2 pl-3">
              {/* 用户凭证授权（Device Flow） */}
              <div className="space-y-1.5 rounded border border-border/60 bg-background/50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {t("settings.sections.feishu.authTitle", { defaultValue: "用户凭证授权（发布文档必需）" })}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void genAuthLink()}
                    disabled={authState === "linking" || authState === "completing"}
                    className="h-7 gap-1 whitespace-nowrap text-xs"
                  >
                    <RefreshCw className={`h-3 w-3 ${authState === "linking" ? "animate-spin" : ""}`} />
                    {authState === "linking"
                      ? t("settings.sections.feishu.authLinking", { defaultValue: "生成中…" })
                      : t("settings.sections.feishu.authGen", { defaultValue: "生成授权链接" })}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("settings.sections.feishu.authHint", {
                    defaultValue:
                      "发布文档走你的用户身份（bot 应用无文档权限）。点「生成授权链接」→ 浏览器打开并确认（授权 docs/drive/im 域）→ 回来点「完成授权」。授权一次长期有效，token 过期会自动刷新。",
                  })}
                </p>
                {authLink && (authState === "waiting" || authState === "completing") && (
                  <div className="space-y-1.5 rounded border border-amber-300/50 bg-amber-50/50 p-2 dark:bg-amber-950/20">
                    <p className="break-all text-[11px]">
                      {t("settings.sections.feishu.authStep1", { defaultValue: "① 打开链接并确认（确认码" })}
                      <span className="font-mono font-semibold">{authLink.userCode || "—"}</span>
                      {t("settings.sections.feishu.authStep1b", { defaultValue: "，10 分钟内有效）：" })}
                    </p>
                    <a
                      href={authLink.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all text-[11px] text-blue-600 underline dark:text-blue-400"
                    >
                      {authLink.url}
                    </a>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void finishAuth()}
                      disabled={authState === "completing"}
                      className="h-7 gap-1 text-xs"
                    >
                      <RefreshCw className={`h-3 w-3 ${authState === "completing" ? "animate-spin" : ""}`} />
                      {authState === "completing"
                        ? t("settings.sections.feishu.authCompleting", { defaultValue: "完成中…" })
                        : t("settings.sections.feishu.authDone", { defaultValue: "② 我已授权，完成登录" })}
                    </Button>
                  </div>
                )}
                {authState === "ok" && (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                    ✓ {t("settings.sections.feishu.authOk", { defaultValue: "授权成功，凭证已保存到本机（~/.lark-cli），文档发布可长期使用" })}
                  </p>
                )}
                {authState === "fail" && (
                  <p className="break-all text-[11px] text-destructive">✗ {authError}</p>
                )}
              </div>
              {/* 文档目录 */}
              <div className="space-y-1">
                <Label className="text-xs">
                  {t("settings.sections.feishu.bridgeDocFolder", { defaultValue: "文档生成目录" })}
                </Label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={draft.feishuConfig.bridgeDocFolder}
                    onChange={(e) => {
                      const raw = e.target.value
                      setFolderTestState("idle")
                      setDraft("feishuConfig", {
                        ...draft.feishuConfig,
                        bridgeDocFolder: extractFeishuFolderToken(raw) ?? raw,
                      })
                    }}
                    placeholder="粘贴飞书文件夹链接（…/drive/folder/xxx），留空 = 我的空间根目录"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void testDocFolder()}
                    disabled={folderTestState === "testing" || !draft.feishuConfig.bridgeDocFolder.trim()}
                    className="h-7 shrink-0 gap-1 whitespace-nowrap text-xs"
                  >
                    <RefreshCw className={`h-3 w-3 ${folderTestState === "testing" ? "animate-spin" : ""}`} />
                    {folderTestState === "testing"
                      ? t("settings.sections.feishu.folderTesting", { defaultValue: "测试中…" })
                      : t("settings.sections.feishu.folderTest", { defaultValue: "测试目录" })}
                  </Button>
                </div>
                {folderTestState === "ok" && (
                  <p className="break-all text-[11px] text-emerald-600 dark:text-emerald-400">
                    ✓ {t("settings.sections.feishu.folderTestOk", { defaultValue: "测试文档已生成：" })}
                    <a href={folderTestInfo} target="_blank" rel="noreferrer" className="underline">
                      {folderTestInfo}
                    </a>
                  </p>
                )}
                {folderTestState === "fail" && (
                  <p className="break-all text-[11px] text-destructive">✗ {folderTestInfo}</p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {t("settings.sections.feishu.bridgeDocFolderHint", {
                    defaultValue: "在飞书云盘里打开目标文件夹，复制地址栏链接粘贴到这里；仅「每次新建」模式生效。",
                  })}
                </p>
              </div>
              {/* 模式选择 */}
              <div className="space-y-1">
                <Label className="text-xs">
                  {t("settings.sections.feishu.bridgeDocMode", { defaultValue: "文档模式" })}
                </Label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      name="feishu-doc-mode"
                      checked={draft.feishuConfig.bridgeDocMode === "new"}
                      onChange={() =>
                        setDraft("feishuConfig", { ...draft.feishuConfig, bridgeDocMode: "new" })
                      }
                      className="h-3.5 w-3.5"
                    />
                    {t("settings.sections.feishu.bridgeDocModeNew", { defaultValue: "每次新建文档" })}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      name="feishu-doc-mode"
                      checked={draft.feishuConfig.bridgeDocMode === "fixed"}
                      onChange={() =>
                        setDraft("feishuConfig", { ...draft.feishuConfig, bridgeDocMode: "fixed" })
                      }
                      className="h-3.5 w-3.5"
                    />
                    {t("settings.sections.feishu.bridgeDocModeFixed", { defaultValue: "覆盖固定文档" })}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      name="feishu-doc-mode"
                      checked={draft.feishuConfig.bridgeDocMode === "append"}
                      onChange={() =>
                        setDraft("feishuConfig", { ...draft.feishuConfig, bridgeDocMode: "append" })
                      }
                      className="h-3.5 w-3.5"
                    />
                    {t("settings.sections.feishu.bridgeDocModeAppend", { defaultValue: "追加到固定文档" })}
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("settings.sections.feishu.bridgeDocModeHint", {
                    defaultValue:
                      "新建=每条回复一个新文档；覆盖=每次整体替换同一文档；追加=每次回复接在文末（自动加分隔线和问题标题），形成问答日志。",
                  })}
                </p>
              </div>
              {/* 固定文档目标 */}
              {draft.feishuConfig.bridgeDocMode !== "new" && (
                <div className="space-y-1">
                  <Label className="text-xs">
                    {t("settings.sections.feishu.bridgeDocTarget", { defaultValue: "目标文档链接" })}
                  </Label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={draft.feishuConfig.bridgeDocTarget}
                      onChange={(e) => {
                        const raw = e.target.value
                        setDocTestState("idle")
                        setDraft("feishuConfig", {
                          ...draft.feishuConfig,
                          bridgeDocTarget: extractFeishuDocToken(raw) ?? raw,
                        })
                      }}
                      placeholder="粘贴目标飞书文档链接（…/docx/xxx）"
                      className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void testDocTarget()}
                      disabled={docTestState === "testing" || !draft.feishuConfig.bridgeDocTarget.trim()}
                      className="h-7 shrink-0 gap-1 whitespace-nowrap text-xs"
                    >
                      <RefreshCw className={`h-3 w-3 ${docTestState === "testing" ? "animate-spin" : ""}`} />
                      {docTestState === "testing"
                        ? t("settings.sections.feishu.docTesting", { defaultValue: "校验中…" })
                        : t("settings.sections.feishu.docTest", { defaultValue: "测试文档" })}
                    </Button>
                  </div>
                  {docTestState === "ok" && (
                    <p className="break-all text-[11px] text-emerald-600 dark:text-emerald-400">
                      ✓ {t("settings.sections.feishu.docTestOk", { defaultValue: "文档有效：" })}
                      {docTestInfo.split("|")[0] && (
                        <span>《{docTestInfo.split("|")[0]}》</span>
                      )}
                      {docTestInfo.split("|")[1] && (
                        <a href={docTestInfo.split("|")[1]} target="_blank" rel="noreferrer" className="ml-1 underline">
                          {docTestInfo.split("|")[1]}
                        </a>
                      )}
                    </p>
                  )}
                  {docTestState === "fail" && (
                    <p className="break-all text-[11px] text-destructive">✗ {docTestInfo}</p>
                  )}
                  {draft.feishuConfig.bridgeDocTarget.trim() !== "" &&
                    !extractFeishuDocToken(draft.feishuConfig.bridgeDocTarget) && (
                      <p className="text-[11px] text-destructive">
                        {t("settings.sections.feishu.bridgeDocTargetInvalid", {
                          defaultValue: "无法识别文档链接：需要 …/docx/xxx 格式或 20-40 位文档 token。",
                        })}
                      </p>
                    )}
                  <p className="text-[11px] text-muted-foreground">
                    {draft.feishuConfig.bridgeDocMode === "append"
                      ? t("settings.sections.feishu.bridgeDocTargetAppendHint", {
                          defaultValue: "每次回复会追加到该文档文末（自动加分隔线和问题标题）。",
                        })
                      : t("settings.sections.feishu.bridgeDocTargetHint", {
                          defaultValue: "注意：每次回复会整体替换该文档内容（含手动编辑的部分），请用专用文档。",
                        })}
                  </p>
                </div>
              )}
            </div>
          )}
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
          </>
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
    </div>
  )
}
