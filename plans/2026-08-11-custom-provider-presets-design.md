# Add 2 more curated Custom Provider presets (Qwen + Tencent Hunyuan)

**Status:** Approved for implementation. Branch: current `main` worktree (kept local).

**Goal:** In Settings → LLM provider configuration, add two more *built-in
custom-provider* presets — **通义千问 Qwen (阿里云百炼 DashScope)** and
**腾讯混元 (Tencent Hunyuan)** — so the user can switch custom models with a
single dropdown click instead of re-editing the Endpoint + model name each time.

---

## Why these two

The curated drop-down already covers 15+ custom/OpenAI-compatible providers:
DeepSeek, Atlas Cloud, Groq, xAI, NVIDIA NIM, Kimi (global/CN/Coding Plan),
智谱 GLM, MiniMax (global/CN), 阿里百炼 Coding Plan, 小米 MiMo,
火山引擎 Ark, Ollama Cloud, plus a generic **Custom**.

The two most prominent Chinese GPT-class providers still missing are Qwen
(DashScope standard OpenAI-compatible endpoint — only the *Coding Plan* variant
exists today) and Tencent Hunyuan (absent entirely). Both expose stable
OpenAI-compatible `/v1` endpoints, so they map 1:1 onto the existing
`provider: "custom"` + `apiMode: "chat_completions"` wire.

> Note on the user's private/vLLM/one-api use case: that need is **already
> covered** by the existing 添加自定义配置 (custom profiles) feature, which saves
> up to 50 named profiles each remembering its own Endpoint, model, API key and
> API mode. This change only extends the *curated* picker to include two more
> popular public gateways; no new subsystem is introduced.

---

## Current relevant code (audit)

- `src/components/settings/llm-presets.ts` — `LLM_PRESETS: LlmPreset[]`, each
  entry: `{ id, label, hint, provider, baseUrl, defaultModel, apiMode,
  suggestedModels, suggestedContextSize }`.
  - `availableLlmPresets()` merges `LLM_PRESETS` + user custom profiles.
  - `matchPreset()` reverse-lookup already handles `provider === "custom"` by
    comparing normalized `baseUrl` + `apiMode`.
- `src/components/settings/preset-resolver.ts::resolveConfig(preset, override, fallback)`
  — for `provider === "custom"`, builds `LlmConfig` from
  `ov.baseUrl ?? preset.baseUrl`, `ov.model ?? preset.defaultModel`, and
  `ov.apiMode ?? preset.apiMode`. **No dispatch changes needed** — new presets
  are pure data.
- `src/components/settings/preset-resolver.test.ts` — unit tests that look up
  presets by `id` (e.g. `deepseek`, `atlascloud`, `xiaomi-mimo`); pattern to
  extend.
- `Provider` union in `llm-presets.ts` — both new presets use the existing
  `"custom"` member. **No type changes.**

## Design

Append two entries to `LLM_PRESETS` (after `volcengine-ark`, before
`ollama-local`) :

### 1. Qwen — 阿里云百炼 DashScope (standard OpenAI-compatible)

```ts
{
  id: "qwen",
  label: "通义千问 Qwen (Bailian)",
  hint: "dashscope.aliyuncs.com/compatible-mode",
  provider: "custom",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultModel: "qwen-max",
  apiMode: "chat_completions",
  // Standard DashScope OpenAI-compatible gateway (unlike the Coding Plan
  // preset which uses coding.dashscope.aliyuncs.com). Key format sk-…
  // from the Model Studio console. Catalog rotates; practical subset below,
  // any id can still be typed into the free-form input.
  suggestedModels: [
    "qwen-max",
    "qwen-plus",
    "qwen-turbo",
    "qwen-long",
    "qwen3-max",
    "qwen3-235b-a22b",
    "qwen3-32b",
  ],
  suggestedContextSize: 131072,
},
```

### 2. Tencent Hunyuan — 腾讯混元

```ts
{
  id: "hunyuan",
  label: "腾讯混元 (Tencent Hunyuan)",
  hint: "api.hunyuan.cloud.tencent.com",
  provider: "custom",
  baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  defaultModel: "hunyuan-turbo",
  apiMode: "chat_completions",
  // Hunyuan's public OpenAI-compatible gateway. Key issued from the
  // TencentCloud / 混元 open platform console. Catalog rotates.
  suggestedModels: [
    "hunyuan-turbo",
    "hunyuan-turbos",
    "hunyuan-pro",
    "hunyuan-standard",
    "hunyuan-lite",
    "hunyuan-k2",
  ],
  suggestedContextSize: 131072,
},
```

### Behavior after the change

- Both appear in every preset dropdown (provider row list, task routing
  Chat/Ingest selects, project override provider select) via
  `availableLlmPresets()` — no UI file changes required.
- Selecting either pre-fills Endpoint + API mode + suggested model chips;
  per-preset overrides (key, model, context) are saved in
  `providerConfigs[id]` and restored on switch.
- `matchPreset()` will correctly reverse-match these two when the user is on
  their exact `baseUrl` + `chat_completions` wire.
- Default `Custom` catch-all and the 添加自定义配置 feature are untouched.

## Tests

Extend `src/components/settings/preset-resolver.test.ts`:

1. Resolving `qwen` → `LlmConfig` has `provider: "custom"`,
   `customEndpoint === "https://dashscope.aliyuncs.com/compatible-mode/v1"`,
   default model `qwen-max`, `apiMode === "chat_completions"`.
2. Resolving `hunyuan` → same assertions with the Hunyuan URL / model.
3. `availableLlmPresets()` contains both new ids.

No i18n changes (preset labels are plain strings, consistent with existing
presets). No README change (README does not enumerate the curated providers).

## Non-goals

- No private-endpoint presets hardcoded (that stays a user
  添加自定义配置 concern).
- No dispatch/wire changes; no `Provider` union change.
- No new settings scaffolding.

## Rollout / verification

- `npm run typecheck`
- `npm run test:mocks`
- Manual: dev server → Settings → LLM → two new rows appear and connect-tests
  run against the selected endpoint.
- Commit locally (`feat:`); **never push** per repo instructions.
