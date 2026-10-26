import { describe, expect, it } from "vitest"
import { parseModelProfile, prepareModelProfile } from "./model-profile"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { findLlmPreset } from "@/components/settings/llm-presets"
import { useWikiStore } from "@/stores/wiki-store"
const profile = { schema_version: 1, profile_id: "dws-primary", revision: "1234567890abcdef", protocol: "openai-chat-completions", endpoint: "https://gateway.example/v1/", model: "test-model" }
describe("independent model profile import", () => {
  it("imports without credentials, activation or execution policy", () => {
    const p=parseModelProfile(JSON.stringify(profile))
    const result=prepareModelProfile(p, [], {})
    expect(p.endpoint).toBe("https://gateway.example/v1")
    expect(result.configs[result.id].apiKey).toBe("")
    const preset=findLlmPreset(result.id, result.presets)!
    const fallback={...useWikiStore.getState().globalLlmConfig,apiKey:"DO-NOT-INHERIT",customHeaders:{"X-Token":"DO-NOT-INHERIT"}}
    const resolved=resolveConfig(preset,result.configs[result.id],fallback)
    expect(resolved.model).toBe(profile.model)
    expect(resolved.apiKey).toBe("")
    expect(resolved.customHeaders).toEqual({})
    expect(resolved.customEndpoint).toBe(p.endpoint)
    expect(result).not.toHaveProperty("activePresetId")
    expect(result).not.toHaveProperty("taskModelRouting")
  })
  it("is idempotent and keeps existing local credentials", () => {
    const p=parseModelProfile(JSON.stringify(profile)), first=prepareModelProfile(p,[],{})
    first.configs[first.id].apiKey="LOCAL-ONLY"
    const second=prepareModelProfile(p,first.presets,first.configs)
    expect(second.alreadyImported).toBe(true)
    expect(second.configs[second.id].apiKey).toBe("LOCAL-ONLY")
    expect(()=>prepareModelProfile({...p,endpoint:"https://other.example/v1"},first.presets,first.configs)).toThrow(/different settings/)
    const newRevision=prepareModelProfile({...p,revision:"second",endpoint:"https://other.example/v1"},first.presets,first.configs)
    expect(newRevision.configs[newRevision.id].apiKey).toBe("")
    expect(newRevision.configs[first.id].apiKey).toBe("LOCAL-ONLY")
  })
  it("rejects secrets, unsupported contracts, oversized files and endpoint credentials", () => {
    for(const extra of [{api_key:"secret"},{customHeaders:{}},{max_rounds:20},{schema_version:2},{protocol:"anthropic"},{profile_id:"../../p"},{model:"\n"}]) {
      expect(()=>parseModelProfile(JSON.stringify({...profile,...extra}))).toThrow()
    }
    for(const endpoint of ["https://user:secret@host/v1","https://host/v1?token=secret","https://host/v1#secret","file:///tmp","https://host/v1/chat/completions"]) expect(()=>parseModelProfile(JSON.stringify({...profile,endpoint}))).toThrow()
    expect(()=>parseModelProfile(" ".repeat(17000))).toThrow()
    expect(()=>prepareModelProfile(parseModelProfile(JSON.stringify(profile)),Array.from({length:50},(_,i)=>({id:`custom-${i}`,label:"p"})),{})).toThrow(/50/)
  })
  it("reuses only this profile's exact same local endpoint authentication", () => {
    const p=parseModelProfile(JSON.stringify(profile)), first=prepareModelProfile(p,[],{})
    first.configs[first.id].apiKey="LOCAL-ONLY"
    first.configs[first.id].customHeaders={"X-Local":"local"}
    const next=prepareModelProfile({...p,revision:"new-model",model:"new-model"},first.presets,first.configs)
    expect(next.configs[next.id].apiKey).toBe("LOCAL-ONLY")
    expect(next.configs[next.id].customHeaders).not.toBe(first.configs[first.id].customHeaders)
    const unrelated=prepareModelProfile({...p,profile_id:"another"},first.presets,first.configs)
    expect(unrelated.configs[unrelated.id].apiKey).toBe("")
    const prefix=prepareModelProfile({...p,profile_id:"dws"},first.presets,first.configs)
    expect(prefix.configs[prefix.id].apiKey).toBe("")
  })
})
