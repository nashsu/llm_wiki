// Source identity + summary slug derivation (port of src/lib/source-identity.ts).
//
// The source identity is the project-relative path under raw/sources/ (or the
// bare filename as a legacy fallback). Summary slugs are derived from it
// deterministically; the candidates list includes every slug shape ever
// produced so legacy summary pages keep resolving after slug-format changes.
//
// PORT NOTE: getFileName/normalizePath are inlined from @/lib/path-utils —
// regexes and algorithms are byte-identical to the client source.

const RAW_SOURCES_PREFIX = "raw/sources/"
const RAW_SOURCES_MARKER = "/raw/sources/"
const MAX_SOURCE_SUMMARY_SLUG_LENGTH = 120
const FALLBACK_SOURCE_PART = "source"

/** Normalize a path to use forward slashes (works on both macOS and Windows). */
function normalizePath(p) {
  return p.replace(/\\/g, "/")
}

/** Get the filename from a path (handles both / and \). */
function getFileName(p) {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

export function sourceIdentityForPath(projectPath, sourcePath) {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const sp = normalizePath(sourcePath)
  const projectRawSourcesPrefix = `${pp}/${RAW_SOURCES_PREFIX}`
  const spKey = sp.toLowerCase()
  if (spKey.startsWith(projectRawSourcesPrefix.toLowerCase())) {
    return sp.slice(projectRawSourcesPrefix.length)
  }
  if (spKey.startsWith(RAW_SOURCES_PREFIX)) {
    return sp.slice(RAW_SOURCES_PREFIX.length)
  }
  const markerIndex = spKey.indexOf(RAW_SOURCES_MARKER)
  if (markerIndex >= 0) {
    return sp.slice(markerIndex + RAW_SOURCES_MARKER.length)
  }
  return getFileName(sp)
}

export function sourceReferenceIdentity(sourceReference) {
  const ref = normalizePath(sourceReference)
  const refKey = ref.toLowerCase()
  if (refKey.startsWith(RAW_SOURCES_PREFIX)) {
    return ref.slice(RAW_SOURCES_PREFIX.length)
  }
  const markerIndex = refKey.indexOf(RAW_SOURCES_MARKER)
  if (markerIndex >= 0) {
    return ref.slice(markerIndex + RAW_SOURCES_MARKER.length)
  }
  return ref
}

export function sourceSummarySlugFromIdentity(sourceIdentity) {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    return parts[0] || "source"
  }

  const hash = stableSlugHash(sourceIdentity)
  const slug = parts.map((part) => {
    const { readable, structuralLength } = readableSlugPart(part)
    return `${structuralLength}-${readable}`
  }).join("--")
  const fullSlug = `${slug}--${hash}`
  if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) {
    return fullSlug
  }

  const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2
  const readablePrefix = slug.slice(0, readableLimit).replace(/-+$/, "")
  return `${readablePrefix || "source"}--${hash}`
}

export function legacySourceSummarySlugFromIdentity(sourceIdentity) {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    return parts[0] || "source"
  }

  const hash = stableSlugHash(sourceIdentity)
  const slug = parts.map((part) => {
    const encoded = encodeURIComponent(part)
    return `${encoded.length}-${encoded}`
  }).join("--")
  return `${slug}--${hash}`
}

export function sourceSummarySlugCandidatesFromIdentity(sourceIdentity) {
  const canonical = sourceSummarySlugFromIdentity(sourceIdentity)
  const previousReadable = previousReadableSourceSummarySlugFromIdentity(sourceIdentity)
  const legacy = legacySourceSummarySlugFromIdentity(sourceIdentity)
  return Array.from(new Set([canonical, previousReadable, legacy]))
}

function previousReadableSourceSummarySlugFromIdentity(sourceIdentity) {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    return parts[0] || "source"
  }

  const hash = stableSlugHash(sourceIdentity)
  const slug = parts.map((part) => {
    const { readable } = readableSlugPart(part)
    return `${Array.from(readable).length}-${readable}`
  }).join("--")
  const fullSlug = `${slug}--${hash}`
  if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) {
    return fullSlug
  }

  const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2
  const readablePrefix = slug.slice(0, readableLimit).replace(/-+$/, "")
  return `${readablePrefix || "source"}--${hash}`
}

function readableSlugPart(part) {
  const structural = part
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  const readable = structural.replace(/-+/g, "-") || FALLBACK_SOURCE_PART
  return {
    readable,
    structuralLength: Math.max(1, Array.from(structural || FALLBACK_SOURCE_PART).length),
  }
}

function stableSlugHash(value) {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
