import { beforeEach, describe, expect, it } from "vitest"
import { useAppDialog, useAppDialogStore } from "./app-dialog-store"

describe("app dialog store", () => {
  beforeEach(() => {
    useAppDialogStore.setState({ current: null, queue: [] })
  })

  it("queues dialogs and resolves them in order", async () => {
    const dialogs = useAppDialog()
    const first = dialogs.confirm({ message: "first" })
    const second = dialogs.confirm({ message: "second" })

    expect(useAppDialogStore.getState().current?.message).toBe("first")
    expect(useAppDialogStore.getState().queue).toHaveLength(1)

    const firstId = useAppDialogStore.getState().current!.id
    useAppDialogStore.getState().settle(firstId, true)
    await expect(first).resolves.toBe(true)
    expect(useAppDialogStore.getState().current?.message).toBe("second")

    useAppDialogStore.getState().settle(useAppDialogStore.getState().current!.id, false)
    await expect(second).resolves.toBe(false)
    expect(useAppDialogStore.getState().current).toBeNull()
  })

  it("resolves alerts after dismissal", async () => {
    const pending = useAppDialog().alert({ message: "notice" })
    useAppDialogStore.getState().settle(useAppDialogStore.getState().current!.id, false)
    await expect(pending).resolves.toBeUndefined()
  })

  it("ignores stale events from the previous dialog", async () => {
    const dialogs = useAppDialog()
    const first = dialogs.confirm({ message: "first" })
    const second = dialogs.confirm({ message: "second" })
    const firstId = useAppDialogStore.getState().current!.id

    useAppDialogStore.getState().settle(firstId, true)
    useAppDialogStore.getState().settle(firstId, true)

    await expect(first).resolves.toBe(true)
    expect(useAppDialogStore.getState().current?.message).toBe("second")
    expect(useAppDialogStore.getState().queue).toHaveLength(0)
    useAppDialogStore.getState().settle(useAppDialogStore.getState().current!.id, false)
    await expect(second).resolves.toBe(false)
  })
})
