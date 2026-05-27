import { createHash } from "node:crypto";
import path from "node:path";

export interface FileSystemLike {
	readFile(path: string, encoding: "utf8"): Promise<string>;
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
	access(path: string): Promise<void>;
	mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
	realpath(path: string): Promise<string>;
}

export interface WritePlan {
	absolutePath: string;
	relativePath: string;
}

const MAX_SLUG_LENGTH = 80;

export function normalizeProjectRelPath(input: string): string {
	return input.trim().replaceAll("\\", "/");
}

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function slugifyName(name: string): string {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/['"]/g, "")
		.replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
		.replace(/-+$/g, "");
	return slug || "untitled";
}

export function assertWikiMarkdownPath(input: string): string {
	const rel = normalizeProjectRelPath(input);
	const parts = rel.split("/");
	if (
		rel === "" ||
		path.posix.isAbsolute(rel) ||
		parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))
	) {
		throw new Error("Path must be a safe project-relative path");
	}
	if (!rel.startsWith("wiki/") || !rel.endsWith(".md")) {
		throw new Error("Write tools may only modify wiki/**/*.md");
	}
	return rel;
}

export function defaultEntityPath(name: string): string {
	return `wiki/entities/${slugifyName(name)}.md`;
}

export function defaultConceptPath(name: string): string {
	return `wiki/concepts/${slugifyName(name)}.md`;
}

export function assertFixedDirectoryPath(input: string, directory: "entities" | "concepts"): string {
	const rel = assertWikiMarkdownPath(input);
	const prefix = `wiki/${directory}/`;
	if (!rel.startsWith(prefix) || rel.slice(prefix.length).includes("/")) {
		throw new Error(`Path must be inside ${prefix} and cannot contain nested folders`);
	}
	return rel;
}

export async function resolveWritePlan(
	fs: FileSystemLike,
	projectPath: string,
	relativePath: string,
): Promise<WritePlan> {
	const root = await fs.realpath(projectPath);
	const rel = assertWikiMarkdownPath(relativePath);
	const absolutePath = path.resolve(root, rel);
	const parent = path.dirname(absolutePath);
	const realParent = await fs.realpath(parent);
	const relativeFromRoot = path.relative(root, absolutePath);
	const relativeParentFromRoot = path.relative(root, realParent);
	if (
		relativeFromRoot.startsWith("..") ||
		path.isAbsolute(relativeFromRoot) ||
		relativeParentFromRoot.startsWith("..") ||
		path.isAbsolute(relativeParentFromRoot)
	) {
		throw new Error("Resolved path escapes the project directory");
	}
	return { absolutePath, relativePath: rel };
}

export async function pathExists(fs: FileSystemLike, absolutePath: string): Promise<boolean> {
	try {
		await fs.access(absolutePath);
		return true;
	} catch {
		return false;
	}
}

export function assertWritableContents(contents: string, maxWriteBytes: number): void {
	const bytes = Buffer.byteLength(contents, "utf8");
	if (bytes > maxWriteBytes) {
		throw new Error(`Write exceeds maxWriteBytes (${bytes} > ${maxWriteBytes})`);
	}
	if (contents.trim().length < 20) {
		throw new Error("Refusing to write empty or placeholder content");
	}
}

export function diffSummary(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	let sharedPrefix = 0;
	while (
		sharedPrefix < oldLines.length &&
		sharedPrefix < newLines.length &&
		oldLines[sharedPrefix] === newLines[sharedPrefix]
	) {
		sharedPrefix += 1;
	}

	let sharedSuffix = 0;
	while (
		sharedSuffix + sharedPrefix < oldLines.length &&
		sharedSuffix + sharedPrefix < newLines.length &&
		oldLines[oldLines.length - 1 - sharedSuffix] === newLines[newLines.length - 1 - sharedSuffix]
	) {
		sharedSuffix += 1;
	}

	return JSON.stringify({
		oldLines: oldLines.length,
		newLines: newLines.length,
		changedOldLines: Math.max(0, oldLines.length - sharedPrefix - sharedSuffix),
		changedNewLines: Math.max(0, newLines.length - sharedPrefix - sharedSuffix),
	});
}

function yamlArray(values: string[] | undefined): string {
	if (!values || values.length === 0) return "[]";
	return `\n${values.map((value) => `  - ${JSON.stringify(value)}`).join("\n")}`;
}

export function buildEntityMarkdown(args: {
	name: string;
	summary: string;
	aliases?: string[];
	sources?: string[];
}): string {
	return `---\ntitle: ${JSON.stringify(args.name)}\ntype: entity\naliases: ${yamlArray(args.aliases)}\nsources: ${yamlArray(args.sources)}\n---\n\n# ${args.name}\n\n${args.summary.trim()}\n`;
}

export function buildConceptMarkdown(args: {
	name: string;
	explanation: string;
	related?: string[];
	sources?: string[];
}): string {
	const related = args.related?.length
		? `\n## Related\n\n${args.related.map((item) => `- [[${item}]]`).join("\n")}\n`
		: "";
	return `---\ntitle: ${JSON.stringify(args.name)}\ntype: concept\nsources: ${yamlArray(args.sources)}\n---\n\n# ${args.name}\n\n${args.explanation.trim()}\n${related}`;
}
