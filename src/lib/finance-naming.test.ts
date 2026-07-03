import { describe, expect, it } from "vitest"
import {
  buildFinanceFileName,
  extractSourceDate,
  matchStock,
  mergeStockRecords,
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
    expect(extractSourceDate("20260630-稀美资源-小范围交流（附0401参观调研纪要）", FALLBACK))
      .toEqual({ date: "20260630", source: "filename", matchedText: "20260630" })
  })

  it("expands yymmdd with the century", () => {
    expect(extractSourceDate("260607-久谦论坛-调研周报", FALLBACK))
      .toEqual({ date: "20260607", source: "filename", matchedText: "260607" })
  })

  it("expands trailing mmdd with the reference year", () => {
    expect(extractSourceDate("悦安电感材料专家交流0701", FALLBACK))
      .toEqual({ date: "20260701", source: "filename", matchedText: "0701" })
  })

  it("does not mistake a 6-digit stock code for a date (invalid month)", () => {
    // 688786 → 月份 87 非法，不是日期
    expect(extractSourceDate("688786调研摘录", FALLBACK))
      .toEqual({ date: "20260702", source: "fallback" })
  })

  it("does not mistake a bare ticker like 600519 for a yymmdd date (year window)", () => {
    // 60/05/19 月日合法，但年份 2060 超出 20-39 合理窗口 → 拒绝
    expect(extractSourceDate("600519调研纪要", FALLBACK))
      .toEqual({ date: "20260702", source: "fallback" })
  })

  it("does not treat a leading 4-digit model number as mmdd (end-anchored only)", () => {
    // 1206 是封装尺寸而非日期；mmdd 仅在主干结尾时才认
    expect(extractSourceDate("1206阻容专家交流", FALLBACK))
      .toEqual({ date: "20260702", source: "fallback" })
  })

  it("falls back to the reference date when nothing parses", () => {
    expect(extractSourceDate("汉钟精机学习笔记", FALLBACK))
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

  it("tolerates a leading unnamed index column (pandas to_csv without index=False)", () => {
    const csv = [
      ",ts_code,symbol,name,area,industry,cnspell,market",
      "0,688786.SH,688786,悦安新材,福建,小金属,yaxc,科创板",
    ].join("\n")

    expect(parseStockBasicCsv(csv)).toEqual([
      { tsCode: "688786.SH", name: "悦安新材", cnspell: "yaxc" },
    ])
  })

  it("accepts hk_basic's cn_spell header (with underscore) for the spell column", () => {
    const csv = [
      "ts_code,name,fullname,enname,cn_spell,market",
      "00700.HK,腾讯控股,腾讯控股有限公司,TENCENT,txkg,主板",
    ].join("\n")

    expect(parseStockBasicCsv(csv)).toEqual([
      { tsCode: "00700.HK", name: "腾讯控股", cnspell: "txkg" },
    ])
  })
})

describe("mergeStockRecords", () => {
  it("dedupes by name with earlier tables taking priority (A股优先于港股)", () => {
    const aShare: StockRecord[] = [{ tsCode: "688981.SH", name: "中芯国际", cnspell: "zxgj" }]
    const hk: StockRecord[] = [
      { tsCode: "00981.HK", name: "中芯国际", cnspell: "zxgj" },
      { tsCode: "00700.HK", name: "腾讯控股", cnspell: "txkg" },
    ]

    expect(mergeStockRecords(aShare, hk)).toEqual([
      { tsCode: "688981.SH", name: "中芯国际", cnspell: "zxgj" },
      { tsCode: "00700.HK", name: "腾讯控股", cnspell: "txkg" },
    ])
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

  it("resolves A/B-suffix base-name hit over an HK sibling's prefix hit (京东方A vs 京东方精电)", () => {
    // A+H 前缀撞车：两者都以「京东方」（长度 3）命中；「京东方A」的基名
    // （去掉市场类别后缀 A）恰为「京东方」，应视为完整名命中并胜出
    const ahStocks: StockRecord[] = [
      { tsCode: "000725.SZ", name: "京东方A", cnspell: "jdfa" },
      { tsCode: "00710.HK", name: "京东方精电", cnspell: "jdfjd" },
    ]
    const match = matchStock("京东方投资者交流日纪要", ahStocks)
    expect(match?.stock.tsCode).toBe("000725.SZ")
    expect(match?.matchedBy).toBe("name")
  })

  it("treats a full-width Ａ suffix the same way (万科Ａ vs 万科企业)", () => {
    const ahStocks: StockRecord[] = [
      { tsCode: "000002.SZ", name: "万科Ａ", cnspell: "wka" },
      { tsCode: "02202.HK", name: "万科企业", cnspell: "wkqy" },
    ]
    expect(matchStock("万科年度业绩会纪要", ahStocks)?.stock.tsCode).toBe("000002.SZ")
  })

  it("still ambiguous when tied prefix hits have no base-name winner", () => {
    const tied: StockRecord[] = [
      { tsCode: "300059.SZ", name: "东方财富", cnspell: "dfcf" },
      { tsCode: "600958.SH", name: "东方证券", cnspell: "dfzq" },
    ]
    expect(matchStock("东方专家电话会", tied)).toBeNull()
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

  it("resolves the reported 京东方 A+H collision end-to-end (regression)", () => {
    // 用户报告：此文件曾因 京东方A/京东方精电 前缀撞车落到 NA
    const ahStocks: StockRecord[] = [
      { tsCode: "000725.SZ", name: "京东方A", cnspell: "jdfa" },
      { tsCode: "00710.HK", name: "京东方精电", cnspell: "jdfjd" },
    ]
    const { fileName, record } = buildFinanceFileName(
      "京东方投资者交流日纪要20260702.docx",
      ahStocks,
      FALLBACK,
    )
    expect(fileName).toBe("20260702-000725.SZ-京东方A-投资者交流日纪要.docx")
    expect(record.tsCode).toBe("000725.SZ")
    expect(record.matchedBy).toBe("name")
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

  it("preserves meaningful digits in the title (only the adopted date is stripped)", () => {
    const { fileName } = buildFinanceFileName("悦安2028年产能规划260701.docx", stocks, FALLBACK)
    expect(fileName).toBe("20260701-688786.SH-悦安新材-2028年产能规划.docx")
  })

  it("keeps a bare ticker in the title instead of misreading it as a date", () => {
    const { fileName, record } = buildFinanceFileName("600519调研纪要.docx", stocks, FALLBACK)
    expect(fileName).toBe("20260702-NA-600519调研纪要.docx")
    expect(record.dateSource).toBe("fallback")
  })
})
