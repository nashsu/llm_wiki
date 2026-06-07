import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { MineruModelVersion } from "@/stores/wiki-store"
import { testMineruConnection } from "@/lib/mineru"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type TestState = "idle" | "running" | "success" | "failed"

export function MineruSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [testState, setTestState] = useState<TestState>("idle")
  const [testError, setTestError] = useState("")

  const handleTest = async () => {
    if (!draft.mineruToken.trim()) return
    setTestState("running")
    setTestError("")
    try {
      await testMineruConnection(draft.mineruToken.trim())
      setTestState("success")
    } catch (err) {
      setTestState("failed")
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.mineru.title", { defaultValue: "MinerU PDF Parser" })}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.sections.mineru.description", {
            defaultValue:
              "Use MinerU cloud API for higher quality PDF parsing (tables, formulas, complex layouts)",
          })}
        </p>
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {t("settings.sections.mineru.privacyNotice", {
            defaultValue:
              "When enabled, PDF contents are uploaded to MinerU cloud for parsing. Do not enable this for sensitive documents unless you accept that.",
          })}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.mineruEnabled}
          onChange={(e) => setDraft("mineruEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.mineru.enabled", { defaultValue: "Enable MinerU" })}
        </span>
      </label>

      {draft.mineruEnabled && (
        <div className="space-y-4 pl-1">
          <div className="space-y-2">
            <Label htmlFor="mineru-token">
              {t("settings.sections.mineru.token", { defaultValue: "API Token" })}
            </Label>
            <Input
              id="mineru-token"
              type="password"
              value={draft.mineruToken}
              onChange={(e) => {
                setDraft("mineruToken", e.target.value)
                setTestState("idle")
              }}
              placeholder={t("settings.sections.mineru.tokenHint", {
                defaultValue: "Get your token from mineru.net",
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mineru-model">
              {t("settings.sections.mineru.model", { defaultValue: "Model Version" })}
            </Label>
            <select
              id="mineru-model"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={draft.mineruModelVersion}
              onChange={(e) =>
                setDraft("mineruModelVersion", e.target.value as MineruModelVersion)
              }
            >
              <option value="vlm">
                {t("settings.sections.mineru.modelVlm", {
                  defaultValue: "VLM (Recommended, best for complex layouts)",
                })}
              </option>
              <option value="pipeline">
                {t("settings.sections.mineru.modelPipeline", {
                  defaultValue: "Pipeline (Faster)",
                })}
              </option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.mineru.modelHint", {
                defaultValue: "PDF parsing supports pipeline and vlm. MinerU-HTML is for HTML files and is not used here.",
              })}
            </p>
          </div>
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("settings.sections.mineru.testQuotaNotice", {
              defaultValue:
                "Connection test submits a small demo file to MinerU and may consume a small amount of quota.",
            })}
          </p>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={
                !draft.mineruToken.trim() || testState === "running"
              }
            >
              {testState === "running"
                ? t("settings.sections.mineru.testing", { defaultValue: "Testing..." })
                : t("settings.sections.mineru.test", {
                    defaultValue: "Test Connection",
                  })}
            </Button>
            {testState === "success" && (
              <span className="text-sm text-green-600">
                {t("settings.sections.mineru.testSuccess", {
                  defaultValue: "Connection successful",
                })}
              </span>
            )}
            {testState === "failed" && (
              <span className="text-sm text-red-600">
                {t("settings.sections.mineru.testFailed", {
                  defaultValue: "Test failed",
                })}
                : {testError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
