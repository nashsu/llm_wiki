import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { parseModelProfile, prepareModelProfile, type ModelProfile } from "@/lib/model-profile"
import { saveImportedModelProfile } from "@/lib/project-store"

export function ModelProfileImport() {
  const {t}=useTranslation()
  const [profile,setProfile]=useState<ModelProfile|null>(null)
  const [busy,setBusy]=useState(false)
  const [ready,setReady]=useState(false)
  const [feedback,setFeedback]=useState("")
  const generation=useRef(0)
  const lock=useRef(false)
  useEffect(()=>()=>{generation.current++},[])
  const key="settings.sections.llm.profileImport."
  async function read(file:File) {
    if(lock.current)return
    const id=++generation.current
    lock.current=true;setBusy(true);setReady(false);setFeedback(t(key+"reading"))
    try {
      if(file.size>16384)throw new Error("Model profile exceeds 16 KB")
      const parsed=parseModelProfile(await file.text())
      if(id!==generation.current)return
      setProfile(parsed);setReady(true);setFeedback(t(key+"preview"))
    } catch(e){if(id===generation.current)setFeedback(`${t(key+"failed")} ${String(e)}`)}
    finally{lock.current=false;if(id===generation.current)setBusy(false)}
  }
  async function apply() {
    if(!profile||!ready||lock.current)return
    lock.current=true;setBusy(true);setFeedback(t(key+"saving"))
    const id=generation.current
    try {
      const state=useWikiStore.getState()
      const next=prepareModelProfile(profile,state.customLlmPresets,state.providerConfigs)
      await saveImportedModelProfile(next.presets,next.configs)
      if(!next.alreadyImported) {
        // Do not touch the active model, project override, routing, queues or credentials.
        useWikiStore.setState(current=>({
          customLlmPresets:current.customLlmPresets.some(p=>p.id===next.id) ? current.customLlmPresets : [...current.customLlmPresets,next.presets.find(p=>p.id===next.id)!],
          providerConfigs:{...current.providerConfigs,[next.id]:next.configs[next.id]},
        }))
      }
      const latest=useWikiStore.getState()
      await saveImportedModelProfile(latest.customLlmPresets,latest.providerConfigs)
      if(id===generation.current)setFeedback(t(key+"saved"))
    } catch(e){if(id===generation.current)setFeedback(`${t(key+"failed")} ${String(e)}`)}
    finally{lock.current=false;if(id===generation.current)setBusy(false)}
  }
  function cancel(){generation.current++;setProfile(null);setReady(false);setBusy(false);setFeedback(t(key+"cancelled"))}
  return <div className="space-y-2 rounded-md border p-3">
    <h3 className="text-sm font-medium">{t(key+"title")}</h3>
    <p className="text-xs text-muted-foreground">{t(key+"hint")}</p>
    <label className="block text-sm" htmlFor="model-profile-file">{t(key+"file")}</label>
    <input id="model-profile-file" className="block max-w-full text-sm focus-visible:outline-2" type="file" accept="application/json,.json" disabled={busy}
      onChange={e=>{const file=e.target.files?.[0];e.target.value="";if(file)void read(file)}} />
    <dl className="h-32 overflow-auto break-all text-xs"><dt>{t(key+"model")}</dt><dd>{profile?.model??"—"}</dd><dt>{t(key+"endpoint")}</dt><dd>{profile?.endpoint??"—"}</dd><dt>{t(key+"revision")}</dt><dd>{profile ? `${profile.profile_id} · ${profile.revision}` : "—"}</dd></dl>
    <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={!ready||busy} onClick={()=>void apply()}>{t(key+"apply")}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>{t(key+"cancel")}</Button>
    </div>
    <p role="status" aria-live="polite" className="h-16 overflow-auto text-xs text-muted-foreground">{feedback}</p>
  </div>
}
