// Verbatim server port of src/lib/text-chunker.ts (types stripped; logic,
// regexes, and defaults byte-identical — the embedding rows produced here
// must match the desktop chunker exactly so re-indexed content lands on the
// same chunk boundaries). See the client module for the full design notes.

const DEFAULT_OPTIONS = {
  targetChars: 1000,
  maxChars: 1500,
  minChars: 200,
  overlapChars: 200,
}

export function chunkMarkdown(content, userOptions) {
  const opts = { ...DEFAULT_OPTIONS, ...(userOptions ?? {}) }

  if (opts.maxChars < opts.targetChars) {
    opts.maxChars = opts.targetChars
  }
  if (opts.overlapChars >= opts.targetChars) {
    opts.overlapChars = Math.floor(opts.targetChars / 2)
  }

  const { body, bodyOffset } = stripFrontmatter(content)
  if (body.trim().length === 0) return []

  const sections = splitIntoSections(body, bodyOffset)

  const chunks = []
  let runningIndex = 0
  for (const section of sections) {
    const sectionChunks = chunkSection(section, opts)
    for (const c of sectionChunks) {
      chunks.push({ ...c, index: runningIndex++ })
    }
  }

  return chunks
}

export function stripFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { body: content, bodyOffset: 0 }
  }
  const rest = content.slice(4)
  const closeRelIdx = rest.search(/(^|\n)---\s*(\n|$)/)
  if (closeRelIdx < 0) return { body: content, bodyOffset: 0 }
  const after = rest.slice(closeRelIdx).match(/^(\n)?---\s*\n?/)
  if (!after) return { body: content, bodyOffset: 0 }
  const bodyOffset = 4 + closeRelIdx + after[0].length
  return { body: content.slice(bodyOffset), bodyOffset }
}

function splitIntoSections(body, bodyOffset) {
  const lines = body.split("\n")
  const sections = []

  const headings = {}

  let current = {
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
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0)

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

    const hMatch = !inFence ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : null
    if (hMatch) {
      flush()
      const level = hMatch[1].length
      const title = hMatch[2].trim()
      headings[level] = title
      for (let lvl = level + 1; lvl <= 6; lvl++) delete headings[lvl]

      const pathParts = []
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

function chunkSection(section, opts) {
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

  const atoms = tokenizeAtoms(text)
  const pieces = splitAtomsToPieces(atoms, opts)
  const sized = sizePieces(pieces, opts)
  const merged = mergeSmall(sized, opts)
  const withOverlap = applyOverlap(merged, opts)

  const out = []
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

function tokenizeAtoms(text) {
  const atoms = []
  const lines = text.split("\n")

  let cursor = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fenceMatch = line.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const start = cursor
      const bodyLines = [line]
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
    }

    if (line.trim() === "") {
      atoms.push({ text: "", offset: cursor, indivisible: false, kind: "blank" })
      cursor += line.length + 1
      i++
      continue
    }

    const start = cursor
    const bodyLines = []
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

function splitAtomsToPieces(atoms, opts) {
  const pieces = []
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

const SENTENCE_SPLITTERS = [
  ["lines", (t) => splitKeepingSep(t, /(\n+)/)],
  [
    "sentences",
    (t) => splitKeepingSep(t, /([。！？!?；;]+\s*|(?:\.\s+))/),
  ],
  ["spaces", (t) => splitKeepingSep(t, /(\s+)/)],
]

function recursiveSplit(text, baseOffset, targetChars) {
  const paraPieces = splitKeepingSep(text, /(\n{2,})/)
  const out = []
  let cursor = baseOffset
  for (const chunk of paraPieces) {
    if (chunk.length === 0) continue
    if (chunk.length <= targetChars) {
      out.push({ text: chunk, offset: cursor })
      cursor += chunk.length
      continue
    }
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
      let anyTooBig = false
      let subCursor = cursor
      const subOut = []
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
    }
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

function splitKeepingSep(text, sep) {
  const out = []
  let last = 0
  const globalRe = new RegExp(sep.source, "g")
  let m
  while ((m = globalRe.exec(text)) !== null) {
    const end = m.index + m[0].length
    out.push(text.slice(last, end))
    last = end
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++
  }
  if (last < text.length) out.push(text.slice(last))
  return out.filter((s) => s.length > 0)
}

function sizePieces(pieces, opts) {
  const out = []
  let buf = ""
  let bufOffset = null
  for (const p of pieces) {
    if (p.text.length === 0) continue
    if (p.text.length > opts.targetChars) {
      if (buf.length > 0 && bufOffset !== null) {
        out.push({ text: buf, offset: bufOffset })
      }
      out.push({ text: p.text, offset: p.offset })
      buf = ""
      bufOffset = null
      continue
    }
    if (buf.length + p.text.length > opts.targetChars && buf.length > 0 && bufOffset !== null) {
      out.push({ text: buf, offset: bufOffset })
      buf = p.text
      bufOffset = p.offset
      continue
    }
    if (buf.length === 0) bufOffset = p.offset
    buf += p.text
  }
  if (buf.length > 0 && bufOffset !== null) {
    out.push({ text: buf, offset: bufOffset })
  }
  return out
}

function mergeSmall(pieces, opts) {
  if (pieces.length < 2) return pieces
  const out = []
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

function applyOverlap(pieces, opts) {
  if (opts.overlapChars <= 0 || pieces.length < 2) return pieces
  const out = [pieces[0]]
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1]
    const curr = pieces[i]
    const tailSrc = prev.text.slice(Math.max(0, prev.text.length - opts.overlapChars))
    const snapped = snapOverlapHead(tailSrc)
    out.push({ text: snapped + curr.text, offset: curr.offset - snapped.length })
  }
  return out
}

function snapOverlapHead(tail) {
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
