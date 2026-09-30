import { invoke } from "@tauri-apps/api/core"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

/** Deterministically rebuild wiki/index.md, then refresh the file tree and
 *  bump dataVersion so the graph/sources/views refresh. Mirrors the manual
 *  "Rebuild Index" action exactly (same invoke + refresh). */
export async function rebuildIndexForProject(projectPath: string): Promise<void> {
  await invoke("rebuild_wiki_index", { projectPath })
  await refreshProjectFileTree(projectPath, { bumpDataVersion: true })
}
