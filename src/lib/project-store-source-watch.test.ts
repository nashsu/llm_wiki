import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => new Map<string, unknown>())
const save = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => storage.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      storage.set(key, value)
    },
    save,
  })),
}))

describe("source watch all-projects persistence", () => {
  beforeEach(() => {
    storage.clear()
    save.mockClear()
  })

  it("defaults off and round-trips the global option", async () => {
    const {
      loadSourceWatchAllProjects,
      saveSourceWatchAllProjects,
    } = await import("./project-store")

    expect(await loadSourceWatchAllProjects()).toBe(false)
    await saveSourceWatchAllProjects(true)
    expect(await loadSourceWatchAllProjects()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)

    await saveSourceWatchAllProjects(false)
    expect(await loadSourceWatchAllProjects()).toBe(false)
  })
})
