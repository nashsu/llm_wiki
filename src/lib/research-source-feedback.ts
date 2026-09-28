import type { TFunction } from "i18next"
import type { SearchApiConfig } from "@/stores/wiki-store"
import {
  getDeepResearchConfigurationIssue,
  SEARCH_PROVIDER_LABELS,
} from "@/lib/web-search"

export function getDeepResearchConfigurationMessage(
  config: SearchApiConfig,
  t: TFunction,
): string | null {
  const issue = getDeepResearchConfigurationIssue(config)
  if (!issue) return null

  switch (issue.kind) {
    case "no-provider":
      return t("research.noWebProvider")
    case "missing-api-key":
      return t("research.providerMissingApiKey", {
        provider: SEARCH_PROVIDER_LABELS[issue.provider],
      })
    case "missing-url":
      return t("research.providerMissingUrl", {
        provider: SEARCH_PROVIDER_LABELS[issue.provider],
      })
    case "anytxt-not-configured":
      return t("research.anyTxtNotConfigured")
    case "no-sources-configured":
      return t("research.notConfigured")
  }
}
