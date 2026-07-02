/**
 * 金融来源文件名规范化引擎。
 *
 * 目标格式：`yyyymmdd-<ts_code|NA>-<简称|主体>-<标题>.<ext>`——
 * 让时间与标的锚点进入来源身份，全链路（摘要页/检索/LLM 上下文）可见。
 * 纯逻辑与 IO 分离：解析/匹配/构名为纯函数，磁盘读写在文件末尾的包装函数。
 */
import { readFile, writeFile, createDirectory, getFileModifiedTime } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface StockRecord {
  tsCode: string
  name: string
  cnspell: string
}

export interface RenameRecord {
  original: string
  renamed: string
  date: string
  dateSource: "filename" | "fallback"
  tsCode: string | null
  stockName: string | null
  matchedBy: "name" | "name-prefix" | null
  importedAt: number
}

/** 校验 mm/dd 是否为合法月日。 */
function isValidMonthDay(mm: number, dd: number): boolean {
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31
}

/** yymmdd 补世纪时可信的两位年份窗口（2020-2039），窗口外视为非日期（如裸代码 600519）。 */
const YY_MIN = 20
const YY_MAX = 39

/**
 * 从文件名中提取日期，统一为 yyyymmdd。
 *
 * 提取优先级：yyyymmdd → yymmdd（补世纪，年份限 20-39 窗口）→
 * mmdd（补参考年份，仅认主干结尾位置，避免把型号/规格误判）。
 * 每级都做月/日合法性校验；全部落空时回退参考日期（通常为文件
 * 修改时间）。matchedText 返回被采用的原文片段，供构名时精确剥除，
 * 不误伤标题中的其他数字。
 *
 * :param fileName: 原始文件名（不含扩展名为佳）
 * :param fallback: 回退参考日期
 * :returns: { date: yyyymmdd, source: 来源, matchedText?: 采用的原文片段 }
 */
export function extractSourceDate(
  fileName: string,
  fallback: Date,
): { date: string; source: "filename" | "fallback"; matchedText?: string } {
  for (const match of fileName.matchAll(/(20\d{2})(\d{2})(\d{2})/g)) {
    if (isValidMonthDay(Number(match[2]), Number(match[3]))) {
      return { date: match[0], source: "filename", matchedText: match[0] }
    }
  }
  for (const match of fileName.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/g)) {
    const yy = Number(match[1])
    if (yy >= YY_MIN && yy <= YY_MAX && isValidMonthDay(Number(match[2]), Number(match[3]))) {
      return { date: `20${match[0]}`, source: "filename", matchedText: match[0] }
    }
  }
  const referenceYear = fallback.toISOString().slice(0, 4)
  const trailing = fileName.match(/(?<!\d)(\d{2})(\d{2})$/)
  if (trailing && isValidMonthDay(Number(trailing[1]), Number(trailing[2]))) {
    return {
      date: `${referenceYear}${trailing[0]}`,
      source: "filename",
      matchedText: trailing[0],
    }
  }
  return { date: fallback.toISOString().slice(0, 10).replace(/-/g, ""), source: "fallback" }
}

/** 解析一行 CSV（支持双引号包裹与内嵌逗号）。 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else current += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ",") { fields.push(current); current = "" }
    else current += ch
  }
  fields.push(current)
  return fields.map((f) => f.trim())
}

/**
 * 解析 tushare stock_basic 导出的 CSV，按表头定位 ts_code/name/cnspell 列。
 *
 * :param csv: CSV 全文
 * :returns: 个股记录列表；缺少必需表头时返回空列表
 */
export function parseStockBasicCsv(csv: string): StockRecord[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const tsCodeIdx = headers.indexOf("ts_code")
  const nameIdx = headers.indexOf("name")
  // A 股表列名为 cnspell，港股表（hk_basic）为 cn_spell，两者都认
  const cnspellIdx = headers.indexOf("cnspell") >= 0
    ? headers.indexOf("cnspell")
    : headers.indexOf("cn_spell")
  if (tsCodeIdx < 0 || nameIdx < 0) return []

  const records: StockRecord[] = []
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line)
    const tsCode = fields[tsCodeIdx] ?? ""
    const name = fields[nameIdx] ?? ""
    if (!tsCode || !name) continue
    records.push({ tsCode, name, cnspell: cnspellIdx >= 0 ? (fields[cnspellIdx] ?? "") : "" })
  }
  return records
}

export interface StockMatch {
  stock: StockRecord
  /** 文件名中实际命中的文本（全称或其前缀），供构名时剔除 */
  matchedText: string
  matchedBy: "name" | "name-prefix"
}

/**
 * 在文本中匹配个股：全称包含优先，其次简称前缀递减匹配（最短 2 字）。
 *
 * 纪要文件名常用简称缩写（如"悦安"指悦安新材），故按前缀长度分级取最长
 * 命中；同一长度命中多只个股视为歧义，返回 null（宁可落行业格式也不猜）。
 *
 * :param subject: 待匹配文本（通常为去掉日期与扩展名的文件名）
 * :param stocks: 个股基础表
 * :returns: 唯一最长命中，歧义或零命中为 null
 */
export function matchStock(subject: string, stocks: StockRecord[]): StockMatch | null {
  let bestLength = 0
  let winners: StockMatch[] = []
  for (const stock of stocks) {
    if (stock.name.length < 2) continue
    // 从全称往短试，找到该股在文本中的最长前缀命中
    for (let length = stock.name.length; length >= 2; length--) {
      const prefix = stock.name.slice(0, length)
      if (!subject.includes(prefix)) continue
      const match: StockMatch = {
        stock,
        matchedText: prefix,
        matchedBy: length === stock.name.length ? "name" : "name-prefix",
      }
      if (length > bestLength) {
        bestLength = length
        winners = [match]
      } else if (length === bestLength) {
        winners.push(match)
      }
      break
    }
  }
  return winners.length === 1 ? winners[0] : null
}

/** 清理分段分隔符残渣（连续/首尾的 -、_、空白、全半角括号内空壳）。 */
function cleanSegment(value: string): string {
  return value
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-]+|[-]+$/g, "")
}

/**
 * 构造规范化文件名并产出审计记录。
 *
 * 匹配成功：`yyyymmdd-<ts_code>-<简称>-<标题>.<ext>`（标题为原名去日期
 * 去简称后的残余，空则用"纪要"占位）；未匹配：`yyyymmdd-NA-<主干>.<ext>`。
 * 对已符合格式的文件名幂等（重复处理不再变化）。
 *
 * :param originalName: 原始文件名（含扩展名）
 * :param stocks: 个股基础表（可为空列表）
 * :param fallbackDate: 日期回退参考（通常为文件修改时间）
 * :returns: { fileName: 新文件名, record: 审计记录 }
 */
export function buildFinanceFileName(
  originalName: string,
  stocks: StockRecord[],
  fallbackDate: Date,
): { fileName: string; record: RenameRecord } {
  const extMatch = originalName.match(/\.[^./\\]+$/)
  const ext = extMatch ? extMatch[0] : ""
  const stem = ext ? originalName.slice(0, -ext.length) : originalName

  // 幂等：重复处理已规范化的文件名时，先剥掉 ts_code 形状的段
  // （避免其中 6 位数字被日期提取误判），再仅剥"实际采用"的日期片段——
  // 标题中的其他数字（年份/规格/型号）原样保留
  const codeStripped = stem.replace(/\d{6}\.[A-Z]{2}/g, "")
  const { date, source: dateSource, matchedText } = extractSourceDate(codeStripped, fallbackDate)
  const dateStripped = matchedText ? codeStripped.replace(matchedText, "") : codeStripped

  const match = matchStock(dateStripped, stocks)
  let fileName: string
  if (match) {
    // matchedText 即文本中实际命中的片段（全称或其前缀），删它即可
    const title = cleanSegment(
      dateStripped.replace(match.matchedText, "").replace(/^-?NA-?/, ""),
    ) || "纪要"
    fileName = `${date}-${match.stock.tsCode}-${match.stock.name}-${title}${ext}`
  } else {
    const cleaned = cleanSegment(dateStripped.replace(/^-?NA-?/, "")) || "纪要"
    fileName = `${date}-NA-${cleaned}${ext}`
  }

  return {
    fileName,
    record: {
      original: originalName,
      renamed: fileName,
      date,
      dateSource,
      tsCode: match?.stock.tsCode ?? null,
      stockName: match?.stock.name ?? null,
      matchedBy: match?.matchedBy ?? null,
      importedAt: Date.now(),
    },
  }
}

// ── IO 包装 ────────────────────────────────────────────────────────

const NAMING_CONFIG_FILE = ".llm-wiki/source-naming.json"
const RENAME_MAP_FILE = ".llm-wiki/rename-map.json"
/** 项目根下 A 股基础表的约定位置。 */
export const STOCK_BASIC_FILE = "stock_basic.csv"
/** 项目根下港股基础表的约定位置（可选，tushare hk_basic 导出）。 */
export const HK_BASIC_FILE = "hk_basic.csv"

/**
 * 合并多张个股表并按简称去重，靠前的表优先。
 *
 * A+H 两地上市公司在两张表中同名，若不去重会造成匹配歧义
 * （永远落 NA）；按加载顺序保留首个记录即"A 股代码优先"。
 *
 * :param tables: 个股表列表（按优先级排列）
 * :returns: 去重后的合并表
 */
export function mergeStockRecords(...tables: StockRecord[][]): StockRecord[] {
  const merged: StockRecord[] = []
  const seenNames = new Set<string>()
  for (const table of tables) {
    for (const record of table) {
      if (seenNames.has(record.name)) continue
      seenNames.add(record.name)
      merged.push(record)
    }
  }
  return merged
}

/** 项目是否启用了金融来源命名规范化。 */
export async function isFinanceNamingEnabled(projectPath: string): Promise<boolean> {
  try {
    const raw = await readFile(`${normalizePath(projectPath)}/${NAMING_CONFIG_FILE}`)
    return (JSON.parse(raw) as { mode?: string }).mode === "finance"
  } catch {
    return false
  }
}

/** 为项目启用金融来源命名规范化（建项目复选框调用）。 */
export async function enableFinanceNaming(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFile(`${pp}/${NAMING_CONFIG_FILE}`, JSON.stringify({ mode: "finance" }, null, 2))
}

/**
 * 读取项目根的个股基础表：stock_basic.csv（A 股）+ 可选 hk_basic.csv（港股）。
 *
 * 两文件均可缺失（缺失时该市场为空表）；合并按简称去重，A 股优先，
 * 使 A+H 两地上市公司稳定解析到 A 股代码而非落入歧义。
 *
 * :param projectPath: 项目根路径
 * :returns: 合并去重后的个股表；全部缺失时为空（仅做日期规范化）
 */
export async function loadStockBasic(projectPath: string): Promise<StockRecord[]> {
  const pp = normalizePath(projectPath)
  const readTable = async (fileName: string): Promise<StockRecord[]> => {
    try {
      return parseStockBasicCsv(await readFile(`${pp}/${fileName}`))
    } catch {
      return []
    }
  }
  return mergeStockRecords(await readTable(STOCK_BASIC_FILE), await readTable(HK_BASIC_FILE))
}

/** 追加改名审计记录到 .llm-wiki/rename-map.json（仅供排错，无运行时消费方）。 */
export async function appendRenameMap(
  projectPath: string,
  records: RenameRecord[],
): Promise<void> {
  if (records.length === 0) return
  const pp = normalizePath(projectPath)
  const mapPath = `${pp}/${RENAME_MAP_FILE}`
  let existing: RenameRecord[] = []
  try {
    const parsed = JSON.parse(await readFile(mapPath)) as unknown
    if (Array.isArray(parsed)) existing = parsed as RenameRecord[]
  } catch {
    // 首次写入
  }
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFile(mapPath, JSON.stringify([...existing, ...records], null, 2))
}

/** 取文件修改时间作为日期回退参考；读取失败回退当前时间。 */
export async function fileDateFallback(sourcePath: string): Promise<Date> {
  try {
    const mtime = await getFileModifiedTime(sourcePath)
    return new Date(mtime)
  } catch {
    return new Date()
  }
}
