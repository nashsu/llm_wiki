import fs from "node:fs"
import fsp from "node:fs/promises"
import { markAppWrite } from "../appwrite.js"
import { openPath, revealItemInDir } from "../opener.js"
import path from "node:path"

// Node port of src-tauri/src/commands/project.rs.

const fwd = (p) => p.split(path.sep).join("/")

function writeFileSync(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents, "utf-8")
}

const SCHEMA_CONTENT = `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| entity | wiki/entities/ | Named things (models, companies, people, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena |
| source | wiki/sources/ | Papers, articles, talks, blog posts |
| query | wiki/queries/ | Open questions under investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |

## Naming Conventions

- Files: \`kebab-case.md\`
- Entities: match official name where possible (e.g., \`gpt-4.md\`, \`openai.md\`)
- Concepts: descriptive noun phrases (e.g., \`chain-of-thought.md\`)
- Sources: \`author-year-slug.md\` (e.g., \`wei-2022-chain-of-thought.md\`)
- Queries: question as slug (e.g., \`does-scale-improve-reasoning.md\`)

## Frontmatter

All pages must include YAML frontmatter:

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

Source pages also include:
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\`

## Index Format

\`wiki/index.md\` lists all pages grouped by type. Each entry:
\`\`\`
- [[page-slug]] — one-line description
\`\`\`

## Log Format

\`wiki/log.md\` records research activity in reverse chronological order:
\`\`\`
## YYYY-MM-DD

- Action taken / finding noted
\`\`\`

## Cross-referencing Rules

- Use \`[[page-slug]]\` syntax to link between wiki pages
- Every entity and concept should appear in \`wiki/index.md\`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via \`related:\`

## Contradiction Handling

When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists
`

const PURPOSE_CONTENT = `# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this research -->

1.
2.
3.

## Scope

<!-- What is in scope? What is explicitly out of scope? -->

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as research progresses) -->

> TBD
`

const INDEX_CONTENT = `# Wiki Index

## Entities

## Concepts

## Sources

## Queries

## Comparisons

## Synthesis
`

const OVERVIEW_CONTENT = `---
type: overview
title: Project Overview
tags: []
related: []
---

# Overview

<!-- Provide a high-level summary of what this wiki covers and its current state. Update regularly as understanding deepens. -->
`

const OBSIDIAN_APP = `{
  "attachmentFolderPath": "raw/assets",
  "userIgnoreFilters": [
    ".cache",
    ".llm-wiki",
    ".superpowers"
  ],
  "useMarkdownLinks": false,
  "newLinkFormat": "shortest",
  "showUnsupportedFiles": false
}`

const OBSIDIAN_APPEARANCE = `{
  "baseFontSize": 16,
  "theme": "obsidian"
}`

const OBSIDIAN_CORE_PLUGINS = `{
  "file-explorer": true,
  "global-search": true,
  "graph": true,
  "backlink": true,
  "tag-pane": true,
  "page-preview": true,
  "outgoing-link": true,
  "starred": true
}`

function validateWikiProjectRoot(root) {
  if (!fs.existsSync(root)) throw new Error(`Path does not exist: '${root}'`)
  if (!fs.statSync(root).isDirectory()) throw new Error(`Path is not a directory: '${root}'`)
  if (!fs.existsSync(path.join(root, "schema.md"))) {
    throw new Error(`Not a valid wiki project (missing schema.md): '${root}'`)
  }
  if (!fs.existsSync(path.join(root, "wiki")) || !fs.statSync(path.join(root, "wiki")).isDirectory()) {
    throw new Error(`Not a valid wiki project (missing wiki/ directory): '${root}'`)
  }
}

/**
 * Scaffold a fresh wiki project's directory tree + seed files at `root`.
 * Shared by the legacy `create_project` command and the v2
 * `POST /api/v2/projects` route so the on-disk layout can never drift between
 * the two create paths. `root` is the project root itself (the v2 contract);
 * the legacy command derives it as join(parent, name) before calling this.
 * Throws a plain Error on filesystem failure; callers map it to their own
 * error type (legacy: rethrown to the bridge; v2: wrapped in an ApiError).
 */
export function scaffoldWikiProject(root) {
  const dirs = [
    "raw/sources", "raw/assets",
    "wiki/entities", "wiki/concepts", "wiki/sources",
    "wiki/queries", "wiki/comparisons", "wiki/synthesis",
  ]
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(path.join(root, "schema.md"), SCHEMA_CONTENT)
  writeFileSync(path.join(root, "purpose.md"), PURPOSE_CONTENT)
  writeFileSync(path.join(root, "wiki/index.md"), INDEX_CONTENT)
  writeFileSync(path.join(root, "wiki/log.md"), `# Research Log\n\n## ${today}\n\n- Project created\n`)
  writeFileSync(path.join(root, "wiki/overview.md"), OVERVIEW_CONTENT)
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true })
  writeFileSync(path.join(root, ".obsidian/app.json"), OBSIDIAN_APP)
  writeFileSync(path.join(root, ".obsidian/appearance.json"), OBSIDIAN_APPEARANCE)
  writeFileSync(path.join(root, ".obsidian/core-plugins.json"), OBSIDIAN_CORE_PLUGINS)
  fs.mkdirSync(path.join(root, ".llm-wiki"), { recursive: true })
  markAppWrite(root)
}

function createProject({ name, path: basePath }) {
  const root = path.join(basePath, name)
  if (fs.existsSync(root)) throw new Error(`Directory already exists: '${root}'`)
  scaffoldWikiProject(root)
  return { name, path: fwd(root) }
}

function openProject({ path: p }) {
  validateWikiProjectRoot(p)
  const name = path.basename(p) || "Unknown"
  return { name, path: fwd(p) }
}

// Native folder reveal / external opener. The web server runs on the user's
// host (the supported same-host topology), so — exactly like the desktop app —
// it opens paths in the OS default handler via ../opener.js (a faithful port
// of tauri-plugin-opener). Faithful port of src-tauri/src/commands/project.rs
// `open_project_folder` / `open_path_in_project`: same validation, same
// canonicalization, same containment guard, same error strings, and the same
// open → reveal_item_in_dir fallback.
function isWithinDir(root, target) {
  // Component-wise prefix check (Rust Path::starts_with semantics).
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

async function openProjectFolder({ path: p }) {
  validateWikiProjectRoot(p)
  let canonical
  try {
    canonical = fs.realpathSync(p)
  } catch (err) {
    throw new Error(`Failed to resolve project path '${p}': ${err.message}`)
  }
  try {
    await openPath(canonical)
  } catch (openErr) {
    try {
      await revealItemInDir(canonical)
    } catch (revealErr) {
      throw new Error(
        `Failed to open project folder: ${openErr.message}; reveal fallback also failed: ${revealErr.message}`,
      )
    }
  }
  return null
}

async function openPathInProject({ projectPath, targetPath }) {
  validateWikiProjectRoot(projectPath)
  let rootCanonical
  try {
    rootCanonical = fs.realpathSync(projectPath)
  } catch (err) {
    throw new Error(`Failed to resolve project path '${projectPath}': ${err.message}`)
  }
  const target = path.isAbsolute(targetPath) ? targetPath : path.join(rootCanonical, targetPath)
  let targetCanonical
  try {
    targetCanonical = fs.realpathSync(target)
  } catch (err) {
    throw new Error(`Failed to resolve target path '${target}': ${err.message}`)
  }
  if (!isWithinDir(rootCanonical, targetCanonical)) {
    throw new Error(`Refusing to open a path outside the project: '${targetCanonical}'`)
  }
  try {
    await openPath(targetCanonical)
  } catch (openErr) {
    try {
      await revealItemInDir(targetCanonical)
    } catch (revealErr) {
      throw new Error(
        `Failed to open project path: ${openErr.message}; reveal fallback also failed: ${revealErr.message}`,
      )
    }
  }
  return null
}

export const projectCommands = {
  create_project: createProject,
  open_project: openProject,
  open_project_folder: openProjectFolder,
  open_path_in_project: openPathInProject,
}
