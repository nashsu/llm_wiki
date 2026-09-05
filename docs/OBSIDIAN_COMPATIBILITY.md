# Obsidian vault compatibility contract

LLM Wiki can open an existing Obsidian vault directly. Selecting a directory that contains a real (non-symlink) `.obsidian/` directory adopts that directory as the project root and adds only missing LLM Wiki-managed scaffolding.

## Ownership boundaries

LLM Wiki owns these paths after adoption:

- `.llm-wiki/` — local project identity, file history, queues, indexes, and other app metadata
- `raw/` — source documents and LLM Wiki-managed assets
- `wiki/` — generated and curated knowledge pages
- `schema.md` and `purpose.md` — project instructions

Adoption creates missing managed directories and starter files with create-new semantics. It never replaces an existing file. Existing notes, attachment folders, dotfiles, and other unknown files remain in place.

`.obsidian/` is entirely Obsidian-owned. LLM Wiki does not rewrite, merge, or normalize existing Obsidian settings, workspace state, themes, snippets, or plugin data. New projects may receive recommended Obsidian settings during creation; adopting an existing vault does not apply those defaults.

Existing notes outside `wiki/` remain ordinary vault content and are preserved. LLM Wiki's knowledge generation, graph, search, and lint workflows continue to use `wiki/` as their managed knowledge namespace; a user must deliberately import or move other vault notes into that namespace before those workflows mutate them.

## Core format compatibility

The supported interchange contract is filesystem-level and local-first:

- UTF-8 Markdown remains Markdown; the raw editor does not serialize it through a proprietary document model.
- YAML frontmatter, including unknown keys and values, is retained unless the user explicitly edits it.
- `[[wikilinks]]`, aliases such as `[[Target|label]]`, and embeds such as `![[image.png]]` remain in source form.
- Relative Markdown images and Obsidian attachment embeds are resolved for preview without rewriting their source syntax.
- Attachments and unknown binary files are copied, renamed, or deleted as bytes; they are not transcoded.
- Checked rename refuses to replace an existing destination. Checked rename and delete verify the loaded file revision before changing the filesystem.

The Rust smoke tests exercise existing-vault adoption, preservation of `.obsidian/` and unknown files, Markdown/frontmatter/wikilinks/embed round trips, attachment byte preservation, checked rename/delete, stale-write rejection, history, and recovery after deletion.

## Write, backup, and recovery policy

Interactive Markdown saves use a versioned read and a checked atomic write:

1. The backend reads the UTF-8 bytes and computes the MD5 revision from that same byte snapshot.
2. A save supplies that loaded revision.
3. The backend rechecks the current file immediately before the write boundary. If Obsidian, a sync client, or another ordinary cooperating process changed it, the save fails without modifying either version. A hostile process running as the same OS user can still race pathname operations in the final syscall window and is outside the desktop app's security boundary.
4. On success, the backend writes and syncs a temporary sibling file, then renames it over the destination. Readers therefore see the old complete file or the new complete file, not a partial write.

There is no automatic last-writer-wins behavior and no implicit three-way merge. After a conflict, reload the disk version and manually reapply or merge the pending edit.

File history is enabled by default and retains up to 10 versions per text file unless changed in Settings. Before checked writes, renames, and deletes, the current text version is atomically recorded under `.llm-wiki/history/`; an eligible text mutation aborts if that baseline cannot be stored. Restore also snapshots the current version before replacing it. Deleted text files can be listed and restored by their original path. History is bounded to 512 KiB per text snapshot, 30 configurable versions per file, 128 MiB total, and 2,048 history files. Binary attachment history is outside this bounded text-history store, so users should continue to use normal vault backup/version-control for irreplaceable binaries.

## Features supplied by Obsidian

This fork does not reproduce Obsidian's proprietary application UI or full plugin ecosystem. Open the same vault in Obsidian for:

- Obsidian's file explorer, command palette, tabs, panes, workspaces, Canvas, and mobile UI
- core-plugin behavior beyond the Markdown/wikilink filesystem contract
- community plugin installation, execution, settings, and compatibility
- Obsidian Sync, Publish, themes, CSS snippets, hotkeys, and plugin-specific formats
- Obsidian's exact graph, backlinks, search, properties, and live-preview user experience

Where deeper integration is needed, it should be implemented as an explicit Obsidian plugin bridge rather than by mutating private Obsidian state or cloning proprietary UI behavior.
