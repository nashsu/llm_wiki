import { fsCommands } from "./commands/fs.js"
import { projectCommands } from "./commands/project.js"
import { searchCommands } from "./commands/search.js"
import { webSearchCommands } from "./commands/websearch.js"
import { fileSyncCommands } from "./commands/fileSync.js"
import { miscCommands } from "./commands/misc.js"
import { extractImageCommands } from "./commands/extractImages.js"
import { vectorCommands } from "./commands/vectorstore.js"
import { maintenanceCommands } from "./commands/maintenance.js"
import { agentCommands } from "./agent.js"
import { cliCommands } from "./cli.js"
import { openerWebCommands } from "./commands/openerWeb.js"

// Registry of every Tauri command exposed over HTTP. The browser client's
// `invoke(command, args)` shim POSTs to /api/invoke/:command and the server
// dispatches here. Command names match the Rust `generate_handler!` list so
// the unmodified frontend works against either backend.
export const commands = {
  ...fsCommands,
  ...projectCommands,
  ...searchCommands,
  ...webSearchCommands,
  ...fileSyncCommands,
  ...vectorCommands,
  ...maintenanceCommands,
  ...agentCommands,
  ...cliCommands,
  ...extractImageCommands,
  ...openerWebCommands,
  ...miscCommands,
}

export function hasCommand(name) {
  return Object.prototype.hasOwnProperty.call(commands, name)
}

export async function dispatch(name, args) {
  const handler = commands[name]
  if (!handler) throw new Error(`Unknown command: ${name}`)
  return await handler(args ?? {})
}

export function commandNames() {
  return Object.keys(commands).sort()
}
