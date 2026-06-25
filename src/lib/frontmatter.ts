import yaml from "js-yaml"

export type FrontmatterValue = string | string[]

export interface FrontmatterParseResult {
  frontmatter: Record<string, FrontmatterValue> | null
  body: string
  /**
   * The literal frontmatter block (opening `---`, YAML payload,
   * closing `---`, plus the newlines that separate it from the
   * body) as it appears in the input. Empty string when there is
   * no frontmatter. Callers that edit only the body — e.g. the
   * read-mode renderers or body-only transforms — write back
   * `rawBlock + body` so user-managed YAML survives untouched.
   */
  rawBlock: string
}

// Strict, anchored detector. Both fence lines must be on their own
// line; content between is delegated to js-yaml. Used as the first
// step before falling back to the locator below.
const FM_BLOCK_STRICT_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/

// Same shape as STRICT but unanchored — used only when STRICT
// failed. LLM-generated pages often prepend an extra line or two
// before the real frontmatter (a stray `\`\`\`yaml` wrapper line, a
// `frontmatter:` key from a misformatted nested-document attempt,
// etc.). Rather than enumerating every such prefix, we look for
// the FIRST `---\n…\n---` block whose OPENING fence sits in the
// top few lines. The closing fence can land anywhere — long
// frontmatter lists are common — but capping the open-line means
// a `---` horizontal rule used as a section divider deep in the
// body can't be mistaken for frontmatter.
const FM_BLOCK_ANYWHERE_RE = /\n---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/
const MAX_PREFIX_LINES_BEFORE_FRONTMATTER = 6

export function parseFrontmatter(content: string): FrontmatterParseResult {
  const located = locateFrontmatterBlock(content)
  if (!located) return { frontmatter: null, body: content, rawBlock: "" }

  const { yamlPayload, rawBlock, body } = located

  // Two-pass YAML parse: try the payload as-is first, then on
  // failure run a single round of "wikilink-list" repair (LLMs
  // sometimes emit `related: [[a]], [[b]], [[c]]` which is not
  // valid YAML — wrap each `[[…]]` in quotes so it parses as a
  // string list). This is the only fixup we apply; anything
  // beyond that is reported as no-frontmatter.
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

  return {
    frontmatter: normalize(parsed),
    body,
    rawBlock,
  }
}

/**
 * Find the first `---…---` frontmatter block. Strict (top-of-file)
 * match is preferred; if it fails we scan a small window for an
 * unanchored block, which lets us recover from common LLM-corrupted
 * pages that put a junk line or two before the real frontmatter
 * (e.g. wrapping the file in a code fence, or emitting
 * `frontmatter:\n---\n…\n---\n`). Returns null when neither finds
 * anything plausible.
 */
function locateFrontmatterBlock(
  content: string,
): { yamlPayload: string; rawBlock: string; body: string } | null {
  const strict = content.match(FM_BLOCK_STRICT_RE)
  if (strict) {
    return {
      yamlPayload: strict[1],
      rawBlock: strict[0],
      body: content.slice(strict[0].length),
    }
  }

  // Scan the entire content (not just a head window) so a long
  // frontmatter list still resolves. The lazy match picks the
  // FIRST `---…---` pair, and we then guard against false
  // positives by checking that the OPENING `---` is within the
  // first few lines — that excludes section-divider HRs deep in
  // the body without limiting how long the frontmatter itself
  // can be.
  const fallback = content.match(FM_BLOCK_ANYWHERE_RE)
  if (!fallback || fallback.index === undefined) return null

  const openIdx = fallback.index + 1 // skip the leading `\n`
  if (lineNumberAt(content, openIdx) > MAX_PREFIX_LINES_BEFORE_FRONTMATTER) {
    return null
  }

  const rawBlock = content.slice(openIdx, openIdx + fallback[0].length - 1)
  const bodyAfterFm = content.slice(openIdx + rawBlock.length)

  // If the prefix that pushed us into the fallback is a ```yaml /
  // ```yml (or bare ```) code fence opener, strip the matching
  // CLOSING fence at the head of the body too. Without this, a
  // legacy LLM-corrupted page that wrapped its frontmatter in a
  // code fence renders correctly up top (the parser still
  // recovered the YAML) but the body opens with an orphan ```
  // that ReactMarkdown treats as a never-closed code block —
  // every heading / list / table below appears as raw source.
  const prefix = content.slice(0, openIdx)
  const prefixIsYamlFence = /^\s*```(?:yaml|yml)?\s*\r?\n$/i.test(prefix)
  if (prefixIsYamlFence) {
    const stripped = bodyAfterFm.replace(/^\s*```\s*(?:\r?\n|$)/, "")
    return {
      yamlPayload: fallback[1],
      rawBlock,
      body: stripped,
    }
  }

  return {
    yamlPayload: fallback[1],
    rawBlock,
    body: bodyAfterFm,
  }
}

/** 1-based line number that a given character index sits on. */
function lineNumberAt(s: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < s.length; i++) {
    if (s.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Repair a YAML payload where the author wrote a list of Obsidian
 * wikilinks without the outer brackets:
 *
 *     related: [[a]], [[b]], [[c]]
 *
 * which YAML rejects. We rewrite each line that matches that shape
 * into a quoted-string flow array so js-yaml can parse it:
 *
 *     related: ["[[a]]", "[[b]]", "[[c]]"]
 *
 * Only touches lines that look exactly like that pattern; anything
 * else is passed through unchanged so a legitimate nested-array
 * value (`tags: [[red, blue], [green]]`) isn't mangled.
 */
function repairWikilinkLists(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*[A-Za-z_][\w-]*\s*:\s*)(\[\[[^\]]+\]\](?:\s*,\s*\[\[[^\]]+\]\])+)\s*$/)
      if (!m) return line
      const prefix = m[1]
      const items = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => `"${s}"`)
        .join(", ")
      return `${prefix}[${items}]`
    })
    .join("\n")
}

/**
 * Coerce js-yaml's output into the shape FrontmatterPanel consumes:
 * a flat `Record<string, string | string[]>`. Nested objects and
 * scalars that aren't strings are stringified so unusual YAML
 * still surfaces in the UI rather than silently disappearing.
 */
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
  // Object / nested array → JSON so the user still sees something.
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
