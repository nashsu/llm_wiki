/**
 * Frontmatter parser — Node.js port.
 * Uses js-yaml for YAML parsing.
 */
import yaml from "js-yaml"

export type FrontmatterValue = string | string[]

export interface FrontmatterParseResult {
  frontmatter: Record<string, FrontmatterValue> | null
  body: string
  rawBlock: string
}

const FM_BLOCK_STRICT_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/

export function parseFrontmatter(content: string): FrontmatterParseResult {
  const strict = content.match(FM_BLOCK_STRICT_RE)
  if (!strict) return { frontmatter: null, body: content, rawBlock: "" }

  const yamlPayload = strict[1]
  const rawBlock = strict[0]
  const body = content.slice(rawBlock.length)

  let parsed: unknown
  try {
    parsed = yaml.load(yamlPayload, { schema: yaml.JSON_SCHEMA })
  } catch {
    try {
      parsed = yaml.load(repairWikilinkLists(yamlPayload), { schema: yaml.JSON_SCHEMA })
    } catch {
      return { frontmatter: null, body, rawBlock }
    }
  }

  return { frontmatter: normalize(parsed), body, rawBlock }
}

function repairWikilinkLists(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/)
      if (!m) return line
      const items = m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => `"${s}"`).join(", ")
      return `${m[1]}[${items}]`
    })
    .join("\n")
}

function normalize(parsed: unknown): Record<string, FrontmatterValue> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const out: Record<string, FrontmatterValue> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[key] = value.map((v) => stringifyScalar(v))
      continue
    }
    out[key] = stringifyScalar(value)
  }
  return out
}

function stringifyScalar(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  try { return JSON.stringify(v) } catch { return String(v) }
}
