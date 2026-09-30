import { useState } from "react"
import { Eye, EyeOff, ShieldAlert, Ticket } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { JiraApiError, JiraClient } from "@/lib/jira-api"
import { normalizeJiraConfig, resolveJiraExportDir } from "@/lib/jira-config"
import { saveJiraConfig } from "@/lib/project-store"
import { useWikiStore, type JiraConfig } from "@/stores/wiki-store"

/**
 * Jira settings persist on commit (blur / toggle) rather than through the
 * shared draft + Save bar — this section owns a single config object that the
 * Jira view reads directly, so an unsaved draft would leave the two out of
 * step with no visible reason.
 */
export function JiraSection() {
  const { t } = useTranslation()
  const config = useWikiStore((s) => s.jiraConfig)
  const setJiraConfig = useWikiStore((s) => s.setJiraConfig)
  const project = useWikiStore((s) => s.project)
  const [showPassword, setShowPassword] = useState(false)
  const [fields, setFields] = useState(() => ({
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    processFieldId: config.processFieldId,
    exportDir: config.exportDir,
    scopeJql: config.scopeJql,
    userAgent: config.userAgent,
    maxAttachmentMb: String(config.maxAttachmentMb),
  }))
  const [testState, setTestState] = useState<{
    state: "idle" | "testing" | "ok" | "error"
    message: string
  }>({ state: "idle", message: "" })

  /** Push the edited fields into the store and to disk. */
  function commitFields(patch: Partial<JiraConfig> = {}) {
    const next = normalizeJiraConfig({
      ...useWikiStore.getState().jiraConfig,
      baseUrl: fields.baseUrl,
      username: fields.username,
      password: fields.password,
      processFieldId: fields.processFieldId,
      exportDir: fields.exportDir,
      scopeJql: fields.scopeJql,
      userAgent: fields.userAgent,
      maxAttachmentMb: Number(fields.maxAttachmentMb),
      ...patch,
    })
    setJiraConfig(next)
    saveJiraConfig(next).catch((error: unknown) => {
      console.warn("Failed to save the Jira settings:", error)
    })
  }

  const resolvedExportDir = resolveJiraExportDir(project?.path ?? "", fields.exportDir)

  async function handleTestConnection() {
    const candidate = normalizeJiraConfig({
      ...useWikiStore.getState().jiraConfig,
      baseUrl: fields.baseUrl,
      username: fields.username,
      password: fields.password,
      userAgent: fields.userAgent,
    })
    commitFields()
    setTestState({ state: "testing", message: t("settings.sections.jira.testRunning") })
    try {
      const info = await new JiraClient(candidate).testConnection()
      setTestState({
        state: "ok",
        message: t("settings.sections.jira.testOk", {
          version: info.version ?? "?",
          title: info.serverTitle ?? "",
        }),
      })
    } catch (error) {
      setTestState({
        state: "error",
        message: error instanceof JiraApiError ? error.describe() : String(error),
      })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Ticket className="h-5 w-5 text-muted-foreground" />
          {t("settings.sections.jira.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.jira.description")}
        </p>
      </div>

      <section className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="jira-base-url" className="text-xs font-semibold">
            {t("settings.sections.jira.baseUrl")}
          </Label>
          <Input
            id="jira-base-url"
            value={fields.baseUrl}
            placeholder="https://jira.example.com"
            onChange={(event) => setFields((current) => ({ ...current, baseUrl: event.target.value }))}
            onBlur={() => commitFields()}
            className="h-8 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.baseUrlHint")}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="jira-username" className="text-xs font-semibold">
              {t("settings.sections.jira.username")}
            </Label>
            <Input
              id="jira-username"
              value={fields.username}
              onChange={(event) => setFields((current) => ({ ...current, username: event.target.value }))}
              onBlur={() => commitFields()}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jira-password" className="text-xs font-semibold">
              {t("settings.sections.jira.password")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="jira-password"
                type={showPassword ? "text" : "password"}
                value={fields.password}
                onChange={(event) => setFields((current) => ({ ...current, password: event.target.value }))}
                onBlur={() => commitFields()}
                className="h-8 text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                title={t(showPassword ? "settings.sections.jira.hidePassword" : "settings.sections.jira.showPassword")}
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={testState.state === "testing"}
            onClick={() => void handleTestConnection()}
          >
            {t("settings.sections.jira.testConnection")}
          </Button>
          {testState.message && (
            <p
              className={`break-all text-xs ${
                testState.state === "error"
                  ? "text-destructive"
                  : testState.state === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
              }`}
            >
              {testState.message}
            </p>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-destructive">
              {t("settings.sections.jira.passwordWarningTitle")}
            </p>
            <p>{t("settings.sections.jira.passwordWarning")}</p>
          </div>
        </div>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={config.acceptInvalidCerts}
            onChange={(event) => commitFields({ acceptInvalidCerts: event.target.checked })}
            className="mt-1 h-4 w-4"
          />
          <span className="space-y-1">
            <span className="block text-sm font-semibold">
              {t("settings.sections.jira.acceptInvalidCerts")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("settings.sections.jira.acceptInvalidCertsHint")}
            </span>
          </span>
        </label>

        <div className="space-y-1.5">
          <Label htmlFor="jira-user-agent" className="text-xs font-semibold">
            {t("settings.sections.jira.userAgent")}
          </Label>
          <Input
            id="jira-user-agent"
            value={fields.userAgent}
            onChange={(event) => setFields((current) => ({ ...current, userAgent: event.target.value }))}
            onBlur={() => commitFields()}
            className="h-8 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.userAgentHint")}
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">{t("settings.sections.jira.exportTitle")}</h3>
        <div className="space-y-1.5">
          <Label htmlFor="jira-export-dir" className="text-xs font-semibold">
            {t("settings.sections.jira.exportDir")}
          </Label>
          <Input
            id="jira-export-dir"
            value={fields.exportDir}
            onChange={(event) => setFields((current) => ({ ...current, exportDir: event.target.value }))}
            onBlur={() => commitFields()}
            className="h-8 text-sm"
          />
          <p className="break-all text-xs text-muted-foreground">
            {t("settings.sections.jira.exportDirHint")} {resolvedExportDir}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="jira-max-attachment" className="text-xs font-semibold">
            {t("settings.sections.jira.maxAttachmentMb")}
          </Label>
          <Input
            id="jira-max-attachment"
            type="number"
            min={1}
            max={2048}
            value={fields.maxAttachmentMb}
            onChange={(event) =>
              setFields((current) => ({ ...current, maxAttachmentMb: event.target.value }))
            }
            onBlur={() => commitFields()}
            className="h-8 w-32 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.maxAttachmentMbHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="jira-process-field" className="text-xs font-semibold">
            {t("settings.sections.jira.processFieldId")}
          </Label>
          <Input
            id="jira-process-field"
            value={fields.processFieldId}
            placeholder="customfield_12345"
            onChange={(event) =>
              setFields((current) => ({ ...current, processFieldId: event.target.value }))
            }
            onBlur={() => commitFields()}
            className="h-8 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.processFieldIdHint")}
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">{t("settings.sections.jira.searchTitle")}</h3>
        <div className="space-y-1.5">
          <Label htmlFor="jira-scope-jql" className="text-xs font-semibold">
            {t("settings.sections.jira.scopeJql")}
          </Label>
          <Input
            id="jira-scope-jql"
            value={fields.scopeJql}
            placeholder="project = AERDM"
            onChange={(event) => setFields((current) => ({ ...current, scopeJql: event.target.value }))}
            onBlur={() => commitFields()}
            className="h-8 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.jira.scopeJqlHint")}
          </p>
        </div>
      </section>
    </div>
  )
}
