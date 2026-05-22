export type SkillTag = "factual" | "conceptual" | "cross-doc" | "multi-hop"
export type QuestionType = "freeform" | "mcq"
export type Difficulty = "easy" | "medium" | "hard"

export interface EvalDocument {
  title: string
  /** Public URL to obtain/download the document. Required for open.jsonl records. */
  url?: string
  /** Local path hint relative to the repo root, for repo-only records. */
  localPath?: string
}

export interface EvalRecord {
  id: string
  domain: string
  /** Where the question was sourced from, e.g. "cbdp-assignments", "raft-paper", "hotpotqa" */
  source: string
  type: QuestionType
  difficulty: Difficulty
  skill: SkillTag
  /** Source documents that MUST be ingested into LLM Wiki before running this question. */
  documents: EvalDocument[]
  question: string
  gold_answer: string
  /** Only for type="mcq": four answer choices labelled A–D. */
  mcq_choices?: [string, string, string, string]
  /** Only for type="mcq": the correct choice letter. */
  mcq_correct?: "A" | "B" | "C" | "D"
  /** Rubric for the LLM judge: what concepts must the answer cover to score well. */
  judge_rubric: string
}

export interface JudgeScore {
  correctness: number  // 1–5
  depth: number        // 1–5
  overall: number      // (correctness + depth) / 2
  rationale: string
}

export interface RunResult {
  id: string
  domain: string
  skill: SkillTag
  difficulty: Difficulty
  question: string
  goldAnswer: string
  wikiContext: string   // top-K snippets concatenated
  wikiAnswer: string
  baselineAnswer: string
  wikiScore: JudgeScore
  baselineScore: JudgeScore
  deltaOverall: number  // wikiScore.overall - baselineScore.overall
}
