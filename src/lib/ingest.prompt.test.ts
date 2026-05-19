import { describe, it, expect, beforeEach } from "vitest"
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildEntityBatchPrompt,
  type AnalysisEntity,
} from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("buildAnalysisPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildAnalysisPrompt("purpose", "index", "english source content")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses user setting even when source is in a different language", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const prompt = buildAnalysisPrompt("", "", "这段内容是中文")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Chinese")
  })

  it("auto mode falls back to detecting source content language", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "これは日本語の文章です")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })

  it("auto mode with empty source defaults to English", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("contains structural analysis sections", () => {
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("## Key Entities")
    expect(prompt).toContain("## Key Concepts")
    expect(prompt).toContain("## Main Arguments & Findings")
    expect(prompt).toContain("## Recommendations")
  })

  it("instructs the model to emit the <entities> manifest block first", () => {
    // Without this manifest the downstream batched-generation
    // pipeline can't tell which entity pages to write per batch
    // and falls back to one giant Generation call. The block must
    // come BEFORE the prose so an output-token cap on long docs
    // truncates the prose tail rather than the manifest.
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("<entities>")
    expect(prompt).toContain("</entities>")
    expect(prompt).toContain('"type":"entity"')
    expect(prompt).toContain('"type":"concept"')
  })
})

describe("buildGenerationPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildGenerationPrompt("schema", "purpose", "index", "source.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("honors Vietnamese setting", () => {
    useWikiStore.getState().setOutputLanguage("Vietnamese")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Vietnamese")
  })

  it("auto mode detects from source content", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf", undefined, "这是中文源文档内容")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("includes the source filename in output instructions", () => {
    const prompt = buildGenerationPrompt("", "", "", "my-paper.pdf")
    expect(prompt).toContain("my-paper.pdf")
  })

  it("respects user setting regardless of source content language", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const prompt = buildGenerationPrompt("", "", "", "x.pdf", undefined, "私は日本語の文章を書きます")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Japanese")
  })
})

describe("buildEntityBatchPrompt", () => {
  const SAMPLE_BATCH: AnalysisEntity[] = [
    { name: "Activity Based Costing", type: "concept" },
    { name: "Cost Accounting", type: "concept" },
    { name: "Prof Kaplan", type: "entity" },
  ]

  it("lists every batch item under its type heading", () => {
    const prompt = buildEntityBatchPrompt("", "", "", "src.pdf", SAMPLE_BATCH)
    expect(prompt).toContain("- Activity Based Costing")
    expect(prompt).toContain("- Cost Accounting")
    expect(prompt).toContain("- Prof Kaplan")
  })

  it("forbids writing source summary / index / log / overview pages", () => {
    // Those are written by the final global Generation call; if a batch
    // emits them they either get discarded or clobber the global write.
    const prompt = buildEntityBatchPrompt("", "", "", "src.pdf", SAMPLE_BATCH)
    expect(prompt).toMatch(/DO NOT write `wiki\/sources/)
    expect(prompt).toMatch(/DO NOT write `wiki\/index\.md`/)
    expect(prompt).toMatch(/DO NOT write `wiki\/log\.md`/)
    expect(prompt).toMatch(/DO NOT write `wiki\/overview\.md`/)
    expect(prompt).toMatch(/DO NOT emit REVIEW blocks/)
  })

  it("includes the source filename in the frontmatter sources requirement", () => {
    const prompt = buildEntityBatchPrompt("", "", "", "my-paper.pdf", SAMPLE_BATCH)
    expect(prompt).toContain("my-paper.pdf")
  })

  it("handles an entity-only batch (concept list shows '(none in this batch)')", () => {
    const prompt = buildEntityBatchPrompt("", "", "", "src.pdf", [
      { name: "Alpha Corp", type: "entity" },
    ])
    expect(prompt).toContain("- Alpha Corp")
    expect(prompt).toContain("(none in this batch)")
  })

  it("respects the user's output language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildEntityBatchPrompt("", "", "", "src.pdf", SAMPLE_BATCH)
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })
})

describe("buildGenerationPrompt — skipContentPages mode", () => {
  // skipContentPages=true is the post-batch path: the model must NOT
  // re-emit entity/concept pages (already written by batches) but
  // still produce source summary / index / log / overview.

  it("default mode lists all 6 outputs including entity/concept pages", () => {
    const prompt = buildGenerationPrompt("", "", "", "src.pdf")
    expect(prompt).toContain("Entity pages in wiki/entities/")
    expect(prompt).toContain("Concept pages in wiki/concepts/")
  })

  it("skip mode renumbers outputs and drops the entity/concept items", () => {
    const prompt = buildGenerationPrompt("", "", "", "src.pdf", undefined, "", true)
    expect(prompt).not.toContain("Entity pages in wiki/entities/")
    expect(prompt).not.toContain("Concept pages in wiki/concepts/")
    expect(prompt).toContain("source summary")
    expect(prompt).toContain("wiki/index.md")
    expect(prompt).toContain("wiki/log.md")
    expect(prompt).toContain("wiki/overview.md")
  })

  it("skip mode includes an explicit DO NOT-write warning for entity/concept paths", () => {
    // Without this warning models occasionally still emit entity pages
    // and overwrite the richer batched output with one-line stubs.
    const prompt = buildGenerationPrompt("", "", "", "src.pdf", undefined, "", true)
    expect(prompt).toMatch(/DO NOT.*entity.*concept/i)
  })

  it("skip mode preserves the language directive", () => {
    useWikiStore.getState().setOutputLanguage("Spanish")
    const prompt = buildGenerationPrompt("", "", "", "src.pdf", undefined, "", true)
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Spanish")
  })
})

describe("analysis + generation prompt consistency", () => {
  // Both stages MUST declare the same target language — otherwise the wiki
  // files generated in stage 2 may disagree with the analysis from stage 1.
  it("both stages declare the same language for a given setting", () => {
    useWikiStore.getState().setOutputLanguage("Korean")
    const analysis = buildAnalysisPrompt("", "", "")
    const generation = buildGenerationPrompt("", "", "", "f.pdf")
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("both stages in auto mode agree on detected language from source", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const korean = "이것은 한국어 문장입니다"
    const analysis = buildAnalysisPrompt("", "", korean)
    const generation = buildGenerationPrompt("", "", "", "f.pdf", undefined, korean)
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })
})
