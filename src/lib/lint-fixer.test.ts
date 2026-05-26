import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LintResult } from "@/lib/lint";
import type { LlmConfig } from "@/stores/wiki-store";

vi.mock("./llm-client", () => ({
	streamChat: vi.fn(),
}));
vi.mock("@/commands/fs", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	listDirectory: vi.fn(),
}));

import { listDirectory, readFile, writeFile } from "@/commands/fs";
import { fixAllLintResults, fixLintResult, isFixable } from "./lint-fixer";
import { streamChat } from "./llm-client";

const mockStreamChat = vi.mocked(streamChat);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockListDirectory = vi.mocked(listDirectory);

function fakeLlmConfig(): LlmConfig {
	return {
		provider: "openai",
		apiKey: "k",
		model: "m",
		ollamaUrl: "",
		customEndpoint: "",
		maxContextSize: 128000,
	};
}

beforeEach(() => {
	mockStreamChat.mockReset();
	mockReadFile.mockReset();
	mockWriteFile.mockReset();
	mockListDirectory.mockReset();
});

// ── isFixable ────────────────────────────────────────────────────────────────

describe("isFixable", () => {
	it("marks orphan as fixable", () => {
		expect(
			isFixable({ type: "orphan", severity: "info", page: "a.md", detail: "" }),
		).toBe(true);
	});

	it("marks broken-link as fixable", () => {
		expect(
			isFixable({
				type: "broken-link",
				severity: "warning",
				page: "a.md",
				detail: "",
			}),
		).toBe(true);
	});

	it("marks no-outlinks as fixable", () => {
		expect(
			isFixable({
				type: "no-outlinks",
				severity: "info",
				page: "a.md",
				detail: "",
			}),
		).toBe(true);
	});

	it("marks semantic contradiction as fixable", () => {
		expect(
			isFixable({
				type: "semantic",
				severity: "warning",
				page: "x",
				detail: "[contradiction] pages disagree",
			}),
		).toBe(true);
	});

	it("marks semantic stale as fixable", () => {
		expect(
			isFixable({
				type: "semantic",
				severity: "info",
				page: "x",
				detail: "[stale] outdated info",
			}),
		).toBe(true);
	});

	it("marks semantic missing-page as fixable", () => {
		expect(
			isFixable({
				type: "semantic",
				severity: "info",
				page: "X",
				detail: "[missing-page] no page for X",
			}),
		).toBe(true);
	});

	it("does NOT mark semantic suggestion as fixable", () => {
		expect(
			isFixable({
				type: "semantic",
				severity: "info",
				page: "x",
				detail: "[suggestion] add source",
			}),
		).toBe(false);
	});
});

// ── fixLintResult: orphan ────────────────────────────────────────────────────

describe("fixLintResult — orphan", () => {
	it("adds wikilink to index.md", async () => {
		mockReadFile.mockResolvedValue("# Wiki Index\n- [[existing]]\n");

		const result = await fixLintResult(
			"/project",
			{
				type: "orphan",
				severity: "info",
				page: "entities/foo.md",
				detail: "No links",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		expect(result.filesWritten).toHaveLength(1);
		expect(mockWriteFile).toHaveBeenCalledWith(
			"/project/wiki/index.md",
			expect.stringContaining("[[foo]]"),
		);
	});

	it("does not duplicate if link already exists", async () => {
		mockReadFile.mockResolvedValue("# Wiki Index\n- [[foo]]\n");

		const result = await fixLintResult(
			"/project",
			{
				type: "orphan",
				severity: "info",
				page: "entities/foo.md",
				detail: "No links",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		// writeFile should NOT be called because the link already exists
		expect(mockWriteFile).not.toHaveBeenCalled();
	});
});

// ── fixLintResult: broken-link (LLM) ─────────────────────────────────────────

describe("fixLintResult — broken-link", () => {
	it("uses LLM to fix and writes back", async () => {
		mockReadFile.mockResolvedValue(
			"---\ntitle: Test\n---\nSome text with [[MissingPage]].",
		);
		mockStreamChat.mockImplementation(async (_c, _m, cb) => {
			cb.onToken(
				"---\ntitle: Test\n---\nSome text with MissingPage (link removed).",
			);
			cb.onDone();
		});

		const result = await fixLintResult(
			"/project",
			{
				type: "broken-link",
				severity: "warning",
				page: "entities/test.md",
				detail: "Broken link: [[MissingPage]]",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		expect(result.filesWritten).toHaveLength(1);
		expect(mockStreamChat).toHaveBeenCalled();
		// Verify prompt mentions the broken link
		const prompt = mockStreamChat.mock.calls[0][1][0].content as string;
		expect(prompt).toContain("[[MissingPage]]");
	});

	it("returns failure when LLM produces empty output", async () => {
		mockReadFile.mockResolvedValue("---\ntitle: Test\n---\nContent.");
		mockStreamChat.mockImplementation(async (_c, _m, cb) => {
			cb.onDone();
		});

		const result = await fixLintResult(
			"/project",
			{
				type: "broken-link",
				severity: "warning",
				page: "test.md",
				detail: "Broken link: [[X]]",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(false);
	});
});

// ── fixLintResult: no-outlinks (LLM) ─────────────────────────────────────────

describe("fixLintResult — no-outlinks", () => {
	it("uses LLM to add cross-references", async () => {
		mockReadFile.mockResolvedValue(
			"---\ntitle: Foo\n---\nFoo is related to bar and baz.",
		);
		mockListDirectory.mockResolvedValue([]);
		mockStreamChat.mockImplementation(async (_c, _m, cb) => {
			cb.onToken(
				"---\ntitle: Foo\n---\nFoo is related to [[bar]] and [[baz]].",
			);
			cb.onDone();
		});

		const result = await fixLintResult(
			"/project",
			{
				type: "no-outlinks",
				severity: "info",
				page: "entities/foo.md",
				detail: "No outbound links",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		expect(mockWriteFile).toHaveBeenCalled();
		const prompt = mockStreamChat.mock.calls[0][1][0].content as string;
		expect(prompt).toContain("no cross-references");
	});
});

// ── fixLintResult: semantic contradiction (LLM) ──────────────────────────────

describe("fixLintResult — semantic contradiction", () => {
	it("reads affected pages and writes FILE blocks back", async () => {
		mockReadFile
			.mockResolvedValueOnce("---\ntitle: A\n---\nX is 5.")
			.mockResolvedValueOnce("---\ntitle: B\n---\nX is 10.");
		mockStreamChat.mockImplementation(async (_c, _m, cb) => {
			cb.onToken(
				"---FILE: entities/a.md---\n---\ntitle: A\n---\nX is 5.\n---END FILE---\n---FILE: entities/b.md---\n---\ntitle: B\n---\nX is 10 (updated).\n---END FILE---",
			);
			cb.onDone();
		});

		const result = await fixLintResult(
			"/project",
			{
				type: "semantic",
				severity: "warning",
				page: "contradiction",
				detail: "[contradiction] A says X is 5, B says X is 10",
				affectedPages: ["entities/a.md", "entities/b.md"],
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		expect(result.filesWritten).toHaveLength(2);
	});
});

// ── fixLintResult: semantic stale (LLM) ──────────────────────────────────────

describe("fixLintResult — semantic stale", () => {
	it("asks LLM to review and update stale content", async () => {
		mockReadFile.mockResolvedValue(
			"---\ntitle: Tech\n---\nReact 18 is the latest.",
		);
		mockStreamChat.mockImplementation(async (_c, _m, cb) => {
			cb.onToken(
				"---\ntitle: Tech\n---\nReact 19 is the latest.\n\n> ⚠️ This section may need updating.",
			);
			cb.onDone();
		});

		const result = await fixLintResult(
			"/project",
			{
				type: "semantic",
				severity: "info",
				page: "tech/react.md",
				detail: "[stale] React 18 is outdated",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		expect(mockWriteFile).toHaveBeenCalled();
		const prompt = mockStreamChat.mock.calls[0][1][0].content as string;
		expect(prompt).toContain("outdated");
	});
});

// ── fixLintResult: semantic missing-page (LLM) ──────────────────────────────

describe("fixLintResult — semantic missing-page", () => {
	it("creates a new page from references", async () => {
		mockReadFile.mockResolvedValue("---\ntitle: A\n---\nRust is fast.");
		mockListDirectory.mockResolvedValue([]);
		mockStreamChat.mockImplementation(async (_c, _m, cb) => {
			cb.onToken(
				"---FILE: entities/rust.md---\n---\ntype: entity\ntitle: Rust\n---\nRust is a systems language.\n---END FILE---",
			);
			cb.onDone();
		});

		const result = await fixLintResult(
			"/project",
			{
				type: "semantic",
				severity: "info",
				page: "Rust",
				detail: "[missing-page] Rust has no page",
				affectedPages: ["entities/a.md"],
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(true);
		expect(mockWriteFile).toHaveBeenCalled();
		const prompt = mockStreamChat.mock.calls[0][1][0].content as string;
		expect(prompt).toContain("Rust");
	});
});

// ── fixLintResult: semantic suggestion (not fixable) ──────────────────────────

describe("fixLintResult — semantic suggestion", () => {
	it("returns failure for suggestion type", async () => {
		const result = await fixLintResult(
			"/project",
			{
				type: "semantic",
				severity: "info",
				page: "x",
				detail: "[suggestion] add a source",
			},
			fakeLlmConfig(),
		);

		expect(result.success).toBe(false);
		expect(result.detail).toContain("Cannot auto-fix");
	});
});

// ── fixAllLintResults ─────────────────────────────────────────────────────────

describe("fixAllLintResults", () => {
	it("only fixes fixable results", async () => {
		const results: LintResult[] = [
			{ type: "orphan", severity: "info", page: "a.md", detail: "" },
			{
				type: "semantic",
				severity: "info",
				page: "x",
				detail: "[suggestion] skip me",
			},
		];

		// orphan fix reads index.md
		mockReadFile.mockResolvedValue("# Wiki Index\n");

		const fixResults = await fixAllLintResults(
			"/project",
			results,
			fakeLlmConfig(),
		);

		expect(fixResults).toHaveLength(1); // only the orphan
		expect(fixResults[0].success).toBe(true);
	});

	it("handles empty input", async () => {
		const fixResults = await fixAllLintResults("/project", [], fakeLlmConfig());
		expect(fixResults).toHaveLength(0);
	});
});
