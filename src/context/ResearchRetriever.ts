/**
 * Bounded, client-owned tools for Agent-led Vault research.
 *
 * Search discovers safe previews and opaque R# handles. It never admits those
 * previews as citeable evidence. Only an explicit read resolves a run-local R#
 * and adds an S# item to the evidence ledger. readAround expands a run-local S#
 * against the same source revision. No method accepts a Vault path from a model.
 */

import type { EvidenceItem, EvidenceKind } from "./evidence";
import { contextHeadingLabel, kindOf, labelFor, splitSections } from "./evidence";
import { hasExplicitArchiveMetadata, isEligibleContextPath } from "./eligibility";
import { extractRelevantPassage, extractTerms, previewAroundMatch } from "./retrieval";
import type { VaultReader } from "./types";
import type { DocRange } from "../types";
import type {
	ResearchReadAroundObservation,
	ResearchReadObservation,
	ResearchSearchObservation,
	ResearchSearchObservationItem,
	ResearchToolFailureObservation,
} from "./ResearchProtocol";
import { DEFAULT_RESEARCH_AROUND_CHARS, MAX_RESEARCH_AROUND_CHARS } from "./ResearchProtocol";
import { countChars } from "../util/text";
import { contentRevision } from "./revision";

export const DEFAULT_RESEARCH_FILE_LIMIT = 12;
export const DEFAULT_RESEARCH_EVIDENCE_LIMIT = 16;
export const DEFAULT_RESEARCH_CHAR_LIMIT = 24_000;
export const DEFAULT_RESEARCH_PER_EVIDENCE_CHARS = 6_000;
export const DEFAULT_RESEARCH_SEARCH_RESULT_LIMIT = 6;
export const DEFAULT_RESEARCH_SEARCH_SNIPPET_CHARS = 600;

/** Hard ceilings remain in force even when a caller supplies a larger budget. */
export const MAX_RESEARCH_FILE_LIMIT = 32;
/**
 * Files one run may open purely to rank them.
 *
 * Probing is how content gets a say in ranking: content hits outweigh filename
 * hits by design (`localHits * 100` vs `pathHits * 30`), but they are only
 * computable for a file that has been opened. While probes and admissions drew
 * on one counter, a search could probe six files at most — chosen by filename
 * and link — so a manuscript whose chapters are called 卷01…卷11 answered plot
 * questions from whatever the path hash surfaced.
 *
 * Probing is a local disk read; the whole test vault (8.3M characters) is
 * processed in well under a second. What it must never do is starve the reads
 * that admit evidence, which is exactly why it no longer shares their budget.
 */
export const DEFAULT_RESEARCH_PROBE_LIMIT = 60;
export const MAX_RESEARCH_PROBE_LIMIT = 200;
export const MAX_RESEARCH_EVIDENCE_LIMIT = 32;
export const MAX_RESEARCH_CHAR_LIMIT = 64_000;
export const MAX_RESEARCH_PER_EVIDENCE_CHARS = 12_000;
export const MAX_RESEARCH_SEARCH_RESULT_LIMIT = 12;

/** The narrow, read-only surface retrieval needs. A VaultReader satisfies it. */
export interface ResearchSearchSource {
	listMarkdownFiles(): string[];
	read(path: string): Promise<string>;
	linksFrom(path: string): string[];
	activeFilePath(): string | null;
	/** Live unsaved text for the active file, when the host can provide it. */
	activeFileText?(): string | null;
}

export interface ResearchEligibilityService {
	isEligible(path: string, options: { includeArchives: boolean; activeFilePath: string | null }): boolean;
	hasArchiveMetadata(text: string): boolean;
}

const DEFAULT_ELIGIBILITY: ResearchEligibilityService = {
	isEligible: (path, options) => isEligibleContextPath(path, options),
	hasArchiveMetadata: hasExplicitArchiveMetadata,
};

export interface ResearchRetrievalBudget {
	/** Reads that verify and admit sources — never spent on ranking. */
	maxFilesRead: number;
	/** Files a search may open to rank them. Local cost only. */
	maxFilesProbed: number;
	maxEvidenceItems: number;
	/** Automatic evidence allowance; explicit selection evidence is preserved whole. */
	maxEvidenceChars: number;
	perEvidenceChars: number;
}

export const DEFAULT_RESEARCH_RETRIEVAL_BUDGET: Readonly<ResearchRetrievalBudget> = Object.freeze({
	maxFilesRead: DEFAULT_RESEARCH_FILE_LIMIT,
	maxFilesProbed: DEFAULT_RESEARCH_PROBE_LIMIT,
	maxEvidenceItems: DEFAULT_RESEARCH_EVIDENCE_LIMIT,
	maxEvidenceChars: DEFAULT_RESEARCH_CHAR_LIMIT,
	perEvidenceChars: DEFAULT_RESEARCH_PER_EVIDENCE_CHARS,
});

export interface ResearchRetrieverOptions {
	eligibility?: ResearchEligibilityService;
	now?: () => number;
	maxSearchResults?: number;
	searchSnippetChars?: number;
}

/** Content-free measurements. No query, path, excerpt, or model prose appears. */
export interface ResearchRetrievalReport {
	queries: number;
	filesConsidered: number;
	filesRead: number;
	readFailures: number;
	excludedByMetadata: number;
	evidenceAdded: number;
	evidenceDeduplicated: number;
	charsAdded: number;
	fileLimitReached: boolean;
	evidenceLimitReached: boolean;
	charLimitReached: boolean;
}

export interface ResearchRetrieveOptions {
	signal?: AbortSignal;
	/** Absolute epoch milliseconds shared by the entire controller run. */
	deadlineAt?: number;
}

export interface ResearchSearchResult {
	observation: ResearchSearchObservation;
	report: ResearchRetrievalReport;
}

export interface ResearchReadResult {
	observation: ResearchReadObservation | ResearchToolFailureObservation;
	report: ResearchRetrievalReport;
}

export interface ResearchReadAroundResult {
	observation: ResearchReadAroundObservation | ResearchToolFailureObservation;
	report: ResearchRetrievalReport;
}

export class ResearchRetrievalCancelledError extends Error {
	constructor() {
		super("Research retrieval cancelled");
		this.name = "ResearchRetrievalCancelledError";
	}
}

export class ResearchRetrievalDeadlineError extends Error {
	constructor() {
		super("Research retrieval deadline exceeded");
		this.name = "ResearchRetrievalDeadlineError";
	}
}

/** Stable evidence ids and deduplication state for one run. */
export class ResearchEvidenceLedger {
	private readonly items: EvidenceItem[] = [];
	private readonly identities = new Set<string>();
	private readonly fingerprints = new Set<string>();
	private readonly ids = new Set<string>();
	private nextId = 1;
	private chars = 0;
	private deduplicated = 0;

	constructor(
		initialEvidence: readonly EvidenceItem[] = [],
		private readonly budget: ResearchRetrievalBudget = DEFAULT_RESEARCH_RETRIEVAL_BUDGET,
	) {
		for (const item of initialEvidence) this.add(item, true, item.kind === "selection");
	}

	get evidence(): EvidenceItem[] { return this.items.map((item) => ({ ...item })); }
	get size(): number { return this.items.length; }
	get charsUsed(): number { return this.chars; }
	get deduplicatedCount(): number { return this.deduplicated; }
	get isEvidenceFull(): boolean { return this.items.length >= this.budget.maxEvidenceItems; }
	get isCharFull(): boolean { return this.chars >= this.budget.maxEvidenceChars; }

	get(id: string): EvidenceItem | null {
		const item = this.items.find((candidate) => candidate.id.toUpperCase() === id.toUpperCase());
		return item ? { ...item } : null;
	}

	findEquivalent(candidate: EvidenceItem): EvidenceItem | null {
		const identity = evidenceIdentity(candidate);
		const fingerprint = evidenceFingerprint(candidate.excerpt);
		const item = this.items.find((existing) =>
			evidenceIdentity(existing) === identity || (fingerprint.length > 0 && evidenceFingerprint(existing.excerpt) === fingerprint));
		return item ? { ...item } : null;
	}

	/** Add one item, returning the stable admitted clone or null when omitted. */
	add(candidate: EvidenceItem, preserveId = false, preserveWhole = false): EvidenceItem | null {
		if (!safeEvidencePath(candidate.path) || !candidate.excerpt.trim()) return null;
		const identity = evidenceIdentity(candidate);
		const fingerprint = evidenceFingerprint(candidate.excerpt);
		if (this.identities.has(identity) || (fingerprint && this.fingerprints.has(fingerprint))) {
			this.deduplicated += 1;
			return null;
		}
		if (!preserveWhole && (this.isEvidenceFull || this.isCharFull)) return null;

		const originalChars = countChars(candidate.excerpt);
		const allowance = preserveWhole
			? originalChars
			: Math.min(this.budget.perEvidenceChars, this.budget.maxEvidenceChars - this.chars);
		if (allowance <= 0) return null;
		const excerpt = truncateEvidenceExcerpt(candidate.excerpt, allowance);
		if (!excerpt.trim()) return null;

		const preferred = preserveId && /^S[1-9]\d*$/iu.test(candidate.id) ? candidate.id.toUpperCase() : null;
		const id = preferred && !this.ids.has(preferred) ? preferred : this.allocateId();
		const numeric = /^S([1-9]\d*)$/u.exec(id);
		if (numeric) this.nextId = Math.max(this.nextId, Number(numeric[1]) + 1);

		const admitted: EvidenceItem = {
			...candidate, id, excerpt, truncated: candidate.truncated || originalChars > allowance,
		};
		this.items.push(admitted);
		this.ids.add(id);
		this.identities.add(identity);
		if (fingerprint) this.fingerprints.add(fingerprint);
		this.chars += countChars(excerpt);
		return { ...admitted };
	}

	/** Replace one evidence excerpt with a larger bounded window, preserving S#. */
	expand(id: string, excerpt: string, truncated: boolean): EvidenceItem | null {
		const index = this.items.findIndex((item) => item.id.toUpperCase() === id.toUpperCase());
		if (index === -1) return null;
		const current = this.items[index];
		const currentChars = countChars(current.excerpt);
		const allowance = Math.min(
			this.budget.perEvidenceChars,
			Math.max(currentChars, this.budget.maxEvidenceChars - (this.chars - currentChars)),
		);
		if (allowance <= currentChars) return { ...current };
		const expanded = truncateEvidenceExcerpt(excerpt, allowance);
		if (!expanded.trim() || countChars(expanded) <= currentChars) return { ...current };
		// The selection is the passage a rewrite replaces. Widened, it is no
		// longer that passage: kept as "the selected text" it would travel into
		// the rewrite as such, and a rewrite of the wider window would repeat the
		// sentences around the selection once applied. It becomes the selection's
		// context, as the evidence around a selection is everywhere else; the
		// selection itself always travels with the rewrite on its own.
		const relabel = current.kind === "selection"
			? { kind: "current" as const, heading: contextHeadingLabel(), label: `${current.name} · ${contextHeadingLabel()}` }
			: {};
		const updated = { ...current, ...relabel, excerpt: expanded, truncated: truncated || countChars(excerpt) > allowance };
		this.items[index] = updated;
		this.chars += countChars(expanded) - currentChars;
		this.fingerprints.add(evidenceFingerprint(expanded));
		return { ...updated };
	}

	private allocateId(): string {
		while (this.ids.has(`S${this.nextId}`)) this.nextId += 1;
		const id = `S${this.nextId}`;
		this.nextId += 1;
		return id;
	}
}

interface SourceSnapshot {
	path: string;
	text: string;
	revision: string;
	revisionKind: "saved" | "editor";
	excludedByMetadata: boolean;
}

interface ResultLocator {
	handle: string;
	item: EvidenceItem;
	path: string;
	revision: string;
	revisionKind: "saved" | "editor";
}

interface EvidenceLocator {
	path: string;
	revision?: string;
	revisionKind?: "saved" | "editor";
	anchorText: string;
	excerpt: string;
	range?: DocRange;
}

/** Mutable state is scoped to one controller run. Handles cannot cross runs. */
export class ResearchRetrievalSession {
	readonly ledger: ResearchEvidenceLedger;
	readonly budget: ResearchRetrievalBudget;
	readonly includeArchives: boolean;
	private readonly visitedPaths = new Set<string>();
	private readonly snapshots = new Map<string, SourceSnapshot>();
	private readonly resultLocators = new Map<string, ResultLocator>();
	private readonly resultIdentityHandles = new Map<string, string>();
	private readonly evidenceLocators = new Map<string, EvidenceLocator>();
	private readCount = 0;
	private probeCount = 0;
	private reservedVerificationReads = 0;
	private nextResultId = 1;

	constructor(options: {
		initialEvidence?: readonly EvidenceItem[];
		budget?: Partial<ResearchRetrievalBudget>;
		includeArchives?: boolean;
	} = {}) {
		this.budget = resolveResearchRetrievalBudget(options.budget);
		this.includeArchives = options.includeArchives === true;
		this.ledger = new ResearchEvidenceLedger(options.initialEvidence, this.budget);
		for (const item of this.ledger.evidence) {
			this.evidenceLocators.set(item.id.toUpperCase(), {
				path: item.path, anchorText: item.anchorText, excerpt: item.excerpt,
				...(item.range ? { range: item.range } : {}),
			});
		}
	}

	/** Every file this run has opened, however it was opened. */
	get filesRead(): number { return this.readCount + this.probeCount; }
	get remainingFileReads(): number { return Math.max(0, this.budget.maxFilesRead - this.readCount); }
	/**
	 * Files the next search may still open.
	 *
	 * Probes have their own allowance, so a search can no longer strand the
	 * read that admits its own result: the verification reserve below now
	 * arbitrates only between admissions and readAround expansions, which is
	 * the competition it was designed for.
	 */
	get searchReadsAvailable(): number {
		return Math.max(0, this.budget.maxFilesProbed - this.probeCount);
	}
	get unreservedFileReads(): number { return Math.max(0, this.remainingFileReads - this.reservedVerificationReads); }
	hasVisited(path: string): boolean { return this.visitedPaths.has(path); }
	markVisited(path: string): void {
		if (this.visitedPaths.has(path)) return;
		this.visitedPaths.add(path);
		this.probeCount += 1;
	}
	consumeAdditionalFileRead(): boolean {
		if (this.unreservedFileReads <= 0) return false;
		this.readCount += 1;
		return true;
	}
	reserveVerificationRead(): void {
		if (this.reservedVerificationReads === 0 && this.remainingFileReads > 0) this.reservedVerificationReads = 1;
	}
	consumeVerificationRead(): boolean {
		if (this.remainingFileReads <= 0) return false;
		if (this.reservedVerificationReads > 0) this.reservedVerificationReads -= 1;
		this.readCount += 1;
		return true;
	}
	releaseVerificationRead(): void {
		if (this.reservedVerificationReads > 0) this.reservedVerificationReads -= 1;
	}

	getSnapshot(path: string): SourceSnapshot | null { return this.snapshots.get(path) ?? null; }
	setSnapshot(snapshot: SourceSnapshot): void { this.snapshots.set(snapshot.path, snapshot); }
	allSnapshots(): SourceSnapshot[] { return [...this.snapshots.values()]; }

	result(handle: string): ResultLocator | null { return this.resultLocators.get(handle.toUpperCase()) ?? null; }
	consumeResult(handle: string): void {
		const key = handle.toUpperCase();
		const locator = this.resultLocators.get(key);
		if (!locator || !this.resultLocators.delete(key)) return;
		// Editor-backed results need no saved-source verification and therefore
		// do not own (or release) the reservation protecting a saved R#.
		if (locator.revisionKind === "saved") this.releaseVerificationRead();
	}
	registerResult(item: EvidenceItem, snapshot: SourceSnapshot): string {
		const identity = evidenceIdentity(item);
		const existing = this.resultIdentityHandles.get(identity);
		const handle = existing ?? `R${this.nextResultId++}`;
		this.resultIdentityHandles.set(identity, handle);
		this.resultLocators.set(handle, {
			handle, item: { ...item }, path: snapshot.path, revision: snapshot.revision, revisionKind: snapshot.revisionKind,
		});
		return handle;
	}

	evidenceLocator(handle: string): EvidenceLocator | null {
		return this.evidenceLocators.get(handle.toUpperCase()) ?? null;
	}
	registerEvidence(item: EvidenceItem, locator: EvidenceLocator): void {
		this.evidenceLocators.set(item.id.toUpperCase(), {
			...locator, excerpt: item.excerpt, anchorText: item.anchorText,
			...(item.range ? { range: item.range } : {}),
		});
	}

	/** Pin seed evidence only when it can be located in a complete live source. */
	pinInitialEvidenceRevision(snapshot: SourceSnapshot): void {
		if (snapshot.excludedByMetadata) return;
		for (const item of this.ledger.evidence) {
			if (item.path !== snapshot.path || (item.kind !== "selection" && item.kind !== "current")) continue;
			const handle = item.id.toUpperCase();
			const locator = this.evidenceLocators.get(handle);
			if (!locator || !locateEvidence(snapshot.text, locator)) continue;
			this.evidenceLocators.set(handle, {
				...locator, revision: snapshot.revision, revisionKind: snapshot.revisionKind,
			});
		}
	}
}

export class ResearchRetriever {
	private readonly eligibility: ResearchEligibilityService;
	private readonly now: () => number;
	private readonly maxSearchResults: number;
	private readonly searchSnippetChars: number;

	constructor(private readonly source: ResearchSearchSource, options: ResearchRetrieverOptions = {}) {
		this.eligibility = options.eligibility ?? DEFAULT_ELIGIBILITY;
		this.now = options.now ?? Date.now;
		this.maxSearchResults = boundedInteger(
			options.maxSearchResults, DEFAULT_RESEARCH_SEARCH_RESULT_LIMIT, 1, MAX_RESEARCH_SEARCH_RESULT_LIMIT,
		);
		this.searchSnippetChars = boundedInteger(
			options.searchSnippetChars, DEFAULT_RESEARCH_SEARCH_SNIPPET_CHARS, 80, DEFAULT_RESEARCH_PER_EVIDENCE_CHARS,
		);
	}

	createSession(options: {
		initialEvidence?: readonly EvidenceItem[];
		budget?: Partial<ResearchRetrievalBudget>;
		includeArchives?: boolean;
	} = {}): ResearchRetrievalSession {
		const session = new ResearchRetrievalSession(options);
		const activePath = this.source.activeFilePath();
		const live = activePath && this.source.activeFileText ? this.source.activeFileText() : null;
		if (activePath && live !== null) {
			session.pinInitialEvidenceRevision(
				snapshotFor(activePath, live, "editor", this.eligibility, session.includeArchives),
			);
		}
		return session;
	}

	/** Search the eligible corpus and return safe previews, never evidence. */
	async search(
		query: string,
		session: ResearchRetrievalSession,
		options: ResearchRetrieveOptions = {},
	): Promise<ResearchSearchResult> {
		throwIfStopped(options, this.now);
		const activePath = this.source.activeFilePath();
		const inventory = unique([
			...this.source.listMarkdownFiles(),
			...(activePath ? [activePath] : []),
		]).filter((path) => this.eligibility.isEligible(path, {
			includeArchives: session.includeArchives, activeFilePath: activePath,
		}));
		const terms = extractTerms(query, 40);
		const ranked = rankSearchPaths(inventory, terms, query, activePath, this.source);
		let filesRead = 0;
		let readFailures = 0;
		let excludedByMetadata = 0;
		// A previously visited active editor is refreshed without consuming a new
		// probe. Saved sources remain immutable observations until an explicit
		// read verifies their revision.
		if (activePath && session.hasVisited(activePath) && this.source.activeFileText) {
			const live = this.source.activeFileText();
			throwIfStopped(options, this.now);
			if (live !== null) {
				session.setSnapshot(snapshotFor(activePath, live, "editor", this.eligibility, session.includeArchives));
			}
		}

		// Keep filename/link/folder signals as hints, while reserving half of
		// every round for stable query-independent exploration. Unused hinted
		// capacity falls back to exploration; neither path can exceed the same
		// hard per-run file-read budget.
		// A saved R# must be reread to prove that its revision still matches the
		// preview before it can become citeable S# evidence. Keep one read in
		// reserve so search cannot consume the entire run budget and strand the
		// very result it just returned. This is an execution guarantee, not a
		// relevance heuristic.
		// How many files this search may open, which is not how many results it
		// returns. Returning costs tokens and stays capped at `maxSearchResults`;
		// opening costs a local read and is bounded by the run's probe allowance.
		// Front-loading the probing is deliberate: `searchSnapshots` below ranks
		// over every snapshot this session holds, so a later, reformulated query
		// re-ranks the whole probed corpus by its own terms at no new cost.
		const probeSlots = session.searchReadsAvailable;
		const probes = selectSearchProbes(ranked, session, probeSlots);
		for (const candidate of probes) {
			throwIfStopped(options, this.now);
			session.markVisited(candidate.path);
			filesRead += 1;
			try {
				const live = candidate.path === activePath && this.source.activeFileText
					? this.source.activeFileText()
					: null;
				throwIfStopped(options, this.now);
				const text = live ?? await cancellableRead(() => this.source.read(candidate.path), options, this.now);
				const snapshot = snapshotFor(
					candidate.path, text, live !== null ? "editor" : "saved", this.eligibility, session.includeArchives,
				);
				session.setSnapshot(snapshot);
				if (snapshot.excludedByMetadata) excludedByMetadata += 1;
			} catch (error) {
				if (error instanceof ResearchRetrievalCancelledError || error instanceof ResearchRetrievalDeadlineError) throw error;
				readFailures += 1;
			}
		}

		const results = this.searchSnapshots(query, terms, session);
		if (results.some((item) => session.result(item.handle)?.revisionKind === "saved")) {
			session.reserveVerificationRead();
		}
		const unvisitedEligible = inventory.some((path) => !session.hasVisited(path));
		const discoveryExhausted = !unvisitedEligible || session.searchReadsAvailable === 0;
		return {
			observation: { action: "search", ok: true, results, exhausted: discoveryExhausted },
			report: emptyReport({
				queries: 1, filesConsidered: inventory.length, filesRead, readFailures, excludedByMetadata,
				fileLimitReached: session.searchReadsAvailable === 0 && unvisitedEligible,
				evidenceLimitReached: session.ledger.isEvidenceFull, charLimitReached: session.ledger.isCharFull,
			}),
		};
	}

	/** Resolve only a run-local R# and admit its passage through the ledger. */
	async read(
		handle: string,
		session: ResearchRetrievalSession,
		options: ResearchRetrieveOptions = {},
	): Promise<ResearchReadResult> {
		throwIfStopped(options, this.now);
		const beforeDedup = session.ledger.deduplicatedCount;
		const beforeChars = session.ledger.charsUsed;
		const locator = session.result(handle);
		if (!locator) return { observation: failureObservation("read", handle, "unknown-handle"), report: emptyReport() };
		if (!this.eligibility.isEligible(locator.path, {
			includeArchives: session.includeArchives, activeFilePath: this.source.activeFilePath(),
		})) {
			return { observation: failureObservation("read", handle, "source-unavailable"), report: emptyReport() };
		}

		const checked = await this.readLocatorSource(locator, session, options, true);
		if (!checked.ok) {
			return { observation: failureObservation("read", handle, checked.reason), report: checked.report };
		}
		session.consumeResult(handle);
		if (checked.snapshot.revision !== locator.revision || checked.snapshot.revisionKind !== locator.revisionKind) {
			return {
				observation: failureObservation("read", handle, "source-changed"),
				report: emptyReport({
					filesRead: checked.filesRead, fileLimitReached: checked.filesRead > 0 && session.remainingFileReads === 0,
				}),
			};
		}
		if (checked.snapshot.excludedByMetadata) {
			return {
				observation: failureObservation("read", handle, "source-unavailable"),
				report: emptyReport({
					filesRead: checked.filesRead, excludedByMetadata: 1,
					fileLimitReached: checked.filesRead > 0 && session.remainingFileReads === 0,
				}),
			};
		}

		const equivalent = session.ledger.findEquivalent(locator.item);
		const admitted = equivalent ?? session.ledger.add(locator.item);
		if (!admitted) {
			return {
				observation: failureObservation("read", handle, "budget-exhausted"),
				report: reportAfterLedger(session, beforeDedup, beforeChars, 0, {
					filesRead: checked.filesRead, fileLimitReached: checked.filesRead > 0 && session.remainingFileReads === 0,
				}),
			};
		}
		if (!equivalent) {
			session.registerEvidence(admitted, {
				path: locator.path, revision: locator.revision, revisionKind: locator.revisionKind,
				anchorText: admitted.anchorText, excerpt: admitted.excerpt,
				...(admitted.range ? { range: admitted.range } : {}),
			});
		}
		return {
			observation: {
				action: "read", ok: true, resultHandle: locator.handle, evidence: observationEvidence(admitted),
			},
			report: reportAfterLedger(
				session, beforeDedup, beforeChars, equivalent ? 0 : 1, {
					filesRead: checked.filesRead, fileLimitReached: checked.filesRead > 0 && session.remainingFileReads === 0,
				},
			),
		};
	}

	/** Expand one S# around its verified source location, preserving the S# id. */
	async readAround(
		handle: string,
		session: ResearchRetrievalSession,
		request: { before?: number; after?: number } = {},
		options: ResearchRetrieveOptions = {},
	): Promise<ResearchReadAroundResult> {
		throwIfStopped(options, this.now);
		const item = session.ledger.get(handle);
		const locator = session.evidenceLocator(handle);
		if (!item || !locator) {
			return { observation: failureObservation("readAround", handle, "unknown-handle"), report: emptyReport() };
		}
		const activePath = this.source.activeFilePath();
		if (!this.eligibility.isEligible(locator.path, { includeArchives: session.includeArchives, activeFilePath: activePath })) {
			return { observation: failureObservation("readAround", handle, "source-unavailable"), report: emptyReport() };
		}
		if (locator.revision === undefined || locator.revisionKind === undefined) {
			return { observation: failureObservation("readAround", handle, "source-unavailable"), report: emptyReport() };
		}

		const checked = await this.readLocatorSource(locator, session, options);
		if (!checked.ok) {
			return { observation: failureObservation("readAround", handle, checked.reason), report: checked.report };
		}
		const { snapshot, filesRead } = checked;
		if (snapshot.revision !== locator.revision || snapshot.revisionKind !== locator.revisionKind) {
			return {
				observation: failureObservation("readAround", handle, "source-changed"),
				report: emptyReport({ filesRead, fileLimitReached: filesRead > 0 && session.remainingFileReads === 0 }),
			};
		}
		if (snapshot.excludedByMetadata) {
			return {
				observation: failureObservation("readAround", handle, "source-unavailable"),
				report: emptyReport({
					filesRead, excludedByMetadata: 1, fileLimitReached: filesRead > 0 && session.remainingFileReads === 0,
				}),
			};
		}
		const bounds = locateEvidence(snapshot.text, locator);
		if (!bounds) {
			return {
				observation: failureObservation("readAround", handle, "source-changed"),
				report: emptyReport({ filesRead, fileLimitReached: filesRead > 0 && session.remainingFileReads === 0 }),
			};
		}
		const before = boundedInteger(request.before, DEFAULT_RESEARCH_AROUND_CHARS, 0, MAX_RESEARCH_AROUND_CHARS);
		const after = boundedInteger(request.after, DEFAULT_RESEARCH_AROUND_CHARS, 0, MAX_RESEARCH_AROUND_CHARS);
		const window = codePointWindow(snapshot.text, bounds.start, bounds.end, before, after);
		const beforeChars = session.ledger.charsUsed;
		const expanded = session.ledger.expand(item.id, window.text, window.truncated);
		if (!expanded) {
			return {
				observation: failureObservation("readAround", handle, "budget-exhausted"),
				report: emptyReport({
					filesRead, fileLimitReached: filesRead > 0 && session.remainingFileReads === 0,
					charLimitReached: session.ledger.isCharFull,
				}),
			};
		}
		return {
			observation: { action: "readAround", ok: true, sourceHandle: item.id, evidence: observationEvidence(expanded) },
			report: emptyReport({
				filesRead, charsAdded: session.ledger.charsUsed - beforeChars,
				fileLimitReached: filesRead > 0 && session.remainingFileReads === 0,
				evidenceLimitReached: session.ledger.isEvidenceFull, charLimitReached: session.ledger.isCharFull,
			}),
		};
	}

	private searchSnapshots(
		query: string,
		terms: string[],
		session: ResearchRetrievalSession,
	): ResearchSearchObservationItem[] {
		const activePath = this.source.activeFilePath();
		// Weight terms by how rare they are among the probed sources.
		//
		// Scoring used to count matched terms with every term worth the same, and
		// wide probing broke that: a six-thousand-character window cut from a
		// hundred-thousand-character volume matches as many *common* terms
		// (身份, 性格, 设定…) as an eight-hundred-character character sheet can
		// match at all, so the volumes crowded the sheet out of the results and
		// the model duly reported the sheet's subject as unknown — measured
		// against the real test vault, twice. The terms that identify the right
		// source are precisely the ones most of the corpus does not contain, and
		// this is the standard, subject-agnostic way of saying so.
		const rarity = termRarity(terms, session);
		const ranked: Array<{ item: EvidenceItem; snapshot: SourceSnapshot; score: number }> = [];
		for (const snapshot of session.allSnapshots()) {
			if (snapshot.excludedByMetadata) continue;
			const pathHits = termHits(snapshot.path, terms);
			const contentHits = termHits(snapshot.text, terms);
			if (pathHits === 0 && contentHits === 0) continue;
			// A read admits a usable passage, bounded by the per-item allowance and
			// then by the run's evidence ledger.
			//
			// It used to admit `searchSnippetChars` — six hundred characters, the
			// size of a *search preview* — on the reasoning that an explicit
			// readAround would expand whatever mattered. Nothing ever did: a turn
			// affords about four actions, and spending two of them on one source
			// leaves nothing for the rest. So every read arrived at preview size
			// and marked truncated, and the answers that came back said 证据不足
			// because they honestly were.
			//
			// readAround keeps its purpose, which is reaching *past* the matching
			// passage. It is no longer the only way to reach a useful size.
			const passage = extractRelevantPassage(
				snapshot.text, terms, session.budget.perEvidenceChars, "match",
			);
			for (const item of evidenceForPassage(snapshot.path, passage.text, passage.truncated, countChars(snapshot.text))) {
				const localHits = termHits(item.excerpt, terms);
				if (localHits === 0 && pathHits === 0) continue;
				// Length-normalised, BM25-style: the same matched terms in a short,
				// dense source say more than in a window cut from a volume. Without
				// this, a character sheet and six volume windows matching the same
				// terms tie, and ties fall to the stable hash — a coin toss between
				// the answer and a mention.
				const density = 1 / (0.5 + 0.5 * (countChars(item.excerpt) / Math.max(1, session.budget.perEvidenceChars)));
				const score = weightedHits(item.excerpt, terms, rarity) * 100 * density +
					weightedHits(snapshot.path, terms, rarity) * 30 +
					(snapshot.path === activePath ? 3 : 0);
				ranked.push({ item, snapshot, score });
			}
		}
		ranked.sort((left, right) => right.score - left.score ||
			stableQueryOrder(query, left.snapshot.path) - stableQueryOrder(query, right.snapshot.path) ||
			left.item.label.localeCompare(right.item.label));
		return ranked.slice(0, this.maxSearchResults).map(({ item, snapshot }) => {
			// Centred on the match, not cut from the head: the preview is the only
			// thing the model judges a result by, and a passage that won on
			// density can easily open on none of it.
			const snippet = previewAroundMatch(item.excerpt, terms, this.searchSnippetChars);
			return {
				handle: session.registerResult(item, snapshot),
				label: safeObservationLabel(item),
				heading: item.heading,
				snippet,
				truncated: item.truncated || countChars(item.excerpt) > this.searchSnippetChars,
				// What reading this handle would actually buy.
				//
				// A preview is six hundred characters whatever it came from, so a
				// two-thousand-character character sheet and a three-hundred-thousand-
				// character volume arrive looking identical: same snippet length, same
				// `truncated: true`. Reading the first returns the whole sheet and the
				// second two percent of a volume, and nothing in the observation said
				// so — leaving searching again as the only action with a knowable
				// payoff. These two numbers are that payoff, stated.
				sourceChars: countChars(snapshot.text),
				readableChars: Math.min(countChars(item.excerpt), session.budget.perEvidenceChars),
			};
		});
	}

	private currentEditorSnapshot(path: string, session: ResearchRetrievalSession): SourceSnapshot | null {
		if (path !== this.source.activeFilePath() || !this.source.activeFileText) return null;
		const text = this.source.activeFileText();
		if (text === null) return null;
		return snapshotFor(path, text, "editor", this.eligibility, session.includeArchives);
	}

	private async readLocatorSource(
		locator: Pick<EvidenceLocator, "path" | "revisionKind">,
		session: ResearchRetrievalSession,
		options: ResearchRetrieveOptions,
		useReservedVerification = false,
	): Promise<
		| { ok: true; snapshot: SourceSnapshot; filesRead: number }
		| { ok: false; reason: "budget-exhausted" | "source-unavailable"; report: ResearchRetrievalReport }
	> {
		if (locator.revisionKind === "editor") {
			const snapshot = this.currentEditorSnapshot(locator.path, session);
			throwIfStopped(options, this.now);
			return snapshot
				? { ok: true, snapshot, filesRead: 0 }
				: { ok: false, reason: "source-unavailable", report: emptyReport() };
		}
		const allowed = useReservedVerification
			? session.consumeVerificationRead()
			: session.consumeAdditionalFileRead();
		if (!allowed) {
			return {
				ok: false, reason: "budget-exhausted", report: emptyReport({ fileLimitReached: true }),
			};
		}
		try {
			const text = await cancellableRead(() => this.source.read(locator.path), options, this.now);
			return {
				ok: true, filesRead: 1,
				snapshot: snapshotFor(locator.path, text, "saved", this.eligibility, session.includeArchives),
			};
		} catch (error) {
			if (error instanceof ResearchRetrievalCancelledError || error instanceof ResearchRetrievalDeadlineError) throw error;
			return {
				ok: false, reason: "source-unavailable", report: emptyReport({
					filesRead: 1, readFailures: 1, fileLimitReached: session.remainingFileReads === 0,
				}),
			};
		}
	}
}

/** VaultReader is intentionally accepted without an adapter at call sites. */
export function researchRetrieverForVault(reader: VaultReader): ResearchRetriever {
	return new ResearchRetriever(reader);
}

export function resolveResearchRetrievalBudget(input: Partial<ResearchRetrievalBudget> = {}): ResearchRetrievalBudget {
	return {
		maxFilesRead: boundedInteger(input.maxFilesRead, DEFAULT_RESEARCH_FILE_LIMIT, 0, MAX_RESEARCH_FILE_LIMIT),
		maxFilesProbed: boundedInteger(input.maxFilesProbed, DEFAULT_RESEARCH_PROBE_LIMIT, 0, MAX_RESEARCH_PROBE_LIMIT),
		maxEvidenceItems: boundedInteger(input.maxEvidenceItems, DEFAULT_RESEARCH_EVIDENCE_LIMIT, 0, MAX_RESEARCH_EVIDENCE_LIMIT),
		maxEvidenceChars: boundedInteger(input.maxEvidenceChars, DEFAULT_RESEARCH_CHAR_LIMIT, 0, MAX_RESEARCH_CHAR_LIMIT),
		perEvidenceChars: boundedInteger(input.perEvidenceChars, DEFAULT_RESEARCH_PER_EVIDENCE_CHARS, 1, MAX_RESEARCH_PER_EVIDENCE_CHARS),
	};
}

interface RankedPath { path: string; score: number; order: number; }

function selectSearchProbes(
	ranked: readonly RankedPath[], session: ResearchRetrievalSession, slots: number,
): RankedPath[] {
	if (slots <= 0) return [];
	const available = ranked.filter((candidate) => !session.hasVisited(candidate.path));
	const explorationQuota = Math.ceil(slots / 2);
	const hintedQuota = slots - explorationQuota;
	const stableAvailable = [...available].sort((left, right) =>
		stableExplorationOrder(left.path) - stableExplorationOrder(right.path) || left.path.localeCompare(right.path));
	const exploration = stableAvailable.slice(0, explorationQuota);
	const selectedPaths = new Set(exploration.map((candidate) => candidate.path));
	const hinted = available
		.filter((candidate) => candidate.score > 0 && !selectedPaths.has(candidate.path))
		.slice(0, hintedQuota);
	const selected = [...hinted, ...exploration];
	selectedPaths.clear();
	for (const candidate of selected) selectedPaths.add(candidate.path);
	if (selected.length < slots) {
		selected.push(...stableAvailable.filter((candidate) => !selectedPaths.has(candidate.path)).slice(0, slots - selected.length));
	}
	return selected;
}

/** Generic lexical/link hints only; no task-kind recipes. */
function rankSearchPaths(
	paths: readonly string[], terms: readonly string[], query: string, activePath: string | null, source: ResearchSearchSource,
): RankedPath[] {
	const activeFolder = activePath?.split("/").slice(0, -1).join("/") ?? null;
	const linked = new Set(activePath ? source.linksFrom(activePath) : []);
	return paths.map((path) => {
		const lower = path.toLocaleLowerCase();
		let score = terms.reduce((sum, term) => sum + (lower.includes(term.toLocaleLowerCase()) ? 30 : 0), 0);
		if (linked.has(path)) score += 50;
		if (activeFolder && path.startsWith(`${activeFolder}/`)) score += 5;
		return { path, score, order: stableQueryOrder(query, path) };
	}).sort((left, right) => right.score - left.score || left.order - right.order);
}

function evidenceForPassage(path: string, text: string, truncated: boolean, sourceChars?: number): EvidenceItem[] {
	const kind: EvidenceKind = kindOf({ path, role: "retrieved", text, truncated });
	const name = path.split("/").pop()?.replace(/\.md$/iu, "") ?? path;
	return splitSections(text).map((section) => ({
		id: "", path, name, kind, heading: section.heading, label: labelFor(kind, name, section.heading),
		excerpt: section.text, anchorText: section.anchorText, truncated,
		...(truncated && sourceChars !== undefined ? { sourceChars } : {}),
	}));
}

function snapshotFor(
	path: string, text: string, revisionKind: "saved" | "editor", eligibility: ResearchEligibilityService, includeArchives: boolean,
): SourceSnapshot {
	return {
		path, text, revision: contentRevision(text), revisionKind,
		excludedByMetadata: !includeArchives && eligibility.hasArchiveMetadata(text),
	};
}

function observationEvidence(item: EvidenceItem): { handle: string; label: string; truncated: boolean } {
	// The excerpt already travels once through the normal S# evidence document.
	// Repeating it inside the tool observation would waste context and create a
	// second channel for the same manuscript text.
	return { handle: item.id, label: safeObservationLabel(item), truncated: item.truncated };
}

function failureObservation(
	action: "read" | "readAround", handle: string, reason: ResearchToolFailureObservation["reason"],
): ResearchToolFailureObservation {
	return { action, ok: false, handle, reason };
}

function safeObservationLabel(item: EvidenceItem): string {
	return item.heading ? `${item.name} · ${item.heading}` : item.name;
}

function evidenceIdentity(item: EvidenceItem): string {
	if (item.kind === "selection") {
		return `selection:${item.path}:${item.range?.from.line ?? ""}:${item.range?.from.ch ?? ""}:${item.range?.to.line ?? ""}:${item.range?.to.ch ?? ""}:${item.excerpt}`;
	}
	// The passage itself is part of who it is: a search that centres a second
	// window on another part of the same section (no heading inside either
	// window) is new evidence, not the first window again. Equal text still
	// collapses into one item.
	const text = evidenceFingerprint(item.excerpt);
	return `${item.path}#${item.heading ?? ""}#${text.length}:${text.slice(0, 160)}`;
}

function evidenceFingerprint(text: string): string {
	return text.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
}

function safeEvidencePath(path: string): boolean {
	return path.length > 0 && !path.startsWith("/") && !path.includes("\0") &&
		!path.split(/[\\/]/u).some((part) => part === "..") &&
		!/^([A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(path);
}

/**
 * How much a term is worth, by how few probed sources contain it.
 *
 * `log(1 + N/df)`: a term every source contains is worth little, one that a
 * handful contain is worth a lot, and a term nothing probed contains keeps a
 * high weight so a path-only match on it still registers. Computed per search
 * over this session's snapshots — no persistent index, no cross-run state.
 */
function termRarity(terms: readonly string[], session: ResearchRetrievalSession): Map<string, number> {
	const snapshots = [...session.allSnapshots()].filter((snapshot) => !snapshot.excludedByMetadata);
	const total = Math.max(1, snapshots.length);
	const rarity = new Map<string, number>();
	for (const term of terms) {
		const lower = term.toLocaleLowerCase();
		let holders = 0;
		for (const snapshot of snapshots) {
			if (snapshot.text.toLocaleLowerCase().includes(lower) ||
				snapshot.path.toLocaleLowerCase().includes(lower)) holders += 1;
		}
		rarity.set(term, Math.log(1 + total / Math.max(1, holders)));
	}
	return rarity;
}

/**
 * Rarity-weighted, frequency-damped term score.
 *
 * `Σ idf(t) · log(1 + count(t))`: a term's occurrences count, but with quickly
 * diminishing returns, so a scene that is *about* the queried place (ten
 * mentions) outranks a timeline that cites it twice — while two hundred
 * mentions cannot outrank it twenty-fold. Presence-only scoring could not tell
 * those apart, and the tie fell to the stable hash: a coin toss between the
 * answer and a mention.
 */
function weightedHits(text: string, terms: readonly string[], rarity: Map<string, number>): number {
	const lower = text.toLocaleLowerCase();
	let sum = 0;
	for (const term of terms) {
		const needle = term.toLocaleLowerCase();
		let count = 0;
		let at = lower.indexOf(needle);
		while (at !== -1 && count < 50) {
			count += 1;
			at = lower.indexOf(needle, at + needle.length);
		}
		if (count > 0) sum += (rarity.get(term) ?? 1) * Math.log(1 + count);
	}
	return sum;
}

function termHits(text: string, terms: readonly string[]): number {
	const lower = text.toLocaleLowerCase();
	return terms.reduce((sum, term) => sum + (lower.includes(term.toLocaleLowerCase()) ? 1 : 0), 0);
}

/** Query-dependent ordering avoids an alphabetical zero-score pseudo-policy. */
function stableQueryOrder(query: string, path: string): number {
	let hash = 0;
	for (const char of `${query.normalize("NFKC")}\0${path}`) {
		hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 31);
	}
	return hash >>> 0;
}

/** Fixed path order lets each session advance exploration independently of query wording. */
function stableExplorationOrder(path: string): number {
	let hash = 0;
	for (const char of path.normalize("NFKC")) {
		hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 31);
	}
	return hash >>> 0;
}

function locateEvidence(text: string, locator: EvidenceLocator): { start: number; end: number } | null {
	if (locator.range) {
		const start = offsetAt(text, locator.range.from);
		const end = offsetAt(text, locator.range.to);
		if (start === null || end === null || end < start || text.slice(start, end) !== locator.excerpt) return null;
		return { start, end };
	}
	const exact = trimGeneratedEllipses(locator.excerpt);
	if (exact.length > 0) {
		const at = uniqueIndexOf(text, exact);
		if (at !== -1) return { start: at, end: at + exact.length };
	}
	if (locator.anchorText) {
		const at = uniqueIndexOf(text, locator.anchorText);
		if (at !== -1) return { start: at, end: at + locator.anchorText.length };
	}
	return null;
}

function uniqueIndexOf(text: string, needle: string): number {
	const first = text.indexOf(needle);
	if (first === -1) return -1;
	return text.indexOf(needle, first + needle.length) === -1 ? first : -1;
}

function offsetAt(text: string, position: { line: number; ch: number }): number | null {
	const lines = text.split("\n");
	if (position.line < 0 || position.line >= lines.length) return null;
	if (position.ch < 0 || position.ch > lines[position.line].length) return null;
	let offset = 0;
	for (let line = 0; line < position.line; line += 1) offset += lines[line].length + 1;
	return offset + position.ch;
}

function trimGeneratedEllipses(text: string): string {
	const value = text.replace(/^…/u, "").replace(/…$/u, "");
	return value.includes("…") ? "" : value;
}

function codePointWindow(
	text: string, startUtf16: number, endUtf16: number, before: number, after: number,
): { text: string; truncated: boolean } {
	const chars = Array.from(text);
	const start = Array.from(text.slice(0, startUtf16)).length;
	const end = Array.from(text.slice(0, endUtf16)).length;
	const from = Math.max(0, start - before);
	const to = Math.min(chars.length, end + after);
	const leading = from > 0 ? "…" : "";
	const trailing = to < chars.length ? "…" : "";
	return { text: `${leading}${chars.slice(from, to).join("")}${trailing}`, truncated: from > 0 || to < chars.length };
}

function emptyReport(overrides: Partial<ResearchRetrievalReport> = {}): ResearchRetrievalReport {
	return {
		queries: 0, filesConsidered: 0, filesRead: 0, readFailures: 0, excludedByMetadata: 0,
		evidenceAdded: 0, evidenceDeduplicated: 0, charsAdded: 0, fileLimitReached: false,
		evidenceLimitReached: false, charLimitReached: false, ...overrides,
	};
}

function reportAfterLedger(
	session: ResearchRetrievalSession, beforeDedup: number, beforeChars: number, evidenceAdded: number,
	overrides: Partial<ResearchRetrievalReport> = {},
): ResearchRetrievalReport {
	return emptyReport({
		evidenceAdded, evidenceDeduplicated: session.ledger.deduplicatedCount - beforeDedup,
		charsAdded: session.ledger.charsUsed - beforeChars, evidenceLimitReached: session.ledger.isEvidenceFull,
		charLimitReached: session.ledger.isCharFull, ...overrides,
	});
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

async function cancellableRead(
	read: () => Promise<string>, options: ResearchRetrieveOptions, now: () => number,
): Promise<string> {
	throwIfStopped(options, now);
	const signal = options.signal;
	const remaining = options.deadlineAt === undefined ? null : Math.max(0, options.deadlineAt - now());
	let timer: number | undefined;
	let abortListener: (() => void) | undefined;
	const gates: Array<Promise<never>> = [];
	if (signal) {
		gates.push(new Promise<never>((_resolve, reject) => {
			abortListener = () => reject(new ResearchRetrievalCancelledError());
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) abortListener();
		}));
	}
	if (remaining !== null) {
		gates.push(new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new ResearchRetrievalDeadlineError()), remaining);
		}));
	}
	try {
		const pendingRead = Promise.resolve().then(() => { throwIfStopped(options, now); return read(); });
		const text = gates.length > 0 ? await Promise.race([...gates, pendingRead]) : await pendingRead;
		throwIfStopped(options, now);
		return text;
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
		if (signal && abortListener) signal.removeEventListener("abort", abortListener);
	}
}

/** Truncate to an exact code-point ceiling, including the ellipsis itself. */
function truncateEvidenceExcerpt(text: string, allowance: number): string {
	const chars = Array.from(text);
	if (chars.length <= allowance) return text;
	if (allowance <= 0) return "";
	if (allowance === 1) return "…";
	return `${chars.slice(0, allowance - 1).join("")}…`;
}

function throwIfStopped(options: ResearchRetrieveOptions, now: () => number): void {
	if (options.signal?.aborted) throw new ResearchRetrievalCancelledError();
	if (options.deadlineAt !== undefined && now() >= options.deadlineAt) throw new ResearchRetrievalDeadlineError();
}

function boundedInteger(value: number | undefined, fallbackValue: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return Math.max(minimum, Math.min(maximum, Math.floor(fallbackValue)));
	return Math.max(minimum, Math.min(maximum, Math.floor(value as number)));
}
