export function pageTextToMarkdown(title: string, url: string, text: string): string {
  const cleanTitle = title.trim() || url
  const cleanText = normalizeExtractedText(text)
  return [`# ${escapeMarkdownHeading(cleanTitle)}`, "", `> 来源：${url}`, "", cleanText].join("\n")
}

export function normalizeExtractedText(text: string, maxChars = 30_000): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}\n\n……（内容过长，已截断）`
}

export function quoteFromMarkdown(markdown: string, maxChars = 1_200): string {
  const body = markdown
    .replace(/^# .+$/m, "")
    .replace(/^> 来源：.+$/m, "")
    .trim()
  return body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}…` : body
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/^[#]+/g, "").trim()
}
