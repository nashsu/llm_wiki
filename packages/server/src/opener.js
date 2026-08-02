// OS default-opener / file-manager reveal for the web server.
//
// Faithful Node port of the desktop's `tauri-plugin-opener` semantics
// (plugins-workspace v2: open.rs + reveal_item_in_dir.rs) used by the Rust
// commands `open_project_folder` / `open_path_in_project` (project.rs) and
// the frontend's `@tauri-apps/plugin-opener` calls. The web server runs on
// the user's host (the supported same-host topology), so — exactly like the
// desktop app — it can open paths in the OS default handler and reveal items
// in the file manager.
//
// Platform behavior (mirroring the plugin):
//   - open:      macOS `open <path>`; Windows `cmd /c start "" "<path>"`
//                (ShellExecute equivalent); Linux/BSD `xdg-open <path>`.
//                The plugin spawns detached (`open::that_detached`) and does
//                NOT observe the child's exit status — only spawn-time
//                failures (binary missing) and the up-front existence check
//                (`path.metadata()?`) are errors. We mirror that exactly.
//   - reveal:    macOS `open -R <path>` (NSWorkspace select); Windows
//                `explorer /select,<path>` (SHOpenFolderAndSelectItems
//                equivalent); Linux/BSD the freedesktop FileManager1 D-Bus
//                `ShowItems` call (what the plugin does via zbus) issued
//                through `dbus-send`, with the xdg-desktop-portal
//                `OpenURI.OpenDirectory` fallback, and a last-resort
//                `xdg-open <parent dir>`.
//
// Command resolution reuses cli.js#whichCommand (inherited PATH first, then
// the cached login-shell PATH), so `xdg-open`/`dbus-send` are found even
// when the server is launched by a GUI/daemon with a minimal PATH.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { whichCommand } from "./cli.js"

// Synchronous reveal steps (dbus-send, `open -R`) block only until the
// handler answers; cap them so a wedged session bus cannot hang a command.
const REVEAL_STEP_TIMEOUT_MS = 5000

function resolveCmd(name) {
  const found = whichCommand(name)
  if (!found) throw new Error(`${name} not found on PATH`)
  return found
}

/**
 * Spawn a detached, fully-unref'd child (fire-and-forget, like
 * `open::that_detached`). Resolves once the OS has spawned the process;
 * rejects only on spawn-time failure (e.g. ENOENT). The child's exit
 * status is deliberately NOT observed — matching the desktop plugin.
 */
function spawnDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    const onError = (err) => reject(err)
    child.once("error", onError)
    child.once("spawn", () => {
      child.removeListener("error", onError)
      child.unref()
      resolve()
    })
  })
}

/** Run a synchronous helper (reveal step) and fail on non-zero exit. */
function runSyncChecked(cmd, args) {
  const r = spawnSync(cmd, args, { timeout: REVEAL_STEP_TIMEOUT_MS, encoding: "utf8" })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const stderr = String(r.stderr || "").trim().split("\n")[0]
    throw new Error(
      `${path.basename(cmd)} exited with code ${r.status}${stderr ? `: ${stderr.slice(0, 200)}` : ""}`,
    )
  }
}

/** Quote a path for `cmd /c start "" <path>` (first quoted arg is the title). */
export function escapeForCmdStart(p) {
  return `"${String(p).replace(/"/g, '""')}"`
}

/**
 * Open a path with the OS default handler (port of the plugin's `open_path`:
 * existence check, then a detached platform spawn; exit status unchecked).
 */
export async function openPath(target) {
  // The plugin does `path.metadata()?` first: an IO error if it doesn't exist.
  fs.statSync(target)
  const t = String(target)
  if (process.platform === "darwin") {
    await spawnDetached(resolveCmd("open"), [t])
  } else if (process.platform === "win32") {
    const cmdExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "cmd.exe")
      : "cmd.exe"
    await spawnDetached(cmdExe, ["/c", "start", "", escapeForCmdStart(t)])
  } else {
    await spawnDetached(resolveCmd("xdg-open"), [t])
  }
}

/**
 * Reveal a path in the system file manager (port of the plugin's
 * `reveal_item_in_dir`: canonicalize first, then the platform mechanism).
 */
export async function revealItemInDir(target) {
  const canonical = fs.realpathSync(target) // throws if it doesn't exist
  if (process.platform === "darwin") {
    runSyncChecked(resolveCmd("open"), ["-R", canonical])
    return
  }
  if (process.platform === "win32") {
    // explorer's exit code is meaningless (often non-zero on success), so —
    // like the WinAPI call in the plugin — only spawn failure is an error.
    const explorer = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "explorer.exe")
      : "explorer.exe"
    await spawnDetached(explorer, [`/select,${canonical}`])
    return
  }
  // Linux / BSD: the plugin calls org.freedesktop.FileManager1.ShowItems over
  // the session bus (falling back to the OpenURI portal's OpenDirectory).
  // We issue the same calls via dbus-send, then fall back to opening the
  // parent directory.
  const errors = []
  const uri = pathToFileURL(canonical).href
  const dbus = whichCommand("dbus-send")
  if (dbus) {
    try {
      runSyncChecked(dbus, [
        "--session", "--type=method_call", "--print-reply",
        "--dest=org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        `array:string:${uri}`,
        "string:",
      ])
      return
    } catch (err) {
      errors.push(`FileManager1.ShowItems failed (${err.message})`)
    }
    try {
      runSyncChecked(dbus, [
        "--session", "--type=method_call", "--print-reply",
        "--dest=org.freedesktop.portal.OpenURI",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI.OpenDirectory",
        "string:",
        `string:${uri}`,
        "dict:string:variant:",
      ])
      return
    } catch (err) {
      errors.push(`portal.OpenDirectory failed (${err.message})`)
    }
  } else {
    errors.push("dbus-send not found on PATH")
  }
  // Last resort: open the parent directory in the default file manager.
  try {
    await openPath(path.dirname(canonical))
    return
  } catch (err) {
    errors.push(`xdg-open parent failed (${err.message})`)
  }
  throw new Error(`reveal_item_in_dir failed: ${errors.join("; ")}`)
}
