/**
 * Continuous/recurring research mode.
 *
 * Periodically checks for due recurring tasks, runs them via the existing
 * deep-research pipeline, and creates review items when results differ
 * significantly from the previous run.
 */

import { queueResearch } from "./deep-research"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"

/** How often the scheduler wakes up to check for due tasks (1 hour). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000

let timerHandle: ReturnType<typeof setInterval> | null = null

/**
 * Start the recurring-research scheduler for the given project.
 * Safe to call multiple times — calling again simply resets the timer.
 */
export function startRecurringResearch(projectPath: string): void {
  stopRecurringResearch()
  console.log("[recurring-research] scheduler started")

  // Run the first check immediately, then on the interval.
  tick(projectPath).catch((err) =>
    console.warn("[recurring-research] initial tick failed:", err),
  )

  timerHandle = setInterval(() => {
    tick(projectPath).catch((err) =>
      console.warn("[recurring-research] tick failed:", err),
    )
  }, CHECK_INTERVAL_MS)
}

/** Stop the recurring-research scheduler. */
export function stopRecurringResearch(): void {
  if (timerHandle !== null) {
    clearInterval(timerHandle)
    timerHandle = null
    console.log("[recurring-research] scheduler stopped")
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function tick(projectPath: string): Promise<void> {
  const { recurringTasks } = useResearchStore.getState()
  const now = Date.now()

  for (const task of recurringTasks) {
    if (!task.enabled) continue

    const lastRun = task.lastRunAt ?? 0
    if (now - lastRun < task.intervalMs) continue

    await executeRecurringTask(projectPath, task)
  }
}

async function executeRecurringTask(
  projectPath: string,
  recurring: import("@/stores/research-store").RecurringResearchTask,
): Promise<void> {
  const { llmConfig, searchApiConfig } = useWikiStore.getState()

  // Skip if search is not configured.
  if (searchApiConfig.provider === "none" || !searchApiConfig.apiKey) return

  console.log(`[recurring-research] running task: ${recurring.topic}`)

  const taskId = queueResearch(
    projectPath,
    recurring.topic,
    llmConfig,
    searchApiConfig,
    recurring.searchQueries,
  )

  // Poll until the task reaches a terminal state.
  await waitForTaskCompletion(taskId)

  const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
  if (!task || task.status !== "done" || !task.synthesis) return

  const previousSummary = recurring.lastResultSummary

  // Update the recurring task with the new result summary.
  const newSummary = task.synthesis.slice(0, 500)
  useResearchStore.getState().updateRecurringTaskLastRun(recurring.id, newSummary)

  // If there was a previous run, compare and surface differences.
  if (previousSummary) {
    try {
      const hasDiff = await detectSignificantDifference(
        llmConfig,
        recurring.topic,
        previousSummary,
        newSummary,
      )
      if (hasDiff) {
        useReviewStore.getState().addItems([
          {
            type: "suggestion",
            title: `Research Update: ${recurring.topic}`,
            description: `New information detected for "${recurring.topic}". The latest research synthesis differs from the previous run. Review the updated research page to incorporate new findings.`,
            searchQueries: recurring.searchQueries ?? [recurring.topic],
            options: [
              { label: "View Research", action: "view-research" },
              { label: "Dismiss", action: "dismiss" },
            ],
          },
        ])
        console.log(`[recurring-research] significant diff detected for: ${recurring.topic}`)
      }
    } catch (err) {
      console.warn("[recurring-research] diff comparison failed:", err)
    }
  }
}

/**
 * Wait for a research task to reach "done" or "error" status.
 * Polls every 2 seconds with a 10-minute timeout.
 */
function waitForTaskCompletion(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const timeout = 10 * 60 * 1000
    const intervalMs = 2000
    const start = Date.now()

    const check = () => {
      const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
      if (!task || task.status === "done" || task.status === "error") {
        resolve()
        return
      }
      if (Date.now() - start > timeout) {
        console.warn(`[recurring-research] timed out waiting for task ${taskId}`)
        resolve()
        return
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
}

/**
 * Ask the LLM whether two synthesis summaries differ significantly.
 * Returns true if the LLM says there are meaningful new findings.
 */
async function detectSignificantDifference(
  llmConfig: import("@/stores/wiki-store").LlmConfig,
  topic: string,
  previous: string,
  current: string,
): Promise<boolean> {
  let answer = ""

  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content:
          "You are comparing two research summaries about the same topic. " +
          "Reply with ONLY 'YES' if there are significant differences " +
          "(new facts, changed conclusions, important updates). " +
          "Reply with ONLY 'NO' if the content is substantially the same. " +
          "Do not include any other text.",
      },
      {
        role: "user",
        content:
          `Topic: ${topic}\n\n` +
          `## Previous Summary\n${previous}\n\n` +
          `## Current Summary\n${current}\n\n` +
          `Are there significant differences?`,
      },
    ],
    {
      onToken: (token) => {
        answer += token
      },
      onDone: () => {},
      onError: (err) => {
        throw err
      },
    },
  )

  return answer.trim().toUpperCase().startsWith("Y")
}
