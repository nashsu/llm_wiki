import { describe, expect, it } from "vitest"
import {
  buildFinanceFileName,
  extractSourceDate,
  matchStock,
  parseStockBasicCsv,
  type StockRecord,
} from "./finance-naming"

const stocks: StockRecord[] = [
  { tsCode: "688786.SH", name: "悦安新材", cnspell: "yaxc" },
  { tsCode: "002738.SZ", name: "中矿资源", cnspell: "zkzy" },
  { tsCode: "300080.SZ", name: "易成新能", cnspell: "ycxn" },
]

const FALLBACK = new Date("2026-07-02T00:00:00Z")

describe("extractSourceDate", () => {
  it("prefers full yyyymmdd dates", () => {
    expect(extractSourceDate("20260630-稀美资源-小范围交流（附0401参观调研纪要）.docx", FALLBACK))
      .toEqual({ date: "20260630", source: "filename" })
  })

  it("expands yymmdd with the century", () => {
    expect(extractSourceDate("260607-久谦论坛-调研周报.md", FALLBACK))
      .toEqual({ date: "20260607", source: "filename" })
  })

  it("expands mmdd with the reference year", () => {
    expect(extractSourceDate("悦安电感材料专家交流0701.docx", FALLBACK))
      .toEqual({ date: "20260701", source: "filename" })
  })

  it("does not mistake a 6-digit stock code for a date", () => {
    // 688786 → 月份 87 非法，不是日期
    expect(extractSourceDate("688786调研摘录.docx", FALLBACK))
      .toEqual({ date: "20260702", source: "fallback" })
  })

  it("falls back to the reference date when nothing parses", () => {
    expect(extractSourceDate("汉钟精机学习笔记.docx", FALLBACK))
      .toEqual({ date: "20260702", source: "fallback" })
  })
})

describe("parseStockBasicCsv", () => {
  it("reads ts_code/name/cnspell columns by header", () => {
    const csv = [
      "ts_code,symbol,name,area,industry,cnspell,market",
      "688786.SH,688786,悦安新材,福建,小金属,yaxc,科创板",
      '002738.SZ,002738,"中矿资源",江西,小金属,zkzy,主板',
    ].join("\n")

    expect(parseStockBasicCsv(csv)).toEqual([
      { tsCode: "688786.SH", name: "悦安新材", cnspell: "yaxc" },
      { tsCode: "002738.SZ", name: "中矿资源", cnspell: "zkzy" },
    ])
  })

  it("returns empty list for missing required headers", () => {
    expect(parseStockBasicCsv("foo,bar\n1,2")).toEqual([])
  })
})

describe("matchStock", () => {
  it("matches by full name containment", () => {
    expect(matchStock("悦安新材专家交流", stocks)?.stock.tsCode).toBe("688786.SH")
  })

  it("matches abbreviated prefix forms (悦安 → 悦安新材)", () => {
    const match = matchStock("悦安电感材料专家交流", stocks)
    expect(match?.stock.tsCode).toBe("688786.SH")
    expect(match?.matchedBy).toBe("name-prefix")
  })

  it("returns null when multiple stocks match at the same strength (ambiguous)", () => {
    expect(matchStock("中矿资源与悦安新材对比纪要", stocks)).toBeNull()
  })

  it("returns null when nothing matches", () => {
    expect(matchStock("久谦论坛-调研周报", stocks)).toBeNull()
  })
})

describe("buildFinanceFileName", () => {
  it("builds date-code-name-title for a matched stock", () => {
    const { fileName, record } = buildFinanceFileName(
      "悦安电感材料专家交流260701.docx",
      stocks,
      FALLBACK,
    )
    expect(fileName).toBe("20260701-688786.SH-悦安新材-电感材料专家交流.docx")
    expect(record.tsCode).toBe("688786.SH")
    expect(record.matchedBy).toBe("name-prefix")
    expect(record.dateSource).toBe("filename")
  })

  it("builds date-NA-stem for unmatched industry documents", () => {
    const { fileName, record } = buildFinanceFileName(
      "260607-久谦论坛-调研周报.md",
      stocks,
      FALLBACK,
    )
    expect(fileName).toBe("20260607-NA-久谦论坛-调研周报.md")
    expect(record.tsCode).toBeNull()
  })

  it("keeps already-normalized names stable (idempotent)", () => {
    const first = buildFinanceFileName("悦安电感材料专家交流260701.docx", stocks, FALLBACK)
    const second = buildFinanceFileName(first.fileName, stocks, FALLBACK)
    expect(second.fileName).toBe(first.fileName)
  })

  it("uses a placeholder title when nothing is left after cleaning", () => {
    const { fileName } = buildFinanceFileName("悦安新材0701.docx", stocks, FALLBACK)
    expect(fileName).toBe("20260701-688786.SH-悦安新材-纪要.docx")
  })
})
