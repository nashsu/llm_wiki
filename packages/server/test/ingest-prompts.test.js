// Tests for the server-ported ingest prompt builders + token budgets
// (issue #14 P0 server-driven ingest). Ported IN FULL from the client's
// src/lib/ingest.prompt.test.ts — the zustand store plumbing
// (useWikiStore.getState().setOutputLanguage) is replaced by the server
// seam: outputLanguage is a plain input to languageRule(), and the prompt
// builders receive the finished language directive as their first parameter.
// Every behavioral assertion from the client suite is preserved.

import { describe, it, expect, beforeEach } from "vitest"
import {
  buildAnalysisPrompt,
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  buildGenerationPrompt,
  buildPageMergeSystemPrompt,
  buildReviewSuggestionPrompt,
  buildTruncatedFileRepairPrompt,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  computeIngestSourceBudget,
  filterTruncatedFileRepairOutput,
  formatIngestWarningLogEntry,
  languageRule,
  splitSourceIntoSemanticChunks,
} from "../src/ingest/prompts.js"

// Server equivalent of useWikiStore.getState().setOutputLanguage(): the
// pipeline reads outputLanguage from the shared store and passes it through.
let outputLanguage = "auto"

beforeEach(() => {
  outputLanguage = "auto"
})

// Build the directive the builders receive, mirroring how the client's
// internal languageRule(sourceContent) call resolved it.
const directive = (sourceContent = "") => languageRule(outputLanguage, sourceContent)

describe("buildAnalysisPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    outputLanguage = "Chinese"
    const prompt = buildAnalysisPrompt(directive("english source content"), "purpose", "index")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses user setting even when source is in a different language", () => {
    outputLanguage = "Japanese"
    const prompt = buildAnalysisPrompt(directive("这段内容是中文"), "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Chinese")
  })

  it("auto mode falls back to detecting source content language", () => {
    outputLanguage = "auto"
    const prompt = buildAnalysisPrompt(directive("これは日本語の文章です"), "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })

  it("auto mode with empty source defaults to English", () => {
    outputLanguage = "auto"
    const prompt = buildAnalysisPrompt(directive(""), "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("contains structural analysis sections", () => {
    const prompt = buildAnalysisPrompt(directive(""), "", "")
    expect(prompt).toContain("## Key Entities")
    expect(prompt).toContain("## Key Concepts")
    expect(prompt).toContain("## Main Arguments & Findings")
    expect(prompt).toContain("## Recommendations")
  })

  it("requires claims to stay attached to their named subject", () => {
    const prompt = buildAnalysisPrompt(directive(""), "", "")
    expect(prompt).toContain("Which named subject is each claim about")
    expect(prompt).toContain("Do not transfer claims, limits, or evaluations")
  })

  it("injects the project schema so analysis can recommend custom-typed pages", () => {
    const schema = "## Page Types\n| goal | wiki/goals/ | Outcomes |\n| habit | wiki/habits/ | Behaviours |"
    const prompt = buildAnalysisPrompt(directive(""), "", "", schema)
    expect(prompt).toContain("## Project Schema")
    expect(prompt).toContain("wiki/goals/")
    // Recommendations guidance must mention schema-defined types
    expect(prompt).toContain("goal, habit")
  })

  it("omits the schema section when no schema is provided", () => {
    const prompt = buildAnalysisPrompt(directive(""), "", "")
    expect(prompt).not.toContain("## Project Schema")
  })

  it("does not invent schema content not present in the source", () => {
    const prompt = buildAnalysisPrompt(directive(""), "", "", "| goal | wiki/goals/ | x |")
    expect(prompt).toContain("never invent")
  })
})

describe("ingest warning log formatting", () => {
  it("records all warnings with timestamp and source identity", () => {
    const entry = formatIngestWarningLogEntry(
      "book.pdf",
      ["FILE block was truncated", "Aggregate repair failed"],
      new Date("2026-06-30T01:02:03.000Z"),
    )

    expect(entry).toContain("## 2026-06-30T01:02:03.000Z | book.pdf")
    expect(entry).toContain("1. FILE block was truncated")
    expect(entry).toContain("2. Aggregate repair failed")
  })
})

describe("buildGenerationPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    outputLanguage = "Chinese"
    const prompt = buildGenerationPrompt(directive(), "schema", "purpose", "index", "source.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("honors Vietnamese setting", () => {
    outputLanguage = "Vietnamese"
    const prompt = buildGenerationPrompt(directive(), "", "", "", "file.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Vietnamese")
  })

  it("auto mode detects from source content", () => {
    outputLanguage = "auto"
    const prompt = buildGenerationPrompt(directive("这是中文源文档内容"), "", "", "", "file.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("includes the source filename in output instructions", () => {
    const prompt = buildGenerationPrompt(directive(), "", "", "", "my-paper.pdf")
    expect(prompt).toContain("my-paper.pdf")
  })

  it("tells the model to keep generated filenames aligned with the output language", () => {
    outputLanguage = "Chinese"
    const prompt = buildGenerationPrompt(directive(), "", "", "", "source.pdf")

    expect(prompt).toContain("Derive filenames from the page title in the mandatory output language")
    expect(prompt).toContain("keep readable CJK characters in the filename")
  })

  it("preserves technical proper nouns instead of translating them into the output language", () => {
    outputLanguage = "Chinese"
    const prompt = buildGenerationPrompt(directive(), "", "", "", "source.pdf")

    expect(prompt).toContain("proper nouns and technical identifiers take precedence")
    expect(prompt).toContain("GPT-5")
    expect(prompt).toContain("Transformer")
    expect(prompt).toContain("standard original form")
    expect(prompt).toContain("Do not put raw URLs, citation strings, or full paper titles directly into file paths")
    expect(prompt).toContain("technical terms with no widely-used localized equivalent")
    expect(prompt).not.toContain("No exceptions — not even for page names")
  })

  it("tells generation to preserve subject and source boundaries", () => {
    const prompt = buildGenerationPrompt(directive(), "", "", "", "source.pdf")

    expect(prompt).toContain("Preserve subject boundaries")
    expect(prompt).toContain("Do not merge or generalize a claim about one subject into another subject's page")
    expect(prompt).toContain("cite which source/frontmatter `sources` entry supports that statement")
  })

  it("makes project schema routing authoritative over default entity and concept folders", () => {
    const prompt = buildGenerationPrompt(
      directive(),
      "Use wiki/people/ for people. Use wiki/technologies/ for technical methods.",
      "",
      "",
      "source.pdf",
    )
    expect(prompt).toContain("## Project Schema and Routing (AUTHORITATIVE)")
    expect(prompt).toContain("write pages into those schema-defined folders")
    expect(prompt).toContain("frontmatter type must match the schema directory")
    expect(prompt).toContain("otherwise use wiki/entities/")
    expect(prompt).not.toContain("Entity pages in wiki/entities/ for key entities")
  })

  it("respects user setting regardless of source content language", () => {
    outputLanguage = "English"
    const prompt = buildGenerationPrompt(directive("私は日本語の文章を書きます"), "", "", "", "x.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Japanese")
  })

  it("repeats the language directive at the end of the prompt", () => {
    outputLanguage = "Chinese"
    const prompt = buildGenerationPrompt(directive(), "", "", "", "source.pdf")
    const idx = prompt.lastIndexOf("MANDATORY OUTPUT LANGUAGE: Chinese")
    // Once near the top, once in the trailing repeat — matches the client's
    // "most recent instruction" tie-breaker.
    expect(prompt.indexOf("MANDATORY OUTPUT LANGUAGE: Chinese")).toBeGreaterThanOrEqual(0)
    expect(idx).toBeGreaterThan(prompt.indexOf("## Output Format"))
  })
})

describe("analysis + generation prompt consistency", () => {
  // Both stages MUST declare the same target language — otherwise the wiki
  // files generated in stage 2 may disagree with the analysis from stage 1.
  it("both stages declare the same language for a given setting", () => {
    outputLanguage = "Korean"
    const analysis = buildAnalysisPrompt(directive(), "", "")
    const generation = buildGenerationPrompt(directive(), "", "", "", "f.pdf")
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("both stages in auto mode agree on detected language from source", () => {
    outputLanguage = "auto"
    const korean = "이것은 한국어 문장입니다"
    const analysis = buildAnalysisPrompt(directive(korean), "", "")
    const generation = buildGenerationPrompt(directive(korean), "", "", "", "f.pdf")
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })
})

describe("page merge prompt", () => {
  it("keeps comparisons attribution-exact instead of folding them into the main subject", () => {
    const prompt = buildPageMergeSystemPrompt()
    expect(prompt).toContain("Both versions target the same wiki page")
    expect(prompt).toContain("may mention additional subjects for comparison or context")
    expect(prompt).toContain("keep those comparisons attribution-exact")
    expect(prompt).toContain("do not fold them into claims about the main page subject")
    expect(prompt).toContain("prefer keeping them separate")
    expect(prompt).not.toContain("describe the same entity")
  })
})

describe("long-source ingest planning", () => {
  it("scales generation output tokens with the configured context window", () => {
    expect(computeIngestGenerationMaxTokens(64_000)).toBe(8_192)
    expect(computeIngestGenerationMaxTokens(128_000)).toBe(16_384)
    expect(computeIngestGenerationMaxTokens(256_000)).toBe(24_576)
    expect(computeIngestGenerationMaxTokens(1_000_000)).toBe(32_768)
    expect(computeIngestReviewMaxTokens(1_000_000)).toBe(8_192)
  })

  it("scales source budget from the configured context window instead of a fixed 50k cap", () => {
    const small = computeIngestSourceBudget(64_000, 8_000)
    const large = computeIngestSourceBudget(1_000_000, 8_000)

    expect(small).toBeGreaterThan(20_000)
    expect(large).toBeGreaterThan(200_000)
    expect(large).toBeLessThanOrEqual(300_000)
  })

  it("splits long sources on heading and paragraph boundaries with overlap", () => {
    const content = [
      "# Chapter One",
      "",
      "A".repeat(1200),
      "",
      "B".repeat(1200),
      "",
      "## Section Two",
      "",
      "C".repeat(1200),
      "",
      "D".repeat(1200),
    ].join("\n")

    const chunks = splitSourceIntoSemanticChunks(content, 1800, 200)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].headingPath).toBe("Chapter One")
    expect(chunks.some((chunk) => chunk.headingPath.includes("Section Two"))).toBe(true)
    expect(chunks[1].overlapBefore.length).toBeGreaterThan(0)
    expect(chunks[1].main.startsWith(chunks[0].main.slice(-200))).toBe(false)
  })
})

// ── Server-suite additions for builders the client test file doesn't cover ──

describe("languageRule directive building", () => {
  it("explicit outputLanguage wins over source detection", () => {
    const rule = languageRule("English", "これは日本語の文章です")
    expect(rule).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(rule).not.toContain("OUTPUT LANGUAGE: Japanese")
  })

  it("auto mode detects CJK source languages", () => {
    expect(languageRule("auto", "이것은 한국어 문장입니다")).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(languageRule("auto", "これはひらがなの文です")).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(languageRule("auto", "这是中文的内容")).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("auto mode with no signal defaults to English", () => {
    expect(languageRule("auto", "")).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(languageRule(undefined, "")).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("uses localized prompt names from the language metadata", () => {
    expect(languageRule("Arabic", "")).toContain("MANDATORY OUTPUT LANGUAGE: Arabic / العربية")
    expect(languageRule("Persian", "")).toContain("MANDATORY OUTPUT LANGUAGE: Persian (Farsi / فارسی)")
    expect(languageRule("Czech", "")).toContain("MANDATORY OUTPUT LANGUAGE: Czech / čeština")
  })

  it("passes through languages without metadata entries", () => {
    // Vietnamese has no LANGUAGE_METADATA entry — promptName falls back to
    // the language name itself, same as the client.
    expect(languageRule("Vietnamese", "")).toContain("MANDATORY OUTPUT LANGUAGE: Vietnamese")
    expect(languageRule("Vietnamese", "")).toContain("Write surrounding natural-language prose in **Vietnamese**.")
  })
})

describe("buildReviewSuggestionPrompt", () => {
  it("carries the directive, review template, and capped context sections", () => {
    outputLanguage = "Chinese"
    const longAnalysis = "分析".repeat(20_000) // 40k chars > sectionCap for default ctx
    const prompt = buildReviewSuggestionPrompt(
      directive(),
      "my purpose",
      "my index",
      "raw/sources/doc.pdf",
      longAnalysis,
      "source context",
      "generation output",
      undefined,
    )
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
    expect(prompt).toContain("high-value follow-up research items")
    expect(prompt).toContain("---REVIEW: suggestion | Precise title---")
    expect(prompt).toContain("## Wiki Purpose\nmy purpose")
    expect(prompt).toContain("## Current Wiki Index\nmy index")
    expect(prompt).toContain("## Source\nraw/sources/doc.pdf")
    expect(prompt).toContain("[...trimmed for prompt budget...]")
    // Short sections pass through untrimmed.
    expect(prompt).toContain("## Source Context\nsource context")
    expect(prompt).toContain("## Generated Wiki Output\ngeneration output")
  })

  it("omits empty purpose and index sections", () => {
    const prompt = buildReviewSuggestionPrompt(
      languageRule("English", ""),
      "",
      "",
      "doc.pdf",
      "analysis",
      "context",
      "output",
      undefined,
    )
    expect(prompt).not.toContain("## Wiki Purpose")
    expect(prompt).not.toContain("## Current Wiki Index")
  })
})

describe("buildTruncatedFileRepairPrompt + filterTruncatedFileRepairOutput", () => {
  it("lists requested paths, source identity, and caps context sections", () => {
    const prompt = buildTruncatedFileRepairPrompt(
      languageRule("English", ""),
      ["wiki/concepts/alpha.md", "wiki/entities/beta.md"],
      "raw/sources/big.pdf",
      {
        schema: "schema text",
        purpose: "purpose text",
        analysis: "a".repeat(30_000), // exceeds sectionCap at default ctx (24576)
        sourceContext: "context body",
        maxContextSize: undefined,
      },
    )
    expect(prompt).toContain("- wiki/concepts/alpha.md")
    expect(prompt).toContain("- wiki/entities/beta.md")
    expect(prompt).toContain("## Source identity\nraw/sources/big.pdf")
    expect(prompt).toContain("## Project schema\nschema text")
    expect(prompt).toContain("## Wiki purpose\npurpose text")
    expect(prompt).toContain("## Source context\ncontext body")
    expect(prompt).toContain("[...trimmed for prompt budget...]")
  })

  it("omits schema/purpose sections when empty", () => {
    const prompt = buildTruncatedFileRepairPrompt(
      languageRule("English", ""),
      ["wiki/concepts/alpha.md"],
      "doc.pdf",
      { schema: "", purpose: "", analysis: "an", sourceContext: "sc", maxContextSize: undefined },
    )
    expect(prompt).not.toContain("## Project schema")
    expect(prompt).not.toContain("## Wiki purpose")
  })

  it("keeps only requested FILE blocks and reports drops and duplicates", () => {
    const repairOutput = [
      "---FILE: wiki/concepts/alpha.md---",
      "alpha body",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/unrequested.md---",
      "should be dropped",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/alpha.md---",
      "duplicate body",
      "---END FILE---",
    ].join("\n")

    const result = filterTruncatedFileRepairOutput(repairOutput, ["wiki/concepts/alpha.md"])

    expect(result.paths).toEqual(["wiki/concepts/alpha.md"])
    expect(result.text).toBe("---FILE: wiki/concepts/alpha.md---\nalpha body\n---END FILE---")
    expect(result.warnings.some((w) =>
      w.startsWith("Dropped 1 unrequested FILE block(s) from truncated repair output: wiki/concepts/unrequested.md"),
    )).toBe(true)
    expect(result.warnings.some((w) =>
      w.startsWith("Dropped 1 duplicate FILE block(s) from truncated repair output: wiki/concepts/alpha.md"),
    )).toBe(true)
  })

  it("normalizes backslash paths when matching allowed paths", () => {
    const repairOutput = [
      "---FILE: wiki/entities/beta.md---",
      "beta body",
      "---END FILE---",
    ].join("\n")
    const result = filterTruncatedFileRepairOutput(repairOutput, ["wiki\\entities\\beta.md"])
    expect(result.paths).toEqual(["wiki/entities/beta.md"])
    expect(result.warnings.filter((w) => w.startsWith("Dropped"))).toEqual([])
  })
})

describe("chunk analysis prompts", () => {
  it("buildChunkAnalysisSystemPrompt carries the directive and stable context", () => {
    outputLanguage = "Japanese"
    const prompt = buildChunkAnalysisSystemPrompt(directive(), "purpose text", "schema text", "index text")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(prompt).toContain("Analyze only the current MAIN CHUNK")
    expect(prompt).toContain("## Chunk Analysis")
    expect(prompt).toContain("## Updated Global Digest")
    expect(prompt).toContain("## Wiki Purpose\npurpose text")
    expect(prompt).toContain("## Wiki Schema\nschema text")
    expect(prompt).toContain("## Current Wiki Index\nindex text")
  })

  it("buildChunkAnalysisSystemPrompt omits empty stable-context sections", () => {
    const prompt = buildChunkAnalysisSystemPrompt(languageRule("English", ""), "", "", "")
    expect(prompt).not.toContain("## Wiki Purpose")
    expect(prompt).not.toContain("## Wiki Schema")
    expect(prompt).not.toContain("## Current Wiki Index")
  })

  it("buildChunkAnalysisUserPrompt formats chunk position, digest, and overlap", () => {
    const chunk = {
      id: "chunk-2",
      index: 2,
      total: 5,
      headingPath: "Part One > Details",
      overlapBefore: "overlap tail",
      main: "main chunk body",
    }
    const prompt = buildChunkAnalysisUserPrompt("raw/sources/long.pdf", "papers/energy", chunk, "prior digest")
    expect(prompt).toContain("Source file: raw/sources/long.pdf")
    expect(prompt).toContain("Folder context: papers/energy")
    expect(prompt).toContain("Chunk: 2/5")
    expect(prompt).toContain("Heading path: Part One > Details")
    expect(prompt).toContain("## Current Global Digest\nprior digest")
    expect(prompt).toContain("## Previous Overlap Context\noverlap tail")
    expect(prompt).toContain("## MAIN CHUNK TO ANALYZE\nmain chunk body")
  })

  it("buildChunkAnalysisUserPrompt falls back when digest and optional fields are absent", () => {
    const chunk = {
      id: "chunk-1",
      index: 1,
      total: 3,
      headingPath: "",
      overlapBefore: "",
      main: "first chunk",
    }
    const prompt = buildChunkAnalysisUserPrompt("doc.pdf", undefined, chunk, "")
    expect(prompt).toContain("(No prior digest yet.)")
    expect(prompt).not.toContain("Folder context:")
    expect(prompt).not.toContain("Heading path:")
    expect(prompt).not.toContain("## Previous Overlap Context")
  })
})
