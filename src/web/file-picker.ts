// Server-backed file/folder browser used by the dialog shim. The browser
// cannot open native OS pickers or see the server filesystem directly, so
// this renders an in-app modal that navigates the server's filesystem via
// the `list_directory` command and returns absolute server paths — exactly
// the shape the app's Tauri-based code already consumes.

import { invokeHttp, getHome } from "./http-api"

interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
}

export interface PickerOptions {
  directory?: boolean
  multiple?: boolean
  title?: string
  filters?: { name: string; extensions: string[] }[]
  defaultPath?: string
}

const STYLE_ID = "lw-picker-style"
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
.lw-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000;font-family:system-ui,sans-serif}
.lw-panel{background:var(--popover,#fff);color:var(--popover-foreground,#111);border:1px solid var(--border,#e5e5e5);border-radius:12px;width:min(680px,92vw);height:min(560px,86vh);display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden}
.lw-head{padding:14px 16px;font-weight:600;border-bottom:1px solid var(--border,#eee)}
.lw-pathbar{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid var(--border,#eee)}
.lw-pathbar input{flex:1;padding:7px 10px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--input,#fafafa);color:inherit;font-size:13px}
.lw-btn{padding:7px 12px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--secondary,#f4f4f5);color:inherit;cursor:pointer;font-size:13px}
.lw-btn:hover{filter:brightness(.96)}
.lw-btn.primary{background:var(--primary,#18181b);color:var(--primary-foreground,#fff);border-color:transparent}
.lw-btn:disabled{opacity:.45;cursor:not-allowed}
.lw-list{flex:1;overflow:auto;padding:6px}
.lw-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px;user-select:none}
.lw-row:hover{background:var(--accent,#f4f4f5)}
.lw-row.sel{background:var(--accent,#e4e4e7);outline:1px solid var(--ring,#a1a1aa)}
.lw-row .ico{width:18px;text-align:center}
.lw-row.disabled{opacity:.4;cursor:default}
.lw-empty{padding:24px;text-align:center;color:var(--muted-foreground,#888);font-size:13px}
.lw-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border,#eee)}
.lw-err{color:#dc2626;font-size:12px;padding:0 16px 8px}
`
  document.head.appendChild(style)
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ""
}

function matchesFilters(name: string, filters?: PickerOptions["filters"]): boolean {
  if (!filters || filters.length === 0) return true
  const ext = extOf(name)
  return filters.some((f) => f.extensions.some((e) => e.toLowerCase() === ext))
}

function parentOf(p: string): string {
  const clean = p.replace(/\/+$/, "")
  const idx = clean.lastIndexOf("/")
  if (idx <= 0) return "/"
  return clean.slice(0, idx)
}

export function pickPaths(options: PickerOptions = {}): Promise<string[] | null> {
  return new Promise((resolve) => {
    injectStyle()
    const directory = !!options.directory
    const multiple = !!options.multiple && !directory
    let current = ""
    let selected = new Set<string>()
    let navToken = 0

    const overlay = document.createElement("div")
    overlay.className = "lw-overlay"
    const panel = document.createElement("div")
    panel.className = "lw-panel"

    const head = document.createElement("div")
    head.className = "lw-head"
    head.textContent = options.title || (directory ? "Select Folder" : "Select File")

    const pathbar = document.createElement("div")
    pathbar.className = "lw-pathbar"
    const upBtn = document.createElement("button")
    upBtn.className = "lw-btn"; upBtn.textContent = "↑ Up"
    const pathInput = document.createElement("input")
    pathInput.placeholder = "/path/to/folder"
    const goBtn = document.createElement("button")
    goBtn.className = "lw-btn"; goBtn.textContent = "Go"
    pathbar.append(upBtn, pathInput, goBtn)

    const list = document.createElement("div")
    list.className = "lw-list"
    const errBox = document.createElement("div")
    errBox.className = "lw-err"

    const foot = document.createElement("div")
    foot.className = "lw-foot"
    const cancelBtn = document.createElement("button")
    cancelBtn.className = "lw-btn"; cancelBtn.textContent = "Cancel"
    const okBtn = document.createElement("button")
    okBtn.className = "lw-btn primary"
    okBtn.textContent = directory ? "Select Folder" : "Open"
    foot.append(cancelBtn, okBtn)

    panel.append(head, pathbar, list, errBox, foot)
    overlay.appendChild(panel)

    function close(result: string[] | null) {
      overlay.remove()
      resolve(result)
    }

    function updateOk() {
      if (directory) {
        okBtn.disabled = !current
        okBtn.textContent = current ? `Select "${current.split("/").filter(Boolean).pop() || "/"}"` : "Select Folder"
      } else {
        okBtn.disabled = selected.size === 0
      }
    }

    async function navigate(target: string) {
      const token = ++navToken
      errBox.textContent = ""
      list.innerHTML = `<div class="lw-empty">Loading…</div>`
      try {
        const nodes = await invokeHttp<FileNode[]>("list_directory", {
          path: target, includeHidden: true, maxDepth: 1,
        })
        if (token !== navToken) return // a newer navigation superseded this one
        current = target
        pathInput.value = target
        selected.clear()
        render(nodes)
        updateOk()
      } catch (err) {
        if (token !== navToken) return
        errBox.textContent = err instanceof Error ? err.message : String(err)
        list.innerHTML = `<div class="lw-empty">Could not read this folder.</div>`
      }
    }

    function render(nodes: FileNode[]) {
      list.innerHTML = ""
      const dirs = nodes.filter((n) => n.is_dir)
      const files = nodes.filter((n) => !n.is_dir && (!directory ? matchesFilters(n.name, options.filters) : false))
      if (dirs.length === 0 && files.length === 0) {
        list.innerHTML = `<div class="lw-empty">${directory ? "Empty folder." : "No matching files."}</div>`
        return
      }
      for (const node of dirs) {
        const row = document.createElement("div")
        row.className = "lw-row"
        row.innerHTML = `<span class="ico">📁</span><span></span>`
        row.children[1].textContent = node.name
        row.addEventListener("click", () => navigate(node.path))
        list.appendChild(row)
      }
      if (!directory) {
        for (const node of files) {
          const row = document.createElement("div")
          row.className = "lw-row"
          row.innerHTML = `<span class="ico">📄</span><span></span>`
          row.children[1].textContent = node.name
          row.addEventListener("click", () => {
            if (multiple) {
              if (selected.has(node.path)) selected.delete(node.path); else selected.add(node.path)
            } else {
              selected = new Set([node.path])
            }
            for (const el of list.querySelectorAll(".lw-row")) el.classList.remove("sel")
            for (const p of selected) {
              const match = [...list.querySelectorAll<HTMLElement>(".lw-row")].find((el) => el.dataset.path === p)
              match?.classList.add("sel")
            }
            updateOk()
          })
          row.dataset.path = node.path
          list.appendChild(row)
        }
      }
    }

    upBtn.addEventListener("click", () => { if (current && current !== "/") navigate(parentOf(current)) })
    goBtn.addEventListener("click", () => { const t = pathInput.value.trim(); if (t) navigate(t) })
    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goBtn.click() })
    cancelBtn.addEventListener("click", () => close(null))
    okBtn.addEventListener("click", () => {
      if (directory) close(current ? [current] : null)
      else close(selected.size ? [...selected] : null)
    })
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null) })

    document.body.appendChild(overlay)
    void (async () => {
      const start = options.defaultPath || (await getHome()).home
      navigate(start)
    })()
  })
}

// Simple modal message dialog (used by the `message` dialog shim).
export function showMessage(opts: { title?: string; message: string; kind?: string }): Promise<void> {
  return new Promise((resolve) => {
    injectStyle()
    const overlay = document.createElement("div")
    overlay.className = "lw-overlay"
    const panel = document.createElement("div")
    panel.className = "lw-panel"
    panel.style.height = "auto"
    panel.style.maxWidth = "480px"
    panel.innerHTML = `
      <div class="lw-head"></div>
      <div style="padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.5"></div>
      <div class="lw-foot"><button class="lw-btn primary">OK</button></div>`
    panel.querySelector(".lw-head")!.textContent = opts.title || (opts.kind === "error" ? "Error" : "Notice")
    panel.querySelectorAll("div")[1].textContent = opts.message
    const ok = panel.querySelector("button")!
    const close = () => { overlay.remove(); resolve() }
    ok.addEventListener("click", close)
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
  })
}
