# Add 2 default custom model options (runtime-configurable profiles)

**Status:** Implemented. Branch: current `main` worktree (kept local).

**Goal:** In Settings → LLM provider configuration, provide **2 customizable
model slots** so the user can switch between custom models with a single click
instead of re-editing the Endpoint + model name each time — while keeping the
Endpoint and model values **entered by the user at runtime** (no hardcoded
private endpoints in the build).

---

## Context / why this shape

Two rounds of design were considered and the user chose the second:

1. **Round 1 (superseded):** Two more *curated* presets (通义千问 Qwen +
   腾讯混元 Hunyuan) hardcoded into `LLM_PRESETS`. Rejected by the user —
   they wanted to provide their own Endpoint/model at runtime, not use
   baked-in public gateways. Reverted.
2. **Round 2 (implemented):** Seed **2 default custom profiles** shown in the
   picker as empty, ready-to-configure slots. The user fills Endpoint, model,
   API key and API mode per slot in Settings; each slot persists its own
   values (`providerConfigs[id]`), so switching between them is instant.

The app already had a mature custom-profiles subsystem (up to 50 named
profiles, each remembering Endpoint/model/key/API-mode, wired through
`resolveConfig`, task routing and project overrides). This design just makes
two such slots appear by default — no new subsystem.

## Current code (audit)

- `src/stores/wiki-store.ts` — `customLlmPresets: CustomLlmPreset[]` (list of
  `{ id, label }`); per-profile config lives in `providerConfigs[id]`
  (`ProviderOverride`).
- `src/lib/project-store.ts` — `saveCustomLlmPresets` /
  `loadCustomLlmPresets`; `normalizeCustomLlmPresets` validates ids against
  `/^custom-[A-Za-z0-9-]{1,80}$/`.
- `src/App.tsx` — boot hydration sets `customLlmPresets` from storage
  (effect #1) and applies the saved UI language (`i18n.changeLanguage`,
  effect #2).
- `src/components/settings/llm-presets.ts` — `availableLlmPresets()` merges
  curated `LLM_PRESETS` + user custom presets for every dropdown.
- `src/components/settings/sections/llm-provider-section.tsx` — renders each
  preset as a row; custom profiles (id starts `custom-`) expose rename/delete
  and a free-form Endpoint panel.

## Design

### 1. Seeding (two default slots)

New helper `defaultCustomLlmPresets()` in
`src/components/settings/llm-presets.ts`:

```ts
export function defaultCustomLlmPresetLabel(number: number): string {
  return i18n.t("settings.sections.llm.customProfiles.defaultName", { number })
}
export function defaultCustomLlmPresets(): CustomLlmPreset[] {
  return [
    { id: "custom-default-1", label: defaultCustomLlmPresetLabel(1) },
    { id: "custom-default-2", label: defaultCustomLlmPresetLabel(2) },
  ]
}
```

- No Endpoint / model in code — these are placeholders the user configures at
  runtime (matches "我自己运行的时候再来添加具体的 Endpoint 和模型名").
- Ids satisfy `normalizeCustomLlmPresets`'s `custom-` regex, so the settings
  UI and persistence treat them as ordinary user profiles.
- Labels reuse the existing `settings.sections.llm.customProfiles.defaultName`
  key → "自定义 Provider 1/2" (zh) / "Custom provider 1/2" (en).

### 2. Seeding rule (in-memory, first-run only)

In `src/App.tsx` effect #2, right after `i18n.changeLanguage(savedLang)`:

```ts
const storedCustomPresets = await loadCustomLlmPresetsStored()
const currentPresets = useWikiStore.getState().customLlmPresets
if (storedCustomPresets == null && currentPresets.length === 0) {
  useWikiStore.getState().setCustomLlmPresets(defaultCustomLlmPresets())
}
```

- `loadCustomLlmPresetsStored()` (`src/lib/project-store.ts`) returns the raw
  persisted value so boot can tell **never saved** (`null`/`undefined`) from
  **explicitly emptied** (`[]`).
- Seed only when never saved → a fresh/existing install that hasn't touched
  the feature shows the 2 slots; deleting every profile saves `[]` and is
  respected (no re-seeding / no resurrection).
- Not persisted at seed time: any add/rename/delete from Settings persists the
  full list and takes over; a user who configures slots without renaming is
  re-seeded with the same ids each launch, so the values saved under
  `providerConfigs["custom-default-N"]` still resolve.
- Labels are computed after `i18n.changeLanguage`, so they use the active UI
  language.

### 3. Runtime flow (already working, no changes)

- Expand a seeded profile → fill **Endpoint** + **模型名** (+ API Key / API
  模式 if needed) → saved to `providerConfigs[id]`.
- Switch rows / toggle active → `resolveConfig` restores the saved Endpoint +
  model instantly. No re-typing.

## Tests

`src/components/settings/preset-resolver.test.ts`:
- removes the two Round-1 curated-preset tests;
- adds `describe("defaultCustomLlmPresets")`:
  1. seeds exactly two profiles with ids `custom-default-1/2`, each matching
     the `custom-` persistence regex with a non-empty label;
  2. labels equal `defaultCustomLlmPresetLabel(1)/`(2)` and are distinct.

## Non-goals

- No hardcoded private Endpoints / model names in the build.
- No curated preset added for Qwen/Hunyuan (Round 1 reverted).
- No changes to dispatch (`llm-providers.ts`), the `Provider` union, task
  routing, or the settings-UI editing surface.

## Rollout / verification

- `npm run typecheck`
- `npm run test:mocks`
- Manual (dev): fresh state → Settings → LLM shows "自定义 Provider 1/2";
  configure Endpoint/model per slot; toggle between them without re-editing.
- Commit locally with a `feat:` message; **never push** per repo instructions.
