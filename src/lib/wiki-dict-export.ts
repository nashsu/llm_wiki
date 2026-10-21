import { invoke } from "@tauri-apps/api/core"
import { load } from "@tauri-apps/plugin-store"
import { writeFileAtomic } from "@/commands/fs"
import { joinPath } from "@/lib/path-utils"

export interface WikiTerm {
  text: string
  weight: number
}

export interface WikiDictConfig {
  enabled: boolean
}

export interface WikiDictExportResult {
  entries: number
  targetPath: string | null
}

export const DEFAULT_WIKI_DICT_CONFIG: WikiDictConfig = { enabled: false }

const WIKI_DICT_CONFIG_KEY = "wikiDictConfig"
const STORE_NAME = "app-state.json"

export function normalizeWikiDictConfig(
  config?: Partial<WikiDictConfig> | null,
): WikiDictConfig {
  return {
    enabled: typeof config?.enabled === "boolean" ? config.enabled : false,
  }
}

export async function saveWikiDictConfig(config: WikiDictConfig): Promise<void> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} })
  await store.set(WIKI_DICT_CONFIG_KEY, normalizeWikiDictConfig(config))
  await store.save()
}

export async function loadWikiDictConfig(): Promise<WikiDictConfig> {
  const store = await load(STORE_NAME, { autoSave: true, defaults: {} })
  return normalizeWikiDictConfig(
    await store.get<Partial<WikiDictConfig>>(WIKI_DICT_CONFIG_KEY),
  )
}

export async function qingjianDictTarget(): Promise<string | null> {
  return invoke<string | null>("qingjian_dict_target")
}

/**
 * Scan wiki pages, annotate Han terms with pinyin and atomically write
 * `%APPDATA%\Qingjian\dicts\wiki.tsv` (word TAB pinyin TAB frequency).
 *
 * pinyin-pro options map 1:1 onto Qingjian's dictionary format:
 * - toneType "none": bare syllables (`gou`, not `gǒu`)
 * - type "array": one syllable per Han char, joined with spaces (Qingjian
 *   splits the pinyin column on whitespace)
 * - v: true: ASCII `v` for ü — Qingjian's canonical_syllable only knows
 *   `lve`/`nve`, so `lü`/`nü` (U+00FC) would make the word unreachable
 * - nonZh "consecutive": irrelevant for pure-Han terms, safe default
 */
export async function exportWikiDict(projectPath: string): Promise<WikiDictExportResult> {
  const [terms, targetPath] = await Promise.all([
    invoke<WikiTerm[]>("scan_wiki_terms", { projectPath }),
    qingjianDictTarget(),
  ])
  if (!targetPath) {
    throw new Error("qingjian dicts directory not found on this platform")
  }
  const { pinyin } = await import("pinyin-pro")
  const rows = terms.map((term) => `${term.text}\t${toPinyin(pinyin, term.text)}\t${term.weight}`)
  const tsv = rows.length > 0 ? `${rows.join("\n")}\n` : ""
  await writeFileAtomic(joinPath(targetPath, "wiki.tsv"), tsv)
  return { entries: rows.length, targetPath }
}

type PinyinFn = (
  text: string,
  options?: Record<string, unknown>,
) => string[]

function toPinyin(pinyin: PinyinFn, text: string): string {
  return pinyin(text, {
    toneType: "none",
    type: "array",
    v: true,
    nonZh: "consecutive",
  }).join(" ")
}
