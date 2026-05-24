import { readFile, writeFile, listDirectory, createDirectory, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface GraphSnapshot {
  timestamp: number
  nodeCount: number
  edgeCount: number
  communityCount: number
  topNodes: Array<{ id: string; label: string; linkCount: number }>
  communityDistribution: Array<{ id: number; nodeCount: number; cohesion: number }>
}

const MAX_SNAPSHOTS = 30

function snapshotDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/graph-snapshots`
}

function snapshotPath(projectPath: string, timestamp: number): string {
  return `${snapshotDir(projectPath)}/${timestamp}.json`
}

export async function saveSnapshot(
  projectPath: string,
  snapshot: GraphSnapshot,
): Promise<void> {
  const dir = snapshotDir(projectPath)
  try {
    await createDirectory(dir)
  } catch {
    /* may already exist */
  }

  await writeFile(snapshotPath(projectPath, snapshot.timestamp), JSON.stringify(snapshot, null, 2))

  // Cleanup old snapshots beyond MAX_SNAPSHOTS
  try {
    const files = await listDirectory(dir)
    const jsonFiles = files
      .filter((f) => f.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))

    if (jsonFiles.length > MAX_SNAPSHOTS) {
      const toDelete = jsonFiles.slice(0, jsonFiles.length - MAX_SNAPSHOTS)
      for (const f of toDelete) {
        try {
          await deleteFile(f.path)
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}

export async function listSnapshots(
  projectPath: string,
): Promise<GraphSnapshot[]> {
  const dir = snapshotDir(projectPath)
  try {
    const files = await listDirectory(dir)
    const jsonFiles = files
      .filter((f) => f.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))

    const snapshots: GraphSnapshot[] = []
    for (const f of jsonFiles) {
      try {
        const content = await readFile(f.path)
        snapshots.push(JSON.parse(content))
      } catch {
        /* skip unreadable files */
      }
    }
    return snapshots
  } catch {
    return []
  }
}
