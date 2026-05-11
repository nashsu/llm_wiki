import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter"
import {
  scalarFrontmatterValue,
  shouldExcludeFromDefaultKnowledgeSurface,
} from "@/lib/wiki-metadata"

type GraphExclusionNode = {
  id: string
  path: string
  type?: string
}

const STRUCTURAL_IDS = new Set(["index", "overview", "log", "schema", "purpose"])
const STRUCTURAL_TYPES = new Set(["index", "overview", "log", "schema", "purpose"])
const OPERATIONAL_TYPES = new Set(["query"])
const OPERATIONAL_PATH_SEGMENTS = new Set(["queries"])
const INDEX_LIKE_IDS = new Set([
  "index-map",
  "manifest",
  "map",
  "maps",
  "registry",
  "source-index",
  "source-map",
  "topic-map",
])
const INDEX_LIKE_TYPES = new Set([
  "index-map",
  "manifest",
  "map",
  "registry",
  "source-index",
  "source-map",
  "topic-map",
])

const EXCLUDED_PATH_SEGMENTS = new Set([
  "_retired",
  "10_maps",
  "backup",
  "backups",
  "codex-memory",
  "low-quality",
  "maps",
  "manifest",
  "manifests",
  "registries",
  "registry",
  "retired",
])

const EXCLUDED_FILE_SUFFIXES = [
  "-index",
  "-manifest",
  "-map",
  "-maps",
  "-registry",
  "-source-index",
  "-source-map",
  "-topic-map",
]

const EXCLUDED_FIELD_NAMES = ["type", "role", "source_role", "source_type", "doc_type"]

export function isGraphInputExcludedPage(filePath: string, fileName: string, content: string): boolean {
  if (isGraphInputExcludedPath(filePath, fileName)) return true

  const frontmatter = parseFrontmatter(content).frontmatter
  if (!frontmatter) return false

  if (shouldExcludeFromDefaultKnowledgeSurface({
    path: filePath,
    type: scalarFrontmatterValue(frontmatter.type),
    state: scalarFrontmatterValue(frontmatter.state),
    retention: scalarFrontmatterValue(frontmatter.retention),
  })) {
    return true
  }

  return EXCLUDED_FIELD_NAMES.some((field) => frontmatterValueHasExcludedKind(frontmatter[field]))
}

export function isGraphViewExcludedPage(filePath: string, fileName: string, content: string): boolean {
  if (isGraphInputExcludedPage(filePath, fileName, content)) return true
  if (hasOperationalPathSegment(filePath)) return true

  const frontmatter = parseFrontmatter(content).frontmatter
  return frontmatterValueHasOperationalKind(frontmatter?.type)
}

export function isGraphInputExcludedPath(filePath: string, fileName: string): boolean {
  const id = fileNameToId(fileName)
  if (STRUCTURAL_IDS.has(id)) return true
  if (INDEX_LIKE_IDS.has(id)) return true
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => id.endsWith(suffix))) return true

  const segments = normalizePathSegments(filePath)
  return segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))
}

export function isGraphExcludedNode(node: GraphExclusionNode): boolean {
  const id = normalizeKind(node.id)
  if (STRUCTURAL_IDS.has(id)) return true
  if (INDEX_LIKE_IDS.has(id)) return true

  const type = normalizeKind(node.type ?? "")
  if (STRUCTURAL_TYPES.has(type) || INDEX_LIKE_TYPES.has(type) || OPERATIONAL_TYPES.has(type)) return true

  return hasOperationalPathSegment(node.path) || isGraphInputExcludedPath(node.path, `${node.id}.md`)
}

function frontmatterValueHasExcludedKind(value: FrontmatterValue | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => isExcludedKind(item))
  }
  return isExcludedKind(value ?? "")
}

function frontmatterValueHasOperationalKind(value: FrontmatterValue | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => isOperationalKind(item))
  }
  return isOperationalKind(value ?? "")
}

function isExcludedKind(raw: string): boolean {
  const kind = normalizeKind(raw)
  return STRUCTURAL_TYPES.has(kind) || INDEX_LIKE_TYPES.has(kind)
}

function isOperationalKind(raw: string): boolean {
  return OPERATIONAL_TYPES.has(normalizeKind(raw))
}

function fileNameToId(fileName: string): string {
  return fileName.replace(/\.md$/i, "").trim().toLowerCase()
}

function normalizePathSegments(filePath: string): string[] {
  return filePath
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean)
}

function hasOperationalPathSegment(filePath: string): boolean {
  return normalizePathSegments(filePath).some((segment) => OPERATIONAL_PATH_SEGMENTS.has(segment))
}

function normalizeKind(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-")
}
