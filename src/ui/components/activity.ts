/**
 * What the panel says while a turn is running, and what it leaves behind.
 *
 * The live state is driven by **events that actually arrived**, in this order:
 *
 *   nothing yet                  →  准备中…
 *   `provider.selected`          →  selected provider is processing
 *   an `activity` event          →  reported activity
 *   the first `content.delta`    →  生成中…
 *
 * Each label describes an observed stream event. Providers need not emit every
 * event type; absent activity or reasoning content must never be invented.
 *
 * What it must never do is fill the gap with invented stages. A plausible list
 * of things the model is "doing" is indistinguishable from a true one, so it
 * asks to be trusted and offers no way to check.
 *
 * Afterwards it collapses to `用时 8 秒 · 详情`, and the detail is a short table
 * of numbers that can be pointed at: what was retrieved, what ran, what it cost.
 */

import { evidenceKindFromLabel } from "../../context/evidence";
import { contextDepthLabel } from "../../context/types";
import { t } from "../../i18n";
import { ICONS, iconSpan } from "../icons";
import type { ContextBuildReport, CorpusCoverageReport, CorpusPhaseTimings, ResearchContextReport } from "../../types";
import type { ContextCitation } from "../citations";
import type { ResearchProgress } from "../../session/ResearchController";

/** Before the Runtime has said anything. Functions, not constants: a constant
 * would freeze whichever locale was live at import time, before onload set it. */
export function preparingLabel(): string {
	return t("activity.preparing");
}

/** Once tokens are arriving. */
export function generatingLabel(): string {
	return t("activity.generating");
}

export interface LiveActivityOptions {
	/** True once content has begun streaming. */
	streaming: boolean;
	/** Provider the Runtime reported picking, if it has yet. */
	provider?: string;
	/** The most recent `activity` event, when the Runtime sends them. */
	upstream?: string;
	/** Client-owned stage for a multi-request whole-manuscript job. */
	stage?: string;
	/** Milliseconds since the request started. */
	elapsedMs?: number;
}

/**
 * The label to show right now.
 *
 * Ordered by how specific the evidence is: real upstream activity beats a
 * provider we know is working, which beats knowing only that we asked.
 */
export function currentActivityLabel(options: LiveActivityOptions): string {
	if (options.stage && options.stage.trim().length > 0) return options.stage;
	if (options.streaming) return generatingLabel();
	if (options.upstream && options.upstream.trim().length > 0) return options.upstream;
	if (options.provider) return t("activity.providerWorking", { provider: options.provider });
	return preparingLabel();
}

/** Honest, content-free progress for the client-owned full-corpus pipeline. */
export function fullCorpusActivityLabel(progress: {
	phase: "snapshot" | "evidence" | "leaf" | "reduce" | "final";
	current: number;
	total: number;
}): string {
	if (progress.phase === "snapshot") {
		return progress.total > 0 ? t("activity.readingCorpusN", { current: progress.current, total: progress.total }) : t("activity.readingCorpus");
	}
	if (progress.phase === "evidence") return t("activity.preparingEvidence");
	if (progress.phase === "leaf") return t("activity.analyzingCorpus", { current: progress.current, total: progress.total });
	return t("activity.summarizing");
}

/**
 * Honest, content-free progress for the client-owned bounded research loop.
 *
 * The counters were in this signature from the start and the body ignored all
 * of them, so a research turn showed one unchanging sentence for the thirty to
 * sixty seconds it takes. That reads as a hang rather than as work: nothing
 * says the loop is bounded, how far through it is, or that anything was found.
 *
 * Every number here is a fact about what the client did — an action it counted,
 * a file it opened. None of it describes the model's state, which this module's
 * header is explicit about never inventing.
 */
export function researchActivityLabel(progress: Pick<
	ResearchProgress,
	"phase" | "planningRound" | "maxPlanningRounds" | "queriesExecuted" | "filesRead"
>): string {
	const step = progress.planningRound > 0 && progress.maxPlanningRounds > 0
		? t("activity.researchStep", { round: Math.min(progress.planningRound, progress.maxPlanningRounds), max: progress.maxPlanningRounds })
		: "";
	if (progress.phase === "planning") {
		// Round one is the decision call: it may research or may simply answer,
		// and claiming "查找相关内容" while the model is composing a direct reply
		// would be the panel inventing a stage — the one thing this module's
		// header forbids. From round two onward research is a fact, not a guess.
		if (progress.planningRound <= 1) return t("activity.thinking");
		return step ? t("activity.searchingWith", { detail: step }) : t("activity.searching");
	}
	if (progress.phase === "retrieving") {
		const found = [
			progress.queriesExecuted > 0 ? t("activity.searchedN", { count: progress.queriesExecuted }) : "",
			progress.filesRead > 0 ? t("activity.readFilesN", { count: progress.filesRead }) : "",
		].filter(Boolean).join(" · ");
		const detail = [step, found].filter(Boolean).join(" · ");
		return detail ? t("activity.verifyingWith", { detail }) : t("activity.verifying");
	}
	return generatingLabel();
}

/** `8 秒`, or `1 分 04 秒` once a turn has been running a while. */
export function formatElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.round(elapsedMs / 1000));
	if (seconds < 60) return t("activity.seconds", { seconds });
	return t("activity.minSec", { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, "0") });
}

/**
 * How often a rendered reply time is rewritten.
 *
 * The labels change at minute granularity at their fastest, so a slower tick
 * would show a stale "刚刚" and a faster one would do nothing but work.
 */
export const REPLY_TIME_REFRESH_MS = 30_000;

/** Below this, a reply is still "just now" rather than a count of minutes. */
const JUST_NOW_MS = 60_000;

/**
 * When a reply was produced, in the smallest form that is still unambiguous.
 *
 * Duration answers how long it took; this answers when it happened, which is
 * what a writer returning to a thread actually needs. It is derived only from
 * the persisted `createdAt`: nothing here writes, and a refresh only rewrites
 * the label it already rendered.
 *
 * Returns null for a timestamp we cannot read, so a legacy or corrupted value
 * shows nothing rather than an invented date.
 */
export function replyTimeLabel(createdAt: string, now: number): string | null {
	const at = Date.parse(createdAt);
	if (!Number.isFinite(at)) return null;
	const elapsed = now - at;
	// Two devices rarely agree to the second. A reply from slightly in the
	// future is a clock difference, not something to announce.
	if (elapsed < JUST_NOW_MS) return t("activity.justNow");
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 60) return t("activity.minutesAgo", { minutes });

	const then = new Date(at);
	const today = new Date(now);
	const clock = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
	if (isSameDay(then, today)) return t("activity.todayAt", { clock });
	if (isSameDay(then, new Date(now - 86_400_000))) return t("activity.yesterdayAt", { clock });
	const date = then.getFullYear() === today.getFullYear()
		? t("activity.monthDay", { month: then.getMonth() + 1, day: then.getDate() })
		: t("activity.yearMonthDay", { year: then.getFullYear(), month: then.getMonth() + 1, day: then.getDate() });
	return t("activity.dateAt", { date, clock });
}

function isSameDay(left: Date, right: Date): boolean {
	return left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate();
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Live handles so streaming can patch in place instead of re-rendering. */
export interface LiveActivityHandles {
	root: HTMLElement;
	label: HTMLElement;
	elapsed: HTMLElement;
}

/** The in-progress indicator. Transient: it is not kept in the transcript. */
export function renderLiveActivity(parent: HTMLElement, options: LiveActivityOptions): LiveActivityHandles {
	const root = parent.createDiv({
		cls: "wb-activity-live",
		attr: { role: "status", "aria-live": "polite" },
	});

	root.createSpan({ cls: "wb-activity-pulse", attr: { "aria-hidden": "true" } });
	const label = root.createSpan({ cls: "wb-activity-label", text: currentActivityLabel(options) });
	const elapsed = root.createSpan({
		cls: "wb-activity-elapsed",
		text: options.elapsedMs === undefined ? "" : formatElapsed(options.elapsedMs),
	});

	return { root, label, elapsed };
}

// ---------------------------------------------------------------------------
// The detail table
// ---------------------------------------------------------------------------

/** One row: what happened, and the numbers for it. */
export interface DetailRow {
	label: string;
	detail: string;
}

/**
 * Everything verifiable about how a turn was produced.
 *
 * Persisted metadata supplies execution identity, Context accounting and Full
 * phase timings. The in-memory record adds ephemeral totals such as the whole
 * turn duration and Runtime timing, so a reopened conversation may still show
 * fewer rows rather than reconstructing values that were never saved.
 */
export interface ActivityDetails {
	/** How long the turn took, measured by this client. */
	durationMs?: number;
	/** What the Runtime itself measured, when it reported it. */
	runtimeMs?: number;
	connection?: string;
	connectionType?: string;
	connectionDetail?: string;
	provider?: string;
	model?: string;
	effort?: string;
	skillName?: string;
	/** Files and sections of manuscript this client actually sent. */
	contextFiles?: number;
	contextPassages?: number;
	contextChars?: number;
	contextReport?: ContextBuildReport;
	corpusTimings?: CorpusPhaseTimings;
	sources?: ContextCitation[];
	/** Sources the answer ended up citing. */
	citedSources?: number;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	reasoningTokens?: number;
	/** How many provider attempts it took, when more than one. */
	attempts?: number;
	fallback?: string;
	/** `+23 −13 字`, when the turn produced a rewrite candidate. */
	candidate?: string;
	/** Anything the Runtime reported as an `activity` event. */
	steps: string[];
}

/** True when there is anything worth disclosing. */
export function hasActivityDetails(details: ActivityDetails): boolean {
	return detailRows(details).length > 0 || details.steps.length > 0 || Boolean(details.sources?.length);
}

/**
 * The rows, in a fixed order: what we sent, what ran, what it cost, what it
 * produced.
 *
 * Every row is omitted when its data is absent rather than shown as a dash —
 * an empty row invites the reader to wonder what went wrong.
 */
export function detailRows(details: ActivityDetails): DetailRow[] {
	const rows: DetailRow[] = [];
	if (details.connection) rows.push({ label: t("activity.rowConnection"), detail: details.connection });
	if (details.connectionType) rows.push({ label: t("activity.rowType"), detail: connectionTypeName(details.connectionType) });
	if (details.connectionDetail) rows.push({ label: details.connectionType === "local" ? t("activity.rowEngine") : t("activity.rowPath"), detail: details.connectionDetail });

	// Legacy turns only have these aggregate counters. New turns carry a full
	// context report, whose composition row already includes retrieval volume.
	if (!details.contextReport && details.contextFiles !== undefined && details.contextFiles > 0) {
		const parts = [t("activity.filesN", { count: details.contextFiles })];
		if (details.contextPassages !== undefined) parts.push(t("activity.passagesN", { count: details.contextPassages }));
		if (details.contextChars !== undefined) parts.push(t("chip.charCount", { count: formatCount(details.contextChars) }));
		rows.push({ label: t("activity.rowLocalRetrieval"), detail: parts.join(" · ") });
	}

	if (details.contextReport) {
		const report = details.contextReport;
		if (report.corpusCoverage) {
			const coverage = report.corpusCoverage;
			const percent = corpusCoveragePercent(coverage);
			rows.push({
				label: t("activity.rowCorpusCoverage"),
				detail: t("activity.coverageDetail", {
					includedFiles: coverage.includedFiles,
					totalFiles: coverage.totalFiles,
					includedChars: formatCount(coverage.includedChars),
					totalChars: formatCount(coverage.totalChars),
					percent,
				}),
			});
			rows.push({ label: t("activity.rowAnalysisProgress"), detail: corpusAnalysisProgress(coverage) });
			const gaps = [
				coverage.readFailures > 0 ? t("activity.readFailuresN", { count: coverage.readFailures }) : "",
				coverage.uncoveredFiles.length > 0 ? t("activity.uncoveredN", { count: coverage.uncoveredFiles.length }) : "",
			].filter(Boolean);
			if (gaps.length > 0) rows.push({ label: t("activity.rowCoverageGaps"), detail: gaps.join(" · ") });
		}
		const mode = contextDepthLabel(report.mode === "full" ? "full" : report.mode === "low" ? "low" : "auto");
		rows.push({
			label: t("label.context"),
			detail: mode,
		});

		if (report.research) {
			const listedSources = new Set((details.sources ?? []).map((source) => source.path)).size;
			const sourcesUsed = listedSources || details.citedSources || report.research.citedEvidenceItems;
			rows.push(...researchDetailRows(report.research, sourcesUsed));
		}
	}
	if (details.corpusTimings) {
		const timings = details.corpusTimings;
		rows.push({
			label: t("activity.rowCorpusPhases"),
			detail: t("activity.corpusPhases", {
				snapshot: formatElapsed(timings.snapshotMs),
				evidence: formatElapsed(timings.evidenceMs),
				leaf: formatElapsed(timings.leafMs),
				reduce: formatElapsed(timings.reduceMs + timings.finalMs),
			}),
		});
	}

	const listedSources = new Set((details.sources ?? []).map((source) => source.path)).size;
	const filteredSourceList = Boolean(details.contextReport?.research || details.contextReport?.corpusCoverage);
	const citedSourceCount = details.citedSources ?? (filteredSourceList ? listedSources : 0);
	if (!details.contextReport?.research && citedSourceCount > 0) {
		rows.push({ label: t("activity.rowSources"), detail: t("activity.sourcesN", { count: citedSourceCount }) });
	}

	const ran = [
		details.provider,
		details.model,
		details.effort ? `Effort ${details.effort}` : undefined,
	].filter(
		(part): part is string => Boolean(part),
	);
	if (ran.length > 0) rows.push({ label: t("activity.rowModel"), detail: ran.join(" · ") });

	if (details.skillName) rows.push({ label: t("activity.rowSkill"), detail: details.skillName });

	const tokens: string[] = [];
	if (details.inputTokens !== undefined) tokens.push(t("activity.tokensIn", { count: formatCount(details.inputTokens) }));
	if (details.outputTokens !== undefined) tokens.push(t("activity.tokensOut", { count: formatCount(details.outputTokens) }));
	if (details.cachedInputTokens) tokens.push(t("activity.tokensCached", { count: formatCount(details.cachedInputTokens) }));
	if (details.reasoningTokens) tokens.push(t("activity.tokensReasoning", { count: formatCount(details.reasoningTokens) }));
	if (tokens.length > 0) rows.push({ label: t("activity.rowUsage"), detail: tokens.join(" · ") });

	const timing: string[] = [];
	if (details.durationMs !== undefined) timing.push(formatElapsed(details.durationMs));
	if (details.runtimeMs !== undefined) timing.push(t("activity.serverSide", { seconds: (details.runtimeMs / 1000).toFixed(1) }));
	if (timing.length > 0) rows.push({ label: t("activity.rowDuration"), detail: timing.join(" · ") });

	if (details.attempts !== undefined && details.attempts > 1) {
		rows.push({ label: t("activity.rowRetries"), detail: t("activity.retriesN", { count: details.attempts }) });
	}
	if (details.fallback) rows.push({ label: t("activity.rowFallback"), detail: details.fallback });
	if (details.candidate) rows.push({ label: t("activity.rowCandidate"), detail: details.candidate });

	return rows;
}

/** Content-free counters left by a bounded research run. */
export function researchDetailRows(
	report: ResearchContextReport,
	sourcesUsed = report.citedEvidenceItems,
): DetailRow[] {
	const detail = [
		t("activity.searchesN", { count: report.queriesExecuted }),
		t("activity.sourcesUsedN", { count: sourcesUsed }),
	];
	if (report.readFailures > 0) detail.push(t("activity.readFailN", { count: report.readFailures }));
	if (report.excludedByMetadata > 0) detail.push(t("activity.excludedN", { count: report.excludedByMetadata }));
	if (report.status !== "completed" || report.forcedSynthesis || report.limitsReached.deadline) {
		detail.push(researchIncompleteNote(report));
	}
	return [{ label: "Research", detail: detail.join(" · ") }];
}

/**
 * Say *why* the run stopped short, without naming protocol internals.
 *
 * "0 次搜索 · 研究未完整结束" reads identically whether the model decided it had
 * enough already or whether it answered in a shape the client could not use —
 * and those two call for opposite responses from the writer. Naming which one
 * happened is the difference between a dead counter and something actionable.
 *
 * What stays hidden is the machine reason: `missing-sentinel` tells a novelist
 * nothing. Each of them maps onto a sentence about the run instead.
 */
function researchIncompleteNote(report: ResearchContextReport): string {
	switch (report.planFallbackReason) {
		case "missing-sentinel":
		case "multiple-sentinels":
		case "trailing-content":
		case "missing-json":
		case "malformed-json":
		case "invalid-shape":
			return t("activity.researchProtocolFallback");
		case "unsafe-query":
		case "empty-query":
			return t("activity.researchQueryUnusable");
		case "no-new-query":
		case "duplicate-query":
		case "query-limit":
			return t("activity.researchBudgetSpent");
		default:
			return t("activity.researchIncomplete");
	}
}

function corpusCoveragePercent(coverage: CorpusCoverageReport): number {
	const ratio = coverage.totalChars === 0
		? (coverage.totalFiles === 0 ? 0 : coverage.includedFiles / coverage.totalFiles)
		: coverage.includedChars / coverage.totalChars;
	return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function corpusAnalysisProgress(coverage: CorpusCoverageReport): string {
	const completedLeafBatches = Array.isArray(coverage.completedBatchIndexes)
		? new Set(coverage.completedBatchIndexes.filter((index) =>
			Number.isInteger(index) && index >= 0 && index < coverage.totalBatches,
		)).size
		: coverage.completedBatches;
	const leafPercent = coverage.totalBatches === 0
		? 0
		: Math.max(0, Math.min(100, Math.round(completedLeafBatches / coverage.totalBatches * 100)));
	const parts = [t("activity.leafBatches", { done: completedLeafBatches, total: coverage.totalBatches })];
	if (coverage.totalReductionBatches !== undefined) {
		parts.push(t("activity.reduceBatches", { done: coverage.reductionBatches, total: coverage.totalReductionBatches }));
	} else {
		parts.push(t("activity.reduceBatchesOpen", { count: coverage.reductionBatches }));
	}
	parts.push(corpusSummaryProgress(coverage, leafPercent, completedLeafBatches));
	return parts.join(" · ");
}

function corpusSummaryProgress(
	coverage: CorpusCoverageReport,
	leafPercent: number,
	completedLeafBatches: number,
): string {
	if (coverage.summaryStatus === "complete") return t("activity.summaryComplete");
	if (coverage.summaryStatus === "degraded") return t("activity.summaryDegraded");
	if (coverage.summaryStatus === "partial") {
		return t("activity.summaryPartial", { done: completedLeafBatches, total: coverage.totalBatches });
	}
	if (coverage.summaryStatus === undefined && coverage.status === "partial") {
		return t("activity.summaryPartial", { done: completedLeafBatches, total: coverage.totalBatches });
	}
	if (coverage.summaryStatus === undefined && coverage.status === "degraded") {
		return t("activity.summaryDegraded");
	}

	// A legacy `complete` report could only be persisted after final synthesis
	// passed its coverage checks, so it remains a completed summary. Richer new
	// reports make that terminal state explicit and take precedence above.
	if (coverage.summaryStatus === undefined && coverage.status === "complete") return t("activity.summaryComplete");

	const reading = leafPercent === 100 ? t("activity.readDone") : t("activity.readPercent", { percent: leafPercent });
	const reason = corpusIncompleteReason(coverage);
	return reason ? t("activity.withReason", { reading, reason }) : reading;
}

function corpusIncompleteReason(coverage: CorpusCoverageReport): string | undefined {
	if (coverage.limitReached === "deadline" || coverage.limitReached === "soft-deadline") {
		return t("activity.reasonDeadline");
	}
	if (coverage.limitReached === "backend-call-limit") return t("activity.reasonCallLimit");
	if (coverage.status === "cancelled") return t("activity.reasonCancelled");
	return undefined;
}

function connectionTypeName(value: string): string {
	if (value === "direct-api") return "Direct API";
	if (value === "local") return "Local";
	return value;
}

/** `2,889`. Thousands separators, because these are numbers to be read. */
export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * The post-generation disclosure, collapsed by default.
 *
 * Renders nothing when there is nothing to say, so an ordinary answer carries no
 * extra chrome at all.
 */
export function renderActivityDisclosure(
	parent: HTMLElement,
	details: ActivityDetails,
	expanded: boolean,
	onToggle: () => void,
	/**
	 * Where the expanded content goes. Callers pass a container *outside* the
	 * action row so that expanding cannot move the buttons beside the toggle.
	 */
	bodyParent?: HTMLElement,
	onOpenSource?: (source: ContextCitation) => void,
): void {
	if (!hasActivityDetails(details)) return;

	const wrap = parent.createDiv({ cls: "wb-activity-past" });
	const toggle = wrap.createEl("button", {
		cls: `wb-activity-toggle${expanded ? " is-expanded" : ""}`,
		attr: { type: "button", "aria-expanded": String(expanded) },
	});
	iconSpan(toggle, expanded ? ICONS.expanded : ICONS.collapsed, "wb-activity-chevron");
	toggle.createSpan({ text: activitySummary(details) });
	toggle.addEventListener("click", onToggle);

	if (!expanded) return;

	const body = (bodyParent ?? wrap).createDiv({ cls: "wb-activity-body" });
	const rows = detailRows(details);
	if (rows.length > 0) {
		const facts = body.createDiv({ cls: "wb-activity-facts" });
		for (const row of rows) {
			const line = facts.createDiv({ cls: "wb-activity-fact" });
			line.createSpan({ cls: "wb-activity-fact-key", text: row.label });
			line.createSpan({ cls: "wb-activity-fact-value", text: row.detail });
		}
	}

	if (details.sources && details.sources.length > 0) {
		const sources = body.createDiv({ cls: "wb-activity-sources" });
		sources.createDiv({
			cls: "wb-activity-sources-title",
			text: details.contextReport?.corpusCoverage || details.contextReport?.research
				? t("activity.sourcesFinal")
				: t("activity.sourcesProvided"),
		});
		const list = sources.createDiv({ cls: "wb-activity-sources-list" });
		for (const source of details.sources) {
			const button = list.createEl("button", {
				cls: "wb-source-inline",
				text: `${sourceKindName(source)} · ${source.label}`,
				attr: { type: "button", title: source.path },
			});
			button.addEventListener("click", () => onOpenSource?.(source));
		}
	}

	// Only what the Runtime actually reported. If it reported nothing, the
	// disclosure says nothing rather than filling the space.
	if (details.steps.length > 0) {
		const list = body.createEl("ul", { cls: "wb-activity-list" });
		for (const step of details.steps) list.createEl("li", { text: step });
	}
}

// Saved citations carry a label, not a kind; the label was written in whichever
// language the interface had at the time, so the kind is read back from it.
function sourceKindName(source: ContextCitation): string {
	switch (evidenceKindFromLabel(source.label)) {
		case "selection": return t("activity.kindSelection");
		case "context": return t("activity.kindContext");
		case "character": return t("activity.kindCharacter");
		case "world": return t("activity.kindWorld");
		case "outline": return t("activity.kindOutline");
		default: return t("activity.kindVault");
	}
}

/**
 * The one-line summary left behind once a turn finishes.
 *
 * Time taken, because that is a fact, and `详情` rather than a section title —
 * this is a footnote on an answer, not a subsystem with a name.
 */
export function activitySummary(details: ActivityDetails): string {
	if (details.durationMs === undefined) return t("activity.details");
	return t("activity.tookDetails", { duration: formatElapsed(details.durationMs) });
}
