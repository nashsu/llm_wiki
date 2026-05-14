import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import {
  dropLegacyVectorTable,
  embedAllPages,
  getEmbeddingCount,
  getLastEmbeddingError,
  legacyVectorRowCount,
} from "@/lib/embedding"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type ReindexState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; count: number }

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

export function EmbeddingSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)

  const [chunkCount, setChunkCount] = useState<number | null>(null)
  const [legacyCount, setLegacyCount] = useState<number>(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [reindex, setReindex] = useState<ReindexState>({ kind: "idle" })
  const [legacyDropped, setLegacyDropped] = useState(false)

  const refreshStats = useCallback(async () => {
    if (!project) return
    try {
      const [chunks, legacy] = await Promise.all([
        getEmbeddingCount(project.path),
        legacyVectorRowCount(project.path),
      ])
      setChunkCount(chunks)
      setLegacyCount(legacy)
    } catch {
      setChunkCount(null)
    }
    setLastError(getLastEmbeddingError())
  }, [project])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  const handleReindex = useCallback(async () => {
    if (!project) return
    setReindex({ kind: "running", done: 0, total: 0 })
    const count = await embedAllPages(project.path, embeddingConfig, (done, total) => {
      setReindex({ kind: "running", done, total })
    })
    setReindex({ kind: "done", count })
    await refreshStats()
  }, [project, embeddingConfig, refreshStats])

  const handleDropLegacy = useCallback(async () => {
    if (!project) return
    await dropLegacyVectorTable(project.path)
    setLegacyCount(0)
    setLegacyDropped(true)
  }, [project])

  const showLegacyMigration =
    legacyCount > 0 && (chunkCount === null || chunkCount === 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.embedding.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.embedding.description")}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <div className="text-sm font-medium">{t("settings.sections.embedding.enableLabel")}</div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.embedding.enableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("embeddingEnabled", !draft.embeddingEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            draft.embeddingEnabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              draft.embeddingEnabled ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {draft.embeddingEnabled && (
        <>
          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.endpoint")}</Label>
            <Input
              value={draft.embeddingEndpoint}
              onChange={(e) => setDraft("embeddingEndpoint", e.target.value)}
              placeholder="http://127.0.0.1:1234/v1/embeddings"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.endpointHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.apiKey")}</Label>
            <Input
              type="password"
              value={draft.embeddingApiKey}
              onChange={(e) => setDraft("embeddingApiKey", e.target.value)}
              placeholder={t("settings.sections.embedding.apiKeyPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.model")}</Label>
            <Input
              value={draft.embeddingModel}
              onChange={(e) => setDraft("embeddingModel", e.target.value)}
              placeholder="e.g. text-embedding-qwen3-embedding-0.6b or gemini-embedding-001"
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.outputDimensionality")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.embeddingOutputDimensionality ?? ""}
              onChange={(e) => {
                setDraft("embeddingOutputDimensionality", parsePositiveInteger(e.target.value))
              }}
              placeholder="768"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.outputDimensionalityHint")}
            </p>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="text-sm font-medium">
              {t("settings.sections.embedding.chunking")}
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.embedding.maxChunkChars")}</Label>
              <Input
                type="number"
                min={200}
                step={100}
                value={draft.embeddingMaxChunkChars ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setDraft(
                    "embeddingMaxChunkChars",
                    v === "" ? undefined : Number(v),
                  )
                }}
                placeholder="1000"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.maxChunkCharsHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.embedding.overlapChunkChars")}</Label>
              <Input
                type="number"
                min={0}
                step={50}
                value={draft.embeddingOverlapChunkChars ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  setDraft(
                    "embeddingOverlapChunkChars",
                    v === "" ? undefined : Number(v),
                  )
                }}
                placeholder="200"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.overlapChunkCharsHint")}
              </p>
            </div>
          </div>

          {showLegacyMigration && (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="text-sm font-medium text-destructive">
                {t("settings.sections.embedding.legacyPromptTitle")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.legacyPromptBody", { count: legacyCount })}
              </p>
            </div>
          )}

          <div className="space-y-3 rounded-md border p-3">
            <div className="text-sm font-medium">
              {t("settings.sections.embedding.statsHeading")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.chunkCount", { count: chunkCount ?? 0 })}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReindex}
                disabled={reindex.kind === "running" || !project}
              >
                {reindex.kind === "running"
                  ? t("settings.sections.embedding.reindexing", {
                      done: reindex.done,
                      total: reindex.total,
                    })
                  : t("settings.sections.embedding.reindexAll")}
              </Button>

              {legacyCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDropLegacy}
                  disabled={!project}
                >
                  {t("settings.sections.embedding.dropLegacy")}
                </Button>
              )}
            </div>

            {reindex.kind === "done" && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.reindexDone", { count: reindex.count })}
              </p>
            )}

            {legacyDropped && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.dropLegacyDone")}
              </p>
            )}

            {lastError && (
              <div className="space-y-1">
                <div className="text-xs font-medium">
                  {t("settings.sections.embedding.lastErrorHeading")}
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
                  {lastError}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
