/**
 * Regression test for the project-switch data-loss bug:
 *
 * When switching wiki projects, resetProjectState() empties the review/lint/chat
 * stores. The auto-save subscriptions are debounced, so without a guard their
 * timers fired AFTER the store was cleared but while project?.path still pointed
 * at the OUTGOING project — persisting empty arrays over that project's pending
 * review / deep-research items. Switching back then loaded an emptied review.json.
 *
 * flushAndSuspendAutoSave() must (1) persist the real current state to disk and
 * (2) suspend the subscriptions so the subsequent clear-to-empty does not write.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const { saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences } = vi.hoisted(() => ({
  saveReviewItems: vi.fn().mockResolvedValue(undefined),
  saveLintItems: vi.fn().mockResolvedValue(undefined),
  saveChatHistory: vi.fn().mockResolvedValue(undefined),
  saveChatPreferences: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("./persist", () => ({ saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences }))

import {
  setupAutoSave,
  flushAndSuspendAutoSave,
  resumeAutoSave,
  runWithSuspendedAutoSave,
} from "./auto-save"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"

function setProjectPath(path: string | null): void {
  useWikiStore.setState({ project: path ? ({ id: "p", name: "p", path } as never) : null })
}

function review(id: string): ReviewItem {
  return { id, type: "missing-page", title: id, description: "", options: [], resolved: false, createdAt: 0 }
}

let registered = false

beforeEach(() => {
  saveReviewItems.mockClear()
  saveLintItems.mockClear()
  saveChatHistory.mockClear()
  saveChatPreferences.mockClear()
  useReviewStore.setState({ items: [] })
  useLintStore.setState({ items: [] })
  useChatStore.setState({ conversations: [], messages: [], isStreaming: false })
  resumeAutoSave()
  vi.useFakeTimers()
  // setupAutoSave registers permanent subscriptions; only do it once.
  if (!registered) {
    setupAutoSave()
    registered = true
  }
})

describe("auto-save project-switch guard", () => {
  it("flushes current review state to the outgoing project before suspend", async () => {
    setProjectPath("/proj/A")
    useReviewStore.setState({ items: [review("a1"), review("a2")] })

    await flushAndSuspendAutoSave()

    expect(saveReviewItems).toHaveBeenCalledWith("/proj/A", [review("a1"), review("a2")])
  })

  it("does NOT persist the empty store after suspend (the data-loss bug)", async () => {
    setProjectPath("/proj/A")
    useReviewStore.setState({ items: [review("a1")] })

    await flushAndSuspendAutoSave()
    saveReviewItems.mockClear()
    saveLintItems.mockClear()

    // resetProjectState would do this — clear stores while path is still A.
    useReviewStore.setState({ items: [] })
    useLintStore.setState({ items: [] })
    vi.runAllTimers()

    expect(saveReviewItems).not.toHaveBeenCalled()
    expect(saveLintItems).not.toHaveBeenCalled()
  })

  it("resumes persisting after resumeAutoSave", () => {
    setProjectPath("/proj/B")
    flushAndSuspendAutoSave()
    resumeAutoSave()

    useReviewStore.setState({ items: [review("b1")] })
    vi.runAllTimers()

    expect(saveReviewItems).toHaveBeenCalledWith("/proj/B", [review("b1")])
  })

  it("runs the failure cleanup before resuming auto-save", async () => {
    setProjectPath("/proj/A")
    useReviewStore.setState({ items: [review("a1")] })

    await expect(runWithSuspendedAutoSave(
      async () => {
        throw new Error("open failed")
      },
      () => {
        // This store mutation must still be suppressed. If the helper resumed
        // auto-save before running cleanup, it would schedule an empty write
        // using the old project path captured before setProjectPath(null).
        useReviewStore.setState({ items: [] })
        setProjectPath(null)
      },
    )).rejects.toThrow("open failed")

    saveReviewItems.mockClear()
    saveLintItems.mockClear()
    saveChatHistory.mockClear()
    saveChatPreferences.mockClear()

    // A post-failure store change should not write empty data to the half-opened
    // project because the cleanup cleared the active project before resume.
    useReviewStore.setState({ items: [] })
    useLintStore.setState({ items: [] })
    useChatStore.setState({ conversations: [], messages: [] })
    vi.runAllTimers()

    expect(saveReviewItems).not.toHaveBeenCalled()
    expect(saveLintItems).not.toHaveBeenCalled()
    expect(saveChatHistory).not.toHaveBeenCalled()
    expect(saveChatPreferences).not.toHaveBeenCalled()
  })

  it("skips chat flush while streaming", async () => {
    setProjectPath("/proj/A")
    useChatStore.setState({ isStreaming: true })

    await flushAndSuspendAutoSave()

    expect(saveChatHistory).not.toHaveBeenCalled()
    expect(saveChatPreferences).toHaveBeenCalledWith("/proj/A", {
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
    })
    expect(saveReviewItems).toHaveBeenCalled()
  })

  it("persists chat search preferences on flush", async () => {
    setProjectPath("/proj/A")
    useChatStore.setState({ useWebSearch: true, useAnyTxtSearch: true, agentMode: "local_first" })

    await flushAndSuspendAutoSave()

    expect(saveChatPreferences).toHaveBeenCalledWith("/proj/A", {
      useWebSearch: true,
      useAnyTxtSearch: true,
      agentMode: "local_first",
    })
  })
})
