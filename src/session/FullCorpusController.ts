/**
 * Client-side map/reduce orchestration for an explicit whole-manuscript turn.
 *
 * The Runtime remains a stateless text generator: every request carries all of
 * its input through the frozen V2 fields. The immutable Vault snapshot, batch
 * ordering, recursive reductions, cancellation, and coverage accounting all
 * live here. Intermediate memos never escape this controller.
 */

import { instructionLocale, t } from "../i18n";

/** The model is addressed in the instruction language; both editions say the same thing. */
function say(zh: string, en: string): string {
	return instructionLocale() === "en" ? en : zh;
}
import type { AIBackend, AIEvent, RequestMessage, SkillPayload, TurnPayload, UsageInfo } from "../backend/AIBackend";
import {
	buildFullCorpusSnapshot,
	isFullCorpusSnapshotCancelled,
	type FullCorpusChunk,
	type FullCorpusCoverage,
	type FullCorpusSnapshot,
} from "../context/FullCorpusContext";
import type { ContextPlan, VaultReader } from "../context/types";
import { evidenceDocumentPayloads, type EvidenceItem } from "../context/evidence";
import { buildCitationBlocks, type CitationBlock } from "../context/citationBlocks";
import type {
	ContextBuildReport,
	ContextSourceSnapshot,
	ConversationSession,
	CorpusPhaseTimings,
	GenerationMetadata,
	SessionPreferences,
	Skill,
} from "../types";
import { baseName, countChars } from "../util/text";
import { contentRevision } from "../context/revision";
import { createRequestId } from "../util/id";
import { buildSkillPayload, describeError, type TurnFacts } from "./ConversationController";
import { conversationMessages } from "./conversationHistory";
import { replaceExecutionIdentity, restoreSelectedExecutionIdentity, selectedExecutionIdentity } from "../util/executionIdentity";
import { fullCorpusCacheKey, type FullCorpusMemoCache, type FullCorpusMemoKeyInput } from "../storage/FullCorpusMemoStore";
import { asError } from "../util/errors";
import {
	DEFAULT_FULL_CORPUS_DEADLINE_MINUTES,
	MAX_FULL_CORPUS_CONCURRENCY,
	MAX_FULL_CORPUS_DEADLINE_MINUTES,
	MIN_FULL_CORPUS_CONCURRENCY,
	deadlineMsFromMinutes,
} from "./fullCorpusLimits";

/**
 * What one reduction call may read: the same size as the final synthesis
 * call, which every connection type already receives and which four measured
 * runs on the reference corpus completed. At 24,000 the tree ran 12 → 4 → 2
 * on a character question and deeper on a narrative one, and the reduce phase
 * took 33–56% of the run (OW-102, 2026-09-05). Halving the groups per level
 * removes whole levels; it does not send anything larger than final already
 * sends.
 */
const REDUCTION_INPUT_CHARS = 48_000;

/**
 * What one reduction call may write back, stated to the model as a hard
 * budget. Without it, a 1.29M-character run produced memos as long as their
 * inputs, level after level, until the level cap fired 42 calls later. Kept
 * at 8,000 when the input grew to 48,000: the measured model writes about
 * 9,000 against this figure (14,600 at worst), and 8,000 is what lets the
 * final call read six memos.
 */
const REDUCTION_OUTPUT_CHARS = 8_000;

/**
 * What the final synthesis may read. Deliberately larger than one reduction
 * group's input: the final pass is a single call, and letting it read a few
 * groups' worth of memos directly saves whole reduction levels and keeps more
 * nuance alive for the answer.
 */
const FINAL_SYNTHESIS_INPUT_CHARS = 48_000;
const FINAL_SYNTHESIS_INPUT_ITEMS = 24;

/** When reduction stalls, break to final below this; above it, the run fails. */
const FINAL_SYNTHESIS_HARD_CAP_CHARS = 150_000;

/** A completed level must shrink below this fraction of the one before it. */
const REDUCTION_MIN_SHRINK = 0.9;

/**
 * Rate-limit back-off. Bounded on every axis: a fixed number of attempts, a
 * ceiling on any single wait, and the run's own deadline over all of it.
 *
 * A subscription quota (ChatGPT through a gateway) does not clear in seconds:
 * on 2026-09-23 a 49-batch run read the whole book and then died to one 429
 * nine reductions in, after about two million tokens. When the server names
 * no wait, the schedule climbs to minutes; when it names one, that wins.
 */
const RATE_LIMIT_WAITS_SECONDS = [30, 60, 120, 240, 300] as const;
const MAX_RATE_LIMIT_WAIT_MS = 300_000;
/**
 * Transport back-off. A dropped connection is the failure measured to end a
 * Full run in practice: on 2026-09-04 four of five attempts on a 47-batch
 * manuscript died to `transport` — one after 1,145 s at reduction 12 of 16 —
 * and none to convergence or the deadline (OW-102). Unlike a rate limit the
 * server names no wait, so the schedule is fixed and short. Every retry is a
 * real call against the run's call limit and waits inside its deadline.
 */
const TRANSPORT_RETRY_WAITS_MS = [5_000, 15_000, 45_000] as const;
/** Matches the final call's item cap, so the character budget is the lever. */
const REDUCTION_INPUT_ITEMS = 24;
const MAX_REDUCTION_LEVELS = 10;
/** Guardrail against citation dumps; the prompt's normal target remains 1–2. */
const MAX_FINAL_CITATIONS_PER_CLUSTER = 4;
const MIN_SOFT_RESERVE_MS = 1_000;

export const DEFAULT_FULL_CORPUS_DEADLINE_MS = deadlineMsFromMinutes(DEFAULT_FULL_CORPUS_DEADLINE_MINUTES);
export const MAX_FULL_CORPUS_DEADLINE_MS = deadlineMsFromMinutes(MAX_FULL_CORPUS_DEADLINE_MINUTES);
export const MAX_FULL_CORPUS_BACKEND_CALLS = 256;
const MIN_DEFAULT_FULL_CORPUS_BACKEND_CALLS = 16;
const DEFAULT_FULL_CORPUS_CALL_BUFFER = 8;

export interface FullCorpusRunLimits {
	/** Whole-run wall-clock bound, including the local snapshot. */
	deadlineMs?: number;
	/** How many batches may be in flight at once. One restores the old behaviour. */
	concurrency?: number;
	/** Optional test/operator override, always clamped to the hard ceiling. */
	maxBackendCalls?: number;
}

export type FullCorpusFailureReason = "deadline" | "soft-deadline" | "backend-call-limit" | "resume-mismatch";

export type FullCorpusPhase = "snapshot" | "evidence" | "leaf" | "reduce" | "final";

/** Content-free progress plus final-answer streaming only. */
export interface FullCorpusProgress {
	phase: FullCorpusPhase;
	current: number;
	total: number;
	completedBatches: number;
	totalBatches: number;
	reductionBatches: number;
	timings: CorpusPhaseTimings;
	requestId?: string;
	/** Empty outside final synthesis: leaf/reduction memos are never exposed. */
	finalText: string;
	metadata: GenerationMetadata;
	facts: TurnFacts;
}

export interface FullCorpusRunOptions {
	session: ConversationSession;
	preferences: SessionPreferences;
	plan: ContextPlan;
	question: string;
	/** Frozen transcript selected by the caller, including the current ask. */
	messages?: readonly RequestMessage[];
	currentMessageId?: string;
	skill?: Skill;
	/** Already-composed wire instructions. Authoritative when present. */
	instructionPayload?: SkillPayload;
	/** A capability-validated lower effort for the one concise final retry. */
	finalRetryEffort?: string | null;
	/** Refuse to spend calls unless the current frozen inputs still match this retry. */
	expectedResumeKey?: string;
	/** Optional run bounds. Production defaults remain bounded and manuscript-size aware. */
	limits?: FullCorpusRunLimits;
	onUpdate?: (progress: FullCorpusProgress) => void;
}

export type FullCorpusRunResult =
	| {
		ok: true;
		answer: string;
		metadata: GenerationMetadata;
		facts: TurnFacts;
		/** One item per processing chunk: what was sent, and how much of it. */
		evidence: EvidenceItem[];
		/**
		 * Every id an answer may legitimately name — chunks and their blocks.
		 *
		 * Separate from `evidence` because it is a lookup, not a measurement:
		 * counting it as context would double-count block text that already
		 * travelled inside its chunk.
		 */
		citationEvidence: EvidenceItem[];
		citedEvidence: EvidenceItem[];
		coverage: FullCorpusCoverage;
		requestIds: string[];
		/** True when final synthesis fell back to validated terminal memos. */
		degraded?: true;
		resumeKey: string;
	}
	| {
		ok: false;
		error: string;
		metadata: GenerationMetadata;
		coverage?: FullCorpusCoverage;
		cancelled?: boolean;
		deadlineExceeded?: boolean;
		failureReason?: FullCorpusFailureReason;
		resumeKey?: string;
		requestIds: string[];
	};

interface ActiveJob {
	cancelled: boolean;
	deadlineExceeded: boolean;
	requestId: string | null;
	/**
	 * Every request currently in flight.
	 *
	 * `requestId` alone was enough while batches ran one at a time. With a pool
	 * it names only whichever call started last, so cancelling through it would
	 * leave the rest of the pool generating on the server.
	 *
	 * Cancelling does kill the provider's whole process group, which the
	 * Runtime confirms. Whether that also stops the meter running depends on
	 * the upstream billing by produced tokens and ending when the connection
	 * drops — its semantics, not the Runtime's, and not something either side
	 * here can verify. So: work stopped, cost probably.
	 */
	inFlight: Set<string>;
	abortController: AbortController;
	deadlineAt: number;
	deadlineMs: number;
	maxBackendCalls: number;
	startedAt: number;
	now: () => number;
	timings: CorpusPhaseTimings;
	activePhase: { phase: FullCorpusPhase; startedAt: number } | null;
	successfulCallDurationsMs: number[];
	softDeadlineReached: boolean;
	totalReductionBatches: number;
}

interface Memo {
	id: string;
	text: string;
}

interface CallOutcome {
	ok: boolean;
	text: string;
	metadata: GenerationMetadata;
	facts: TurnFacts;
	error?: string;
	errorCode?: string;
	/** Seconds the server asked us to wait, when it said so. */
	retryAfterSec?: number;
	/** The HTTP status the endpoint answered with; absent when it never answered. */
	status?: number;
	cancelled: boolean;
	deadlineExceeded: boolean;
	failureReason?: FullCorpusFailureReason;
	durationMs?: number;
}

export class FullCorpusController {
	private activeJob: ActiveJob | null = null;

	constructor(
		private readonly reader: VaultReader,
		private readonly backend: AIBackend,
		private readonly nextRequestId: () => string = createRequestId,
		private readonly now: () => number = Date.now,
		private readonly memoCache?: FullCorpusMemoCache,
	) {}

	get isRunning(): boolean {
		return this.activeJob !== null;
	}

	async cancel(): Promise<void> {
		const job = this.activeJob;
		if (!job || job.deadlineExceeded) return;
		// The job flag stops future requests; cancelling only the current id would
		// otherwise allow the next leaf to start after this stream closes.
		job.cancelled = true;
		job.abortController.abort();
		// Settled rather than all: one backend refusing a cancel must not leave
		// the others running.
		await Promise.allSettled([...job.inFlight].map((id) => this.backend.cancel(id)));
	}

	async run(options: FullCorpusRunOptions): Promise<FullCorpusRunResult> {
		if (this.activeJob) {
			return { ok: false, error: t("corpus.busy"), metadata: {}, requestIds: [] };
		}
		if (options.plan.coverage !== "full-current-manuscript") {
			return { ok: false, error: t("corpus.notFullRequest"), metadata: {}, requestIds: [] };
		}
		if (isBlockedWritingAction(options)) {
			return {
				ok: false,
				error: t("corpus.rewriteBlocked"),
				metadata: {},
				requestIds: [],
			};
		}

		const deadlineMs = boundedInteger(
			options.limits?.deadlineMs, DEFAULT_FULL_CORPUS_DEADLINE_MS, 0, MAX_FULL_CORPUS_DEADLINE_MS,
		);
		// One unless asked otherwise. The four a writer gets is a *settings*
		// default, chosen for them; a caller that says nothing here has not
		// decided that its backend can take a burst, and this controller is not
		// the place to decide that on its behalf.
		const concurrency = boundedInteger(
			options.limits?.concurrency, MIN_FULL_CORPUS_CONCURRENCY,
			MIN_FULL_CORPUS_CONCURRENCY, MAX_FULL_CORPUS_CONCURRENCY,
		);
		const startedAt = this.now();
		const job: ActiveJob = {
			cancelled: false, deadlineExceeded: false, requestId: null, inFlight: new Set<string>(),
			abortController: new AbortController(),
			deadlineAt: startedAt + deadlineMs, deadlineMs, maxBackendCalls: 0,
			startedAt, now: this.now, timings: emptyCorpusTimings(), activePhase: null,
			successfulCallDurationsMs: [], softDeadlineReached: false, totalReductionBatches: 0,
		};
		const preferences = Object.freeze({ ...options.preferences });
		const aggregateMetadata = connectionMetadata(preferences);
		const aggregateFacts: TurnFacts = {};
		const requestIds: string[] = [];
		// Freeze the entire caller-composed turn once. Every map/reduce/final call
		// receives this same history plus exactly one stage-specific prompt.
		const baseMessages = freezeBaseMessages(options);
		const instructionPayload = options.instructionPayload ?? buildSkillPayload(options.skill);
		let snapshot: FullCorpusSnapshot | undefined;
		let resumeKey: string | undefined;
		const completedBatchIndexes = new Set<number>();
		let reductionBatches = 0;
		this.activeJob = job;
		const deadlineTimer = this.armDeadline(job);

		const progress = (phase: FullCorpusPhase, current: number, total: number, finalText = ""): void => {
			if (job.cancelled || job.deadlineExceeded) return;
			options.onUpdate?.({
				phase, current, total, completedBatches: completedBatchIndexes.size,
				totalBatches: snapshot?.batches.length ?? 0,
				reductionBatches,
				timings: timingsFor(job),
				...(job.requestId ? { requestId: job.requestId } : {}),
				finalText,
				metadata: { ...aggregateMetadata },
				facts: { ...aggregateFacts },
			});
		};

		try {
			beginPhase(job, "snapshot");
			progress("snapshot", 0, 0);
			this.throwIfStopped(job);
			const snapshotPromise = buildFullCorpusSnapshot(this.reader, {
				signal: job.abortController.signal,
				shouldCancel: () => job.cancelled,
				onProgress: ({ completedFiles, totalFiles }) => progress("snapshot", completedFiles, totalFiles),
			});
			snapshot = await promiseOrAbort(snapshotPromise, job.abortController.signal);
			finishActivePhase(job);
			resumeKey = fullCorpusResumeKey(snapshot, baseMessages, instructionPayload, preferences);
			aggregateMetadata.fullCorpusResumeKey = resumeKey;
			job.maxBackendCalls = resolveFullCorpusBackendCallLimit(
				snapshot.batches.length, options.limits?.maxBackendCalls,
			);
			const expectedResumeKey = options.expectedResumeKey;
			if (expectedResumeKey !== undefined && expectedResumeKey !== resumeKey) {
				const coverage = coverageFor(snapshot, completedBatchIndexes, reductionBatches, "failed", job, requestIds.length, undefined, job.totalReductionBatches, "failed");
				aggregateMetadata.errorCode = "resume-mismatch";
				aggregateMetadata.contextReport = reportFor(options, snapshot, coverage, []);
				return { ok: false, error: t("corpus.resumeMismatch"), metadata: { ...aggregateMetadata }, coverage, failureReason: "resume-mismatch", resumeKey, requestIds };
			}
			this.throwIfStopped(job);
			if (snapshot.readFailures.length > 0 || snapshot.uncoveredFiles.length > 0) {
				setCorpusTimings(aggregateMetadata, job);
				const coverage = coverageFor(snapshot, completedBatchIndexes, reductionBatches, "failed", job, requestIds.length);
				aggregateMetadata.contextReport = reportFor(options, snapshot, coverage, []);
				return {
					ok: false,
					error: t("corpus.readFailures", { count: snapshot.readFailures.length }),
					metadata: { ...aggregateMetadata },
					coverage,
					resumeKey,
					requestIds,
				};
			}
			if (snapshot.batches.length === 0) {
				setCorpusTimings(aggregateMetadata, job);
				const coverage = coverageFor(snapshot, completedBatchIndexes, reductionBatches, "failed", job, requestIds.length);
				aggregateMetadata.contextReport = reportFor(options, snapshot, coverage, []);
				return { ok: false, error: t("corpus.emptyCorpus"), metadata: { ...aggregateMetadata }, coverage, resumeKey, requestIds };
			}
			beginPhase(job, "evidence");
			progress("evidence", 0, 1);
			const evidenceIndex = corpusEvidenceIndex(snapshot);
			finishActivePhase(job);
			progress("evidence", 1, 1);
			const evidence = evidenceIndex.evidence;
			const evidenceByChunk = new Map(snapshot.chunks.map((chunk, index) => [chunk.id, evidence[index]]));
			// Leaf batches are independent by construction: each reads its own chunks
			// and produces its own memo. Awaiting them one at a time made the run cost
			// the sum of every call's latency, which is why a whole manuscript took as
			// long as it did. Results are still collected by index, so the memos — and
			// so the reduction below and the final answer — do not depend on the order
			// the calls happen to finish in.
			// `snapshot` stays a `let` for the failure paths above, and that
			// narrowing does not reach inside a closure. Bound once here.
			const corpus = snapshot;
			const leafMemos = new Array<Memo>(corpus.batches.length);
			const leafInputs = corpus.batches.map((batch, index) => {
				const batchEvidence = batch.chunks.map((chunk) => evidenceByChunk.get(chunk.id)).filter(isEvidence);
				const input = {
					conversationId: options.session.id, preferences,
					messages: messagesForStage(baseMessages, leafPrompt(index, corpus.batches.length)),
					documents: evidenceDocumentPayloads(batchEvidence),
					...(instructionPayload ? { skill: instructionPayload } : {}),
				};
				return { input, cacheInput: memoCacheInput("leaf", input), allowed: allowedCitationIds(batchEvidence) };
			});
			beginPhase(job, "leaf");
			progress("leaf", 0, corpus.batches.length);
			for (let index = 0; index < leafInputs.length; index += 1) {
				const prepared = leafInputs[index];
				const cached = await this.readMemo(prepared.cacheInput, prepared.allowed);
				if (cached === null) continue;
				leafMemos[index] = { id: `leaf:${index + 1}`, text: cached };
				completedBatchIndexes.add(index);
			}
			progress("leaf", completedBatchIndexes.size, corpus.batches.length);
			const missingLeafIndexes = corpus.batches
				.map((_, index) => index)
				.filter((index) => !completedBatchIndexes.has(index));
			// Cached leaves cost no backend calls. Reserve at least one final call
			// rather than rejecting a resumable run based on its original batch count.
			if (missingLeafIndexes.length + 1 > job.maxBackendCalls) {
				return this.failedResult(
					job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds,
					backendCallLimitOutcome(job.maxBackendCalls),
					t("corpus.callLimit"), options,
				);
			}
			const leafFailure = await this.eachInPool(job, concurrency, missingLeafIndexes.length, async (position) => {
				const index = missingLeafIndexes[position];
				const { input, cacheInput, allowed } = leafInputs[index];
				if (shouldStopLeafDispatch(job, leafMemos, concurrency)) {
					return softDeadlineOutcome();
				}
				const outcome = await this.callWithBackoff(job, requestIds, input, aggregateMetadata, aggregateFacts);
				if (!outcome.ok) return outcome;
				const text = keepAllowedEvidenceIds(outcome.text, allowed);
				leafMemos[index] = {
					id: `leaf:${index + 1}`,
					text,
				};
				await this.writeMemo(cacheInput, text, allowed);
				completedBatchIndexes.add(index);
				// A count of what is finished, not of what was started: with a pool the
				// highest index in flight is not progress.
				progress("leaf", completedBatchIndexes.size, corpus.batches.length);
				return outcome;
			});
			finishActivePhase(job);
			if (leafFailure && !job.softDeadlineReached) {
				return this.failedResult(
					job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, leafFailure.outcome,
					t("corpus.leafInterrupted", { index: leafFailure.index + 1, total: corpus.batches.length }), options,
				);
			}

			let memos = leafMemos.filter(isMemo);
			if (memos.length === 0) {
				return this.failedResult(job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds,
					softDeadlineOutcome(), t("corpus.softDeadlineNothing"), options);
			}
			let level = 0;
			let previousChars = Number.POSITIVE_INFINITY;
			beginPhase(job, "reduce");
			while (needsReduction(memos)) {
				this.throwIfStopped(job);
				const totalChars = memoChars(memos);
				// The run that motivated this guard: 48 leaf memos whose every
				// claim carried its full citation set. Told to preserve every id
				// verbatim, the reducer wrote outputs as long as its inputs, and
				// the level cap fired 42 calls and 34 minutes later. A level that
				// failed to shrink will not start converging on the same
				// instructions and material, so stop spinning: the final call may
				// read a few groups' worth of memos directly, and an oversized
				// synthesis beats a certain failure.
				if (level >= MAX_REDUCTION_LEVELS || totalChars >= previousChars * REDUCTION_MIN_SHRINK) {
					if (totalChars <= FINAL_SYNTHESIS_HARD_CAP_CHARS) break;
					const failure: CallOutcome = { ok: false, text: "", metadata: {}, facts: {}, error: t("corpus.reduceOverflow"), cancelled: false, deadlineExceeded: false };
					return this.failedResult(job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, failure, t("corpus.reduceNotConverging"), options);
				}
				previousChars = totalChars;
				level += 1;
				const groups = packMemos(memos);
				job.totalReductionBatches += groups.length;
				progress("reduce", 0, groups.length);
				// Groups within one level are independent of each other for the same
				// reason the leaves are. Levels stay strictly sequential: each one reads
				// what the level below it produced.
				const reduced = new Array<Memo>(groups.length);
				let doneInLevel = 0;
				const reduceFailure = await this.eachInPool(job, concurrency, groups.length, async (index) => {
					const input = {
						conversationId: options.session.id, preferences,
						messages: messagesForStage(baseMessages, reductionPrompt(level)),
						documents: memoDocuments(groups[index], level),
						...(instructionPayload ? { skill: instructionPayload } : {}),
					};
					const allowed = evidenceIdsIn(groups[index].map((memo) => memo.text).join("\n"));
					const cacheInput = memoCacheInput("reduce", input);
					const cached = await this.readMemo(cacheInput, allowed);
					const outcome = cached === null
						? await this.callWithBackoff(job, requestIds, input, aggregateMetadata, aggregateFacts)
						: successfulMemoOutcome(cached);
					if (!outcome.ok) return outcome;
					reductionBatches += 1;
					doneInLevel += 1;
					progress("reduce", doneInLevel, groups.length);
					const text = keepAllowedEvidenceIds(outcome.text, allowed);
					reduced[index] = {
						id: `reduce:${level}:${index + 1}`,
						text,
					};
					if (cached === null) await this.writeMemo(cacheInput, text, allowed);
					return outcome;
				});
				if (reduceFailure) {
					return this.failedResult(job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, reduceFailure.outcome, t("corpus.reduceInterrupted"), options);
				}
				memos = reduced;
			}
			finishActivePhase(job);

			this.throwIfStopped(job);
			beginPhase(job, "final");
			progress("final", 0, 1);
			const finalAllowedIds = evidenceIdsIn(memos.map((memo) => memo.text).join("\n"));
			if (finalAllowedIds.size === 0) {
				const failure: CallOutcome = {
					ok: false, text: "", metadata: {}, facts: {},
					error: t("corpus.noVerifiableCitations"),
					cancelled: false, deadlineExceeded: false,
				};
				return this.failedResult(
					job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, failure,
					t("corpus.finalNoEvidence"), options,
				);
			}
			const finalInput = {
				conversationId: options.session.id, preferences, messages: messagesForStage(baseMessages, finalPrompt(job.softDeadlineReached)),
				documents: memoDocuments(memos, level + 1),
				...(instructionPayload ? { skill: instructionPayload } : {}),
			};
			let finalOutcome = await this.callWithBackoff(job, requestIds, finalInput, aggregateMetadata, aggregateFacts);
			if (finalOutcome.ok) finalOutcome.text = normalizeCitationRanges(finalOutcome.text, finalAllowedIds);
			let citationProblem = finalOutcome.ok ? finalCitationProblem(finalOutcome.text, finalAllowedIds, true) : null;
			// A final call that already waited out its rate limit or dropped
			// connection will not be rescued by a second prompt; the memos below
			// are the answer the writer can still have.
			if ((!finalOutcome.ok && recoverableFailure(finalOutcome) === null) || citationProblem) {
				this.throwIfStopped(job);
				finalOutcome = await this.callWithBackoff(job, requestIds, {
					conversationId: options.session.id, preferences,
					messages: messagesForStage(baseMessages, finalRecoveryPrompt(citationProblem ?? finalOutcome.error, job.softDeadlineReached)),
					documents: memoDocuments(memos, level + 1),
					...(instructionPayload ? { skill: instructionPayload } : {}),
				}, aggregateMetadata, aggregateFacts, options.finalRetryEffort);
				if (finalOutcome.ok) finalOutcome.text = normalizeCitationRanges(finalOutcome.text, finalAllowedIds);
				citationProblem = finalOutcome.ok ? finalCitationProblem(finalOutcome.text, finalAllowedIds, true) : null;
			}

			const fallback = memos.map((memo) => memo.text).join("\n\n");
			const usedFallback = !finalOutcome.ok || citationProblem !== null;
			const chosen = !usedFallback ? finalOutcome.text
				: `${job.softDeadlineReached ? t("corpus.memosPartial") : t("corpus.memosComplete")}\n\n${fallback}`;
			const fallbackProblem = finalCitationProblem(chosen, finalAllowedIds, true);
			if (fallbackProblem) {
				const failure: CallOutcome = { ok: false, text: "", metadata: {}, facts: {}, error: t("corpus.finalCitationFormat", { problem: fallbackProblem }), cancelled: false, deadlineExceeded: false };
				return this.failedResult(job, snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, failure, t("corpus.finalCitationFailed"), options);
			}
			const answer = keepAllowedEvidenceIds(
				job.softDeadlineReached && !chosen.startsWith(t("corpus.partialAnalysis"))
					? `${t("corpus.partialAnalysis")}\n\n${chosen}`
					: chosen,
				finalAllowedIds,
			);
			finishActivePhase(job);
			this.throwIfStopped(job);
			setCorpusTimings(aggregateMetadata, job);
			const coverage = coverageFor(snapshot, completedBatchIndexes, reductionBatches,
				usedFallback ? "degraded" : job.softDeadlineReached ? "partial" : "complete", job, requestIds.length,
				job.softDeadlineReached ? "soft-deadline" : undefined, job.totalReductionBatches,
				usedFallback ? "degraded" : job.softDeadlineReached ? "partial" : "complete");
			if (!job.softDeadlineReached && !usedFallback && !isCompleteCoverage(coverage)) {
				const failed = { ...coverage, status: "failed" as const };
				aggregateMetadata.contextReport = reportFor(options, snapshot, failed, []);
				return { ok: false, error: t("corpus.coverageFailed"), metadata: { ...aggregateMetadata }, coverage: failed, resumeKey, requestIds };
			}
			const citedEvidence = citedEvidenceIn(answer, evidenceIndex.byId);
			aggregateMetadata.contextReport = reportFor(options, snapshot, coverage, citedEvidence, evidenceIndex);
			progress("final", 1, 1, answer);
			return {
				ok: true, answer, metadata: { ...aggregateMetadata }, facts: { ...aggregateFacts },
				evidence, citationEvidence: [...evidenceIndex.byId.values()], citedEvidence, coverage, requestIds,
				...(usedFallback ? { degraded: true as const } : {}), resumeKey,
			};
		} catch (error) {
			finishActivePhase(job);
			setCorpusTimings(aggregateMetadata, job);
			if (job.deadlineExceeded || error instanceof FullCorpusDeadlineError) {
				this.stopForDeadline(job);
				restoreSelectedExecutionIdentity(aggregateMetadata, preferences);
				return deadlineResult(
					snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, options, job, resumeKey,
				);
			}
			if (job.cancelled || isFullCorpusSnapshotCancelled(error) || error instanceof FullCorpusCancelledError) {
				restoreSelectedExecutionIdentity(aggregateMetadata, preferences);
				return snapshot
					? cancelledResult(snapshot, completedBatchIndexes, reductionBatches, aggregateMetadata, requestIds, job, resumeKey)
					: {
						ok: false, error: t("corpus.cancelled"),
						metadata: { ...aggregateMetadata, errorCode: "cancelled" },
						cancelled: true, requestIds,
					};
			}
			const message = error instanceof Error ? error.message : String(error);
			restoreSelectedExecutionIdentity(aggregateMetadata, preferences);
			if (snapshot) {
				const coverage = coverageFor(snapshot, completedBatchIndexes, reductionBatches, "failed", job, requestIds.length, undefined, job.totalReductionBatches, "failed");
				aggregateMetadata.contextReport = reportFor(options, snapshot, coverage, []);
				return { ok: false, error: t("corpus.failed", { reason: message }), metadata: { ...aggregateMetadata }, coverage, resumeKey, requestIds };
			}
			return { ok: false, error: t("corpus.snapshotFailed", { reason: message }), metadata: { ...aggregateMetadata }, requestIds };
		} finally {
			window.clearTimeout(deadlineTimer);
			if (this.activeJob === job) this.activeJob = null;
		}
	}

	/**
	 * Run `total` independent units, at most `concurrency` at a time.
	 *
	 * Returns the first failure in index order — not the first to arrive — so
	 * the message a writer sees names the same batch it would have named when
	 * these ran one after another. Once anything fails, no further unit is
	 * started; the ones already in flight are allowed to finish rather than
	 * being torn out from under `call`, which owns their cleanup.
	 *
	 * `undefined` means every unit succeeded.
	 */
	private async eachInPool(
		job: ActiveJob,
		concurrency: number,
		total: number,
		run: (index: number) => Promise<CallOutcome>,
		stopDispatch?: () => boolean,
	): Promise<{ index: number; outcome: CallOutcome } | undefined> {
		let next = 0;
		const failures: { index: number; outcome: CallOutcome }[] = [];
		const worker = async (): Promise<void> => {
			for (;;) {
				if (failures.length > 0) return;
				if (stopDispatch?.()) return;
				// Checked per unit rather than per pool, so a cancelled or timed
				// out job stops dispatching immediately instead of after the
				// current wave.
				this.throwIfStopped(job);
				const index = next;
				if (index >= total) return;
				next += 1;
				const outcome = await run(index);
				if (!outcome.ok) failures.push({ index, outcome });
			}
		};
		const width = Math.max(1, Math.min(concurrency, total));
		await Promise.all(Array.from({ length: width }, () => worker()));
		// Lowest index rather than first to arrive, so the batch a writer is told
		// about is the same one they would have been told about in a serial run.
		return failures.sort((left, right) => left.index - right.index)[0];
	}

	/**
	 * Run one batch, waiting out the two failures a wait can fix.
	 *
	 * A rate limit is the one failure the server tells us how to recover
	 * from: it names the seconds in `Retry-After` and in `details.retryAfterSec`
	 * and, in this protocol, its `retryable: false` means "another provider
	 * would not help" rather than "do not retry". A transport failure is the one
	 * the measurements say actually ends runs: a connection that dropped mid-call,
	 * for which the only cure is to place the call again after a short wait.
	 * `recoverableFailure` recognises both whichever backend reported them.
	 * Abandoning twenty minutes of completed batches over either would be a
	 * poor trade.
	 *
	 * Deliberately only here. An interactive turn still surfaces both
	 * immediately, because someone is watching it and can decide; a Full run
	 * has dozens of batches and nobody watching each one.
	 *
	 * Each kind has its own bounded budget, so a run alternating between them
	 * is still bounded. The waits stay inside the run's own deadline — the job
	 * stops the moment that passes, so a wait cannot extend a run beyond it —
	 * and every retry goes through `call`, so it counts against the call limit.
	 */
	private async callWithBackoff(
		job: ActiveJob,
		requestIds: string[],
		input: Parameters<FullCorpusController["call"]>[2],
		aggregateMetadata: GenerationMetadata,
		aggregateFacts: TurnFacts,
		effortOverride?: string | null,
	): Promise<CallOutcome> {
		let outcome = await this.call(job, requestIds, input, aggregateMetadata, aggregateFacts, undefined, effortOverride);
		let rateLimitRetries = 0;
		let transportRetries = 0;
		while (!outcome.ok) {
			let waitMs: number;
			const kind = recoverableFailure(outcome);
			if (kind === "rate-limit" && rateLimitRetries < RATE_LIMIT_WAITS_SECONDS.length) {
				const seconds = outcome.retryAfterSec ?? RATE_LIMIT_WAITS_SECONDS[rateLimitRetries];
				rateLimitRetries += 1;
				waitMs = Math.min(seconds * 1_000, MAX_RATE_LIMIT_WAIT_MS);
			} else if (kind === "transport" && transportRetries < TRANSPORT_RETRY_WAITS_MS.length) {
				waitMs = TRANSPORT_RETRY_WAITS_MS[transportRetries];
				transportRetries += 1;
			} else {
				return outcome;
			}
			// A wait that would outlast the deadline is not worth taking: the job
			// would be stopped on the far side of it with nothing gained.
			if (this.now() + waitMs >= job.deadlineAt) return outcome;
			await this.sleep(waitMs, job.abortController.signal);
			this.throwIfStopped(job);
			outcome = await this.call(job, requestIds, input, aggregateMetadata, aggregateFacts, undefined, effortOverride);
		}
		return outcome;
	}

	/** Resolves early when the job is stopped, so cancelling is not stuck behind a wait. */
	private sleep(ms: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const timer = window.setTimeout(finish, ms);
			function finish(): void {
				window.clearTimeout(timer);
				signal.removeEventListener("abort", finish);
				resolve();
			}
			signal.addEventListener("abort", finish, { once: true });
		});
	}

	private async call(
		job: ActiveJob,
		requestIds: string[],
		input: { conversationId: string; preferences: Readonly<SessionPreferences>; messages: TurnPayload["messages"]; documents: TurnPayload["documents"]; skill?: TurnPayload["skill"] },
		aggregateMetadata: GenerationMetadata,
		aggregateFacts: TurnFacts,
		onFinalDelta?: (text: string) => void,
		effortOverride?: string | null,
	): Promise<CallOutcome> {
		this.throwIfStopped(job);
		if (requestIds.length >= job.maxBackendCalls) return backendCallLimitOutcome(job.maxBackendCalls);
		const requestId = this.nextRequestId();
		// A custom id source may synchronously trigger cancellation. Check again
		// before publishing the id or constructing the backend iterable.
		this.throwIfStopped(job);
		if (requestIds.includes(requestId)) {
			return {
				ok: false, text: "", metadata: {}, facts: {},
				error: t("session.noRequestId"), cancelled: false, deadlineExceeded: false,
			};
		}
		requestIds.push(requestId);
		job.requestId = requestId;
		job.inFlight.add(requestId);
		try {
			const payload: TurnPayload = {
				requestId,
				connectionId: input.preferences.connectionId,
				conversationId: input.conversationId,
				provider: input.preferences.provider,
				model: input.preferences.model ?? null,
				effort: effortOverride === undefined ? input.preferences.effort ?? null : effortOverride,
				messages: input.messages.map((message) => ({ ...message })),
				...(input.skill ? { skill: { ...input.skill } } : {}),
				...(input.documents && input.documents.length > 0 ? { documents: input.documents } : {}),
			};
			const callStartedAt = this.now();
			const outcome = await consume(this.backend.chat(payload), job, onFinalDelta);
			outcome.durationMs = elapsedMs(callStartedAt, this.now());
			if (outcome.ok) job.successfulCallDurationsMs.push(outcome.durationMs);
			if (!outcome.ok) restoreSelectedExecutionIdentity(outcome.metadata, input.preferences);
			mergeMetadata(aggregateMetadata, outcome.metadata);
			mergeFacts(aggregateFacts, outcome.facts);
			return outcome;
		} finally {
			job.inFlight.delete(requestId);
			if (job.requestId === requestId) job.requestId = null;
		}
	}

	private failedResult(
		job: ActiveJob, snapshot: FullCorpusSnapshot, completedBatchIndexes: ReadonlySet<number>, reductionBatches: number,
		metadata: GenerationMetadata, requestIds: string[], outcome: CallOutcome, prefix: string, options: FullCorpusRunOptions,
		resumeKey?: string,
	): FullCorpusRunResult {
		resumeKey = resumeKey ?? metadata.fullCorpusResumeKey;
		finishActivePhase(job);
		setCorpusTimings(metadata, job);
		// Other calls from the same concurrent pool may have completed after the
		// chosen failure and overwritten provisional identity. A failed run is
		// described by the target the writer selected, never by whichever batch
		// happened to settle last.
		restoreSelectedExecutionIdentity(metadata, options.preferences);
		if (job.deadlineExceeded || outcome.deadlineExceeded) {
				return deadlineResult(
					snapshot, completedBatchIndexes, reductionBatches, metadata, requestIds, options, job, resumeKey,
			);
		}
		if (job.cancelled || outcome.cancelled) {
			return cancelledResult(snapshot, completedBatchIndexes, reductionBatches, metadata, requestIds, job, resumeKey);
		}
		const coverage = coverageFor(
			snapshot, completedBatchIndexes, reductionBatches, "failed", job, requestIds.length,
			outcome.failureReason === "resume-mismatch" ? undefined : outcome.failureReason,
			job.totalReductionBatches, "failed",
		);
		if (outcome.failureReason) metadata.errorCode = outcome.failureReason;
		else if (outcome.errorCode) metadata.errorCode = outcome.errorCode;
		metadata.contextReport = reportFor(options, snapshot, coverage, []);
		// Every finished batch and reduction is cached by its exact input, so the
		// writer should know that Continue does not pay for them again.
		const saved = completedBatchIndexes.size > 0 && outcome.failureReason !== "resume-mismatch"
			? t("corpus.savedForContinue", { done: completedBatchIndexes.size, total: snapshot.batches.length })
			: "";
		return {
			ok: false, error: `${prefix}：${outcome.error ?? t("session.incompleteResult")}${saved}`,
			metadata: { ...metadata }, coverage, requestIds, ...(resumeKey ? { resumeKey } : {}),
			...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
		};
	}

	private armDeadline(job: ActiveJob): number {
		return window.setTimeout(() => {
			if (this.activeJob !== job || job.cancelled || job.deadlineExceeded) return;
			this.stopForDeadline(job);
		}, Math.max(0, job.deadlineAt - this.now()));
	}

	private stopForDeadline(job: ActiveJob): void {
		if (job.deadlineExceeded || job.cancelled) return;
		job.deadlineExceeded = true;
		job.abortController.abort();
		for (const requestId of job.inFlight) void this.backend.cancel(requestId).catch(() => undefined);
	}

	private async readMemo(input: Readonly<FullCorpusMemoKeyInput>, allowed: ReadonlySet<string>): Promise<string | null> {
		if (!this.memoCache) return null;
		const record = await this.memoCache.get(input);
		if (!record || !record.text.trim()) return null;
		const text = normalizeCitationRanges(record.text, allowed);
		return memoCitationProblem(text, allowed) === null ? text : null;
	}

	private async writeMemo(input: Readonly<FullCorpusMemoKeyInput>, text: string, allowed: ReadonlySet<string>): Promise<void> {
		if (!this.memoCache || !text.trim() || memoCitationProblem(text, allowed) !== null) return;
		try { await this.memoCache.put(input, text); } catch { /* cache failure never fails analysis */ }
	}

	private throwIfStopped(job: ActiveJob): void {
		if (job.cancelled) throw new FullCorpusCancelledError();
		if (job.deadlineExceeded || this.now() >= job.deadlineAt) {
			this.stopForDeadline(job);
			throw new FullCorpusDeadlineError();
		}
	}
}

class FullCorpusCancelledError extends Error {}
class FullCorpusDeadlineError extends Error {}

async function consume(
	stream: AsyncIterable<AIEvent>,
	job: ActiveJob,
	onDelta?: (text: string) => void,
): Promise<CallOutcome> {
	let streamed = "";
	let resultText: string | undefined;
	let error: string | undefined;
	let errorCode: string | undefined;
	let retryAfterSec: number | undefined;
	let status: number | undefined;
	const metadata: GenerationMetadata = {};
	const facts: TurnFacts = {};
	const iterator = stream[Symbol.asyncIterator]();
	try {
		while (true) {
			const next = await nextOrAbort(iterator.next(), job.abortController.signal);
			if (next === null || next.done) break;
			const event = next.value;
			switch (event.type) {
				case "provider.selected":
					metadata.provider = event.provider;
					if (event.model) metadata.model = event.model;
					if (event.effort) metadata.effort = event.effort;
					if (event.granularity) facts.granularity = event.granularity;
					break;
				case "content.delta":
					streamed += event.text;
					onDelta?.(streamed);
					break;
				case "usage":
					metadata.usage = persistableUsage(event.usage);
					if (event.usage.cachedInputTokens !== undefined) facts.cachedInputTokens = event.usage.cachedInputTokens;
					if (event.usage.reasoningTokens !== undefined) facts.reasoningTokens = event.usage.reasoningTokens;
					break;
				case "fallback":
					metadata.fallback = event.reason ? t("backend.withSuffix", { message: event.to, suffix: event.reason }) : event.to;
					break;
				case "result":
					if ("text" in event.result && event.result.text.trim()) resultText = event.result.text;
					if (event.metadata) {
						replaceExecutionIdentity(metadata, event.metadata);
						if (event.metadata.usage) metadata.usage = persistableUsage(event.metadata.usage);
						if (event.metadata.durationMs !== undefined) facts.runtimeMs = event.metadata.durationMs;
						if (event.metadata.attempts !== undefined) facts.attempts = event.metadata.attempts;
					if (event.metadata.fellBack && !metadata.fallback) {
						metadata.fallback = event.metadata.provider ?? t("session.fellBack");
					}
					}
					break;
				case "error":
					errorCode = event.code;
					retryAfterSec = event.retryAfterSec;
					status = event.status;
					error = describeError(event.code, event.message);
					break;
				case "request.started":
				case "activity":
				case "done":
					break;
			}
		}
	} catch (caught) {
		if (!job.cancelled && !job.deadlineExceeded) {
			error = describeError(undefined, caught instanceof Error ? caught.message : String(caught));
		}
	}
	if (job.cancelled || job.deadlineExceeded) {
		void iterator.return?.().catch(() => undefined);
		return {
			ok: false, text: "", metadata, facts, cancelled: job.cancelled,
			deadlineExceeded: job.deadlineExceeded,
			...(job.deadlineExceeded ? { failureReason: "deadline" as const } : {}),
		};
	}
	if (error) return {
		ok: false, text: "", metadata, facts, error, ...(errorCode ? { errorCode } : {}),
		...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
		...(status !== undefined ? { status } : {}),
		cancelled: false, deadlineExceeded: false,
	};
	const text = nonBlank(resultText) ?? nonBlank(streamed);
	if (text === undefined) return {
		ok: false, text: "", metadata, facts, error: t("session.incompleteResult"),
		cancelled: false, deadlineExceeded: false,
	};
	onDelta?.(text);
	return { ok: true, text, metadata, facts, cancelled: false, deadlineExceeded: false };
}

/**
 * Which wait, if any, can fix a failed call.
 *
 * The retired runtime named its failures `rate_limited` and `transport`; a
 * direct connection reports every failure as `direct_api_error` and carries
 * the HTTP status instead. Reading only the codes meant no direct run ever
 * waited: one 429 or one timeout ended it. A 503 that names its wait is a
 * gateway cooling a target down, which is a rate limit by another name; the
 * other 5xx gateway answers and a call that got no answer at all (timeout,
 * dropped connection, unreadable body) are transport.
 */
export function recoverableFailure(outcome: Pick<CallOutcome, "errorCode" | "status" | "retryAfterSec">): "rate-limit" | "transport" | null {
	const { errorCode, status } = outcome;
	if (errorCode === "rate_limited" || status === 429) return "rate-limit";
	if (status === 503 && outcome.retryAfterSec !== undefined) return "rate-limit";
	if (errorCode === "transport" || errorCode === "stream_interrupted") return "transport";
	// 529 is Anthropic's "overloaded", which its documentation says to retry.
	if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return "transport";
	if (errorCode === "direct_api_error" && status === undefined) return "transport";
	return null;
}

function nextOrAbort<T>(
	next: Promise<IteratorResult<T>>,
	signal: AbortSignal,
): Promise<IteratorResult<T> | null> {
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			resolve(null);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		next.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", onAbort); reject(asError(error)); },
		);
	});
}

function promiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new FullCorpusCancelledError());
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new FullCorpusCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", onAbort); reject(asError(error)); },
		);
	});
}

/**
 * Chunk-level evidence, plus the finer blocks a claim may cite inside a chunk.
 *
 * The chunk list is unchanged: one item per frozen processing chunk, in
 * snapshot order, which is what batching and the leaf requests consume. What is
 * new is that each item carries a chunk-local block map, and every block also
 * resolves to an item of its own whose range is that paragraph rather than the
 * whole chunk. Nothing about coverage, batching or call topology reads this.
 */
interface CorpusEvidenceIndex {
	evidence: EvidenceItem[];
	/** Every citeable id — chunk and block alike — resolved to its own item. */
	byId: Map<string, EvidenceItem>;
	/** Evidence id, chunk or block, to the frozen chunk it was cut from. */
	chunkByEvidenceId: Map<string, FullCorpusChunk>;
}

/** `S17.B2` → `2`, for labelling. Only block ids reach this. */
function blockOrdinal(id: string): string {
	return /\.B([1-9]\d*)$/u.exec(id)?.[1] ?? "1";
}

function corpusEvidenceIndex(snapshot: FullCorpusSnapshot): CorpusEvidenceIndex {
	const totals = new Map<string, number>();
	for (const chunk of snapshot.chunks) totals.set(chunk.path, (totals.get(chunk.path) ?? 0) + 1);
	const displayNames = uniqueCorpusNames(snapshot.files.map((file) => file.path));
	const files = new Map(snapshot.files.map((file) => [file.path, file]));
	const revisions = new Map(snapshot.files.map((file) => [file.path, contentRevision(file.text)]));

	const blocksByChunk = new Map<string, readonly CitationBlock[]>();
	for (const chunk of snapshot.chunks) {
		const blocks = buildCitationBlocks(`S${chunk.index + 1}`, chunk.text);
		// A lone block is the chunk again under a longer name. The chunk id
		// already says exactly that, so nothing is gained by offering both.
		if (blocks.length >= 2) blocksByChunk.set(chunk.id, blocks);
	}
	const ranges = fullCorpusRanges(snapshot, blocksByChunk);

	const evidence: EvidenceItem[] = [];
	const byId = new Map<string, EvidenceItem>();
	const chunkByEvidenceId = new Map<string, FullCorpusChunk>();

	for (const chunk of snapshot.chunks) {
		const id = `S${chunk.index + 1}`;
		const name = baseName(chunk.path).replace(/\.md$/i, "");
		const ordinal = `${chunk.chunkIndex + 1}/${totals.get(chunk.path) ?? 1}`;
		const source = files.get(chunk.path);
		const range = ranges.get(id);
		const blocks = blocksByChunk.get(chunk.id);
		const shared = {
			path: chunk.path, name,
			kind: (chunk.path === snapshot.target.activeFilePath ? "current" : "related") as EvidenceItem["kind"],
			heading: null,
			label: `${displayNames.get(chunk.path) ?? name} · ${ordinal}`,
			anchorText: "",
			...(source ? { revision: revisions.get(chunk.path), revisionKind: source.revision } : {}),
			truncated: (totals.get(chunk.path) ?? 1) > 1,
		};

		const item: EvidenceItem = {
			...shared, id,
			excerpt: chunk.text.length > 0 ? chunk.text : t("corpus.emptyFile"),
			...(range ? { range } : {}),
			...(blocks ? { citationBlocks: blocks } : {}),
		};
		evidence.push(item);
		byId.set(id, item);
		chunkByEvidenceId.set(id, chunk);

		for (const block of blocks ?? []) {
			const blockRange = ranges.get(block.id);
			// The label stays the chunk's: it names where in the manuscript this
			// is, which the block has not changed. What changed is the range.
			byId.set(block.id, {
				...shared, id: block.id, excerpt: block.text,
				// The label is what a saved conversation keys on, so a block
				// cannot share its chunk's. The suffix says which paragraph.
				label: `${shared.label} · ${say("段", "para. ")}${blockOrdinal(block.id)}`,
				...(blockRange ? { range: blockRange } : {}),
			});
			chunkByEvidenceId.set(block.id, chunk);
		}
	}

	return { evidence, byId, chunkByEvidenceId };
}

/**
 * Convert frozen chunk offsets, and any block offsets inside them, to exact
 * editor positions. Chunking itself is untouched: blocks are read from a
 * chunk's own text and mapped through the same verified boundary pass.
 */
function fullCorpusRanges(
	snapshot: FullCorpusSnapshot,
	blocksByChunk: ReadonlyMap<string, readonly CitationBlock[]>,
): Map<string, import("../types").DocRange> {
	const ranges = new Map<string, import("../types").DocRange>();
	const chunksByPath = new Map<string, FullCorpusChunk[]>();
	for (const chunk of snapshot.chunks) {
		const chunks = chunksByPath.get(chunk.path) ?? [];
		chunks.push(chunk);
		chunksByPath.set(chunk.path, chunks);
	}
	for (const file of snapshot.files) {
		const chunks = chunksByPath.get(file.path) ?? [];
		const codePoints = Array.from(file.text);
		const boundaries = new Set<number>();
		for (const chunk of chunks) {
			boundaries.add(chunk.startChar);
			boundaries.add(chunk.endChar);
			for (const block of blocksByChunk.get(chunk.id) ?? []) {
				boundaries.add(chunk.startChar + block.startChar);
				boundaries.add(chunk.startChar + block.endChar);
			}
		}
		const positions = positionsAtCodePointOffsets(codePoints, boundaries);
		for (const chunk of chunks) {
			if (chunk.startChar < 0 || chunk.endChar < chunk.startChar ||
				chunk.endChar > codePoints.length || chunk.endChar - chunk.startChar !== chunk.chars ||
				codePoints.slice(chunk.startChar, chunk.endChar).join("") !== chunk.text) {
				throw new Error(`Invalid frozen chunk range: ${chunk.id}`);
			}
			const from = positions.get(chunk.startChar);
			const to = positions.get(chunk.endChar);
			if (!from || !to) throw new Error(`Missing frozen chunk boundary: ${chunk.id}`);
			ranges.set(`S${chunk.index + 1}`, { from: { ...from }, to: { ...to } });

			for (const block of blocksByChunk.get(chunk.id) ?? []) {
				const blockFrom = positions.get(chunk.startChar + block.startChar);
				const blockTo = positions.get(chunk.startChar + block.endChar);
				// A block that cannot be located exactly is simply not offered;
				// the chunk citation above remains valid and complete.
				if (blockFrom && blockTo) {
					ranges.set(block.id, { from: { ...blockFrom }, to: { ...blockTo } });
				}
			}
		}
	}
	return ranges;
}

/** Map requested code-point boundaries to UTF-16 editor coordinates in one pass. */
function positionsAtCodePointOffsets(
	codePoints: readonly string[],
	offsets: ReadonlySet<number>,
): Map<number, import("../types").DocPosition> {
	const positions = new Map<number, import("../types").DocPosition>();
	let line = 0;
	let ch = 0;
	for (let offset = 0; offset <= codePoints.length; offset += 1) {
		if (offsets.has(offset)) positions.set(offset, { line, ch });
		if (offset === codePoints.length) break;
		const char = codePoints[offset];
		if (char === "\r") {
			line += 1;
			ch = 0;
		} else if (char === "\n") {
			// CRLF is one logical editor line break even when a frozen chunk
			// boundary happens to fall between the two code points.
			if (offset === 0 || codePoints[offset - 1] !== "\r") line += 1;
			ch = 0;
		} else {
			ch += char.length;
		}
	}
	return positions;
}

/** Smallest path suffix that still distinguishes every file in this snapshot. */
function uniqueCorpusNames(paths: readonly string[]): Map<string, string> {
	const segments = new Map(paths.map((path) => {
		const parts = path.split("/");
		parts[parts.length - 1] = (parts[parts.length - 1] ?? path).replace(/\.md$/i, "");
		return [path, parts] as const;
	}));
	const names = new Map<string, string>();
	for (const path of paths) {
		const parts = segments.get(path) ?? [path.replace(/\.md$/i, "")];
		for (let depth = 1; depth <= parts.length; depth += 1) {
			const candidate = parts.slice(-depth).join("/");
			const unique = paths.every((other) =>
				other === path || (segments.get(other) ?? []).slice(-depth).join("/") !== candidate,
			);
			if (unique || depth === parts.length) {
				names.set(path, candidate);
				break;
			}
		}
	}
	return names;
}

/**
 * Resolve the ids an answer actually cited, in manuscript order.
 *
 * The map is built chunk-then-its-blocks in snapshot order, so a cited block
 * sorts with the chunk it was cut from and the persisted source list still
 * reads the way the manuscript does.
 */
function citedEvidenceIn(text: string, byId: ReadonlyMap<string, EvidenceItem>): EvidenceItem[] {
	const used = evidenceIdsIn(text);
	return [...byId.values()].filter((item) => used.has(item.id.toUpperCase()));
}

/** Every id a stage may cite: the chunks it was given, and their blocks. */
function allowedCitationIds(items: readonly EvidenceItem[]): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		ids.add(item.id);
		for (const block of item.citationBlocks ?? []) ids.add(block.id);
	}
	return ids;
}

function evidenceIdsIn(text: string): Set<string> {
	const used = new Set<string>();
	for (const match of text.matchAll(/[[【]\s*([^\]】\n]{1,200})\s*[\]】]/gu)) {
		const ids = citationIdsInMarker(match[1]);
		if (ids) for (const id of ids) used.add(id);
	}
	return used;
}

/** Drop only our own unknown ids; ordinary bracketed prose is untouched. */
function keepAllowedEvidenceIds(text: string, allowed: ReadonlySet<string>): string {
	return normalizeCitationRanges(text, allowed).replace(/[[【]\s*([^\]】\n]{1,200})\s*[\]】]/gu, (whole, group: string) => {
		const ids = citationIdsInMarker(group);
		if (!ids) return whole;
		return ids
			.filter((id) => allowed.has(id))
			.map((id) => `[${id}]`)
			.join("");
	});
}

/** Expand only unambiguous, fully admitted block ranges; never infer missing evidence. */
function normalizeCitationRanges(text: string, allowed: ReadonlySet<string>): string {
	return text.replace(/[[【]\s*([^\]】\n]{1,200})\s*[\]】]/gu, (whole, group: string) => {
		const range = /^\s*(S[1-9]\d*)\.B([1-9]\d*)\s*[-–—]\s*(S[1-9]\d*)\.B([1-9]\d*)\s*$/iu.exec(group);
		if (!range || range[1].toUpperCase() !== range[3].toUpperCase()) return whole;
		const start = Number(range[2]), end = Number(range[4]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start >= 200) return whole;
		const ids = Array.from({ length: end - start + 1 }, (_, offset) => range[1].toUpperCase() + '.B' + (start + offset));
		return ids.every((id) => allowed.has(id)) ? ids.map((id) => '[' + id + ']').join('') : whole;
	});
}

/** Internal memos may be dense, but malformed or unknown citations are not cacheable. */
function memoCitationProblem(text: string, allowed: ReadonlySet<string>): string | null {
	for (const match of text.matchAll(/[[【]\s*([^\]】\n]{1,200})\s*[\]】]/gu)) {
		const ids = citationIdsInMarker(match[1]);
		if (!ids) {
			if (/\bS\d+\b/iu.test(match[1])) return match[0];
		} else if (ids.some((id) => !allowed.has(id))) return match[0];
	}
	return null;
}

/** The single citation grammar used for both sanitation and permission flow. */
function citationIdsInMarker(group: string): string[] | null {
	const normalized = group.trim();
	if (!/^S[1-9]\d*(?:\.B[1-9]\d*)?(?:(?:\s*[,;，；、]\s*|\s+)S[1-9]\d*(?:\.B[1-9]\d*)?)*$/iu.test(normalized)) return null;
	return (normalized.match(/S[1-9]\d*(?:\.B[1-9]\d*)?/giu) ?? []).map((id) => id.toUpperCase());
}

/** Structural final-answer validation; semantic evidence choice remains model-owned. */
function finalCitationProblem(
	text: string,
	allowedIds: ReadonlySet<string>,
	requireCitation = false,
): string | null {
	const citedIds = new Set<string>();
	for (const match of text.matchAll(/[[【]\s*([^\]】\n]{1,200})\s*[\]】]/gu)) {
		const ids = citationIdsInMarker(match[1]);
		if (!ids) {
			if (/\bS\d+\b/iu.test(match[1])) return t("corpus.badCitation", { marker: match[0] });
			continue;
		}
		const unknown = ids.find((id) => !allowedIds.has(id));
		if (unknown) return t("corpus.citationNotAllowed", { id: unknown });
		for (const id of ids) citedIds.add(id);
	}
	if (requireCitation && allowedIds.size > 0 && citedIds.size === 0) {
		return t("corpus.repairRemovedAll");
	}

	for (const claim of citationClaims(text)) {
		const ids = [...claim.matchAll(/[[【]\s*([^\]】\n]{1,200})\s*[\]】]/gu)]
			.flatMap((group) => citationIdsInMarker(group[1]) ?? []);
		if (ids.length === 0) continue;
		const unique = new Set(ids);
		if (unique.size !== ids.length) return t("corpus.duplicateCitation");
		if (unique.size > MAX_FINAL_CITATIONS_PER_CLUSTER) {
			return t("corpus.tooManyCitations", { count: unique.size, max: MAX_FINAL_CITATIONS_PER_CLUSTER });
		}
	}
	return null;
}

/** Split display claims without treating separators inside citation markers as prose. */
function citationClaims(text: string): string[] {
	const claims: string[] = [];
	let current = "";
	let markerDepth = 0;
	for (const char of text) {
		current += char;
		if (char === "[" || char === "【") markerDepth += 1;
		else if ((char === "]" || char === "】") && markerDepth > 0) markerDepth -= 1;
		if (markerDepth === 0 && /[\r\n。！？!?；;]/u.test(char)) {
			if (current.trim()) claims.push(current);
			current = "";
		}
	}
	if (current.trim()) claims.push(current);
	return claims;
}

function memoDocuments(memos: readonly Memo[], level: number): NonNullable<TurnPayload["documents"]> {
	return [
		{
			// Full-width parentheses in both languages: the opaque-label grammar
			// `safePath.ts` accepts is written with them.
			path: say("（全文汇总说明）", "（full-manuscript summary note）"),
			text: say(
				"这些是客户端对同一冻结全文快照生成的中间备忘。方括号中的 [S数字] 与 [S数字.B数字] 都是原文证据编号；必须原样保留，不能改号、补号、降级为所属编号或猜测。",
				"These are intermediate memos the client produced over the same frozen full-manuscript snapshot. The bracketed [S<number>] and [S<number>.B<number>] are evidence ids for the original text; keep them exactly as they are — never renumber, add, downgrade to the containing id, or guess.",
			),
		},
		...memos.map((memo, index) => ({ path: say(`（第 ${level} 层备忘 ${index + 1}/${memos.length}）`, `（level ${level} memo ${index + 1}/${memos.length}）`), text: memo.text })),
	];
}

function memoChars(memos: readonly Memo[]): number {
	return memos.reduce((sum, memo) => sum + countChars(memo.text), 0);
}

/** Reduce only until the memos fit the final call, not one group's budget. */
function needsReduction(memos: readonly Memo[]): boolean {
	return memos.length > FINAL_SYNTHESIS_INPUT_ITEMS || memoChars(memos) > FINAL_SYNTHESIS_INPUT_CHARS;
}

function packMemos(memos: readonly Memo[]): Memo[][] {
	const pieces = memos.flatMap(splitMemo);
	const groups: Memo[][] = [];
	let current: Memo[] = [];
	let chars = 0;
	for (const memo of pieces) {
		const size = countChars(memo.text);
		if (current.length >= REDUCTION_INPUT_ITEMS || (current.length > 0 && chars + size > REDUCTION_INPUT_CHARS)) {
			groups.push(current);
			current = [];
			chars = 0;
		}
		current.push(memo);
		chars += size;
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

function splitMemo(memo: Memo): Memo[] {
	if (countChars(memo.text) <= REDUCTION_INPUT_CHARS) return [memo];
	const chars = Array.from(memo.text);
	const pieces: Memo[] = [];
	for (let start = 0; start < chars.length; start += REDUCTION_INPUT_CHARS) {
		pieces.push({ id: `${memo.id}:${pieces.length + 1}`, text: chars.slice(start, start + REDUCTION_INPUT_CHARS).join("") });
	}
	return pieces;
}

function leafPrompt(index: number, total: number): string {
	return [
		say(`你正在分析同一份冻结全文快照的第 ${index + 1}/${total} 批。`, `You are analysing batch ${index + 1}/${total} of one frozen full-manuscript snapshot.`),
		say("用户最终问题已经作为本次冻结消息中的最后一条作者消息提供；不要复述或改写它。", "The user's final question is already provided as the last writer message in this frozen conversation; do not restate or rephrase it."),
		say("只输出供后续汇总使用的紧凑分析备忘，不要声称已经看完全文，也不要直接写最终答复。", "Output only a compact analysis memo for later summarisation; do not claim to have read the whole manuscript, and do not write the final answer."),
		say("每个原子判断独占一项，记录与问题有关的事实、模式、矛盾和例外。", "One atomic claim per item, recording the facts, patterns, contradictions and exceptions relevant to the question."),
		say("这是内部 provenance 阶段：每项保留所有直接支持它的本批真实 [S数字]，不要为了展示简洁而抽样或限制引用。", "This is the internal provenance stage: every item keeps all the real [S<number>] ids from this batch that directly support it; do not sample or cap citations for the sake of brevity."),
		say("证据正文中每个段落前标有 [S数字.B数字] 形式的块编号。引用时优先使用最直接支持该判断的块编号；只有当判断确实横跨整份证据、没有更细的块可用时，才使用不带 .B 的 [S数字]。", "Every paragraph of the evidence is prefixed with a block id of the form [S<number>.B<number>]. Prefer the block id that most directly supports a claim; use the plain [S<number>] without .B only when the claim genuinely spans the whole item and no finer block applies."),
	].join("\n");
}

/**
 * The reduction contract, with the two levers convergence depends on.
 *
 * An earlier version demanded that every claim keep its complete citation set
 * and named no output length at all. On a novel-sized corpus the id mass alone
 * made memos incompressible, each level's output matched its input, and the
 * run burned to the level cap. Downstream, the final answer only ever uses
 * one to two ids per claim (four at most, the same guardrail applied here),
 * so provenance beyond that was carried through the tree and then discarded.
 */
function reductionPrompt(level: number): string {
	return [
		say(`这是全文分析的第 ${level} 层汇总。用户最终问题已经在冻结消息中提供。`, `This is level ${level} of the full-manuscript summarisation. The user's final question is already in the frozen conversation.`),
		say("把所附备忘压缩为明显更短的汇总备忘，合并重复项，保留冲突、例外和关键细节。", "Compress the attached memos into a clearly shorter summary memo: merge duplicates, keep conflicts, exceptions and key details."),
		say(`输出总长不得超过 ${REDUCTION_OUTPUT_CHARS} 字，这是硬性预算：超出会让汇总无法收敛。压缩靠合并与取舍，不是删掉判断本身。`, `The output must not exceed ${REDUCTION_OUTPUT_CHARS} characters; this is a hard budget, and exceeding it keeps the summarisation from converging. Compress by merging and choosing, not by dropping the claims themselves.`),
		say("只能使用输入中真实出现的 [S数字] 与 [S数字.B数字] 编号，不要发明；块编号不得为了简洁替换成它所属的 [S数字]，那会让证据退回整块粒度。", "Use only [S<number>] and [S<number>.B<number>] ids that actually appear in the input; never invent one. Do not replace a block id with its containing [S<number>] for brevity — that drops the evidence back to whole-block granularity."),
		say(`每个原子判断最多保留 ${MAX_FINAL_CITATIONS_PER_CLUSTER} 个最直接支持它的编号，优先保留块编号；一个判断似乎需要更多编号时，把它拆成更小的原子判断分别引用。`, `Keep at most ${MAX_FINAL_CITATIONS_PER_CLUSTER} of the most direct supporting ids per atomic claim, preferring block ids; when a claim seems to need more, split it into smaller atomic claims and cite each separately.`),
		say("这仍是中间备忘，不要声称已经完成全文回答。", "This is still an intermediate memo; do not claim the full-manuscript answer is complete."),
	].join("\n");
}

function finalPrompt(partial = false): string {
	return [
		partial
			? say(
					"客户端只完成了冻结全文快照的一部分批次，并把已完成结果汇总在所附备忘中。答案必须明确说明未覆盖全文，不得声称这是完整全文结论。",
					"The client completed only part of the batches of the frozen full-manuscript snapshot and summarised the finished results in the attached memos. The answer must state clearly that it does not cover the whole manuscript, and must not claim to be a complete full-manuscript conclusion.",
				)
			: say(
					"客户端已经逐批分析完整的冻结全文快照，并把中间结果汇总在所附备忘中。",
					"The client analysed the complete frozen full-manuscript snapshot batch by batch and summarised the intermediate results in the attached memos.",
				),
		say("现在请直接回答用户的问题。综合所有备忘，保留重要分歧和例外，不要提到批次、map/reduce 或中间备忘。", "Now answer the user's question directly. Synthesise all memos, keep the important disagreements and exceptions, and do not mention batches, map/reduce or intermediate memos."),
		say("中间备忘保留了完整 provenance，但最终答案不要复述整棵祖先引用集合。", "The intermediate memos keep full provenance, but the final answer must not repeat the whole ancestral citation set."),
		say("每个实质性判断或结构化条目默认只保留 1–2 个最直接支持它的 [S数字]。只有该项必须由 3–4 个彼此不可替代的来源共同成立时才可使用 3–4 个；若看似需要 5 个以上，应拆成多个原子判断并分别引用直接证据。", "By default keep only the 1–2 most direct supporting [S<number>] ids per substantive claim or structured entry. Use 3–4 only when the item genuinely rests on 3–4 sources none of which can replace another; if it seems to need 5 or more, split it into several atomic claims and cite the direct evidence for each."),
		say("不得为了减少引用而写出缺乏证据的判断。只使用备忘中真实出现且直接支持当前判断的编号，不要编造。", "Never write an unsupported claim to reduce citations. Use only ids that actually appear in the memos and directly support the claim at hand; never invent one."),
		say("备忘中的块编号 [S数字.B数字] 要原样保留，不要替换成它所属的 [S数字]：读者会点击这个编号定位原文，块编号指向具体段落，[S数字] 指向整个处理块。", "Keep block ids [S<number>.B<number>] from the memos exactly as they are; do not replace one with its containing [S<number>]. The reader clicks the id to locate the original text: a block id points at a specific paragraph, [S<number>] at a whole processing block."),
		say("人物出场或时间线任务优先按位置、事件、时间点、作用组织；只有这些字段与用户问题相关时才使用，不要强行补全。", "For character-appearance or timeline tasks, organise by location, event, point in time and role, but only where those fields matter to the user's question; do not pad them in."),
	].join("\n");
}

function finalRecoveryPrompt(problem?: string, partial = false): string {
	return [
		finalPrompt(partial),
		say("这是最后一次合成尝试。请降低推理复杂度，输出更短、更直接的答案；只保留最重要且有明确证据的判断。", "This is the last synthesis attempt. Reduce reasoning complexity and give a shorter, more direct answer; keep only the most important claims that have clear evidence."),
		say("答案不超过 1200 字。", "Keep the answer under 1200 characters."),
		...(problem ? [say(`上一次尝试失败或未通过校验：${problem}。`, `The previous attempt failed or did not pass validation: ${problem}.`)] : []),
		say("仍须保留每项判断的合法原文引用，不得编造、改号或删除全部引用。", "Every claim must still carry valid citations to the original text; do not invent, renumber or drop all citations."),
	].join("\n");
}

function memoCacheInput(
	stage: "leaf" | "reduce",
	input: Parameters<FullCorpusController["call"]>[2],
): FullCorpusMemoKeyInput {
	return {
		stage,
		routing: {
			connectionId: input.preferences.connectionId ?? null,
			provider: input.preferences.provider ?? null,
			model: input.preferences.model ?? null,
			effort: input.preferences.effort ?? null,
		},
		messages: input.messages,
		instructions: input.skill ?? null,
		documents: input.documents ?? [],
	};
}

function fullCorpusResumeKey(
	snapshot: FullCorpusSnapshot,
	messages: readonly RequestMessage[],
	instructions: SkillPayload | undefined,
	preferences: Readonly<SessionPreferences>,
): string {
	return fullCorpusCacheKey({
		stage: "run", messages, instructions: instructions ?? null,
		routing: {
			connectionId: preferences.connectionId ?? null, provider: preferences.provider ?? null,
			model: preferences.model ?? null, effort: preferences.effort ?? null,
		},
		documents: snapshot.batches.map((batch) => ({
			path: `${snapshot.target.root || "/"}#batch:${batch.index}`,
			text: batch.chunks.map((chunk) =>
				`${chunk.id}\n${chunk.path}\n${chunk.revision}\n${chunk.startChar}:${chunk.endChar}\n${chunk.text}`
			).join("\n\u0000\n"),
		})),
	});
}

function successfulMemoOutcome(text: string): CallOutcome {
	return { ok: true, text, metadata: {}, facts: {}, cancelled: false, deadlineExceeded: false };
}

function isMemo(value: Memo | undefined): value is Memo {
	return value !== undefined;
}

function shouldStopLeafDispatch(
	job: ActiveJob,
	leafMemos: readonly (Memo | undefined)[],
	concurrency: number,
): boolean {
	if (job.softDeadlineReached) return true;
	const completed = leafMemos.filter(isMemo);
	const completedLeaves = completed.length;
	const projectedLeaves = completedLeaves + job.inFlight.size;
	if (projectedLeaves === 0 || job.successfulCallDurationsMs.length === 0) return false;
	const typical = Math.max(MIN_SOFT_RESERVE_MS, ...job.successfulCallDurationsMs);
	const observedChars = completed.reduce((sum, memo) => sum + countChars(memo.text), 0);
	const averageChars = completedLeaves > 0 ? Math.max(1, Math.ceil(observedChars / completedLeaves)) : 1;
	// Verbose models make the character cap, not the item cap, determine how
	// many reduction groups are needed. Estimate wall-clock waves rather than
	// raw calls because independent groups retain the configured concurrency.
	const projectedChars = averageChars * projectedLeaves;
	const firstReductionGroups = Math.max(
		projectedLeaves > REDUCTION_INPUT_ITEMS ? Math.ceil(projectedLeaves / REDUCTION_INPUT_ITEMS) : 0,
		projectedChars > REDUCTION_INPUT_CHARS ? Math.ceil(projectedChars / REDUCTION_INPUT_CHARS) : 0,
	);
	const reductionWaves = firstReductionGroups === 0
		? 0
		: Math.ceil(firstReductionGroups / Math.max(1, concurrency)) +
			Math.max(0, Math.ceil(Math.log(Math.max(1, firstReductionGroups)) / Math.log(REDUCTION_INPUT_ITEMS)));
	const reserve = typical * (reductionWaves + 2) + MIN_SOFT_RESERVE_MS;
	if (job.deadlineAt - job.now() > reserve) return false;
	job.softDeadlineReached = true;
	return true;
}

function freezeBaseMessages(options: FullCorpusRunOptions): readonly RequestMessage[] {
	const messages = options.messages ?? conversationMessages(
		options.session,
		options.question,
		options.currentMessageId,
	);
	return Object.freeze(messages.map((message) => Object.freeze({ ...message })));
}

function messagesForStage(base: readonly RequestMessage[], prompt: string): RequestMessage[] {
	return [
		...base.map((message) => ({ ...message })),
		{ role: "user", content: prompt },
	];
}

function isBlockedWritingAction(options: FullCorpusRunOptions): boolean {
	return options.plan.blockingReason === "full-not-supported-for-writing-action" ||
		options.skill?.action === "rewrite" ||
		options.skill?.action === "continue" ||
		options.instructionPayload?.action === "rewrite" ||
		options.instructionPayload?.action === "continue";
}

function coverageFor(
	snapshot: FullCorpusSnapshot,
	completedBatchIndexes: ReadonlySet<number>,
	reductionBatches: number,
	status: FullCorpusCoverage["status"],
	job?: ActiveJob,
	backendCalls = 0,
	limitReached?: Exclude<FullCorpusFailureReason, "resume-mismatch">,
	totalReductionBatches?: number,
	summaryStatus: NonNullable<FullCorpusCoverage["summaryStatus"]> = status === "complete" ? "complete" : "failed",
): FullCorpusCoverage {
	const indexes = [...completedBatchIndexes].sort((left, right) => left - right);
	const completedChunks = snapshot.batches.filter((batch) => completedBatchIndexes.has(batch.index)).flatMap((batch) => [...batch.chunks]);
	const completedIds = new Set(completedChunks.map((chunk) => chunk.id));
	const includedFiles = snapshot.files.filter((file) =>
		snapshot.chunks.filter((chunk) => chunk.path === file.path).every((chunk) => completedIds.has(chunk.id)),
	).length;
	const incompleteFiles = snapshot.files.filter((file) =>
		snapshot.chunks.some((chunk) => chunk.path === file.path && !completedIds.has(chunk.id)),
	).map((file) => file.path);
	return {
		target: "current-manuscript", status, includedFiles, totalFiles: snapshot.totalFiles,
		includedChars: completedChunks.reduce((sum, chunk) => sum + chunk.chars, 0),
		totalChars: snapshot.totalChars, completedBatches: indexes.length, completedBatchIndexes: indexes, totalBatches: snapshot.batches.length, reductionBatches,
		...(totalReductionBatches !== undefined ? { totalReductionBatches } : {}), summaryStatus,
		readFailures: snapshot.readFailures.length,
		uncoveredFiles: [...new Set([...snapshot.uncoveredFiles, ...incompleteFiles])],
		...(job ? {
			backendCalls, maxBackendCalls: job.maxBackendCalls, deadlineMs: job.deadlineMs,
		} : {}),
		...(limitReached ? { limitReached } : {}),
	};
}

function isCompleteCoverage(coverage: FullCorpusCoverage): boolean {
	return coverage.status === "complete" && coverage.includedFiles === coverage.totalFiles &&
		coverage.includedChars === coverage.totalChars && coverage.completedBatches === coverage.totalBatches &&
		coverage.completedBatchIndexes?.every((index, position) => index === position) !== false &&
		coverage.readFailures === 0 && coverage.uncoveredFiles.length === 0;
}

function reportFor(
	options: FullCorpusRunOptions,
	snapshot: FullCorpusSnapshot,
	coverage: FullCorpusCoverage,
	cited: readonly EvidenceItem[],
	existingIndex?: CorpusEvidenceIndex,
): ContextBuildReport {
	const completedIndexes = coverage.completedBatchIndexes ?? Array.from({ length: coverage.completedBatches }, (_, index) => index);
	const completedSet = new Set(completedIndexes);
	const completed = snapshot.batches.filter((batch) => completedSet.has(batch.index)).flatMap((batch) => [...batch.chunks]);
	const activeFileChars = completed.filter((chunk) => chunk.path === snapshot.target.activeFilePath).reduce((sum, chunk) => sum + chunk.chars, 0);
	const revisions = new Set(snapshot.files.map((file) => file.revision));
	const sourceRevision = revisions.size > 1 ? "mixed" : revisions.has("editor") ? "editor" : "saved";
	const index = cited.length > 0 ? existingIndex ?? corpusEvidenceIndex(snapshot) : undefined;
	const sources: ContextSourceSnapshot[] = cited.map((item) => {
		const chunk = index?.chunkByEvidenceId.get(item.id);
		const canonical = index?.byId.get(item.id) ?? item;
		return {
			path: canonical.path, label: canonical.label,
			type: canonical.path === snapshot.target.activeFilePath ? "current" : "retrieved",
			anchorText: canonical.anchorText,
			...(canonical.range ? { from: canonical.range.from, to: canonical.range.to } : {}),
			...(canonical.revision ? { revision: canonical.revision } : {}),
			...(canonical.revisionKind ? { revisionKind: canonical.revisionKind } : {}),
			truncated: chunk ? snapshot.chunks.some((candidate) => candidate.path === chunk.path && candidate.id !== chunk.id) : canonical.truncated,
		};
	});
	return {
			mode: options.plan.mode, resolvedDepth: options.plan.resolvedDepth, task: options.plan.task,
		sourceRevision, selectionChars: 0, surroundingChars: 0, activeFileChars,
		retrievedChars: Math.max(0, coverage.includedChars - activeFileChars), rawChars: snapshot.totalChars,
		deduplicatedChars: 0, finalChars: coverage.includedChars, estimatedTokens: Math.ceil(coverage.includedChars / 2),
		includedSources: completed.length, excludedArchiveCount: snapshot.excludedFiles.length, truncatedSources: 0,
		omittedSources: coverage.uncoveredFiles.length, budgetExpandedForSelection: false,
		conversationMessages: Math.max(0, (options.messages?.length ?? conversationMessages(
			options.session, options.question, options.currentMessageId,
		).length) - 1),
		...(options.skill ? { skillId: options.skill.id } : {}),
		...(sources.length > 0 ? { sources } : {}), corpusCoverage: coverage,
	};
}

function emptyCorpusTimings(): CorpusPhaseTimings {
	return { snapshotMs: 0, evidenceMs: 0, leafMs: 0, reduceMs: 0, finalMs: 0, totalMs: 0 };
}

function beginPhase(job: ActiveJob, phase: FullCorpusPhase): void {
	finishActivePhase(job);
	job.activePhase = { phase, startedAt: job.now() };
}

/** The timings field a phase accumulates into. */
function phaseTimingKey(phase: FullCorpusPhase): Exclude<keyof CorpusPhaseTimings, "totalMs"> {
	return `${phase}Ms`;
}

function finishActivePhase(job: ActiveJob): void {
	const active = job.activePhase;
	if (!active) return;
	job.timings[phaseTimingKey(active.phase)] += elapsedMs(active.startedAt, job.now());
	job.activePhase = null;
}

function elapsedMs(startedAt: number, endedAt: number): number {
	return Math.max(0, Math.floor(endedAt - startedAt));
}

function timingsFor(job: ActiveJob): CorpusPhaseTimings {
	const timings = { ...job.timings, totalMs: elapsedMs(job.startedAt, job.now()) };
	if (job.activePhase) {
		timings[phaseTimingKey(job.activePhase.phase)] += elapsedMs(job.activePhase.startedAt, job.now());
	}
	return timings;
}

function setCorpusTimings(metadata: GenerationMetadata, job: ActiveJob): void {
	metadata.corpusTimings = timingsFor(job);
}

function cancelledResult(
	snapshot: FullCorpusSnapshot, completedBatchIndexes: ReadonlySet<number>, reductionBatches: number, metadata: GenerationMetadata, requestIds: string[],
	job?: ActiveJob, resumeKey?: string,
): FullCorpusRunResult {
	if (job) setCorpusTimings(metadata, job);
	const coverage = coverageFor(snapshot, completedBatchIndexes, reductionBatches, "cancelled", job, requestIds.length, undefined, job?.totalReductionBatches, "failed");
	return { ok: false, error: t("corpus.cancelled"), metadata: { ...metadata, errorCode: "cancelled" }, coverage, cancelled: true, requestIds, ...(resumeKey ? { resumeKey } : {}) };
}

function deadlineResult(
	snapshot: FullCorpusSnapshot | undefined,
	completedBatchIndexes: ReadonlySet<number>,
	reductionBatches: number,
	metadata: GenerationMetadata,
	requestIds: string[],
	options: FullCorpusRunOptions,
	job: ActiveJob,
	resumeKey?: string,
): FullCorpusRunResult {
	resumeKey = resumeKey ?? metadata.fullCorpusResumeKey;
	metadata.errorCode = "deadline";
	setCorpusTimings(metadata, job);
	if (!snapshot) {
		return {
			ok: false, error: t("corpus.deadlineNoSnapshot"),
			metadata: { ...metadata }, deadlineExceeded: true, failureReason: "deadline", requestIds,
		};
	}
	const coverage = coverageFor(
		snapshot, completedBatchIndexes, reductionBatches, "failed", job, requestIds.length, "deadline", job.totalReductionBatches, "failed",
	);
	metadata.contextReport = reportFor(options, snapshot, coverage, []);
	return {
		ok: false, error: t("corpus.deadline"), metadata: { ...metadata },
		coverage, deadlineExceeded: true, failureReason: "deadline", requestIds, ...(resumeKey ? { resumeKey } : {}),
	};
}

function backendCallLimitOutcome(maxBackendCalls: number): CallOutcome {
	return {
		ok: false, text: "", metadata: {}, facts: {},
		error: t("corpus.backendCallLimit", { count: maxBackendCalls }),
		cancelled: false, deadlineExceeded: false, failureReason: "backend-call-limit",
	};
}

function softDeadlineOutcome(): CallOutcome {
	return { ok: false, text: "", metadata: {}, facts: {}, error: t("corpus.softDeadline"), cancelled: false, deadlineExceeded: false, failureReason: "soft-deadline" };
}

export function resolveFullCorpusBackendCallLimit(leafBatches: number, override?: number): number {
	const safeLeafBatches = Number.isFinite(leafBatches)
		? Math.max(0, Math.floor(leafBatches))
		: 0;
	const derived = Math.min(
		MAX_FULL_CORPUS_BACKEND_CALLS,
		Math.max(MIN_DEFAULT_FULL_CORPUS_BACKEND_CALLS, (safeLeafBatches * 2) + DEFAULT_FULL_CORPUS_CALL_BUFFER),
	);
	return boundedInteger(override, derived, 0, MAX_FULL_CORPUS_BACKEND_CALLS);
}

function connectionMetadata(preferences: Readonly<SessionPreferences>): GenerationMetadata {
	return {
		...(preferences.connectionId ? { connectionId: preferences.connectionId } : {}),
		...(preferences.connectionName ? { connectionName: preferences.connectionName } : {}),
		...(preferences.connectionType ? { connectionType: preferences.connectionType } : {}),
		...(preferences.connectionDetail ? { connectionDetail: preferences.connectionDetail } : {}),
		...selectedExecutionIdentity(preferences),
	};
}

function mergeMetadata(target: GenerationMetadata, source: GenerationMetadata): void {
	for (const key of ["provider", "model", "effort", "fallback", "errorCode"] as const) {
		if (source[key] !== undefined) target[key] = source[key];
	}
	if (source.usage) target.usage = addUsage(target.usage, source.usage);
}

function mergeFacts(target: TurnFacts, source: TurnFacts): void {
	for (const key of ["cachedInputTokens", "reasoningTokens", "runtimeMs", "attempts"] as const) {
		if (source[key] !== undefined) target[key] = (target[key] ?? 0) + source[key];
	}
	if (source.granularity) target.granularity = source.granularity;
}

function addUsage(left: GenerationMetadata["usage"], right: GenerationMetadata["usage"]): GenerationMetadata["usage"] {
	const result: NonNullable<GenerationMetadata["usage"]> = {};
	for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
		if (left?.[key] !== undefined || right?.[key] !== undefined) result[key] = (left?.[key] ?? 0) + (right?.[key] ?? 0);
	}
	return result;
}

function persistableUsage(usage: UsageInfo): NonNullable<GenerationMetadata["usage"]> {
	return {
		...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
		...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
		...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
	};
}

function isEvidence(value: EvidenceItem | undefined): value is EvidenceItem {
	return value !== undefined;
}

function nonBlank(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function boundedInteger(
	value: number | undefined,
	fallbackValue: number,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isFinite(value)) return Math.max(minimum, Math.min(maximum, Math.floor(fallbackValue)));
	return Math.max(minimum, Math.min(maximum, Math.floor(value as number)));
}
