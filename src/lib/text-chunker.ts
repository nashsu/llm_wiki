/**
 * Markdown-aware recursive text chunker for embedding pipelines.
 *
 * Design constraints (enforced by tests in text-chunker.test.ts):
 *
 *   1. Each chunk carries a `headingPath` breadcrumb ("## Intro > ### Usage")
 *      derived from surrounding markdown headings, so the embedded text
 *      always has structural context — critical when a short chunk alone
 *      would be semantically ambiguous.
 *
 *   2. Split priority (Langchain-style Recursive Character Text Splitter,
 *      markdown-tuned):
 *         (a) heading-defined sections (## / ### / ####)
 *         (b) paragraph boundaries   (\n\n)
 *         (c) line breaks            (\n)
 *         (d) sentence terminators   (`. ` / `。` / `! ` / `！` / `? ` / `？` / `; ` / `；`)
 *         (e) whitespace            (` ` / `　` / `\t`)
 *         (f) hard char slice       (last resort)
 *      Each level only kicks in when the level above produces a piece that
 *      still exceeds `maxChars`.
 *
 *   3. Never splits inside a fenced code block (``` ... ```). A code block
 *      larger than `maxChars` becomes one oversized chunk on its own rather
 *      than being torn.
 *
 *   4. Never splits inside a single table (leading `|` lines). Tables over
 *      `maxChars` are kept intact for the same reason — tearing a table
 *      produces semantic garbage.
 *
 *   5. YAML frontmatter (a leading `---\n...\n---` block) is stripped
 *      before chunking, so metadata doesn't pollute embeddings.
 *
 *   6. Overlap is applied between adjacent chunks within the same section
 *      to survive concept-severing boundaries (e.g. a paragraph break in
 *      the middle of a two-sentence idea).
 *
 *   7. Tiny chunks (< `minChars`) are merged into their neighbours before
 *      emission so we don't flood the vector store with 50-character
 *      fragments that carry no signal.
 *
 *   8. Pure & deterministic: same input ⇒ same output. No randomness,
 *      no I/O, no singleton state.
 */

/** Recursive splitter options. All default-friendly; callers typically pass none. */
export interface ChunkingOptions {
  /** Aim for roughly this many characters per emitted chunk. */
  targetChars: number
  /** Hard upper bound — a single "atomic" piece larger than this is still
   *  emitted but logged via `oversized: true`. Servers with tiny context
   *  (e.g. 512-token llama.cpp default) can use this + auto-retry. */
  maxChars: number
  /** Chunks shorter than this are greedily merged into the next sibling. */
  minChars: number
  /** Characters of overlap between adjacent chunks in the same section. */
  overlapChars: number
}

const DEFAULT_OPTIONS: ChunkingOptions = {
  targetChars: 1000,
  maxChars: 1500,
  minChars: 200,
  overlapChars: 200,
}

/** One emitted chunk of the document. */
export interface Chunk {
  /** 0-based position in the emission order. */
  index: number
  /** The visible content of the chunk (no frontmatter, no heading prefix). */
  text: string
  /** Heading breadcrumb for this chunk's location, e.g.
   *  "## Techniques > ### Flash Attention". Empty string when the chunk
   *  lives above any heading. */
  headingPath: string
  /** Character offset into the ORIGINAL input (before frontmatter strip). */
  charStart: number
  /** Character offset (exclusive) into the original input. */
  charEnd: number
  /** True iff this chunk is larger than `maxChars` because a single
   *  indivisible unit (code block, table, unbreakable paragraph) didn't
   *  fit. Callers can use this to apply per-server shrink strategies. */
  oversized: boolean
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Chunk a markdown document into embedding-sized pieces with heading
 * context. See the module-level docstring for the full contract.
 */
export function chunkMarkdown(
  content: string,
  userOptions?: Partial<ChunkingOptions>,
): Chunk[] {
  const opts: ChunkingOptions = { ...DEFAULT_OPTIONS, ...(userOptions ?? {}) }

  if (opts.maxChars < opts.targetChars) {
    // Defensive: nonsensical config. Caller mistake. Swap.
    opts.maxChars = opts.targetChars
  }
  if (opts.overlapChars >= opts.targetChars) {
    // Overlap >= target would make chunks mostly overlap, emit infinitely.
    opts.overlapChars = Math.floor(opts.targetChars / 2)
  }

  const { body, bodyOffset } = stripFrontmatter(content)
  if (body.trim().length === 0) return []

  const sections = splitIntoSections(body, bodyOffset)

  const chunks: Chunk[] = []
  let runningIndex = 0
  for (const section of sections) {
    const sectionChunks = chunkSection(section, opts)
    for (const c of sectionChunks) {
      chunks.push({ ...c, index: runningIndex++ })
    }
  }

  return chunks
}

// ── Frontmatter handling ──────────────────────────────────────────────────

/**
 * Remove a leading YAML frontmatter block (delimited by `---` lines) and
 * report where in the original string the remaining body starts, so we
 * can attribute `charStart`/`charEnd` back to the original document.
 */
export function stripFrontmatter(content: string): { body: string; bodyOffset: number } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { body: content, bodyOffset: 0 }
  }
  // Look for closing `---` on its own line.
  const rest = content.slice(4) // past first `---\n` or `---\r`
  const closeRelIdx = rest.search(/(^|\n)---\s*(\n|$)/)
  if (closeRelIdx < 0) return { body: content, bodyOffset: 0 }
  // Skip past `\n---\n` (or variants).
  const after = rest.slice(closeRelIdx).match(/^(\n)?---\s*\n?/)
  if (!after) return { body: content, bodyOffset: 0 }
  const bodyOffset = 4 + closeRelIdx + after[0].length
  return { body: content.slice(bodyOffset), bodyOffset }
}

// ── Section segmentation ─────────────────────────────────────────────────

/**
 * A "section" here is the text under a heading (or the implicit preamble
 * before the first heading). We walk the document line by line, track
 * the current heading path, and cut a new section whenever a markdown
 * heading appears. Fenced code blocks are treated as opaque — a line
 * starting with ``` toggles "inside-code" mode and no headings inside
 * that block trigger a cut.
 */
interface Section {
  text: string
  /** Offset (in the post-frontmatter body) where this section starts. */
  bodyStart: number
  headingPath: string
}

function splitIntoSections(body: string, bodyOffset: number): Section[] {
  const lines = body.split("\n")
  const sections: Section[] = []

  // heading stack keyed by level: headings[lvl] = text of last heading at that lvl
  const headings: Record<number, string> = {}

  let current: { lines: string[]; start: number; headingPath: string } = {
    lines: [],
    start: bodyOffset,
    headingPath: "",
  }
  let inFence = false
  let fenceMarker = ""
  let charCursor = bodyOffset

  const flush = () => {
    const text = current.lines.join("\n")
    if (text.trim().length > 0) {
      sections.push({
        text,
        bodyStart: current.start,
        headingPath: current.headingPath,
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0) // +1 for the \n we split on

    // Track fenced code state first — inside a fence, nothing else matters.
    const fenceMatch = line.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length)
      } else if (line.startsWith(fenceMarker) && line.trim() === fenceMarker) {
        inFence = false
      }
      current.lines.push(line)
      charCursor += lineLen
      continue
    }

    // Heading detection only outside fences.
    const hMatch = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : null
    if (hMatch) {
      flush()
      const level = hMatch[1].length
      const title = hMatch[2].trim()
      headings[level] = title
      // Clear deeper levels (a level-2 heading resets level-3, level-4, …)
      for (let lvl = level + 1; lvl <= 6; lvl++) delete headings[lvl]

      const pathParts: string[] = []
      for (let lvl = 1; lvl <= 6; lvl++) {
        if (headings[lvl]) pathParts.push(`${"#".repeat(lvl)} ${headings[lvl]}`)
      }

      current = {
        lines: [line],
        start: charCursor,
        headingPath: pathParts.join(" > "),
      }
      charCursor += lineLen
      continue
    }

    current.lines.push(line)
    charCursor += lineLen
  }

  flush()
  return sections
}

// ── Section → chunks ─────────────────────────────────────────────────────

function chunkSection(section: Section, opts: ChunkingOptions): Omit<Chunk, "index">[] {
  const { text, bodyStart, headingPath } = section

  if (text.length <= opts.targetChars) {
    return [
      {
        text,
        headingPath,
        charStart: bodyStart,
        charEnd: bodyStart + text.length,
        oversized: false,
      },
    ]
  }

  // Split the section into "atomic" blocks: fenced code, table rows,
  // paragraphs. Each block is either indivisible (code / table) or
  // further splittable by paragraph/line/sentence rules.
  const atoms = tokenizeAtoms(text)
  const pieces = splitAtomsToPieces(atoms, opts)
  const sized = sizePieces(pieces, opts)
  const merged = mergeSmall(sized, opts)
  const withOverlap = applyOverlap(merged, opts)

  // Compute charStart/charEnd for each emitted chunk, marking oversized.
  const out: Omit<Chunk, "index">[] = []
  for (const piece of withOverlap) {
    out.push({
      text: piece.text,
      headingPath,
      charStart: bodyStart + piece.offset,
      charEnd: bodyStart + piece.offset + piece.text.length,
      oversized: piece.text.length > opts.maxChars,
    })
  }
  return out
}

// ── Atom tokenization (splittable vs indivisible) ────────────────────────

interface Atom {
  text: string
  offset: number  // offset in the containing section
  /** True for atoms that must NEVER be split further (fenced code, tables). */
  indivisible: boolean
  /** Kind label purely for debugging / test clarity. */
  kind: "code" | "table" | "paragraph" | "blank"
}

function tokenizeAtoms(text: string): Atom[] {
  const atoms: Atom[] = []
  const lines = text.split("\n")

  let cursor = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    const fenceMatch = line.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const start = cursor
      const bodyLines: string[] = [line]
      let j = i + 1
      cursor += line.length + 1
      while (j < lines.length) {
        bodyLines.push(lines[j])
        cursor += lines[j].length + 1
        if (lines[j].startsWith(marker) && lines[j].trim() === marker) {
          j++
          break
        }
        j++
      }
      const content = bodyLines.join("\n")
      atoms.push({ text: content, offset: start, indivisible: true, kind: "code" })
      i = j
      continue
    }

    // Table: consecutive lines starting with `|`. Must be at least 2
    // such lines (one header row + one separator / data row) to count.
    if (line.startsWith("|")) {
      let j = i
      while (j < lines.length && lines[j].startsWith("|")) j++
      if (j - i >= 2) {
        const start = cursor
        const bodyLines = lines.slice(i, j)
        const content = bodyLines.join("\n")
        cursor += content.length + (j < lines.length ? 1 : 0)
        atoms.push({ text: content, offset: start, indivisible: true, kind: "table" })
        i = j
        continue
      }
      // A single leading `|` line is just a paragraph — fall through.
    }

    // Blank line: preserves paragraph boundaries but doesn't emit as an
    // atom on its own (rolled into cursor).
    if (line.trim() === "") {
      atoms.push({ text: "", offset: cursor, indivisible: false, kind: "blank" })
      cursor += line.length + 1
      i++
      continue
    }

    // Regular paragraph: accumulate consecutive non-blank, non-special lines.
    // Do not exclude leading `|` here. A lone pipe-prefixed line that
    // fell through the table branch above must be consumed as paragraph
    // text; otherwise `i` never advances and the outer loop spins forever.
    const start = cursor
    const bodyLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(`{3,}|~{3,})/.test(lines[i])
    ) {
      bodyLines.push(lines[i])
      cursor += lines[i].length + 1
      i++
    }
    const content = bodyLines.join("\n")
    atoms.push({ text: content, offset: start, indivisible: false, kind: "paragraph" })
  }

  return atoms.filter((a) => a.kind !== "blank" || a.text.length > 0)
}

// ── Splittable atom → pieces ─────────────────────────────────────────────

interface Piece {
  text: string
  offset: number
}

/**
 * Break every splittable atom down to pieces no larger than `targetChars`
 * using the recursive split ladder (paragraph → line → sentence → space
 * → hard slice). Indivisible atoms pass through unchanged — they'll be
 * flagged `oversized` downstream if they exceed `maxChars`.
 */
function splitAtomsToPieces(atoms: Atom[], opts: ChunkingOptions): Piece[] {
  const pieces: Piece[] = []
  for (const atom of atoms) {
    if (atom.indivisible) {
      pieces.push({ text: atom.text, offset: atom.offset })
      continue
    }
    if (atom.kind === "blank") continue
    if (atom.text.length <= opts.targetChars) {
      pieces.push({ text: atom.text, offset: atom.offset })
      continue
    }
    pieces.push(...recursiveSplit(atom.text, atom.offset, opts.targetChars))
  }
  return pieces
}

const SENTENCE_SPLITTERS: Array<[string, (t: string) => string[]]> = [
  ["lines", (t: string) => splitKeepingSep(t, /(\n+)/)],
  [
    "sentences",
    (t: string) => splitKeepingSep(t, /([。！？!?；;]+\s*|(?:\.\s+))/),
  ],
  ["spaces", (t: string) => splitKeepingSep(t, /(\s+)/)],
]

/**
 * Top-down recursion: try splitting by bigger-grained separator first
 * (double-newline paragraphs), only descending to finer separators if
 * any resulting piece still exceeds the target.
 */
function recursiveSplit(text: string, baseOffset: number, targetChars: number): Piece[] {
  // Start with double-newline (paragraph) split — strong semantic boundary.
  const paraPieces = splitKeepingSep(text, /(\n{2,})/)
  const out: Piece[] = []
  let cursor = baseOffset
  for (const chunk of paraPieces) {
    if (chunk.length === 0) continue
    if (chunk.length <= targetChars) {
      out.push({ text: chunk, offset: cursor })
      cursor += chunk.length
      continue
    }
    // This paragraph alone is too big — descend to finer separators.
    for (const [, splitter] of SENTENCE_SPLITTERS) {
      const subs = splitter(chunk)
      if (subs.every((s) => s.length <= targetChars) && subs.length > 1) {
        let subCursor = cursor
        for (const s of subs) {
          if (s.length === 0) continue
          out.push({ text: s, offset: subCursor })
          subCursor += s.length
        }
        cursor += chunk.length
        break
      }
      // Try descending into the subs that are still too long.
      let anyTooBig = false
      let subCursor = cursor
      const subOut: Piece[] = []
      for (const s of subs) {
        if (s.length === 0) continue
        if (s.length <= targetChars) {
          subOut.push({ text: s, offset: subCursor })
        } else {
          anyTooBig = true
        }
        subCursor += s.length
      }
      if (!anyTooBig && subs.length > 1) {
        out.push(...subOut)
        cursor += chunk.length
        break
      }
      // Otherwise keep trying smaller separators in the next loop iter.
    }
    // If the recursion found no separator small enough, fall through to
    // hard char slicing.
    if (out.length === 0 || out[out.length - 1].offset + out[out.length - 1].text.length <= cursor) {
      let sliceCursor = cursor
      for (let i = 0; i < chunk.length; i += targetChars) {
        const piece = chunk.slice(i, i + targetChars)
        out.push({ text: piece, offset: sliceCursor })
        sliceCursor += piece.length
      }
      cursor += chunk.length
    }
  }
  return out
}

/** Split `text` by `sep` regex but keep the separator attached to the
 *  preceding fragment so offsets stay coherent. */
function splitKeepingSep(text: string, sep: RegExp): string[] {
  const out: string[] = []
  let last = 0
  const globalRe = new RegExp(sep.source, "g")
  let m: RegExpExecArray | null
  while ((m = globalRe.exec(text)) !== null) {
    const end = m.index + m[0].length
    out.push(text.slice(last, end))
    last = end
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++ // avoid zero-width loops
  }
  if (last < text.length) out.push(text.slice(last))
  return out.filter((s) => s.length > 0)
}

// ── Piece sizing: pack pieces into chunks ≤ maxChars ─────────────────────

/**
 * Greedy packer: accumulate pieces into a running chunk until adding the
 * next one would exceed targetChars; emit and start a new one. An
 * oversized indivisible piece gets its own chunk and is flagged via the
 * downstream `oversized` check in chunkSection.
 */
function sizePieces(pieces: Piece[], opts: ChunkingOptions): Piece[] {
  const out: Piece[] = []
  let buf = ""
  let bufOffset: number | null = null
  for (const p of pieces) {
    if (p.text.length === 0) continue
    // Piece alone is larger than targetChars: flush current, emit alone.
    if (p.text.length > opts.targetChars) {
      if (buf.length > 0 && bufOffset !== null) {
        out.push({ text: buf, offset: bufOffset })
      }
      out.push({ text: p.text, offset: p.offset })
      buf = ""
      bufOffset = null
      continue
    }
    // Would exceed target?
    if (buf.length + p.text.length > opts.targetChars && buf.length > 0 && bufOffset !== null) {
      out.push({ text: buf, offset: bufOffset })
      buf = p.text
      bufOffset = p.offset
      continue
    }
    // Accumulate.
    if (buf.length === 0) bufOffset = p.offset
    buf += p.text
  }
  if (buf.length > 0 && bufOffset !== null) {
    out.push({ text: buf, offset: bufOffset })
  }
  return out
}

// ── Small-chunk merge pass ───────────────────────────────────────────────

/**
 * Combine chunks shorter than `minChars` with their next sibling, unless
 * the combined size would exceed `maxChars`. Prevents the emission of
 * dozens of 30-char "fragments" when a section has many short paragraphs.
 */
function mergeSmall(pieces: Piece[], opts: ChunkingOptions): Piece[] {
  if (pieces.length < 2) return pieces
  const out: Piece[] = []
  for (const p of pieces) {
    const last = out[out.length - 1]
    if (
      last &&
      last.text.length < opts.minChars &&
      last.text.length + p.text.length <= opts.maxChars
    ) {
      out[out.length - 1] = { text: last.text + p.text, offset: last.offset }
    } else {
      out.push(p)
    }
  }
  return out
}

// ── Overlap injection ────────────────────────────────────────────────────

/**
 * Prepend `overlapChars` of the preceding chunk's tail to each chunk after
 * the first, so concepts that span a boundary aren't torn at retrieval
 * time. We compute the overlap from the PREVIOUS chunk's final chars,
 * snapped to a word/sentence boundary where possible for readability.
 */
function applyOverlap(pieces: Piece[], opts: ChunkingOptions): Piece[] {
  if (opts.overlapChars <= 0 || pieces.length < 2) return pieces
  const out: Piece[] = [pieces[0]]
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1]
    const curr = pieces[i]
    const tailSrc = prev.text.slice(Math.max(0, prev.text.length - opts.overlapChars))
    // Snap the overlap to the nearest sentence/word boundary so we don't
    // start a chunk mid-word. Search for the first separator AFTER we've
    // trimmed enough chars.
    const snapped = snapOverlapHead(tailSrc)
    out.push({ text: snapped + curr.text, offset: curr.offset - snapped.length })
  }
  return out
}

function snapOverlapHead(tail: string): string {
  // Walk FORWARD through `tail` to find the first clean start-of-unit
  // boundary (end of a sentence, newline, whitespace) and keep everything
  // from there. This ensures overlap is a coherent span rather than a
  // mid-word / mid-sentence fragment.
  //
  // An earlier version searched BACKWARD (find last separator, keep
  // content after it) — which collapsed overlap to near-zero whenever
  // the tail ended exactly at a sentence boundary, because "content
  // after the last `. `" is then just the trailing space. Searching
  // forward instead keeps the bulk of the tail as context.
  const sentMatch = tail.match(/[。！？!?.;；][\s]*/)
  if (sentMatch && sentMatch.index !== undefined) {
    const after = sentMatch.index + sentMatch[0].length
    if (after > 0 && after < tail.length) return tail.slice(after)
  }
  const wsMatch = tail.match(/\s/)
  if (wsMatch && wsMatch.index !== undefined && wsMatch.index < tail.length - 1) {
    return tail.slice(wsMatch.index + 1)
  }
  return tail
}
