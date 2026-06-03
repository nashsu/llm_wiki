import { runStructuralLint } from "@/lib/lint"
import { normalizePath } from "@/lib/path-utils"
import { useLintStore } from "@/stores/lint-store"

let pendingProjectPath: string | null = null
let pendingPaths = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

function snapshotPaths(): string[] {
  return [...pendingPaths].sort()
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void drainQueue()
  }, delayMs)
}

async function drainQueue(): Promise<void> {
  if (running || !pendingProjectPath || pendingPaths.size === 0) return

  running = true
  const projectPath = pendingProjectPath
  const paths = snapshotPaths()
  pendingPaths = new Set()
  useLintStore.getState().setAgentLintState({
    status: "running",
    paths,
    updatedAt: Date.now(),
  })

  try {
    const results = await runStructuralLint(normalizePath(projectPath))
    useLintStore.getState().replaceAgentItems(results)
    useLintStore.getState().setAgentLintState({
      status: "done",
      paths,
      updatedAt: Date.now(),
    })
  } catch (err) {
    useLintStore.getState().setAgentLintState({
      status: "failed",
      paths,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    })
  } finally {
    running = false
    if (pendingPaths.size > 0) schedule(0)
  }
}

/** Enqueue a structural lint refresh after Agent writes wiki files. */
export function enqueueAgentStructuralLint(
  projectPath: string,
  paths: readonly string[],
  delayMs = 500,
): void {
  if (!projectPath || paths.length === 0) return
  pendingProjectPath = projectPath
  for (const path of paths) {
    if (path) pendingPaths.add(path)
  }
  useLintStore.getState().setAgentLintState({
    status: "queued",
    paths: snapshotPaths(),
    updatedAt: Date.now(),
  })
  schedule(delayMs)
}

export function clearAgentStructuralLintQueue(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pendingProjectPath = null
  pendingPaths = new Set()
  running = false
}
