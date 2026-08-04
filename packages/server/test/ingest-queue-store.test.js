// Tests for the ingest_queue lifecycle ops (issue #14 P0, migration 013).
//
// Pins the orchestrator's data-layer invariants: FIFO claim order, per-project
// serialization (never two processing rows of one project), not_before
// scheduling, attempt accounting, manual retry reset, and boot crash recovery.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-iq-test-"))
process.env.LLM_WIKI_NO_SHARE = "1"

const { getDb } = await import("../src/store/db.js")
const { createProject, deleteProject } = await import("../src/store/projects.js")
const q = await import("../src/store/ingest-queue.js")

getDb() // run migrations (incl. 013) before anything else

let projA, projB
const NOW = 1_000_000_000_000

beforeAll(() => {
  projA = createProject({ name: "A", path: "/tmp/iq-a" })
  projB = createProject({ name: "B", path: "/tmp/iq-b" })
})
afterAll(() => {
  deleteProject(projA.id)
  deleteProject(projB.id)
  rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
})

function enq(projectId, file, folderContext = "") {
  return Number(q.enqueueIngestTask(projectId, file, { folderContext }))
}

describe("ingest queue lifecycle (migration 013)", () => {
  it("migration 013 applied: lifecycle columns exist with defaults", () => {
    const id = enq(projA.id, "raw/sources/m013.md")
    const row = q.getIngestTask(id)
    expect(row.attempt_count).toBe(0)
    expect(row.started_at).toBeNull()
    expect(row.updated_at).not.toBeNull()
    expect(row.not_before).toBe(0)
    expect(row.folder_context).toBe("")
    q.deleteIngestTask(id)
  })

  it("claim is FIFO by id among eligible rows", () => {
    const t1 = enq(projA.id, "raw/sources/f1.md")
    const t2 = enq(projA.id, "raw/sources/f2.md")
    const t3 = enq(projB.id, "raw/sources/f3.md")

    const c1 = q.claimNextIngestTask(NOW)
    expect(c1.id).toBe(t1) // oldest id wins
    expect(c1.status).toBe("processing")
    expect(c1.attempt_count).toBe(1)
    expect(c1.started_at).toBe(NOW)

    // t2 is blocked by t1 (same project) → next claim is t3 (project B).
    const c2 = q.claimNextIngestTask(NOW)
    expect(c2.id).toBe(t3)

    q.completeIngestTask(t1)
    const c3 = q.claimNextIngestTask(NOW)
    expect(c3.id).toBe(t2) // project A unblocked after t1 completed

    q.completeIngestTask(t2)
    q.completeIngestTask(t3)
    expect(q.claimNextIngestTask(NOW)).toBeNull()
  })

  it("per-project serialization: never two processing rows of one project", () => {
    const a1 = enq(projA.id, "raw/sources/s1.md")
    const a2 = enq(projA.id, "raw/sources/s2.md")
    const b1 = enq(projB.id, "raw/sources/s3.md")

    q.claimNextIngestTask(NOW) // a1
    q.claimNextIngestTask(NOW) // b1 (a2 blocked)
    expect(q.claimNextIngestTask(NOW)).toBeNull() // nothing left eligible

    const db = getDb()
    const perProject = db.prepare(`
      SELECT project_id, COUNT(*) AS n FROM ingest_queue
      WHERE status = 'processing' GROUP BY project_id
    `).all()
    for (const r of perProject) expect(r.n).toBe(1)

    q.completeIngestTask(a1)
    q.completeIngestTask(b1)
    const last = q.claimNextIngestTask(NOW)
    expect(last.id).toBe(a2)
    q.completeIngestTask(a2)
  })

  it("not_before defers a task until its time has come", () => {
    const id = enq(projA.id, "raw/sources/backoff.md")
    const row = q.getIngestTask(id)
    q.failIngestTask(id, "quota exceeded", { retryable: true, notBefore: NOW + 900_000 })
    expect(q.getIngestTask(id).status).toBe("pending")

    // Before the backoff expires: not claimable.
    expect(q.claimNextIngestTask(NOW)).toBeNull()
    // After: claimable, and the error message was kept for display.
    const claimed = q.claimNextIngestTask(NOW + 900_001)
    expect(claimed.id).toBe(id)
    expect(row.id).toBe(id)
    q.completeIngestTask(id)
  })

  it("attempt_count increments on every claim and survives retryable failures", () => {
    const id = enq(projA.id, "raw/sources/flaky.md")
    q.claimNextIngestTask(NOW)
    expect(q.getIngestTask(id).attempt_count).toBe(1)
    q.failIngestTask(id, "boom", { retryable: true })
    q.claimNextIngestTask(NOW)
    expect(q.getIngestTask(id).attempt_count).toBe(2)
    q.failIngestTask(id, "boom again", { retryable: false })
    const row = q.getIngestTask(id)
    expect(row.status).toBe("failed")
    expect(row.error).toBe("boom again")
    expect(row.attempt_count).toBe(2) // failed does not claim again
  })

  it("manual retry resets attempts, error, and backoff", () => {
    const id = enq(projA.id, "raw/sources/retry-me.md")
    q.claimNextIngestTask(NOW)
    q.failIngestTask(id, "fatal", { retryable: false })
    expect(q.retryIngestTask(id)).toBe(true)
    const row = q.getIngestTask(id)
    expect(row.status).toBe("pending")
    expect(row.attempt_count).toBe(0)
    expect(row.error).toBeNull()
    expect(row.not_before).toBe(0)
    // retrying a non-failed task is a no-op
    expect(q.retryIngestTask(id)).toBe(false)
    q.claimNextIngestTask(NOW)
    q.completeIngestTask(id)
  })

  it("complete clears the error and sets progress 100", () => {
    const id = enq(projA.id, "raw/sources/done.md")
    q.claimNextIngestTask(NOW)
    q.failIngestTask(id, "temporary", { retryable: true })
    q.claimNextIngestTask(NOW)
    q.completeIngestTask(id)
    const row = q.getIngestTask(id)
    expect(row.status).toBe("completed")
    expect(row.progress).toBe(100)
    expect(row.error).toBeNull()
  })

  it("touchIngestTask persists progress without touching status", () => {
    const id = enq(projA.id, "raw/sources/touch.md")
    q.claimNextIngestTask(NOW)
    q.touchIngestTask(id, 55)
    const row = q.getIngestTask(id)
    expect(row.progress).toBe(55)
    expect(row.status).toBe("processing")
    q.completeIngestTask(id)
  })

  it("crash recovery: processing→pending under the cap, failed at/over the cap", () => {
    const fresh = enq(projA.id, "raw/sources/fresh-crash.md")
    const spent = enq(projA.id, "raw/sources/spent-crash.md")
    q.claimNextIngestTask(NOW) // fresh, attempt 1
    q.failIngestTask(spent, "x", { retryable: true })
    // simulate the spent row reaching the cap, then being claimed again
    getDb().prepare("UPDATE ingest_queue SET attempt_count = 3, status = 'processing' WHERE id = ?").run(spent)

    const { reset, failed } = q.resetInterruptedTasks(3)
    expect(reset).toBe(1)
    expect(failed).toBe(1)
    const freshRow = q.getIngestTask(fresh)
    expect(freshRow.status).toBe("pending")
    expect(freshRow.attempt_count).toBe(1) // preserved, not reset
    const spentRow = q.getIngestTask(spent)
    expect(spentRow.status).toBe("failed")
    expect(spentRow.error).toMatch(/restarted/i)
  })

  it("findLiveIngestTask dedupes pending/processing but ignores terminal rows", () => {
    const id = enq(projA.id, "raw/sources/dedupe.md", "folder/x")
    expect(q.findLiveIngestTask(projA.id, "raw/sources/dedupe.md")?.id).toBe(id)
    expect(q.getIngestTask(id).folder_context).toBe("folder/x")
    q.claimNextIngestTask(NOW)
    expect(q.findLiveIngestTask(projA.id, "raw/sources/dedupe.md")?.id).toBe(id) // processing is live
    q.completeIngestTask(id)
    expect(q.findLiveIngestTask(projA.id, "raw/sources/dedupe.md")).toBeUndefined()
  })
})

describe("deferIngestTaskForUsageLimit (usage limits do not consume attempts)", () => {
  // The crash-recovery test above intentionally leaves a pending row behind;
  // start from a clean queue so claims below are deterministic.
  beforeAll(() => {
    getDb().prepare("DELETE FROM ingest_queue").run()
  })

  it("rolls the claim's attempt increment back and parks the row until not_before", () => {
    const id = enq(projA.id, "raw/sources/usage-1.md")
    q.claimNextIngestTask(NOW) // attempt_count → 1
    expect(q.getIngestTask(id).attempt_count).toBe(1)

    q.deferIngestTaskForUsageLimit(id, "Paused after provider usage limit: quota", NOW + 900_000)
    const row = q.getIngestTask(id)
    expect(row.status).toBe("pending")
    expect(row.attempt_count).toBe(0) // attempt NOT consumed
    expect(row.error).toBe("Paused after provider usage limit: quota")
    expect(row.not_before).toBe(NOW + 900_000)

    // Deferred: not claimable before the backoff, claimable after.
    expect(q.claimNextIngestTask(NOW)).toBeNull()
    const reclaimed = q.claimNextIngestTask(NOW + 900_001)
    expect(reclaimed.id).toBe(id)
    expect(reclaimed.attempt_count).toBe(1)
    q.completeIngestTask(id)
  })

  it("never drives attempt_count below zero when called without a prior claim", () => {
    const id = enq(projA.id, "raw/sources/usage-2.md")
    q.deferIngestTaskForUsageLimit(id, "Paused after provider usage limit: 429", NOW + 60_000)
    const row = q.getIngestTask(id)
    expect(row.attempt_count).toBe(0)
    expect(row.status).toBe("pending")
    q.deleteIngestTask(id)
  })

  it("preserves the attempt accounting across repeated usage-limit pauses", () => {
    const id = enq(projA.id, "raw/sources/usage-3.md")
    q.claimNextIngestTask(NOW) // attempt 1
    q.deferIngestTaskForUsageLimit(id, "pause 1", NOW + 1_000)
    const c2 = q.claimNextIngestTask(NOW + 1_001) // attempt 1 again (rolled back)
    expect(c2.id).toBe(id)
    expect(c2.attempt_count).toBe(1)
    q.deferIngestTaskForUsageLimit(id, "pause 2", NOW + 2_000)
    expect(q.getIngestTask(id).attempt_count).toBe(0)
    // Still fully retryable: a normal retryable failure now consumes attempt 1…
    q.claimNextIngestTask(NOW + 2_001)
    q.failIngestTask(id, "boom", { retryable: true })
    expect(q.getIngestTask(id).attempt_count).toBe(1)
    q.failIngestTask(id, "boom terminal", { retryable: false })
    expect(q.getIngestTask(id).status).toBe("failed")
  })
})
