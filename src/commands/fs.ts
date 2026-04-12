import { invoke } from "@tauri-apps/api/core"
import type { FileNode, WikiProject } from "@/types/wiki"

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_file", { path, contents })
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  return invoke<FileNode[]>("list_directory", { path })
}

export async function copyFile(
  source: string,
  destination: string
): Promise<void> {
  return invoke("copy_file", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
  return invoke<string>("preprocess_file", { path })
}

export async function deleteFile(path: string): Promise<void> {
  return invoke("delete_file", { path })
}

export async function findRelatedWikiPages(
  projectPath: string,
  sourceName: string
): Promise<string[]> {
  return invoke<string[]>("find_related_wiki_pages", { projectPath, sourceName })
}

export async function createDirectory(path: string): Promise<void> {
  return invoke<void>("create_directory", { path })
}

export async function createProject(
  name: string,
  path: string,
): Promise<WikiProject> {
  return invoke<WikiProject>("create_project", { name, path })
}

export async function openProject(path: string): Promise<WikiProject> {
  return invoke<WikiProject>("open_project", { path })
}

export async function clipServerStatus(): Promise<string> {
  return invoke<string>("clip_server_status")
}
