import { describe, expect, it, vi } from "vitest"
const storage = vi.hoisted(() => ({ set: vi.fn(), save: vi.fn() }))
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => storage) }))
import { saveImportedModelProfile, saveProviderConfigs } from "./project-store"

describe("model profile persistence boundary", () => {
  it("registers only providers and presets, then flushes without activation", async () => {
    storage.set.mockReset().mockResolvedValue(undefined)
    storage.save.mockReset().mockResolvedValue(undefined)
    await saveImportedModelProfile([{id:"custom-profile-1-p-r",label:"p"}],{
      "custom-profile-1-p-r":{apiKey:"",model:"m",baseUrl:"https://example.test/v1",apiMode:"chat_completions"},
    })
    expect(storage.set.mock.calls.map(call=>call[0])).toEqual(["providerConfigs","customLlmPresets"])
    expect(storage.save).toHaveBeenCalledTimes(1)
  })
  it("propagates a write failure and allows a subsequent retry", async () => {
    storage.set.mockReset().mockRejectedValueOnce(new Error("disk error")).mockResolvedValue(undefined)
    storage.save.mockReset().mockResolvedValue(undefined)
    await expect(saveProviderConfigs({})).rejects.toThrow("disk error")
    await expect(saveImportedModelProfile([],{})).resolves.toBeUndefined()
    expect(storage.save).toHaveBeenCalledTimes(1)
  })
})
