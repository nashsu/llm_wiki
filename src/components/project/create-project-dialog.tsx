import { useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FolderOpen } from "lucide-react"
import { createProject, writeFile, createDirectory } from "@/commands/fs"
import { getTemplate } from "@/lib/templates"
import { TemplatePicker } from "@/components/project/template-picker"
import type { WikiProject } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { OUTPUT_LANGUAGE_OPTIONS } from "@/lib/output-language-options"
import { useWikiStore, type OutputLanguage } from "@/stores/wiki-store"
import { saveOutputLanguage } from "@/lib/project-store"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (project: WikiProject) => void
}

export function CreateProjectDialog({ open: isOpen, onOpenChange, onCreated }: CreateProjectDialogProps) {
  const defaultOutputMode: OutputLanguage = "Chinese (preserve English terms)"
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState("general")
  // Empty string = "user hasn't picked yet"; we validate this on
  // submit so a fresh project never starts in implicit auto-detect
  // mode. Once chosen, the value is one of OUTPUT_LANGUAGE_OPTIONS
  // (`auto` is a valid explicit choice — the user is then opting
  // INTO auto-detect rather than getting it by accident).
  const [language, setLanguage] = useState<string>(defaultOutputMode)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState(false)
  const setOutputLanguage = useWikiStore((s) => s.setOutputLanguage)

  async function handleBrowse() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Parent Directory",
    })
    if (selected) {
      setPath(selected)
    }
  }

  async function handleCreate() {
    if (!name.trim() || !path.trim()) {
      setError("Name and path are required")
      return
    }
    if (!language) {
      setError("Please pick an AI output mode")
      return
    }
    setCreating(true)
    setError("")
    try {
      const project = await createProject(name.trim(), path.trim())
      const pp = normalizePath(project.path)

      const template = getTemplate(selectedTemplate)
      await writeFile(`${pp}/schema.md`, template.schema)
      await writeFile(`${pp}/purpose.md`, template.purpose)
      for (const dir of template.extraDirs) {
        await createDirectory(`${pp}/${dir}`)
      }

      // Persist the user's language choice. The store / disk
      // mirror is what the rest of the app reads via
      // `getOutputLanguage()` — without this write the choice
      // wouldn't survive past the dialog closing.
      const lang = language as OutputLanguage
      setOutputLanguage(lang)
      await saveOutputLanguage(lang, project.id)

      onCreated(project)
      onOpenChange(false)
      setName("")
      setPath("")
      setSelectedTemplate("general")
      setLanguage(defaultOutputMode)
    } catch (err) {
      setError(String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Wiki Project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Project Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-research-wiki" />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Template</Label>
            <TemplatePicker selected={selectedTemplate} onSelect={setSelectedTemplate} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="language">
              AI Output Mode <span className="text-destructive">*</span>
            </Label>
            <select
              id="language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {/*
                * "auto" is intentionally filtered out at project
                * creation time. Auto-detect is a fine post-hoc
                * setting (Settings → Output) for users who later
                * decide they want it, but at create time we force
                * an explicit commitment so the project never starts
                * in the implicit-detect mode that was the source
                * of "wiki content showed up in a language I didn't
                * expect" surprises.
                */}
              {OUTPUT_LANGUAGE_OPTIONS.filter((l) => l.value !== "auto").map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              This controls how AI writes across chat, wiki generation, and
              research. The default mode is Chinese-first while preserving
              necessary English terms. You can change it later in Settings →
              Output.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="path">Parent Directory</Label>
            <div className="flex gap-2">
              <Input id="path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/projects" className="flex-1" />
              <Button variant="outline" size="icon" onClick={handleBrowse} type="button">
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={creating}>{creating ? "Creating..." : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
