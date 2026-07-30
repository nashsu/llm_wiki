// Web-only command extensions (no Tauri/Rust counterpart). The browser's
// `@tauri-apps/plugin-opener` shim (src/web/opener.ts) cannot touch the OS,
// so it delegates here: the server runs on the user's host and performs the
// real OS open / reveal via ../opener.js. Same trust model as the rest of
// the server (it already exposes the filesystem through /api/raw and the
// folder picker), matching the desktop app's local trust boundary.
//
//   web_open_path   { path } -> null   (open with the OS default handler)
//   web_reveal_path { path } -> null   (reveal in the OS file manager)

import { openPath, revealItemInDir } from "../opener.js"

async function webOpenPath({ path: p }) {
  await openPath(p)
  return null
}

async function webRevealPath({ path: p }) {
  await revealItemInDir(p)
  return null
}

export const openerWebCommands = {
  web_open_path: webOpenPath,
  web_reveal_path: webRevealPath,
}
