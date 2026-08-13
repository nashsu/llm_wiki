import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

export class VaultError extends Error {}

function assertMarkdown(relPath: string): void {
  if (!relPath.toLowerCase().endsWith(".md")) {
    throw new VaultError(`Only .md files are allowed: ${relPath}`);
  }
}

// Robust containment check: path.relative + ".." prefix, not a naive
// string prefix (which "/vault-evil" would pass without a separator boundary).
export function resolveVaultPath(vaultRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new VaultError(`Path must be relative to the vault: ${relPath}`);
  }
  const candidate = path.resolve(vaultRoot, relPath);
  const rel = path.relative(vaultRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new VaultError(`Path escapes the vault: ${relPath}`);
  }
  return candidate;
}

function assertWritable(relPath: string, readonlyPrefixes: string[]): void {
  const normalized = relPath.replace(/^\.\//, "");
  for (const prefix of readonlyPrefixes) {
    const p = prefix.replace(/\/$/, "");
    if (normalized === p || normalized.startsWith(p + "/")) {
      throw new VaultError(`Path is read-only (${prefix}): ${relPath}`);
    }
  }
}

export async function readNote(vaultRoot: string, relPath: string): Promise<string> {
  assertMarkdown(relPath);
  const target = resolveVaultPath(vaultRoot, relPath);
  return fs.readFile(target, "utf8");
}

export async function listNotes(vaultRoot: string, relFolder: string = "."): Promise<string[]> {
  const target = resolveVaultPath(vaultRoot, relFolder);
  const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => path.relative(vaultRoot, path.join(e.parentPath, e.name)))
    .sort();
}

export async function writeNote(
  vaultRoot: string,
  relPath: string,
  content: string,
  readonlyPrefixes: string[]
): Promise<void> {
  assertMarkdown(relPath);
  assertWritable(relPath, readonlyPrefixes);
  const target = resolveVaultPath(vaultRoot, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

export async function appendNote(
  vaultRoot: string,
  relPath: string,
  content: string,
  readonlyPrefixes: string[]
): Promise<void> {
  assertMarkdown(relPath);
  assertWritable(relPath, readonlyPrefixes);
  const target = resolveVaultPath(vaultRoot, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const exists = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  await fs.appendFile(target, (exists ? "\n" : "") + content, "utf8");
}

// rg via execFile (argv array, never a shell string) + a "--" sentinel so a
// query starting with "-" can't be parsed as an rg flag.
export async function searchNotes(
  vaultRoot: string,
  query: string,
  limit: number = 20
): Promise<SearchMatch[]> {
  if (!query.trim()) {
    throw new VaultError("query must not be empty");
  }
  let stdout: string;
  try {
    const result = await execFileAsync(
      "rg",
      ["--json", "-g", "*.md", "--", query, vaultRoot],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (err) {
    const e = err as { code?: number; message: string };
    if (e.code === 1) return []; // rg exit code 1 = no matches, not an error
    throw new VaultError(`search failed: ${e.message}`);
  }
  const matches: SearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type !== "match") continue;
    matches.push({
      path: path.relative(vaultRoot, event.data.path.text),
      line: event.data.line_number,
      snippet: event.data.lines.text.trim(),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}
