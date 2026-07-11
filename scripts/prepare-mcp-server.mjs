import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const mcpDir = join(rootDir, "mcp-server")

const packageFiles = [
  join(mcpDir, "package.json"),
  join(mcpDir, "package-lock.json"),
]
const dependencySentinels = [
  join(mcpDir, "node_modules", ".package-lock.json"),
  join(mcpDir, "node_modules", "typescript", "bin", "tsc"),
]

function mtimeMs(path) {
  return statSync(path).mtimeMs
}

function newest(paths) {
  return Math.max(...paths.map(mtimeMs))
}

function oldest(paths) {
  return Math.min(...paths.map(mtimeMs))
}

function run(command, args, cwd) {
  console.log(`[prepare-mcp-server] ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }

  process.exitCode = result.status ?? 1
  if (process.exitCode !== 0) {
    process.exit(process.exitCode)
  }
}

const dependencyFilesExist = dependencySentinels.every(existsSync)
const dependenciesAreFresh =
  dependencyFilesExist && oldest(dependencySentinels) >= newest(packageFiles)

if (!dependenciesAreFresh) {
  run("npm", ["ci"], mcpDir)
} else {
  console.log("[prepare-mcp-server] dependencies are current")
}

run("npm", ["run", "build"], mcpDir)
