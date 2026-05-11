/**
 * Real-filesystem adapter for @/commands/fs. Tests that want to exercise
 * the actual JSON / path round-trip (rather than a vi.mock memory stub)
 * should call `installRealFs()` then use a per-test temp directory via
 * `createTempProject()`.
 *
 * The Tauri fs commands are replaced with implementations backed by
 * node:fs/promises, operating on whatever path the caller passes. The
 * caller is responsible for using a temp-dir root to prevent tests from
 * touching each other's state.
 */
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { FileNode } from "@/types/wiki"

async function buildTree(dir: string): Promise<FileNode[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileNode[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name).replace(/\\/g, "/")
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: full,
        is_dir: true,
        children: await buildTree(full),
      } as FileNode)
    } else {
      nodes.push({
        name: entry.name,
        path: full,
        is_dir: false,
        children: [],
      } as FileNode)
    }
  }
  return nodes
}

/**
 * Implementations of the @/commands/fs API backed by node:fs.
 * Import this from a test file that calls `vi.mock("@/commands/fs", ...)`.
 */
export const realFs = {
  readFile: async (p: string): Promise<string> => {
    return fs.readFile(p, "utf-8")
  },
  writeFile: async (p: string, contents: string): Promise<void> => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = path.join(
      path.dirname(p),
      `.${path.basename(p)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    )
    await fs.writeFile(tmp, contents, "utf-8")
    await fs.rename(tmp, p)
  },
  listDirectory: async (p: string): Promise<FileNode[]> => {
    return buildTree(p)
  },
  copyFile: async (source: string, destination: string): Promise<void> => {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
  },
  preprocessFile: async (p: string): Promise<string> => {
    return fs.readFile(p, "utf-8")
  },
  deleteFile: async (p: string): Promise<void> => {
    await fs.unlink(p).catch(() => {})
  },
  findRelatedWikiPages: async (): Promise<string[]> => {
    return []
  },
  createDirectory: async (p: string): Promise<void> => {
    await fs.mkdir(p, { recursive: true })
  },
  createProject: async () => {
    throw new Error("createProject not supported in tests")
  },
  openProject: async () => {
    throw new Error("openProject not supported in tests")
  },
  clipServerStatus: async (): Promise<string> => "ok",
  mcpServerConfig: async () => ({
    scriptPath: "/repo/mcp-server/llmwiki-mcp.js",
    codexCommand: 'codex mcp add llmwiki -- node "/repo/mcp-server/llmwiki-mcp.js"',
    jsonConfig: JSON.stringify({
      mcpServers: {
        llmwiki: {
          command: "node",
          args: ["/repo/mcp-server/llmwiki-mcp.js"],
        },
      },
    }),
  }),
}

/**
 * Create a fresh unique temp directory for a single test. Returns the
 * absolute path (with forward slashes) and a cleanup function.
 */
export async function createTempProject(label: string = "proj"): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const prefix = path.join(os.tmpdir(), `llmwiki-${label}-`)
  const dir = await fs.mkdtemp(prefix)
  const normalized = dir.replace(/\\/g, "/")
  return {
    path: normalized,
    cleanup: async () => {
      await fs.rm(normalized, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** Read a file directly (bypasses the mocked API) — used in assertions. */
export async function readFileRaw(p: string): Promise<string> {
  return fs.readFile(p, "utf-8")
}

/** Write a file directly (bypasses the mocked API) — used in fixture setup. */
export async function writeFileRaw(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, contents, "utf-8")
}

/** Check if a file exists on disk. */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
