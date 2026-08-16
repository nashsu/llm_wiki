import { describe, expect, it } from "vitest"
import { IngestCommitCoordinator } from "@/lib/ingest-commit-coordinator"

describe("IngestCommitCoordinator", () => {
  it("commits in reservation order even when preparation finishes out of order", async () => {
    const coordinator = new IngestCommitCoordinator()
    const first = coordinator.reserve()
    const second = coordinator.reserve()
    const events: string[] = []
    let finishFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve
    })

    const secondCommit = second.runCommit(async () => {
      events.push("second")
    })
    const firstCommit = first.runCommit(async () => {
      events.push("first:start")
      await firstGate
      events.push("first:end")
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(["first:start"])
    finishFirst()
    await Promise.all([firstCommit, secondCommit])
    expect(events).toEqual(["first:start", "first:end", "second"])
  })

  it("allows later commits to proceed when an earlier task fails before commit", async () => {
    const coordinator = new IngestCommitCoordinator()
    const failedPreparation = coordinator.reserve()
    const next = coordinator.reserve()
    const events: string[] = []

    failedPreparation.release()
    await next.runCommit(async () => {
      events.push("next")
    })

    expect(events).toEqual(["next"])
  })

  it("releases a turn when the commit operation rejects", async () => {
    const coordinator = new IngestCommitCoordinator()
    const first = coordinator.reserve()
    const second = coordinator.reserve()

    await expect(first.runCommit(async () => {
      throw new Error("write failed")
    })).rejects.toThrow("write failed")
    await expect(second.runCommit(async () => "ok")).resolves.toBe("ok")
  })
})
