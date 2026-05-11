import { useState, useCallback, useMemo, useEffect } from "react"
import { Search, FileText, ImageIcon, X, ArrowUpRight } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { searchWiki, tokenizeQuery, type SearchResult, type ImageRef } from "@/lib/search"
import { useTranslation } from "react-i18next"
import { normalizePath } from "@/lib/path-utils"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { findRawSourceForImage, imageUrlToAbsolute } from "@/lib/raw-source-resolver"
import { isImeComposing } from "@/lib/keyboard-utils"

/**
 * One image hit displayed in the Images section.
 *
 * `sourcePath` is the wiki page that contains this image reference
 * — clicking the card opens that page (and the page's markdown
 * preview will scroll the user down to the image naturally).
 *
 * `altMatchesQuery` is whether the caption / alt text matches the
 * query. Used only for ordering: caption matches sort first.
 */
interface ImageHit extends ImageRef {
  sourcePath: string
  sourceTitle: string
  altMatchesQuery: boolean
}

export function SearchView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)

  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  // Lightbox state — null when closed. Held inline rather than via
  // a global store: nothing else needs to know which image is in
  // the lightbox, and search-view-local state means the modal
  // closes naturally when the user navigates away from search.
  const [lightbox, setLightbox] = useState<ImageHit | null>(null)

  const doSearch = useCallback(
    async (q: string) => {
      if (!project || !q.trim()) {
        setResults([])
        return
      }
      setSearching(true)
      setHasSearched(true)
      try {
        const found = await searchWiki(normalizePath(project.path), q)
        setResults(found)
      } catch (err) {
        console.error("Search failed:", err)
        setResults([])
      } finally {
        setSearching(false)
      }
    },
    [project],
  )

  // Flatten + dedupe images across results. Two results referencing
  // the same image (e.g. the source-summary AND a concept page that
  // cited the figure) collapse to one card; we keep the FIRST
  // result we saw it in as the click target since results are
  // already sorted by RRF descending.
  //
  // Caption matching uses the SAME tokenizer the main search uses
  // (`tokenizeQuery`), not raw substring containment. Without this
  // a query like "总资产。" wouldn't match the caption "图：2023
  // 年总资产合计" — the trailing 。 has no business in a substring
  // test against alt text that doesn't end at that exact spot.
  // Falls back to the raw lowercased query when tokenization
  // returns nothing (e.g. user typed only punctuation), so the
  // filter never silently goes empty when the user expected hits.
  const imageHits = useMemo(() => {
    if (!query.trim()) return [] as ImageHit[]
    const tokens = tokenizeQuery(query)
    const fallback = query.trim().toLowerCase()
    const seen = new Set<string>()
    const out: ImageHit[] = []
    for (const r of results) {
      for (const img of r.images) {
        if (seen.has(img.url)) continue
        seen.add(img.url)
        const altLower = img.alt.toLowerCase()
        const altMatchesQuery =
          tokens.length > 0
            ? tokens.some((t) => altLower.includes(t))
            : altLower.includes(fallback)
        out.push({
          ...img,
          sourcePath: r.path,
          sourceTitle: r.title,
          altMatchesQuery,
        })
      }
    }
    // Caption-matches first, then preserve RRF order.
    return out.sort((a, b) => Number(b.altMatchesQuery) - Number(a.altMatchesQuery))
  }, [results, query])

  // Image hits whose CAPTION matches the query are the ones we
  // confidently surface. Hits from matched pages whose alt text
  // doesn't match the query are "supporting" (visible after a
  // toggle) — showing them ALL by default would dilute the image
  // grid with logos / page-corner decorations.
  const [showSupportingImages, setShowSupportingImages] = useState(false)
  const matchingImages = imageHits.filter((h) => h.altMatchesQuery)
  const supportingImages = imageHits.filter((h) => !h.altMatchesQuery)
  const visibleImages = showSupportingImages ? imageHits : matchingImages

  async function handleOpen(path: string) {
    try {
      const content = await readFile(path)
      setSelectedFile(path)
      setFileContent(content)
      setActiveView("wiki")
    } catch (err) {
      console.error("Failed to open search result:", err)
    }
  }

  /**
   * Lightbox jump-to-source: open the ORIGINAL raw source file
   * (the PDF / DOCX / PPTX in `raw/sources/`), not the LLM-
   * summarized `wiki/sources/<slug>.md`. The wiki summary is
   * abbreviated by design — the user's mental model when they
   * click a search-result image is "show me where this came
   * from in the actual document," and that's the raw file.
   *
   * Path derivation: image URLs always live under
   * `<project>/wiki/media/<slug>/img-N.<ext>`. The slug matches
   * the basename of the original raw source (we wrote it that
   * way at extraction time in extract_pdf_markdown / fs.rs's
   * raw-sources-layout heuristic). We list `raw/sources/` once
   * and pick the file whose stem equals the slug.
   *
   * The raw file's preview goes through `read_file` → the
   * combined-extraction path (text + per-page image refs with
   * absolute URLs), which means the `<img data-mdsrc=...>` we
   * scroll-target lives in the same DOM. To match what the
   * preview emits, we normalize `hit.url` to its absolute form
   * before staging the pending scroll — wiki-relative URLs
   * (from the safety-net section) wouldn't otherwise match the
   * absolute URLs the raw extractor uses.
   *
   * Fallback: if we can't find a raw source file (e.g. the user
   * deleted it after ingest, leaving only the wiki summary), we
   * open the wiki page so SOMETHING happens.
   */
  async function handleJumpFromLightbox(hit: ImageHit) {
    const projectPath = project?.path
    let openPath = hit.sourcePath
    let scrollTarget = hit.url

    if (projectPath) {
      const pp = normalizePath(projectPath)
      const rawPath = await findRawSourceForImage(hit.url, pp)
      if (rawPath) {
        console.log(`[search:jump] ${hit.url} → raw source ${rawPath}`)
        openPath = rawPath
        scrollTarget = imageUrlToAbsolute(scrollTarget, pp)
      } else {
        console.warn(
          `[search:jump] no raw source found for image ${hit.url} — falling back to wiki page`,
        )
      }
    }

    try {
      const content = await readFile(openPath)
      setPendingScrollImageSrc(scrollTarget)
      setSelectedFile(openPath)
      setFileContent(content)
      setActiveView("wiki")
      setLightbox(null)
    } catch (err) {
      console.error("Failed to jump to source:", err)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return
              if (e.key === "Enter") doSearch(query)
            }}
            placeholder={t("search.placeholder") + "（Enter 搜索）"}
            autoFocus
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/*
       * Body. Two independently scrollable regions: images (capped
       * height = 2 rows of thumbnails) and pages (fills the rest).
       * Stacked, no outer scroll — the user asked for "image grid
       * doesn't push the text list off-screen, both areas scroll
       * inside themselves."
       */}
      {searching ? (
        <div className="flex-1 p-4 text-center text-sm text-muted-foreground">
          正在搜索...
        </div>
      ) : !hasSearched ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
          <Search className="h-8 w-8 text-muted-foreground/30" />
          <p>按 Enter 开始搜索</p>
        </div>
      ) : results.length === 0 ? (
        <div className="flex-1 p-4 text-center text-sm text-muted-foreground">
          {t("search.noResults")} <span className="font-medium">"{query}"</span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-3 pt-3 pb-1 text-xs text-muted-foreground">
            {results.length} page{results.length !== 1 ? "s" : ""}
            {imageHits.length > 0 && (
              <>
                {" · "}
                {matchingImages.length} image{matchingImages.length !== 1 ? "s" : ""} match
                {supportingImages.length > 0 && ` · +${supportingImages.length} from matched pages`}
              </>
            )}
          </div>

          {/* ── Images: fixed-height thumbnails, 2 rows visible, scrolls inside ── */}
          {visibleImages.length > 0 && (
            <>
              <div className="shrink-0 px-3 pt-1">
                <SectionHeader
                  icon={<ImageIcon className="h-3.5 w-3.5" />}
                  label="Images"
                  count={visibleImages.length}
                  trailing={
                    supportingImages.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setShowSupportingImages((s) => !s)}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        {showSupportingImages
                          ? "Hide supporting"
                          : `Show all (+${supportingImages.length})`}
                      </button>
                    ) : null
                  }
                />
              </div>
              {/*
               * Cap height at 2-rows-worth of cards. Each `ImageHitCard`
               * is fixed at ~176px tall (120px thumbnail + 2-line
               * caption + source title + padding); with `gap-2` (8px)
               * between rows that's ~360px for two rows. We pad to
               * 23rem (368px) so the bottom edge of the second row
               * isn't visually flush with the scrollbar / next
               * section. Anything beyond 2 rows stays accessible via
               * vertical scroll inside this container ONLY — the
               * Pages list below keeps its own scroll independent.
               */}
              <div className="max-h-[23rem] shrink-0 overflow-y-auto px-3 pt-2 pb-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {visibleImages.map((img) => (
                    <ImageHitCard
                      key={img.url}
                      hit={img}
                      query={query}
                      onClick={() => setLightbox(img)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Pages: takes remaining vertical space, scrolls inside ── */}
          <div className="shrink-0 px-3 pt-1">
            <SectionHeader
              icon={<FileText className="h-3.5 w-3.5" />}
              label="Pages"
              count={results.length}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-3">
            <div className="flex flex-col gap-1">
              {results.map((result) => (
                <SearchResultCard
                  key={result.path}
                  result={result}
                  query={query}
                  onClick={() => handleOpen(result.path)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox modal — only mounted when an image is selected.
       *  Sits at the SearchView root so it overlays everything inside
       *  this view but doesn't escape into other views' DOM. */}
      {lightbox && (
        <Lightbox
          hit={lightbox}
          projectPath={project?.path ?? null}
          onClose={() => setLightbox(null)}
          onJumpToSource={() => handleJumpFromLightbox(lightbox)}
        />
      )}
    </div>
  )
}

function Lightbox({
  hit,
  projectPath,
  onClose,
  onJumpToSource,
}: {
  hit: ImageHit
  projectPath: string | null
  onClose: () => void
  onJumpToSource: () => void
}) {
  // Escape-to-close. Body-scroll-lock while open: a long search-
  // results list scrolling underneath the modal is disorienting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const src = resolveMarkdownImageSrc(hit.url, projectPath)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      // Backdrop is the click target; the inner card stops
      // propagation so clicks inside don't accidentally close.
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header strip — caption + close button. */}
        <div className="flex items-start justify-between gap-3 border-b px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {hit.alt ? (
              <div className="line-clamp-3 text-sm leading-snug">{hit.alt}</div>
            ) : (
              <div className="text-sm italic text-muted-foreground">无说明</div>
            )}
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              From: {hit.sourceTitle}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
          aria-label="关闭"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Image area — flex-1 fills, object-contain preserves aspect. */}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
          <img
            src={src}
            alt={hit.alt || ""}
            className="max-h-full max-w-full object-contain"
          />
        </div>

        {/* Action strip — single button to jump to source.
         *  Right-aligned so the eye lands on it after reading the
         *  caption (left-to-right). */}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-2.5">
          <button
            type="button"
            onClick={onJumpToSource}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            Jump to source document
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionHeader({
  icon,
  label,
  count,
  trailing,
}: {
  icon: React.ReactNode
  label: string
  count: number
  trailing?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between border-b pb-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        <span className="text-muted-foreground/60">({count})</span>
      </div>
      {trailing}
    </div>
  )
}

function ImageHitCard({
  hit,
  query,
  onClick,
}: {
  hit: ImageHit
  query: string
  onClick: () => void
}) {
  const project = useWikiStore((s) => s.project)
  const projectPath = project?.path ?? null
  // Same resolver the markdown preview uses — handles absolute
  // filesystem paths (which our extractor emits) AND wiki-relative
  // paths (which the safety-net section emits).
  const src = resolveMarkdownImageSrc(hit.url, projectPath)

  return (
    <button
      type="button"
      onClick={onClick}
      title={hit.alt || hit.sourceTitle}
      className="group flex h-44 flex-col overflow-hidden rounded-lg border bg-background text-left transition-colors hover:bg-accent"
    >
      {/*
       * Fixed thumbnail height (h-30 = 120px). Width fills the grid
       * cell. `object-cover` keeps the source's aspect ratio while
       * cropping to fill — preferable to letterboxing for a thumb
       * grid where users skim by visual identity rather than read
       * the chart axes. Combined with the parent's fixed h-44 (176px)
       * and the text block's `flex-1` cap, every card has the SAME
       * total height regardless of caption length, which keeps the
       * grid's row alignment clean.
       */}
      <div className="h-30 w-full shrink-0 overflow-hidden bg-muted" style={{ height: "7.5rem" }}>
        {/* `loading="lazy"` matters: a project with hundreds of
         *  images would otherwise issue a request for every one
         *  on first render, even when most are scrolled offscreen. */}
        <img
          src={src}
          alt={hit.alt || ""}
          loading="lazy"
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
          // Hide broken-image icon when convertFileSrc can't resolve
          // (network image deleted, project moved, etc.) — leave the
          // bg-muted placeholder visible instead of a sad 🖼️.
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).style.opacity = "0"
          }}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 p-2">
        {hit.alt ? (
          <div className="line-clamp-2 text-[11px] leading-snug">
            <HighlightedText text={hit.alt} query={query} />
          </div>
        ) : (
          <div className="text-[11px] italic text-muted-foreground">无说明</div>
        )}
        <div className="mt-auto truncate text-[10px] text-muted-foreground">
          {hit.sourceTitle}
        </div>
      </div>
    </button>
  )
}

function SearchResultCard({
  result,
  query,
  onClick,
}: {
  result: SearchResult
  query: string
  onClick: () => void
}) {
  const shortPath = result.path.split("/wiki/").pop() ?? result.path

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border p-3 text-left text-sm hover:bg-accent transition-colors"
    >
      <div className="flex items-start gap-2 mb-1.5">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">
            <HighlightedText text={result.title} query={query} />
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{shortPath}</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">
        <HighlightedText text={result.snippet} query={query} />
      </p>
    </button>
  )
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>

  // Highlight EACH non-stopword token from the query, not the raw
  // query string. Same rationale as the alt-text filter above:
  // "总资产。" should still highlight "总资产" inside captions /
  // titles even though the period prevents a literal substring
  // match. Falls back to the raw query when the tokenizer returned
  // nothing, so a query like "(?)" still attempts highlighting
  // (and trivially finds nothing, which is fine).
  const tokens = tokenizeQuery(query)
  const patterns = tokens.length > 0 ? tokens : [query.trim()]
  const regex = new RegExp(`(${patterns.map(escapeRegex).join("|")})`, "gi")
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
