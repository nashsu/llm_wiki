import {
	AlertTriangle,
	ArrowUpRight,
	BrainCircuit,
	CheckCircle2,
	Info,
	Link2Off,
	RefreshCw,
	Sparkles,
	Trash2,
	Unlink,
	Wrench,
	Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listDirectory, readFile, writeFile } from "@/commands/fs";
import { Button } from "@/components/ui/button";
import { hasUsableLlm } from "@/lib/has-usable-llm";
import { runSemanticLint, runStructuralLint } from "@/lib/lint";
import { fixAllLintResults, fixLintResult, isFixable } from "@/lib/lint-fixer";
import { normalizePath } from "@/lib/path-utils";
import { useReviewStore } from "@/stores/review-store";
import { useWikiStore } from "@/stores/wiki-store";
import { useLintStore, type LintItem } from "@/stores/lint-store";

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
	warnings: LintItem[];
	infos: LintItem[];
} {
	const warnings: LintItem[] = [];
	const infos: LintItem[] = [];

	results.forEach((result) => {
		if (result.severity === "warning") {
			warnings.push(result);
		} else {
			infos.push(result);
		}
	});

	return { warnings, infos };
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
	return hasRun || itemCount > 0;
}

export function LintView() {
	const { t } = useTranslation();
	const project = useWikiStore((s) => s.project);
	const setFileTree = useWikiStore((s) => s.setFileTree);
	const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion);
	const llmConfig = useWikiStore((s) => s.llmConfig);
	const setSelectedFile = useWikiStore((s) => s.setSelectedFile);
	const setFileContent = useWikiStore((s) => s.setFileContent);
	const items = useLintStore((s) => s.items);
	const agentLint = useLintStore((s) => s.agentLint);
	const addLintItems = useLintStore((s) => s.addItems);
	const removeLintItem = useLintStore((s) => s.removeItem);
	const clearLintItems = useLintStore((s) => s.clearItems);
	const setLintItems = useLintStore((s) => s.setItems);

	const [running, setRunning] = useState(false);
	const [hasRun, setHasRun] = useState(false);
	const [runSemantic, setRunSemantic] = useState(false);
	const [fixingId, setFixingId] = useState<string | null>(null);
	const [fixingAll, setFixingAll] = useState(false);

	const typeConfig = useMemo(
		() => ({
			orphan: { icon: Link2Off, label: t("lint.typeLabels.orphan") },
			"broken-link": { icon: Unlink, label: t("lint.typeLabels.broken-link") },
			"no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
			semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
		}),
		[t],
	);

	const refreshTree = useCallback(async () => {
		if (!project) return;
		try {
			const tree = await listDirectory(project.path);
			setFileTree(tree);
			bumpDataVersion();
		} catch {
			// ignore
		}
	}, [project, setFileTree, bumpDataVersion]);

	async function handleRunLint() {
		if (!project || running) return;
		const pp = normalizePath(project.path);
		setRunning(true);
		clearLintItems();
		try {
			const structural = await runStructuralLint(pp);
			let all = structural;
			if (runSemantic) {
				const semantic = await runSemanticLint(pp, llmConfig);
				all = [...structural, ...semantic];
			}
			setHasRun(true);
			addLintItems(all);
		} catch (err) {
			console.error("Lint failed:", err);
		} finally {
			setRunning(false);
		}
	}

	async function handleOpenPage(page: string) {
		if (!project) return;
		const pp = normalizePath(project.path);
		const candidates = [`${pp}/wiki/${page}`, `${pp}/wiki/${page}.md`];
		for (const p of candidates) {
			try {
				const content = await readFile(p);
				setSelectedFile(p);
				setFileContent(content);
				return;
			} catch {
				// try next
			}
		}
		setSelectedFile(candidates[0]);
		setFileContent(`Unable to load: ${page}`);
	}

	async function handleFix(item: LintItem) {
		if (!project) return;
		const pp = normalizePath(project.path);
		setFixingId(item.id);

		try {
			switch (item.type) {
				case "orphan": {
					const indexPath = `${pp}/wiki/index.md`;
					let indexContent = "";
					try {
						indexContent = await readFile(indexPath);
					} catch {
						indexContent = "# Wiki Index\n";
					}

					const pageName = item.page.replace(".md", "").replace(/^.*\//, "");
					const entry = `- [[${pageName}]]`;
					if (!indexContent.includes(entry)) {
						indexContent = indexContent.trimEnd() + "\n" + entry + "\n";
						await writeFile(indexPath, indexContent);
					}
					removeLintItem(item.id);
					break;
				}

				case "broken-link": {
					const pagePath = `${pp}/wiki/${item.page}`;
					useReviewStore.getState().addItem({
						type: "confirm",
						title: t("lint.fixBrokenLink", { page: item.page }),
						description: item.detail,
						affectedPages: [item.page],
						options: [
							{ label: t("lint.openEdit"), action: `open:${item.page}` },
							{ label: t("lint.deletePage"), action: `delete:${pagePath}` },
							{ label: t("lint.skip"), action: "Skip" },
						],
					});
					removeLintItem(item.id);
					break;
				}

				case "no-outlinks": {
					useReviewStore.getState().addItem({
						type: "suggestion",
						title: t("lint.addCrossRefs", { page: item.page }),
						description: t("lint.addCrossRefsDescription"),
						affectedPages: [item.page],
						options: [
							{ label: t("lint.openEdit"), action: `open:${item.page}` },
							{ label: t("lint.skip"), action: "Skip" },
						],
					});
					removeLintItem(item.id);
					break;
				}

				default: {
					useReviewStore.getState().addItem({
						type: "confirm",
						title: item.detail.slice(0, 80),
						description: item.detail,
						affectedPages: item.affectedPages ?? [item.page],
						options: [
							{ label: t("lint.openEdit"), action: `open:${item.page}` },
							{ label: t("lint.skip"), action: "Skip" },
						],
					});
					removeLintItem(item.id);
					break;
				}
			}

			const tree = await listDirectory(pp);
			setFileTree(tree);
			bumpDataVersion();
		} catch (err) {
			console.error("Fix failed:", err);
		} finally {
			setFixingId(null);
		}
	}

	async function handleAutoFix(item: LintItem) {
		if (!project) return;
		const pp = normalizePath(project.path);
		setFixingId(`autofix-${item.id}`);

		try {
			const ok = await fixLintResult(pp, item, llmConfig);
			if (ok) {
				removeLintItem(item.id);
				await refreshTree();
			}
		} catch (err) {
			console.error("Auto fix failed:", err);
		} finally {
			setFixingId(null);
		}
	}

	async function handleFixAll() {
		if (!project || fixingAll) return;
		const pp = normalizePath(project.path);
		setFixingAll(true);

		try {
			const fixableItems = items.filter(isFixable);
			const { fixed } = await fixAllLintResults(pp, fixableItems, llmConfig);
			if (fixed.length > 0) {
				const fixedPages = new Set(fixed.map((r) => `${r.type}:${r.page}`));
				const remaining = items.filter(item => !fixedPages.has(`${item.type}:${item.page}`));
				setLintItems(remaining);
				await refreshTree();
			}
		} catch (err) {
			console.error("Fix all failed:", err);
		} finally {
			setFixingAll(false);
		}
	}

	async function handleDeleteOrphan(item: LintItem) {
		if (!project) return;
		const pp = normalizePath(project.path);
		const pagePath = `${pp}/wiki/${item.page}`;
		const confirmed = window.confirm(
			t("lint.deleteOrphanConfirm", { page: item.page }),
		);
		if (!confirmed) return;

		try {
			const { cascadeDeleteWikiPagesWithRefs } = await import(
				"@/lib/wiki-page-delete"
			);
			await cascadeDeleteWikiPagesWithRefs(pp, [pagePath]);
			removeLintItem(item.id);
			await refreshTree();
		} catch (err) {
			console.error("Delete failed:", err);
		}
	}

	const { warnings, infos } = useMemo(
		() => groupLintResultsForDisplay(items),
		[items],
	);
	const shouldRenderResults = shouldShowLintResults(hasRun, items.length);
	const showAgentLintStatus = agentLint.status !== "idle";

	const canAutoFix =
		hasRun &&
		items.length > 0 &&
		hasUsableLlm(llmConfig) &&
		items.some(isFixable);

	return (
		<div className="flex h-full flex-col">
			<div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-semibold">{t("lint.title")}</h2>
					{items.length > 0 && (
						<span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
							{items.length === 1
								? t("lint.issues", { count: items.length })
								: t("lint.issues_plural", { count: items.length })}
						</span>
					)}
					{showAgentLintStatus && (
						<span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
							{t(`agent.lint.${agentLint.status}`)}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
						<input
							type="checkbox"
							className="h-3 w-3"
							checked={runSemantic}
							onChange={(e) => setRunSemantic(e.target.checked)}
						/>
						{t("lint.semantic")}
					</label>
					{canAutoFix && (
						<Button
							variant="outline"
							size="sm"
							className="h-7 text-xs gap-1"
							disabled={fixingAll}
							onClick={handleFixAll}
						>
							<Zap className="h-3 w-3" />
							{fixingAll ? t("lint.fixingAll") : t("lint.fixAll")}
						</Button>
					)}
					<Button
						size="sm"
						onClick={handleRunLint}
						disabled={running || !project}
					>
						<RefreshCw
							className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`}
						/>
						{running ? t("lint.running") : t("lint.runLint")}
					</Button>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				{!shouldRenderResults ? (
					<div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
						<CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
						<p>{t("lint.runLintHint")}</p>
						<p className="text-xs">{t("lint.runLintDescription")}</p>
					</div>
				) : items.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
						<CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
						<p className="text-emerald-600 dark:text-emerald-400 font-medium">
							{t("lint.allClear")}
						</p>
						<p className="text-xs">{t("lint.noIssues")}</p>
					</div>
				) : (
					<div className="flex flex-col gap-2 p-3">
						{warnings.length > 0 && (
							<SectionHeader
								icon={AlertTriangle}
								label={t("lint.warnings")}
								count={warnings.length}
								color="text-amber-500"
								t={t}
							/>
						)}
						{warnings.map((item) => (
							<LintCard
								key={item.id}
								item={item}
								fixing={
									fixingId === item.id ||
									fixingId === `autofix-${item.id}`
								}
								onOpenPage={handleOpenPage}
								onFix={handleFix}
								onAutoFix={
									hasUsableLlm(llmConfig) && isFixable(item)
										? handleAutoFix
										: undefined
								}
								onDelete={
									item.type === "orphan" ? handleDeleteOrphan : undefined
								}
								typeConfig={typeConfig}
								t={t}
							/>
						))}
						{infos.length > 0 && (
							<SectionHeader
								icon={Info}
								label={t("lint.info")}
								count={infos.length}
								color="text-blue-500"
								t={t}
							/>
						)}
						{infos.map((item) => (
							<LintCard
								key={item.id}
								item={item}
								fixing={
									fixingId === item.id ||
									fixingId === `autofix-${item.id}`
								}
								onOpenPage={handleOpenPage}
								onFix={handleFix}
								onAutoFix={
									hasUsableLlm(llmConfig) && isFixable(item)
										? handleAutoFix
										: undefined
								}
								onDelete={
									item.type === "orphan" ? handleDeleteOrphan : undefined
								}
								typeConfig={typeConfig}
								t={t}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function SectionHeader({
	icon: Icon,
	label,
	count,
	color,
	t,
}: {
	icon: typeof AlertTriangle;
	label: string;
	count: number;
	color: string;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	return (
		<div
			className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}
		>
			<Icon className="h-3.5 w-3.5" />
			{t("lint.sectionCount", { label, count })}
		</div>
	);
}

function LintCard({
	item,
	fixing,
	onOpenPage,
	onFix,
	onAutoFix,
	onDelete,
	typeConfig,
	t,
}: {
	item: LintItem;
	fixing: boolean;
	onOpenPage: (page: string) => void;
	onFix: (item: LintItem) => void;
	onAutoFix?: (item: LintItem) => void;
	onDelete?: (item: LintItem) => void;
	typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	const config = typeConfig[item.type] ?? typeConfig.semantic;
	const Icon = config.icon;

	return (
		<div className="rounded-lg border p-3 text-sm">
			<div className="mb-1.5 flex items-start gap-2">
				<Icon
					className={`mt-0.5 h-4 w-4 shrink-0 ${
						item.severity === "warning" ? "text-amber-500" : "text-blue-500"
					}`}
				/>
				<div className="flex-1 min-w-0">
					<div className="font-medium truncate">{item.page}</div>
					<div className="text-[11px] text-muted-foreground">
						{config.label}
					</div>
				</div>
			</div>

			<p className="mb-2 text-xs text-muted-foreground">{item.detail}</p>

			{item.affectedPages && item.affectedPages.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-1">
					{item.affectedPages.map((page) => (
						<button
							key={page}
							type="button"
							onClick={() => onOpenPage(page)}
							className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
						>
							{page}
						</button>
					))}
				</div>
			)}

			<div className="flex items-center gap-1.5 mt-2">
				<Button
					variant="outline"
					size="sm"
					className="h-6 text-xs gap-1"
					onClick={() => onOpenPage(item.page)}
				>
					{t("lint.open")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-6 text-xs gap-1"
					disabled={fixing}
					onClick={() => onFix(item)}
				>
					<Wrench className="h-3 w-3" />
					{fixing ? t("lint.fixing") : t("lint.fix")}
				</Button>
				{onAutoFix && (
					<Button
						variant="outline"
						size="sm"
						className="h-6 text-xs gap-1"
						disabled={fixing}
						onClick={() => onAutoFix(item)}
					>
						<Sparkles className="h-3 w-3" />
						{fixing ? t("lint.fixing") : t("lint.autoFix")}
					</Button>
				)}
				{onDelete && (
					<Button
						variant="outline"
						size="sm"
						className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
						onClick={() => onDelete(item)}
					>
						<Trash2 className="h-3 w-3" />
						{t("lint.delete")}
					</Button>
				)}
			</div>
		</div>
	);
}
