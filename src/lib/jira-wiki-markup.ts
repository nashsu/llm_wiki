/**
 * Jira wiki markup → Markdown (Server/DC issues return wiki markup, not ADF).
 *
 * Guiding principle: every macro is either converted or removed, and no body
 * text is ever dropped. Rendering something as plain text is always preferable
 * to losing it — an issue description is evidence, and a converter that quietly
 * eats a paragraph is worse than one that leaves a stray asterisk.
 *
 * Nothing inside a `{code}`/`{noformat}` block is converted; that content is
 * verbatim by definition.
 */

import { jiraBrowseUrl } from "@/lib/jira-config"

export interface JiraMarkupContext {
  /** Attachment filename → relative path in the exported document. */
  attachmentLinks?: ReadonlyMap<string, string>
  /** Instance root, so `[KEY]` can become a real link. */
  baseUrl?: string
}

/**
 * Wrap a destination Markdown would otherwise split on — `[a](my file.png)`
 * silently becomes a broken link, `[a](<my file.png>)` does not.
 */
export function markdownLinkDestination(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path
}

/** Bold/italic are guarded by word boundaries — `DAB_box` must not become italic. */
const BOLD_PATTERN = /(^|[\s(])\*([^\s*][^*\n]*?)\*(?=$|[\s).,;:!?])/g
const ITALIC_PATTERN = /(^|[\s(])_([^\s_][^_\n]*?)_(?=$|[\s).,;:!?])/g
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/
const ATTACHMENT_NAME_PATTERN = /\.(?:png|jpe?g|gif|bmp|svg|webp|pdf|txt|log|csv|zip|mp4|mov|xlsx?|docx?|pptx?)$/i
const QUOTE_LINE_PATTERN = /^\{(?:quote|panel)(?::[^}]*)?\}$/
const BLOCK_PLACEHOLDER_PATTERN = /^\u0000JIRAFENCE(\d+)\u0000$/

/**
 * Hold already-converted fragments aside so later passes can't re-process
 * them (a URL inside a link must not be italicised, `{{code}}` content must
 * not be macro-stripped).
 */
class Shielder {
  private readonly parts: string[] = []

  stash(value: string): string {
    this.parts.push(value)
    return `\u0001${this.parts.length - 1}\u0001`
  }

  restore(text: string): string {
    return text.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => this.parts[Number(index)] ?? "")
  }
}

interface BlockMacro {
  kind: "code" | "noformat"
  language: string
  startIndex: number
  endIndex: number
}

function findBlockMacro(input: string, from: number): BlockMacro | null {
  const candidates: BlockMacro[] = []
  const code = /\{code(?::([^}\n]*))?\}/g
  code.lastIndex = from
  const codeMatch = code.exec(input)
  if (codeMatch) {
    candidates.push({
      kind: "code",
      // `{code:java|title=X}` — only the language matters here.
      language: (codeMatch[1] ?? "").split("|")[0].trim(),
      startIndex: codeMatch.index,
      endIndex: codeMatch.index + codeMatch[0].length,
    })
  }
  const noformat = /\{noformat\}/g
  noformat.lastIndex = from
  const noformatMatch = noformat.exec(input)
  if (noformatMatch) {
    candidates.push({
      kind: "noformat",
      language: "",
      startIndex: noformatMatch.index,
      endIndex: noformatMatch.index + noformatMatch[0].length,
    })
  }
  candidates.sort((left, right) => left.startIndex - right.startIndex)
  return candidates[0] ?? null
}

/**
 * Replace `{code}`/`{noformat}` blocks with single-line placeholders, so the
 * line pass can't touch their contents. Unclosed macros are left in place
 * rather than swallowing the rest of the document.
 */
function extractBlockMacros(input: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  let text = ""
  let cursor = 0
  for (;;) {
    const macro = findBlockMacro(input, cursor)
    if (!macro) break
    const closeToken = `{${macro.kind}}`
    const closeIndex = input.indexOf(closeToken, macro.endIndex)
    if (closeIndex === -1) break
    const body = input.slice(macro.endIndex, closeIndex).replace(/^\n/, "").replace(/\n\s*$/, "")
    const opening = macro.kind === "code" && macro.language ? `\`\`\`${macro.language}` : "```"
    // A fence has to start at the beginning of a line to render as one.
    const needsBreak = macro.startIndex > 0 && input[macro.startIndex - 1] !== "\n"
    text += input.slice(cursor, macro.startIndex)
    text += `${needsBreak ? "\n" : ""}\u0000JIRAFENCE${blocks.length}\u0000`
    blocks.push(`${opening}\n${body}\n\`\`\``)
    cursor = closeIndex + closeToken.length
  }
  text += input.slice(cursor)
  return { text, blocks }
}

function restoreBlockMacros(text: string, blocks: readonly string[]): string {
  return text.replace(/\u0000JIRAFENCE(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "")
}

function issueHref(key: string, context: JiraMarkupContext): string {
  const base = context.baseUrl?.trim()
  return base && ISSUE_KEY_PATTERN.test(key) ? jiraBrowseUrl(base, key) : key
}

function issueLink(key: string, context: JiraMarkupContext): string {
  const href = issueHref(key, context)
  return href === key ? key : `[${key}](${href})`
}

function attachmentLink(name: string, context: JiraMarkupContext): string {
  const href = context.attachmentLinks?.get(name)
  return href ? `[${name}](${markdownLinkDestination(href)})` : name
}

/** Everything that is not blocked by a fence: macros, links, emphasis. */
function convertInline(input: string, context: JiraMarkupContext, shield: Shielder): string {
  let text = input

  text = text.replace(/\{\{([\s\S]*?)\}\}/g, (_match, body: string) => shield.stash(`\`${body}\``))

  text = text.replace(/!([^!\n]+)!/g, (_match, body: string) => {
    const name = body.split("|")[0].trim()
    return shield.stash(attachmentLink(name, context))
  })

  text = text.replace(/\[([^\[\]]+)\]/g, (match, inner: string) => {
    const parts = inner.split("|")
    const label = parts[0].trim()
    if (parts.length >= 2) {
      const href = issueHref(parts[1].trim(), context)
      return shield.stash(`[${label || href}](${href})`)
    }
    if (ISSUE_KEY_PATTERN.test(label)) return shield.stash(issueLink(label, context))
    if (/^https?:\/\/\S+$/.test(label)) return shield.stash(`<${label}>`)
    if (ATTACHMENT_NAME_PATTERN.test(label)) return shield.stash(attachmentLink(label, context))
    // Unrecognised bracket content stays as typed.
    return match
  })

  // Any macro left over (colours, anchors, TOC, …) goes away; its inner text,
  // if any, was never part of the marker so it stays.
  text = text.replace(/\{[^{}\n]*\}/g, "")

  text = text.replace(BOLD_PATTERN, "$1**$2**")
  text = text.replace(ITALIC_PATTERN, "$1*$2*")

  return text
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line)
}

function parseTableRow(line: string): string[] {
  const isHeader = line.trimStart().startsWith("||")
  const delimiter = isHeader ? "||" : "|"
  let body = line.trim()
  if (body.startsWith(delimiter)) body = body.slice(delimiter.length)
  if (body.endsWith(delimiter)) body = body.slice(0, -delimiter.length)
  return body.split(delimiter).map((cell) => cell.trim())
}

function renderTable(rows: readonly string[], context: JiraMarkupContext, shield: Shielder): string[] {
  const parsed = rows.map(parseTableRow)
  const foundHeader = rows.findIndex((row) => row.trimStart().startsWith("||"))
  const headerIndex = foundHeader === -1 ? 0 : foundHeader
  const width = parsed.reduce((max, row) => Math.max(max, row.length), 1)
  const pad = (row: readonly string[]) => [...row, ...new Array<string>(Math.max(0, width - row.length)).fill("")]
  const header = pad(parsed[headerIndex])
  const body = parsed.filter((_row, index) => index !== headerIndex).map(pad)
  const cell = (value: string) => convertInline(value, context, shield).replace(/\|/g, "\\|")
  return [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ]
}

function renderLine(line: string, context: JiraMarkupContext, shield: Shielder): string {
  const trimmed = line.trim()
  const heading = /^h([1-6])\.\s*(.*)$/.exec(trimmed)
  if (heading) {
    const level = Number(heading[1])
    return `${"#".repeat(level)} ${convertInline(heading[2], context, shield)}`.trimEnd()
  }
  const blockquote = /^bq\.\s*(.*)$/.exec(trimmed)
  if (blockquote) return `> ${convertInline(blockquote[1], context, shield)}`.trimEnd()
  if (/^-{4,}$/.test(trimmed)) return "---"
  const list = /^(\s*)([*#-]+)\s+(.*)$/.exec(line)
  if (list) {
    // Jira nests by repeating the marker: `** x` is a bullet inside a bullet.
    const depth = Math.max(0, list[2].length - 1)
    const ordered = list[2].endsWith("#")
    return `${"  ".repeat(depth)}${ordered ? "1." : "-"} ${convertInline(list[3], context, shield)}`.trimEnd()
  }
  return convertInline(line, context, shield)
}

export function jiraWikiToMarkdown(input: string, context: JiraMarkupContext = {}): string {
  const normalized = (input ?? "").replace(/\r\n?/g, "\n")
  const { text, blocks } = extractBlockMacros(normalized)
  const shield = new Shielder()
  const output: string[] = []
  let tableRows: string[] = []
  let inQuote = false

  const flushTable = () => {
    if (tableRows.length === 0) return
    output.push(...renderTable(tableRows, context, shield))
    tableRows = []
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (BLOCK_PLACEHOLDER_PATTERN.test(trimmed)) {
      flushTable()
      output.push(inQuote ? `> ${trimmed}` : trimmed)
      continue
    }
    if (isTableLine(line)) {
      tableRows.push(line)
      continue
    }
    flushTable()
    if (!trimmed) {
      output.push("")
      continue
    }
    if (QUOTE_LINE_PATTERN.test(trimmed)) {
      // `{quote}` both opens and closes, exactly as Jira treats it.
      inQuote = !inQuote
      continue
    }
    const rendered = renderLine(line, context, shield)
    output.push(inQuote ? `> ${rendered}` : rendered)
  }
  flushTable()

  return restoreBlockMacros(shield.restore(output.join("\n")), blocks)
}
