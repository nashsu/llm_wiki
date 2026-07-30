import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { readFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

// Live cross-client sync. The web server watches the whole project on disk
// and emits `project://files-changed` whenever an EXTERNAL process (e.g. the
// desktop app, or another browser tab) creates/edits/deletes a non-source
// file. The desktop build never emits this event, so this listener is inert
// there — safe to keep in shared code.
//
// On such an event we (a) refresh the file tree so desktop-created pages
// appear without a manual reload, and (b) if the changed file is the one
// currently open in the reader, reload its content — but NEVER while the user
// is editing it (the editor sets window.__lwEditingOpenFile), so an external
// change can't clobber an in-progress edit. Source-file changes are handled
// separately by the ingest pipeline and are not delivered on this event.

interface ExternalChangePayload {
  projectId: string
  paths: string[]
}

function isEditingOpenFile(): boolean {
  return Boolean((globalThis as { __lwEditingOpenFile?: boolean }).__lwEditingOpenFile)
}

export async function subscribeExternalProjectChanges(): Promise<UnlistenFn> {
  return listen<ExternalChangePayload>("project://files-changed", (event) => {
    const payload = event.payload
    if (!payload) return
    const proj = useWikiStore.getState().project
    if (!proj) return
    if (payload.projectId && payload.projectId !== proj.id) return
    const pp = normalizePath(proj.path)

    void refreshProjectFileTree(pp, { projectId: proj.id, bumpDataVersion: true })

    const paths = payload.paths
    if (!paths || paths.length === 0) return
    if (isEditingOpenFile()) return

    const selected = useWikiStore.getState().selectedFile
    if (!selected) return
    const selNorm = normalizePath(selected)
    const selRel = selNorm.startsWith(pp + "/") ? selNorm.slice(pp.length + 1) : ""
    if (!selRel || !paths.includes(selRel)) return

    readFile(selected)
      .then((content) => {
        const st = useWikiStore.getState()
        if (isEditingOpenFile()) return
        if (st.project?.id !== proj.id) return
        if (normalizePath(st.selectedFile ?? "") !== selNorm) return
        st.setFileContent(content)
      })
      .catch(() => {
        const st = useWikiStore.getState()
        if (isEditingOpenFile()) return
        st.setSelectedFile(null)
        st.setFileContent("")
      })
  })
}
