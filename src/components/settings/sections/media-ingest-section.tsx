import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function MediaIngestSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.mediaIngest.title", { defaultValue: "Media ingestion" })}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t("settings.sections.mediaIngest.description", {
            defaultValue:
              "Transcribe audio/video sources and caption image sources so they become searchable wiki content.",
          })}
        </p>
      </div>

      <div className="space-y-4 border-b pb-6">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.mediaIngestAudioVideoEnabled}
            onChange={(e) => setDraft("mediaIngestAudioVideoEnabled", e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-sm font-medium">
            {t("settings.sections.mediaIngest.audioVideoEnabled", {
              defaultValue: "Enable audio/video transcription",
            })}
          </span>
        </label>
        <p className="text-xs text-muted-foreground pl-6">
          {t("settings.sections.mediaIngest.audioVideoDescription", {
            defaultValue:
              "Local video/audio files and video links (YouTube and anything yt-dlp supports) get their audio extracted and transcribed. Off by default — mp4/audio files and links are not ingested until enabled.",
          })}
        </p>

        {draft.mediaIngestAudioVideoEnabled && (
          <div className="space-y-4 pl-1">
            <div className="space-y-2">
              <Label>
                {t("settings.sections.mediaIngest.provider", {
                  defaultValue: "Transcription provider",
                })}
              </Label>
              <div className="space-y-1 pl-1">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={draft.mediaIngestAudioVideoBackend === "groq"}
                    onChange={() => setDraft("mediaIngestAudioVideoBackend", "groq")}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">
                    {t("settings.sections.mediaIngest.providerGroq", {
                      defaultValue: "Groq (Whisper large-v3-turbo) - requires an API token",
                    })}
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={draft.mediaIngestAudioVideoBackend === "custom"}
                    onChange={() => setDraft("mediaIngestAudioVideoBackend", "custom")}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">
                    {t("settings.sections.mediaIngest.providerCustom", {
                      defaultValue: "Custom endpoint - any OpenAI-compatible transcription API",
                    })}
                  </span>
                </label>
              </div>
            </div>

            {draft.mediaIngestAudioVideoBackend === "groq" && (
              <div className="space-y-2">
                <Label htmlFor="media-ingest-groq-token">
                  {t("settings.sections.mediaIngest.groqToken", { defaultValue: "Groq API Token" })}
                </Label>
                <Input
                  id="media-ingest-groq-token"
                  type="password"
                  value={draft.mediaIngestAudioVideoToken}
                  onChange={(e) => setDraft("mediaIngestAudioVideoToken", e.target.value)}
                  placeholder={t("settings.sections.mediaIngest.groqTokenHint", {
                    defaultValue: "Get your token from console.groq.com",
                  })}
                />
              </div>
            )}

            {draft.mediaIngestAudioVideoBackend === "custom" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="media-ingest-custom-endpoint">
                    {t("settings.sections.mediaIngest.customEndpoint", {
                      defaultValue: "Endpoint URL",
                    })}
                  </Label>
                  <Input
                    id="media-ingest-custom-endpoint"
                    type="url"
                    value={draft.mediaIngestAudioVideoCustomEndpoint}
                    onChange={(e) => setDraft("mediaIngestAudioVideoCustomEndpoint", e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("settings.sections.mediaIngest.customEndpointHint", {
                      defaultValue:
                        "Base URL of an OpenAI-compatible /audio/transcriptions endpoint.",
                    })}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="media-ingest-custom-token">
                    {t("settings.sections.mediaIngest.customToken", {
                      defaultValue: "API Token (optional)",
                    })}
                  </Label>
                  <Input
                    id="media-ingest-custom-token"
                    type="password"
                    value={draft.mediaIngestAudioVideoCustomToken}
                    onChange={(e) => setDraft("mediaIngestAudioVideoCustomToken", e.target.value)}
                    placeholder={t("settings.sections.mediaIngest.customTokenHint", {
                      defaultValue: "Sent as an Authorization: Bearer header",
                    })}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.mediaIngestImagesEnabled}
            onChange={(e) => setDraft("mediaIngestImagesEnabled", e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-sm font-medium">
            {t("settings.sections.mediaIngest.imagesEnabled", {
              defaultValue: "Accept standalone image files as sources",
            })}
          </span>
        </label>
        <p className="text-xs text-muted-foreground pl-6">
          {t("settings.sections.mediaIngest.imagesDescription", {
            defaultValue:
              "Lets standalone image files (png/jpg/...) become sources at all. This alone does NOT produce captions — it also requires \"Enable captioning\" under Settings → Image Captioning (that toggle picks the LLM model, which must support image input). With only this one on, images are accepted but stay uncaptioned.",
          })}
        </p>
      </div>
    </div>
  )
}
