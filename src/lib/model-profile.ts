import type { CustomLlmPreset, ProviderConfigs } from "@/stores/wiki-store"

/** Standalone configuration contract. Credentials and execution policy never cross this boundary. */
export interface ModelProfile {
  schema_version: 1
  profile_id: string
  revision: string
  protocol: "openai-chat-completions"
  endpoint: string
  model: string
}
const FIELDS = ["schema_version", "profile_id", "revision", "protocol", "endpoint", "model"]
export function parseModelProfile(text: string): ModelProfile {
  if (new TextEncoder().encode(text).length > 16384) throw new Error("Model profile exceeds 16 KB")
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error("Invalid model profile JSON") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model profile")
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== FIELDS.length || Object.keys(v).some(key => !FIELDS.includes(key))) throw new Error("Profile must not contain credentials, headers or extra fields")
  if (v.schema_version !== 1 || v.protocol !== "openai-chat-completions") throw new Error("Unsupported profile version or protocol")
  if (typeof v.profile_id !== "string" || !/^[A-Za-z0-9-]{1,32}$/.test(v.profile_id)
    || typeof v.revision !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v.revision)) throw new Error("Invalid profile identity or revision")
  if (typeof v.model !== "string" || !v.model.trim() || [...v.model].length > 160 || /\p{Cc}/u.test(v.model)) throw new Error("Invalid model name")
  if (typeof v.endpoint !== "string" || v.endpoint.length > 2048) throw new Error("Invalid endpoint")
  let url: URL
  try { url = new URL(v.endpoint) } catch { throw new Error("Invalid endpoint") }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || v.endpoint.includes("?") || v.endpoint.includes("#") || /\/chat\/completions\/?$/.test(url.pathname)) throw new Error("Endpoint must be an HTTP(S) base URL without credentials or query parameters")
  return { schema_version: 1, profile_id: v.profile_id, revision: v.revision, protocol: v.protocol, endpoint: url.href.replace(/\/+$/, ""), model: v.model.trim() }
}

export function prepareModelProfile(profile: ModelProfile, presets: CustomLlmPreset[], configs: ProviderConfigs) {
  // Every revision is a separate immutable preset: never forward an old key to a new host.
  // Length framing prevents profile "a" from inheriting authentication from "a-b".
  const family = `custom-profile-${profile.profile_id.length}-${profile.profile_id}-`
  const id = `${family}${profile.revision.slice(0,16)}`
  const existing = presets.find(p => p.id === id)
  if (existing) {
    const config = configs[id]
    if (config?.baseUrl !== profile.endpoint || config.model !== profile.model || config.apiMode !== "chat_completions") throw new Error("This profile revision already exists with different settings; use a new revision")
    return { id, presets, configs, alreadyImported: true }
  }
  if (configs[id]) throw new Error("Profile identity conflicts with an existing credential record")
  if (presets.length >= 50) throw new Error("Maximum 50 custom model presets")
  // Only reuse this profile's local authentication at the EXACT same endpoint/protocol.
  const local=([...presets].reverse()).find(p=>p.id.startsWith(family)
    && configs[p.id]?.baseUrl===profile.endpoint && configs[p.id]?.apiMode==="chat_completions")
  const auth=local ? configs[local.id] : undefined
  return {
    id,
    presets: [...presets, { id, label: `${profile.profile_id} · ${profile.revision.slice(0,8)}` }],
    configs: { ...configs, [id]: { apiKey: auth?.apiKey??"", customHeaders: {...auth?.customHeaders}, model: profile.model, baseUrl: profile.endpoint, apiMode: "chat_completions" as const } },
    alreadyImported: false,
  }
}
