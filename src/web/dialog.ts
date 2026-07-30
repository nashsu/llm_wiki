// Web shim for `@tauri-apps/plugin-dialog`, backed by the server filesystem
// picker. Returns absolute server paths so the rest of the app (which reads
// and writes via the backend) works unchanged.

import { pickPaths, showMessage } from "./file-picker"

interface DialogFilter { name: string; extensions: string[] }
interface OpenOptions {
  directory?: boolean
  multiple?: boolean
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
  createDirectories?: boolean
}
interface SaveOptions {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
}
interface MessageOptions { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string }

export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  const paths = await pickPaths({
    directory: options.directory,
    multiple: options.multiple,
    title: options.title,
    filters: options.filters,
    defaultPath: options.defaultPath,
  })
  if (!paths || paths.length === 0) return null
  if (options.multiple) return paths
  return paths[0]
}

export async function save(options: SaveOptions = {}): Promise<string | null> {
  const dir = await pickPaths({ directory: true, title: options.title || "Choose save location", defaultPath: options.defaultPath })
  if (!dir || dir.length === 0) return null
  const ext = options.filters?.[0]?.extensions?.[0]
  const name = window.prompt("File name:", ext ? `export.${ext}` : "export")
  if (!name) return null
  return `${dir[0].replace(/\/+$/, "")}/${name}`
}

export async function message(msg: string, options?: string | MessageOptions): Promise<void> {
  const opts = typeof options === "string" ? { title: options } : options
  await showMessage({ message: msg, title: opts?.title, kind: opts?.kind })
}

export async function ask(msg: string, options?: string | MessageOptions): Promise<boolean> {
  const opts = typeof options === "string" ? { title: options } : options
  return window.confirm(`${opts?.title ? opts.title + "\n\n" : ""}${msg}`)
}

export async function confirm(msg: string, options?: string | MessageOptions): Promise<boolean> {
  return ask(msg, options)
}
