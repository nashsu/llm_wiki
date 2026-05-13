export const PDF_SOURCE_SUMMARY_SECTIONS = [
  "## 요약",
  "## 논문 구조",
  "## 핵심 주장",
  "## 방법론",
  "## 실험 및 근거",
  "## 표/그림 근거",
  "## 한계와 주의점",
  "## LLM Wiki / AI Native Solo Business OS 관점",
  "## 승격 후보",
  "## 검증 및 최신성",
  "## Source Trace",
]

export interface PdfPromotionCandidate {
  type: "entity" | "concept" | "comparison" | "synthesis" | "query" | "workflow" | "review"
  title: string
  decision: string
  evidenceStrength: string
  coverage: string
  sourceTrace: string
  reuseValue: string
  reason: string
}

export interface PdfStructureSummary {
  title: string
  sections: string[]
  figures: string[]
  tables: string[]
  extractionQuality: {
    status: "ok" | "partial" | "failed"
    quality: "normal" | "low" | "missing"
    method: "tauri-read-file" | "pdf-structure-fallback"
    textLength: number
  }
}

export function isPdfSourceFile(sourceFileName: string): boolean {
  return /\.pdf$/iu.test(sourceFileName.trim())
}

function getSourceBaseName(sourceFileName: string): string {
  return sourceFileName.replace(/\.[^.]+$/, "")
}

function normalizePdfGateValue(value: string): string {
  return value.trim().toLowerCase().replace(/^["']|["']$/g, "")
}

function readPdfCandidateField(line: string, field: string): string {
  const match = line.match(new RegExp(`${field}\\s*[:=]\\s*([^|;,]+)`, "iu"))
  return match?.[1]?.trim() ?? ""
}

export function roleForPdfCandidate(rawType: string): PdfPromotionCandidate["type"] {
  const type = normalizePdfGateValue(rawType)
  if (type === "entity") return "entity"
  if (type === "concept") return "concept"
  if (type === "comparison") return "comparison"
  if (type === "synthesis") return "synthesis"
  if (type === "query") return "query"
  if (type === "workflow") return "workflow"
  return "review"
}

export function parsePdfPromotionCandidates(analysis: string): PdfPromotionCandidate[] {
  const section = analysis.match(/##\s*(?:PDF\s+)?Promotion Candidates?\s*([\s\S]*?)(?=\n##\s+|$)/iu)?.[1] ??
    analysis.match(/##\s*승격 후보\s*([\s\S]*?)(?=\n##\s+|$)/iu)?.[1] ??
    ""
  if (!section.trim()) return []

  const candidates: PdfPromotionCandidate[] = []
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "")
    if (!line || !/[|:=]/u.test(line)) continue

    const parts = line.split("|").map((part) => part.trim()).filter(Boolean)
    const typePart = readPdfCandidateField(line, "type") || parts[0] || ""
    const titlePart = readPdfCandidateField(line, "title") || parts[1] || ""
    const candidate: PdfPromotionCandidate = {
      type: roleForPdfCandidate(typePart),
      title: titlePart.replace(/^title\s*[:=]\s*/iu, "").trim(),
      decision: normalizePdfGateValue(readPdfCandidateField(line, "decision") || "review"),
      evidenceStrength: normalizePdfGateValue(
        readPdfCandidateField(line, "evidence_strength") ||
        readPdfCandidateField(line, "evidenceStrength") ||
        readPdfCandidateField(line, "evidence") ||
        "",
      ),
      coverage: normalizePdfGateValue(readPdfCandidateField(line, "coverage") || ""),
      sourceTrace: readPdfCandidateField(line, "source_trace") || readPdfCandidateField(line, "sourceTrace") || "",
      reuseValue: normalizePdfGateValue(
        readPdfCandidateField(line, "reuse_value") ||
        readPdfCandidateField(line, "reuseValue") ||
        "",
      ),
      reason: normalizePdfGateValue(readPdfCandidateField(line, "reason") || "pdf-promotion-candidate"),
    }
    if (candidate.title) candidates.push(candidate)
  }
  return candidates
}

export function pdfTraceIsUsable(sourceTrace: string): boolean {
  return /\.pdf\b/iu.test(sourceTrace) && /\b(page|p\.|section|sec\.|쪽|페이지|섹션)\b/iu.test(sourceTrace)
}

export function isStrongPdfPromotionCandidate(candidate: PdfPromotionCandidate): boolean {
  if (!["create", "promote"].includes(candidate.decision)) return false
  if (!["medium", "high", "strong"].includes(candidate.coverage)) return false
  if (!["medium", "high", "strong"].includes(candidate.evidenceStrength)) return false
  if (!pdfTraceIsUsable(candidate.sourceTrace)) return false
  if (candidate.type === "concept" && !["medium", "high", "strong"].includes(candidate.reuseValue)) return false
  return true
}

function extractPdfHeadingLines(sourceContent: string): string[] {
  const lines = sourceContent.split(/\r?\n/)
  const headings: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(abstract|introduction|background|method|methods|methodology|experiment|experiments|results|discussion|limitations?|conclusion|references)\b/iu.test(trimmed)) {
      headings.push(trimmed.slice(0, 120))
    }
    if (/^\d+(?:\.\d+)*\s+[A-Z][^\n]{3,120}$/u.test(trimmed)) {
      headings.push(trimmed.slice(0, 120))
    }
    if (headings.length >= 12) break
  }
  return Array.from(new Set(headings))
}

export function buildPdfStructureSummary(sourceFileName: string, sourceContent: string): PdfStructureSummary {
  const compact = sourceContent.trim()
  const title = compact.split(/\r?\n/).find((line) => line.trim().length >= 4)?.trim() || getSourceBaseName(sourceFileName)
  const sections = extractPdfHeadingLines(compact)
  const figures = Array.from(compact.matchAll(/\b(?:figure|fig\.)\s*\d+[:.\s-][^\n]{0,160}/giu))
    .map((match) => match[0].trim())
    .slice(0, 8)
  const tables = Array.from(compact.matchAll(/\btable\s*\d+[:.\s-][^\n]{0,160}/giu))
    .map((match) => match[0].trim())
    .slice(0, 8)
  const quality = compact.length >= 1200 ? "normal" : compact.length > 0 ? "low" : "missing"
  return {
    title,
    sections,
    figures,
    tables,
    extractionQuality: {
      status: quality === "missing" ? "failed" : quality === "low" ? "partial" : "ok",
      quality,
      method: compact ? "tauri-read-file" : "pdf-structure-fallback",
      textLength: compact.length,
    },
  }
}

export function formatPdfStructureForPrompt(sourceFileName: string, sourceContent: string): string {
  if (!isPdfSourceFile(sourceFileName)) return ""
  const structure = buildPdfStructureSummary(sourceFileName, sourceContent)
  return [
    "## pdfStructure",
    `- file: ${sourceFileName}`,
    `- title_hint: ${structure.title}`,
    `- extraction: status=${structure.extractionQuality.status}; quality=${structure.extractionQuality.quality}; method=${structure.extractionQuality.method}; text_length=${structure.extractionQuality.textLength}`,
    structure.sections.length > 0 ? `- sections: ${structure.sections.join(" | ")}` : "- sections: not detected; infer conservatively from text order",
    structure.figures.length > 0 ? `- figures: ${structure.figures.join(" | ")}` : "- figures: not detected in extracted text; ask for review if figure evidence matters",
    structure.tables.length > 0 ? `- tables: ${structure.tables.join(" | ")}` : "- tables: not detected in extracted text; ask for review if table evidence matters",
  ].join("\n")
}
