/**
 * Entity/concept page write chokepoint — ADR 0003 Tier A.
 *
 * The LLM emits `FILE: wiki/concepts/SomeName.md` blocks and the
 * filename it chose became the page id verbatim — so `MapReduce`,
 * `map-reduce` and `mapreduce` all reached disk as separate pages
 * (the WIKI-DUP-SLUG-* defects), and hand-rolled frontmatter
 * templates drifted into the WIKI-FRONTMATTER-* defects.
 *
 * Every entity/concept write now passes through
 * `canonicalizeContentPage`: the LLM's chosen filename is run
 * through `pageId()` so it lands in canonical form, and frontmatter
 * is re-emitted by the canonical serializer. The LLM still picks
 * the identifier (a deliberate short id like `rope` is kept, not
 * replaced by `pageId(title)` = `rotary-position-embedding`); the
 * chokepoint only guarantees that pick is well-formed.
 */
import { parseFrontmatter, serializeWikiPage } from "./frontmatter"
import { pageId } from "./page-id"

/** Matches the `entities|concepts/<stem>.md` tail of a wiki path. */
const CONTENT_PAGE_TAIL = /(entities|concepts)\/([^/]+)\.md$/i

export interface CanonicalizedPage {
  relativePath: string
  content: string
  /** True when the path is an entity/concept page. */
  isContentPage: boolean
  /** True when the post-frontmatter body is blank — ADR 0003 Tier A. */
  bodyEmpty: boolean
}

/**
 * Canonicalize one page write.
 *
 * - Frontmatter is re-serialized canonically for any page with
 *   parseable frontmatter (entity, concept, source, …).
 * - For entity/concept pages the filename is additionally
 *   normalized to `pageId(<llm filename stem>)`; the containing
 *   folder is left as the LLM chose it.
 * - `bodyEmpty` reports whether the body is blank, so the caller can
 *   refuse to write an empty entity/concept page (Tier A runtime
 *   validation).
 *
 * Unparseable frontmatter or an empty derived id leave the path
 * untouched.
 */
export function canonicalizeContentPage(
  relativePath: string,
  content: string,
): CanonicalizedPage {
  const tail = relativePath.match(CONTENT_PAGE_TAIL)
  const isContentPage = !!tail
  const parsed = parseFrontmatter(content)

  if (!parsed.frontmatter) {
    return { relativePath, content, isContentPage, bodyEmpty: content.trim() === "" }
  }

  const canonicalContent = serializeWikiPage(parsed.frontmatter, parsed.body)
  const bodyEmpty = parsed.body.trim() === ""

  if (!tail || tail.index === undefined) {
    return { relativePath, content: canonicalContent, isContentPage, bodyEmpty }
  }

  const id = pageId(tail[2])
  if (!id) {
    return { relativePath, content: canonicalContent, isContentPage, bodyEmpty }
  }

  const folder = tail[1].toLowerCase()
  const canonicalPath = `${relativePath.slice(0, tail.index)}${folder}/${id}.md`
  return { relativePath: canonicalPath, content: canonicalContent, isContentPage, bodyEmpty }
}
