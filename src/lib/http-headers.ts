export const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "host",
  "content-length",
  "x-goog-api-key",
])

export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
}

export function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!name || !value || !HTTP_HEADER_NAME_RE.test(name) || RESERVED_HEADER_NAMES.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}
