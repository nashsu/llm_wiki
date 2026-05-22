/**
 * LLM-as-judge scorer for the eval harness.
 *
 * Scores a model-generated answer against a gold answer on two axes:
 *   correctness (1–5): are the key facts present?
 *   depth      (1–5): are the reasoning and trade-offs explained?
 *
 * Uses the Anthropic Messages API directly via fetch (no SDK dep needed).
 * Set ANTHROPIC_API_KEY in the environment before running.
 */

import type { JudgeScore } from "./datasets/schema.js"

const JUDGE_MODEL = "claude-haiku-4-5-20251001"
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages"

const SYSTEM_PROMPT = `\
You are a strict technical grader evaluating an AI-generated answer against a gold reference answer.

Score on two axes, each 1–5:
- correctness: Does the answer contain the key facts from the gold answer? (1=missing most facts, 5=all key facts present)
- depth: Does the answer explain the underlying reasoning, trade-offs, or mechanisms — not just surface labels? (1=superficial/buzzwords only, 5=clear causal explanation with trade-offs)

Return ONLY a JSON object with no markdown fences:
{"correctness": <1-5>, "depth": <1-5>, "rationale": "<one sentence explaining the scores>"}`

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>
  error?: { message: string }
}

async function callAnthropic(userMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set")

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${text}`)
  }

  const data = (await res.json()) as AnthropicResponse
  if (data.error) throw new Error(`Anthropic error: ${data.error.message}`)
  return data.content[0]?.text ?? ""
}

export async function scoreAnswer(opts: {
  question: string
  goldAnswer: string
  judgeRubric: string
  candidateAnswer: string
}): Promise<JudgeScore> {
  const { question, goldAnswer, judgeRubric, candidateAnswer } = opts

  const prompt = `\
Question: ${question}

Gold answer: ${goldAnswer}

Rubric (key concepts required): ${judgeRubric}

Answer to evaluate:
${candidateAnswer}`

  const raw = await callAnthropic(prompt)

  let parsed: { correctness: number; depth: number; rationale: string }
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new Error(`Judge returned non-JSON: ${raw}`)
  }

  const correctness = Math.min(5, Math.max(1, Math.round(parsed.correctness)))
  const depth = Math.min(5, Math.max(1, Math.round(parsed.depth)))
  return {
    correctness,
    depth,
    overall: (correctness + depth) / 2,
    rationale: parsed.rationale ?? "",
  }
}

export function mcqScore(choice: string, correct: string): JudgeScore {
  const hit = choice.trim().toUpperCase() === correct.trim().toUpperCase()
  return {
    correctness: hit ? 5 : 1,
    depth: hit ? 5 : 1,
    overall: hit ? 5 : 1,
    rationale: hit ? "Correct choice selected." : `Wrong choice: got ${choice}, expected ${correct}.`,
  }
}
