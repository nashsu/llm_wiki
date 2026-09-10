import { createDirectory, fileExists, writeFile } from "@/commands/fs"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { makeQuerySlug } from "@/lib/wiki-filename"
import { inferWikiTypeFromPath } from "@/lib/wiki-page-types"
import { loadProjectWikiSchemaRouting, type WikiSchemaRouting } from "@/lib/wiki-schema"

export function lintLinkTarget(target: string): string {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
}

function normalizedLintLinkTarget(target: string): string {
  return lintLinkTarget(target).toLowerCase()
}

function hasWikilinkToTarget(content: string, target: string): boolean {
  const normalized = normalizedLintLinkTarget(target)
  return Array.from(content.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g))
    .some((match) => normalizedLintLinkTarget(match[1]) === normalized)
}

export function appendWikilink(content: string, target: string): string {
  const linkTarget = lintLinkTarget(target)
  if (hasWikilinkToTarget(content, linkTarget)) return content
  const linkLine = `- [[${linkTarget}]]`
  const relatedHeading = /^##\s+Related\s*$/im.exec(content)
  if (relatedHeading) {
    const insertAt = relatedHeading.index + relatedHeading[0].length
    return `${content.slice(0, insertAt)}\n${linkLine}${content.slice(insertAt)}`
  }
  return `${content.trimEnd()}\n\n## Related\n${linkLine}\n`
}

export function rewriteWikilinkTarget(
  content: string,
  brokenTarget: string,
  suggestedTarget: string,
): string {
  const broken = normalizedLintLinkTarget(brokenTarget)
  const replacement = lintLinkTarget(suggestedTarget)
  return content.replace(
    /\[\[([^\]|]+?)(\|[^\]]+?)?\]\]/g,
    (match, rawTarget: string, rawAlias?: string) => {
      if (normalizedLintLinkTarget(rawTarget) !== broken) return match
      return `[[${replacement}${rawAlias ?? ""}]]`
    },
  )
}

export function stubRelativePathFromBrokenTarget(brokenTarget: string): string {
  const normalized = lintLinkTarget(brokenTarget)
  const parts = normalized
    .split("/")
    .map((part) => makeQuerySlug(part))
    .filter(Boolean)
  const rel = parts.length > 1
    ? parts.join("/")
    : `queries/${parts[0] ?? "missing-page"}`
  return `${rel}.md`
}

/**
 * The `type` a stub should carry, given where it is being written.
 *
 * A stub keeps the directory of the link it replaces, but the type used
 * to be hard-coded to `query`. That is only correct for `wiki/queries/`:
 * everywhere else it hid the new page from the graph (`wiki-graph.ts`
 * drops every `query` node) and made the next ingest reject the file,
 * since `validateWikiPageRouting` insists a page under `wiki/concepts/`
 * carries `type: concept`. The app was refusing content it wrote itself.
 *
 * The project's own `schema.md` wins over the built-in map because that
 * is what routing actually validates against — and because the built-in
 * map does not know custom directories, so it would answer `playbooks`
 * where the schema declares `playbook`. With no schema to consult the
 * built-in map is still better than `query`, and `query` remains the
 * last resort for a path neither recognizes. (#733)
 */
export function inferStubType(
  relativePath: string,
  routing: WikiSchemaRouting | null,
): string {
  const dir = relativePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
  if (routing) {
    for (const [type, typeDir] of Object.entries(routing.typeDirs)) {
      if (typeDir.replace(/^wiki\//i, "") === dir) return type
    }
  }
  return inferWikiTypeFromPath(`wiki/${relativePath}`) ?? "query"
}

function stubTitleFromBrokenTarget(brokenTarget: string): string {
  return getFileName(lintLinkTarget(brokenTarget))
    .replace(/[-_]+/g, " ")
    .trim() || "Missing Page"
}

export async function ensureBrokenLinkStub(
  projectPath: string,
  brokenTarget: string,
): Promise<{ fullPath: string; relativePath: string; created: boolean }> {
  const relativePath = stubRelativePathFromBrokenTarget(brokenTarget)
  const fullPath = `${projectPath}/wiki/${relativePath}`
  if (await fileExists(fullPath)) {
    return { fullPath, relativePath, created: false }
  }

  const parent = fullPath.split("/").slice(0, -1).join("/")
  await createDirectory(parent)
  const title = stubTitleFromBrokenTarget(brokenTarget)
  const date = new Date().toISOString().slice(0, 10)
  const routing = await loadProjectWikiSchemaRouting(projectPath)
  const content = [
    "---",
    `type: ${inferStubType(relativePath, routing)}`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `created: ${date}`,
    `updated: ${date}`,
    "tags: [stub, lint]",
    "related: []",
    "sources: []",
    "---",
    "",
    `# ${title}`,
    "",
    "Created by Wiki Lint as a placeholder for a missing wikilink target.",
    "",
  ].join("\n")
  await writeFile(fullPath, content)
  return { fullPath, relativePath, created: true }
}
