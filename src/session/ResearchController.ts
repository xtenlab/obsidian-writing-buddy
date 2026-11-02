/**
 * A bounded Agent loop over client-owned Vault evidence.
 *
 * Every action and, for chat turns, the final synthesis are ordinary
 * AIBackend.chat calls. The client supplies bounded observations and owns every
 * R#/S# lookup; the model never gets a path parameter or write authority.
 * Search previews travel through a bounded observation prompt. Writing turns
 * can stop after gathering and hand the admitted evidence to the existing
 * rewrite path.
 */

import { t } from "../i18n";
import type { AIBackend, AIEvent, RequestMessage, SkillPayload, TurnPayload } from "../backend/AIBackend";
import type { AssembledContext, ContextPlan, VaultReader } from "../context/types";
import type { EvidenceItem } from "../context/evidence";
import { buildEvidence, evidenceDocumentPayloads } from "../context/evidence";
import {
	DEFAULT_MAX_QUERY_CHARS,
	RESEARCH_PLAN_SENTINEL,
	containsResearchAction,
	isRecoverablePlanFallback,
	keepAllowedResearchCitations,
	normalizeResearchQueryKey,
	parseResearchAction,
	researchCitationIds,
	researchDecisionPrompt,
	researchPlanRetryPrompt,
	researchPlannerPrompt,
	researchSynthesisPrompt,
	researchToolObservationPrompt,
	type ResearchToolObservation,
} from "../context/ResearchProtocol";
import {
	MAX_RESEARCH_CHAR_LIMIT,
	MAX_RESEARCH_EVIDENCE_LIMIT,
	DEFAULT_RESEARCH_PROBE_LIMIT,
	MAX_RESEARCH_FILE_LIMIT,
	MAX_RESEARCH_PROBE_LIMIT,
	MAX_RESEARCH_PER_EVIDENCE_CHARS,
	ResearchRetriever,
	ResearchRetrievalCancelledError,
	ResearchRetrievalDeadlineError,
	type ResearchRetrievalBudget,
	type ResearchRetrievalReport,
	type ResearchRetrievalSession,
	type ResearchSearchSource,
} from "../context/ResearchRetriever";
import type {
	ConversationSession,
	GenerationMetadata,
	ResearchContextReport,
	ResearchPlanFallbackReason,
	ResearchTermination,
	SessionPreferences,
} from "../types";
import { createRequestId } from "../util/id";
import { countChars } from "../util/text";
import { describeError, persistableUsage, type TurnFacts } from "./ConversationController";
import { conversationMessages } from "./conversationHistory";
import { sharedContinueOutputInstruction, sharedRewriteOutputInstruction } from "../instructions/sharedInstructions";
import { replaceExecutionIdentity, restoreSelectedExecutionIdentity, selectedExecutionIdentity } from "../util/executionIdentity";
import { asError } from "../util/errors";

/** Four action turns permit two search/read cycles or a later coverage handoff. */
export const MAX_RESEARCH_PLANNING_ROUNDS = 4;
/** Normal chat reserves one final synthesis call after the bounded action loop. */
export const MAX_RESEARCH_BACKEND_CALLS = 5;
/**
 * Calls the action loop may spend, leaving synthesis a seat.
 *
 * The reservation used to be implicit: four planning rounds plus one synthesis
 * happened to equal the ceiling, so nothing enforced it and any extra call
 * inside the loop took synthesis's seat. A corrective retry is exactly such an
 * extra call, and when one fired the run ended with `资料研究超过调用上限，未生成
 * 最终回答` — a hundred thousand input tokens spent for no answer at all, which
 * is strictly worse than the unresearched answer the retry exists to prevent.
 *
 * Nothing in the loop may spend this last call. A turn that has done all the
 * research it can afford still has to say something.
 */
export const MAX_RESEARCH_ACTION_CALLS = MAX_RESEARCH_BACKEND_CALLS - 1;
/** One action can issue at most one query, so this cannot exceed action rounds. */
export const MAX_RESEARCH_TOTAL_QUERIES = MAX_RESEARCH_PLANNING_ROUNDS;
export const MAX_RESEARCH_QUERY_CHARS = DEFAULT_MAX_QUERY_CHARS;
/**
 * Sources a run may open before the evidence budgets take over.
 *
 * Two searches at six probes each, and enough left that reading what they found
 * is still possible. Never below the context plan's own number, so a wider plan
 * still widens research.
 */
export const DEFAULT_RESEARCH_FILE_ALLOWANCE = 24;
/** Whole-run ceiling for client-generated observation prompts, including replays. */
export const MAX_RESEARCH_OBSERVATION_CHARS = 16_000;
/** Deadline for the bounded action phase and, separately, final synthesis. */
/**
 * Wall clock for the bounded action phase.
 *
 * Forty-five seconds was calibrated when a read admitted six hundred characters
 * and previews opened on the head of a passage: runs finished quickly because
 * they accomplished little. With previews centred on their match the model
 * reads what it finds — measured on a real manuscript, one search, a six-handle
 * batch read and an answer citing four admitted sources, in fifty-one seconds.
 * The old limit turned that into nothing at all, which is worse than the wrong
 * answer it replaced.
 *
 * This is a runaway guard on research, not on answering. The clock starts at
 * the first retrieval the model asks for and covers the action loop from
 * there: further planning calls, searches and reads. A call that merely
 * answers — the merged decision call before any retrieval, or the final
 * synthesis — is not research and is not bounded by it; it runs under the
 * same contract as an ordinary turn (the writer's cancel, the backend's own
 * limits). Measured on a local 27B model, reading a 5.7k-token prompt alone
 * takes ~55 s; a clock armed before the model has done anything turned that
 * into a cancelled turn with no answer, which is the failure D-025 removed
 * from the retrieval side. Ordinary turns no longer enter this loop at all
 * (D-024, D-029), so the wait applies to questions that genuinely need the
 * manuscript searched.
 */
export const DEFAULT_RESEARCH_DEADLINE_MS = 90_000;
export const MAX_RESEARCH_DEADLINE_MS = 120_000;

export interface ResearchBudget extends ResearchRetrievalBudget {
	maxPlanningRounds: number;
	maxQueries: number;
	maxQueryChars: number;
	maxObservationChars: number;
	deadlineMs: number;
}

export interface ResearchRunOptions {
	session: ConversationSession;
	preferences: SessionPreferences;
	/** The visible writer request. */
	question?: string;
	/**
	 * Optional already-composed transcript, including the current user turn.
	 * When absent the normal bounded conversation window is composed locally.
	 */
	messages?: readonly RequestMessage[];
	currentMessageId?: string;
	/** Already composed by the instruction owner; this controller never resolves Skills. */
	skill?: SkillPayload;
	initialEvidence?: readonly EvidenceItem[];
	initialContext?: AssembledContext;
	/** Locally selected before entering this controller. */
	plan: ContextPlan;
	budget?: Partial<ResearchBudget>;
	onUpdate?: (progress: ResearchProgress) => void;
	/** Ephemeral, content-safe diagnostics for tests/development; never persisted or returned. */
	onTrace?: (trace: readonly ResearchTraceEntry[]) => void;
}

export type ResearchPhase = "planning" | "retrieving" | "synthesizing";

/** Content-free counters; only final synthesis text is ever streamed outward. */
export interface ResearchProgress {
	phase: ResearchPhase;
	planningRound: number;
	maxPlanningRounds: number;
	backendCalls: number;
	queriesExecuted: number;
	filesRead: number;
	evidenceItems: number;
	evidenceChars: number;
	requestId?: string;
	/** Empty during planning/retrieval so intermediate model output cannot leak. */
	finalText: string;
	metadata: GenerationMetadata;
	facts: TurnFacts;
}

/** Compatibility-friendly name for consumers that call it a run report. */
export type ResearchRunReport = ResearchContextReport;

/** In-memory diagnostics for one bounded run; never attach this to persisted metadata. */
export interface ResearchTraceEntry {
	sequence: number;
	action: "search" | "read" | "readAround" | "completeCorpus" | "synthesize" | "final";
	args?: { queryChars?: number; handle?: string; before?: number; after?: number };
	handles?: string[];
	ok: boolean;
	error?: string;
	fallback?: ResearchPlanFallbackReason | "backend" | "unconsumable-final-search";
	usage?: NonNullable<GenerationMetadata["usage"]>;
	durationMs?: number;
}

export type ResearchTrace = ResearchTraceEntry[];

export type ResearchRunFailure = {
	ok: false;
	error: string;
	metadata: GenerationMetadata;
	report: ResearchContextReport;
	cancelled?: boolean;
	deadlineExceeded?: boolean;
	requestIds: string[];
};

export type ResearchGatherResult =
	| {
		ok: true;
		metadata: GenerationMetadata;
		facts: TurnFacts;
		evidence: EvidenceItem[];
		report: ResearchContextReport;
		requestIds: string[];
	}
	| ResearchRunFailure;

export type ResearchRunResult =
	| {
		ok: true;
		outcome: "answer";
		answer: string;
		metadata: GenerationMetadata;
		facts: TurnFacts;
		evidence: EvidenceItem[];
		citedEvidence: EvidenceItem[];
		report: ResearchContextReport;
		requestIds: string[];
	}
	| {
		ok: true;
		outcome: "complete-corpus";
		metadata: GenerationMetadata;
		facts: TurnFacts;
		report: ResearchContextReport;
		requestIds: string[];
	}
	| ResearchRunFailure;

export function isCompleteCorpusHandoff(
	result: ResearchRunResult,
): result is Extract<ResearchRunResult, { ok: true; outcome: "complete-corpus" }> {
	return result.ok && result.outcome === "complete-corpus";
}

interface ActiveResearchJob {
	cancelled: boolean;
	deadlineExceeded: boolean;
	requestId: string | null;
	abortController: AbortController;
}

interface CallOutcome {
	ok: boolean;
	text: string;
	metadata: GenerationMetadata;
	facts: TurnFacts;
	error?: string;
	errorCode?: string;
	cancelled: boolean;
	deadlineExceeded: boolean;
}

interface ReportState {
	backendCalls: number;
	observationChars: number;
	planningRounds: number;
	retrievalRounds: number;
	queriesRequested: number;
	queriesExecuted: number;
	initialEvidenceItems: number;
	initialEvidenceChars: number;
	addedEvidenceItems: number;
	filesConsidered: number;
	filesRead: number;
	readFailures: number;
	excludedByMetadata: number;
	forcedSynthesis: boolean;
	/** The research clock ran out and the answer was synthesised from what was admitted by then. */
	deadlineReached?: boolean;
	planFallbackReason?: ResearchPlanFallbackReason;
	fileLimitReached: boolean;
	evidenceLimitReached: boolean;
	charLimitReached: boolean;
	observationLimitReached: boolean;
}

export class ResearchController {
	private activeJob: ActiveResearchJob | null = null;
	private readonly retriever: ResearchRetriever;

	constructor(
		source: ResearchSearchSource | VaultReader | ResearchRetriever,
		private readonly backend: AIBackend,
		private readonly nextRequestId: () => string = createRequestId,
		private readonly now: () => number = Date.now,
	) {
		this.retriever = source instanceof ResearchRetriever ? source : new ResearchRetriever(source, { now });
	}

	get isRunning(): boolean { return this.activeJob !== null; }

	async cancel(): Promise<void> {
		const job = this.activeJob;
		if (!job) return;
		job.cancelled = true;
		job.abortController.abort();
		if (job.requestId) await this.backend.cancel(job.requestId);
	}

	async run(options: ResearchRunOptions): Promise<ResearchRunResult> {
		return this.execute(options, "synthesize");
	}

	/** Gather admitted evidence without spending a model call on chat synthesis. */
	async gather(options: ResearchRunOptions): Promise<ResearchGatherResult> {
		return this.execute(options, "gather");
	}

	private execute(options: ResearchRunOptions, completion: "synthesize"): Promise<ResearchRunResult>;
	private execute(options: ResearchRunOptions, completion: "gather"): Promise<ResearchGatherResult>;
	private async execute(
		options: ResearchRunOptions,
		completion: "synthesize" | "gather",
	): Promise<ResearchRunResult | ResearchGatherResult> {
		const budget = resolveResearchBudget(options.plan, options.budget);
		const emptyState = newReportState();
		if (this.activeJob) {
			return failure(t("session.researchBusy"), {}, [], reportFor(
				emptyState, budget, "invalid-invocation", 0, 0, 0, 0,
			));
		}
		if (options.plan.execution !== "bounded-research") {
			return failure(t("session.notPlannedResearch"), {}, [], reportFor(
				emptyState, budget, "invalid-invocation", 0, 0, 0, 0,
			));
		}

		const job: ActiveResearchJob = {
			cancelled: false, deadlineExceeded: false, requestId: null, abortController: new AbortController(),
		};
		this.activeJob = job;
		// The research clock is armed by the first retrieval, not by the run.
		// Until then every call is an answering call and carries no deadline.
		let deadlineAt = Number.POSITIVE_INFINITY;
		const preferences = Object.freeze({ ...options.preferences });
		const metadata = connectionMetadata(preferences);
		const facts: TurnFacts = {};
		const requestIds: string[] = [];
		const trace: ResearchTrace = [];
		const question = resolveQuestion(options);
		const baseMessages = options.messages
			? options.messages.map((message) => ({ ...message }))
			: conversationMessages(options.session, question, options.currentMessageId);
		const researchSkill = completion === "gather" ? gatherSkill(options.skill) : options.skill;
		const seed = [
			...(options.initialEvidence ?? []),
			...(options.initialContext ? buildEvidence(options.initialContext) : []),
		];
		const retrieval = this.retriever.createSession({
			initialEvidence: seed,
			budget: retrievalBudget(budget),
			includeArchives: options.plan.includeArchives,
		});
		const state = newReportState();
		state.initialEvidenceItems = retrieval.ledger.size;
		state.initialEvidenceChars = retrieval.ledger.charsUsed;
		const initialDedup = 0;
		const seenQueries = new Set<string>();
		const observations: ResearchToolObservation[] = [];
		let unconsumedSearch = false;
		let researchPerformed = false;
		const allowCompleteCorpus = completion === "synthesize" &&
			options.plan.mode === "auto" && options.plan.execution === "bounded-research" &&
			options.plan.task !== "rewrite" && options.plan.task !== "continue" &&
			options.skill?.action !== "rewrite" && options.skill?.action !== "continue";

		const progress = (phase: ResearchPhase, finalText = ""): void => {
			if (job.cancelled || job.deadlineExceeded) return;
			options.onUpdate?.({
				phase,
				planningRound: state.planningRounds,
				maxPlanningRounds: budget.maxPlanningRounds,
				backendCalls: requestIds.length,
				queriesExecuted: state.queriesExecuted,
				filesRead: retrieval.filesRead,
				evidenceItems: retrieval.ledger.size,
				evidenceChars: retrieval.ledger.charsUsed,
				...(job.requestId ? { requestId: job.requestId } : {}),
				finalText,
				metadata: { ...metadata },
				facts: { ...facts },
			});
		};
		const recordTrace = (entry: ResearchTraceEntry): void => {
			trace.push(entry);
			emitTraceSnapshot(options.onTrace, trace);
		};

		try {
			// Give a caller that starts and immediately cancels this run one
			// deterministic checkpoint before the first request id is allocated.
			// The job already exists, so cancel() can mark it and abort local work;
			// no planner iterator or backend request needs to start in that case.
			await Promise.resolve();
			this.throwIfStopped(job, deadlineAt);
			try {
				for (let round = 1; round <= budget.maxPlanningRounds; round += 1) {
					this.throwIfStopped(job, deadlineAt);
					// Leave synthesis its seat. A writer who has paid for four planning
					// calls is owed an answer built from them, not a budget error.
					if (requestIds.length >= MAX_RESEARCH_ACTION_CALLS) {
						state.forcedSynthesis = true;
						if (unconsumedSearch) markUnconsumedSearch(trace, options.onTrace);
						break;
					}
					const remainingQueries = Math.max(0, budget.maxQueries - state.queriesExecuted);
					// A search needs a later model turn to inspect its R# results. Do not
					// advertise or accept one when this is the final action round.
					const availableSearches = round < budget.maxPlanningRounds ? remainingQueries : 0;
					const remainingObservationChars = Math.max(0, budget.maxObservationChars - state.observationChars);
					const remainingObservationPrompts = budget.maxPlanningRounds - round + 1;
					const observationPrompt = boundedObservationPrompt(
						observations, Math.floor(remainingObservationChars / remainingObservationPrompts),
					);
					if (observations.length > 0 && !observationPrompt.text) {
						state.observationLimitReached = true;
						state.forcedSynthesis = true;
						if (unconsumedSearch) markUnconsumedSearch(trace, options.onTrace);
						if (completion === "gather" && unconsumedSearch) {
							return failure(
								t("session.researchLastSearchUnused"), { ...metadata }, requestIds,
								reportFor(state, budget, "backend-error", retrieval.ledger.size, retrieval.ledger.charsUsed,
									retrieval.ledger.deduplicatedCount - initialDedup, 0),
							);
						}
						break;
					}
					state.observationChars += observationPrompt.chars;
					state.observationLimitReached ||= observationPrompt.compacted;
					state.planningRounds = round;
					progress("planning");
					// An answer-completion turn merges the decision into the call that was
					// happening anyway: prose is the final answer, a framed action is an
					// action. A gather turn has no answer to give, so it keeps the pure
					// planner. This is what turned a greeting from five calls into one —
					// the judgment was never the cost, the dedicated call for it was.
					const promptOptions = {
						round, maxRounds: budget.maxPlanningRounds, remainingQueries: availableSearches,
						evidenceItems: retrieval.ledger.size, evidenceChars: retrieval.ledger.charsUsed,
						allowCompleteCorpus,
					};
					const roundPrompt = completion === "gather"
						? researchPlannerPrompt(promptOptions)
						: researchDecisionPrompt({
							...promptOptions,
							allowedEvidenceIds: retrieval.ledger.evidence.map((item) => item.id.toUpperCase()),
							researchPerformed,
						});
					const plannerMessages: RequestMessage[] = [
						...baseMessages.map((message) => ({ ...message })),
						...(observationPrompt.text ? [{ role: "user" as const, content: observationPrompt.text }] : []),
						{ role: "user", content: roundPrompt },
					];
					// The merged decision call is, most of the time, the answer, and the
					// writer should see it arrive the way any other answer arrives. Its
					// text is shown as it streams until a framed action appears — then
					// the reply was a plan, which stays private, and the shown text is
					// withdrawn. The tail is held back while it could still be the start
					// of the sentinel, so no fragment of the frame is ever shown.
					let shownAnswer = false;
					const onDecisionDelta = completion === "gather" ? undefined : (text: string): void => {
						const visible = answerPrefixBeforeAction(text);
						if (visible === null) {
							if (shownAnswer) { shownAnswer = false; progress("planning"); }
							return;
						}
						if (!visible) return;
						shownAnswer = true;
						progress("synthesizing", keepAllowedResearchCitations(visible, new Set(retrieval.ledger.evidence.map((item) => item.id.toUpperCase()))));
					};
					let planOutcome = await this.call(
						job, deadlineAt, requestIds, options.session.id, preferences, plannerMessages,
						retrieval.ledger.evidence, researchSkill, metadata, facts, onDecisionDelta,
					);
					if (shownAnswer && !(planOutcome.ok && completion !== "gather" && !containsResearchAction(planOutcome.text))) progress("planning");
					unconsumedSearch = false;
					state.backendCalls = requestIds.length;
					if (planOutcome.ok && completion !== "gather" && !containsResearchAction(planOutcome.text)) {
						// No framed action anywhere in the reply: under the decision
						// prompt this is the model answering, not failing to plan.
						recordTrace(callTrace(trace, "final", planOutcome));
						return this.deliverAnswer(planOutcome.text, state, budget, retrieval, metadata, facts, requestIds, initialDedup, progress);
					}
					if (!planOutcome.ok) {
						recordTrace(callTrace(trace, "synthesize", planOutcome));
						if (researchClockRanOut(job, planOutcome)) throw new ResearchDeadlineError();
						return this.callFailure(job, planOutcome, state, budget, retrieval, metadata, requestIds, initialDedup);
					}

					const parseOptions = {
						remainingQueries: availableSearches,
						maxQueryChars: budget.maxQueryChars, seenQueries, allowCompleteCorpus,
					};
					let decision = parseResearchAction(planOutcome.text, parseOptions);

					// One corrective retry. A round lost to a sentence of preamble or a
					// query that read like a path is not a decision the model made, and
					// forcing synthesis on it silently produces an unresearched answer.
					// Budget-exhausted reasons are excluded: there synthesizing is right.
					// The retry is a real call. Spending the reserved synthesis seat on it
					// trades a partial answer for none at all, so it only happens while
					// the loop still has one of its own.
					if (
						decision.forcedSynthesis &&
						isRecoverablePlanFallback(decision.reason) &&
						requestIds.length < MAX_RESEARCH_ACTION_CALLS
					) {
						const retryOutcome = await this.call(
							job, deadlineAt, requestIds, options.session.id, preferences,
							[...plannerMessages, { role: "user" as const, content: researchPlanRetryPrompt(decision.reason) }],
							retrieval.ledger.evidence, researchSkill, metadata, facts,
						);
						state.backendCalls = requestIds.length;
						if (!retryOutcome.ok) {
							recordTrace(callTrace(trace, "synthesize", retryOutcome));
							if (researchClockRanOut(job, retryOutcome)) throw new ResearchDeadlineError();
							return this.callFailure(job, retryOutcome, state, budget, retrieval, metadata, requestIds, initialDedup);
						}
						// Under the decision prompt the correction can be answered with
						// prose instead of a repaired action — and prose is an answer.
						if (completion !== "gather" && !containsResearchAction(retryOutcome.text)) {
							recordTrace(callTrace(trace, "final", retryOutcome));
							return this.deliverAnswer(retryOutcome.text, state, budget, retrieval, metadata, facts, requestIds, initialDedup, progress);
						}
						const retried = parseResearchAction(retryOutcome.text, parseOptions);
						// Keep the retry only when it actually recovered. A second failure
						// reports the *first* reason, which is the one that describes the
						// model's natural output rather than its response to a correction.
						if (!retried.forcedSynthesis) {
							planOutcome = retryOutcome;
							decision = retried;
						}
					}

					if (decision.action === "synthesize") {
						if (decision.forcedSynthesis) {
							state.forcedSynthesis = true;
							state.planFallbackReason = decision.reason;
						}
						recordTrace(callTrace(trace, "synthesize", planOutcome, {
							...(decision.reason ? { fallback: decision.reason } : {}),
						}));
						break;
					}
					if (decision.action === "completeCorpus") {
						recordTrace(callTrace(trace, "completeCorpus", planOutcome));
						const evidence = retrieval.ledger.evidence;
						return {
							ok: true, outcome: "complete-corpus", metadata: { ...metadata }, facts: { ...facts },
							report: reportFor(
								state, budget, "completed", evidence.length, retrieval.ledger.charsUsed,
								retrieval.ledger.deduplicatedCount - initialDedup, 0,
							),
							requestIds: [...requestIds],
						};
					}
					if (!Number.isFinite(deadlineAt)) deadlineAt = this.now() + budget.deadlineMs;
					progress("retrieving");
					const retrievalOptions = { signal: job.abortController.signal, deadlineAt };
					// One action can now admit several sources, so every branch produces a
					// list. The per-handle budgets inside the retriever are unchanged: a
					// batch stops early on its own when files, chars or evidence run out.
					let found: Array<{ observation: ResearchToolObservation; report: ResearchRetrievalReport; handle?: string }>;
					switch (decision.action) {
							case "search":
								state.queriesRequested += 1;
								state.queriesExecuted += 1;
								seenQueries.add(normalizeResearchQueryKey(decision.query));
								found = [await this.retriever.search(decision.query, retrieval, retrievalOptions)];
								break;
							case "read": {
								const reads: typeof found = [];
								for (const handle of decision.handles) {
									this.throwIfStopped(job, deadlineAt);
									reads.push({ ...await this.retriever.read(handle, retrieval, retrievalOptions), handle });
								}
								found = reads;
								break;
							}
							case "readAround":
								found = [{
									...await this.retriever.readAround(
										decision.handle, retrieval, { before: decision.before, after: decision.after }, retrievalOptions,
									),
									handle: decision.handle,
								}];
								break;
					}
					rememberObservations(observations, found.map((one) => one.observation));
					for (const one of found) {
						researchPerformed ||= one.observation.ok;
						recordTrace(retrievalTrace(trace, decision, one.observation, planOutcome, one.handle));
						mergeRetrievalReport(state, one.report);
					}
					unconsumedSearch = decision.action === "search";
					state.retrievalRounds += 1;
				}

			} catch (error) {
				// The research clock limits research, not the answer (D-038): when it
				// runs out, what was admitted so far is synthesised (or handed to the
				// rewrite), as long as a call is left to do it. Before this, a slow
				// local model that crossed the clock mid-plan lost every piece of
				// evidence it had gathered and the writer got no answer at all.
				const clock = !job.cancelled && (job.deadlineExceeded || error instanceof ResearchRetrievalDeadlineError || error instanceof ResearchDeadlineError);
				if (!clock || (completion !== "gather" && requestIds.length >= MAX_RESEARCH_BACKEND_CALLS)) throw error;
				job.deadlineExceeded = false;
				job.requestId = null;
				job.abortController = new AbortController();
				deadlineAt = Number.POSITIVE_INFINITY;
				state.forcedSynthesis = true;
				state.deadlineReached = true;
				if (unconsumedSearch) markUnconsumedSearch(trace, options.onTrace);
			}
			this.throwIfStopped(job, deadlineAt);
			if (completion === "gather") {
				const evidence = retrieval.ledger.evidence;
				return {
					ok: true,
					metadata: { ...metadata },
					facts: { ...facts },
					evidence,
					report: reportFor(
						state, budget, "completed", evidence.length, retrieval.ledger.charsUsed,
						retrieval.ledger.deduplicatedCount - initialDedup, 0,
					),
					requestIds: [...requestIds],
				};
			}
			// Unreachable while the loop respects its own ceiling; kept because the
			// alternative to noticing here is answering without a model.
			if (requestIds.length >= MAX_RESEARCH_BACKEND_CALLS) {
				return failure(t("session.researchCallLimitNoAnswer"), { ...metadata }, requestIds,
					reportFor(state, budget, "backend-error", retrieval.ledger.size, retrieval.ledger.charsUsed,
						retrieval.ledger.deduplicatedCount - initialDedup, 0));
			}
			progress("synthesizing");
			const allowedIds = retrieval.ledger.evidence.map((item) => item.id.toUpperCase());
			const finalMessages: RequestMessage[] = [
				...baseMessages.map((message) => ({ ...message })),
				{ role: "user", content: researchSynthesisPrompt(allowedIds, {
					researchPerformed,
					forcedSynthesis: state.forcedSynthesis,
				}) },
			];
			// The final answer is not research: the action loop's clock does not
			// reach it, and it gets no clock of its own. A valid search/read
			// sequence must not leave the answer a few milliseconds, and a slow
			// model reading its evidence is not a runaway.
			const finalDeadlineAt = Number.POSITIVE_INFINITY;
			const finalOutcome = await this.call(
				job, finalDeadlineAt, requestIds, options.session.id, preferences, finalMessages,
				retrieval.ledger.evidence, options.skill, metadata, facts,
				(text) => progress("synthesizing", keepAllowedResearchCitations(text, new Set(allowedIds))),
			);
			state.backendCalls = requestIds.length;
			if (!finalOutcome.ok) {
				recordTrace(callTrace(trace, "final", finalOutcome));
				return this.callFailure(job, finalOutcome, state, budget, retrieval, metadata, requestIds, initialDedup);
			}
			recordTrace(callTrace(trace, "final", finalOutcome));

			const answer = keepAllowedResearchCitations(finalOutcome.text, new Set(allowedIds));
			if (!answer.trim()) {
				return failure(
					t("session.noFinalAnswer"), { ...metadata }, requestIds,
					reportFor(state, budget, "backend-error", retrieval.ledger.size, retrieval.ledger.charsUsed,
						retrieval.ledger.deduplicatedCount - initialDedup, 0),
				);
			}
			const used = researchCitationIds(answer);
			const evidence = retrieval.ledger.evidence;
			const citedEvidence = evidence.filter((item) => used.has(item.id.toUpperCase()));
			const report = reportFor(
				state, budget, "completed", evidence.length, retrieval.ledger.charsUsed,
				retrieval.ledger.deduplicatedCount - initialDedup, citedEvidence.length,
			);
			progress("synthesizing", answer);
			return {
				ok: true, outcome: "answer", answer, metadata: { ...metadata }, facts: { ...facts }, evidence, citedEvidence,
				report, requestIds: [...requestIds],
			};
		} catch (error) {
			if (job.cancelled || error instanceof ResearchRetrievalCancelledError) {
				return this.stoppedResult("cancelled", state, budget, retrieval, metadata, requestIds, initialDedup);
			}
			if (job.deadlineExceeded || error instanceof ResearchRetrievalDeadlineError || error instanceof ResearchDeadlineError) {
				this.stopForDeadline(job);
				return this.stoppedResult("deadline", state, budget, retrieval, metadata, requestIds, initialDedup);
			}
			const message = error instanceof Error ? error.message : String(error);
			return failure(
				t("session.researchFailed", { reason: message }), { ...metadata }, requestIds,
				reportFor(state, budget, "backend-error", retrieval.ledger.size, retrieval.ledger.charsUsed,
					retrieval.ledger.deduplicatedCount - initialDedup, 0),
			);
		} finally {
			if (this.activeJob === job) this.activeJob = null;
		}
	}

	/**
	 * Turn a model reply into the run's answer: citation-gate it, refuse an
	 * empty one, count what it cited. Shared by the merged decision call and
	 * the reserved synthesis call, so the two paths cannot drift.
	 */
	private deliverAnswer(
		text: string,
		state: ReportState,
		budget: ResearchBudget,
		retrieval: { ledger: { evidence: EvidenceItem[]; size: number; charsUsed: number; deduplicatedCount: number } },
		metadata: GenerationMetadata,
		facts: TurnFacts,
		requestIds: string[],
		initialDedup: number,
		progress: (phase: ResearchPhase, finalText?: string) => void,
	): ResearchRunResult {
		const allowedIds = retrieval.ledger.evidence.map((item) => item.id.toUpperCase());
		const answer = keepAllowedResearchCitations(text, new Set(allowedIds));
		if (!answer.trim()) {
			return {
				ok: false, error: t("session.noFinalAnswer"), metadata: { ...metadata },
				report: reportFor(state, budget, "backend-error", retrieval.ledger.size, retrieval.ledger.charsUsed,
					retrieval.ledger.deduplicatedCount - initialDedup, 0),
				requestIds: [...requestIds],
			};
		}
		const used = researchCitationIds(answer);
		const evidence = retrieval.ledger.evidence;
		const citedEvidence = evidence.filter((item) => used.has(item.id.toUpperCase()));
		progress("synthesizing", answer);
		return {
			ok: true, outcome: "answer", answer, metadata: { ...metadata }, facts: { ...facts }, evidence, citedEvidence,
			report: reportFor(state, budget, "completed", evidence.length, retrieval.ledger.charsUsed,
				retrieval.ledger.deduplicatedCount - initialDedup, citedEvidence.length),
			requestIds: [...requestIds],
		};
	}

	private async call(
		job: ActiveResearchJob, deadlineAt: number, requestIds: string[], conversationId: string,
		preferences: Readonly<SessionPreferences>, messages: RequestMessage[], evidence: EvidenceItem[],
		skill: SkillPayload | undefined, aggregateMetadata: GenerationMetadata, aggregateFacts: TurnFacts,
		onFinalDelta?: (text: string) => void,
	): Promise<CallOutcome> {
		this.throwIfStopped(job, deadlineAt);
		if (requestIds.length >= MAX_RESEARCH_BACKEND_CALLS) {
			return { ok: false, text: "", metadata: {}, facts: {}, error: t("session.researchCallLimit"), cancelled: false, deadlineExceeded: false };
		}
		const requestId = this.nextRequestId();
		// A custom id source can synchronously trigger cancellation. Re-check
		// before publishing the id or constructing a backend iterable so that
		// this narrow launch race cannot execute a planner after cancellation.
		this.throwIfStopped(job, deadlineAt);
		if (requestIds.includes(requestId)) {
			return { ok: false, text: "", metadata: {}, facts: {}, error: t("session.noRequestId"), cancelled: false, deadlineExceeded: false };
		}
		requestIds.push(requestId);
		job.requestId = requestId;
		const payload: TurnPayload = {
			requestId,
			connectionId: preferences.connectionId,
			conversationId,
			provider: preferences.provider,
			model: preferences.model ?? null,
			effort: preferences.effort ?? null,
			messages: messages.map((message) => ({ ...message })),
			...(skill ? { skill: { ...skill } } : {}),
			...(evidence.length > 0 ? { documents: evidenceDocumentPayloads(evidence) } : {}),
		};
		const timer = this.armDeadline(job, deadlineAt, requestId);
		let outcome: CallOutcome;
		try {
			outcome = await consume(this.backend.chat(payload), job, onFinalDelta);
		} finally {
			window.clearTimeout(timer);
			if (job.requestId === requestId) job.requestId = null;
		}
		if (!outcome.ok) restoreSelectedExecutionIdentity(outcome.metadata, preferences);
		mergeMetadata(aggregateMetadata, outcome.metadata);
		mergeFacts(aggregateFacts, outcome.facts);
		return outcome;
	}

	private armDeadline(job: ActiveResearchJob, deadlineAt: number, requestId: string): number | undefined {
		if (!Number.isFinite(deadlineAt)) return undefined;
		const remaining = Math.max(0, deadlineAt - this.now());
		return window.setTimeout(() => {
			if (this.activeJob !== job || job.requestId !== requestId || job.cancelled) return;
			job.deadlineExceeded = true;
			job.abortController.abort();
			void this.backend.cancel(requestId).catch(() => undefined);
		}, remaining);
	}

	private stopForDeadline(job: ActiveResearchJob): void {
		if (job.deadlineExceeded) return;
		job.deadlineExceeded = true;
		job.abortController.abort();
		if (job.requestId) void this.backend.cancel(job.requestId).catch(() => undefined);
	}

	private throwIfStopped(job: ActiveResearchJob, deadlineAt: number): void {
		if (job.cancelled) throw new ResearchRetrievalCancelledError();
		if (job.deadlineExceeded || this.now() >= deadlineAt) {
			this.stopForDeadline(job);
			throw new ResearchDeadlineError();
		}
	}

	private callFailure(
		job: ActiveResearchJob, outcome: CallOutcome, state: ReportState, budget: ResearchBudget,
		retrieval: ResearchRetrievalSession, metadata: GenerationMetadata, requestIds: string[], initialDedup: number,
	): ResearchRunFailure {
		state.backendCalls = requestIds.length;
		if (job.cancelled || outcome.cancelled) {
			return this.stoppedResult("cancelled", state, budget, retrieval, metadata, requestIds, initialDedup);
		}
		if (job.deadlineExceeded || outcome.deadlineExceeded) {
			return this.stoppedResult("deadline", state, budget, retrieval, metadata, requestIds, initialDedup);
		}
		if (outcome.errorCode) metadata.errorCode = outcome.errorCode;
		return failure(
			outcome.error ?? t("session.incompleteResult"), { ...metadata }, requestIds,
			reportFor(state, budget, "backend-error", retrieval.ledger.size, retrieval.ledger.charsUsed,
				retrieval.ledger.deduplicatedCount - initialDedup, 0),
		);
	}

	private stoppedResult(
		status: "cancelled" | "deadline", state: ReportState, budget: ResearchBudget,
		retrieval: ResearchRetrievalSession, metadata: GenerationMetadata, requestIds: string[], initialDedup: number,
	): ResearchRunFailure {
		state.backendCalls = requestIds.length;
		metadata.errorCode = status;
		return failure(
			status === "cancelled" ? t("session.researchCancelled") : t("session.researchDeadline"),
			{ ...metadata }, requestIds,
			reportFor(state, budget, status, retrieval.ledger.size, retrieval.ledger.charsUsed,
				retrieval.ledger.deduplicatedCount - initialDedup, 0),
			status === "cancelled", status === "deadline",
		);
	}
}

class ResearchDeadlineError extends Error {}

async function consume(
	stream: AsyncIterable<AIEvent>,
	job: ActiveResearchJob,
	onDelta?: (text: string) => void,
): Promise<CallOutcome> {
	let streamed = "";
	let resultText: string | undefined;
	let error: string | undefined;
	let errorCode: string | undefined;
	const metadata: GenerationMetadata = {};
	const facts: TurnFacts = {};
	const iterator = stream[Symbol.asyncIterator]();
	try {
		for (;;) {
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
					mergeResultMetadata(metadata, facts, event.metadata);
					break;
				case "error":
					errorCode = event.code;
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
			ok: false, text: "", metadata, facts, cancelled: job.cancelled, deadlineExceeded: job.deadlineExceeded,
		};
	}
	if (error) {
		return { ok: false, text: "", metadata, facts, error, ...(errorCode ? { errorCode } : {}), cancelled: false, deadlineExceeded: false };
	}
	const text = nonBlank(resultText) ?? nonBlank(streamed);
	if (text === undefined) {
		return { ok: false, text: "", metadata, facts, error: t("session.incompleteResult"), cancelled: false, deadlineExceeded: false };
	}
	onDelta?.(text);
	return { ok: true, text, metadata, facts, cancelled: false, deadlineExceeded: false };
}

function nextOrAbort<T>(next: Promise<IteratorResult<T>>, signal: AbortSignal): Promise<IteratorResult<T> | null> {
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const onAbort = (): void => resolve(null);
		signal.addEventListener("abort", onAbort, { once: true });
		next.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", onAbort); reject(asError(error)); },
		);
	});
}

/**
 * How many sources one run may open.
 *
 * This used to be the context plan's `maxFilesRead`, which is that plan's
 * answer to "how many documents may this turn's prompt carry" — twelve on Auto.
 * Research spends the same counter on two unlike things: probing during a
 * search, which reads a file and keeps six hundred characters of preview, and
 * admitting one through a read. Two searches exhaust it on previews, and the
 * only reason a read still happens at all is the single verification slot the
 * ledger holds back. Measured against a real manuscript that is exactly what
 * occurred: `files` reached its limit while `chars` and `evidence` sat unused,
 * and answers came back citing one source.
 *
 * A file cap is a proxy for prompt size, and prompt size already has two caps
 * of its own here — `maxEvidenceChars` and `maxEvidenceItems` — which bind
 * first when they should. Opening a file the run then declines to admit costs a
 * local disk read and nothing on the wire, so this allowance is about how
 * widely a run may look, not how much it may say.
 */
function researchFileAllowance(plan: ContextPlan): number {
	return Math.max(plan.budget.maxFilesRead, DEFAULT_RESEARCH_FILE_ALLOWANCE);
}

export function resolveResearchBudget(
	plan: ContextPlan,
	input: Partial<ResearchBudget> = {},
): ResearchBudget {
	const maxPlanningRounds = boundedInteger(
		input.maxPlanningRounds, MAX_RESEARCH_PLANNING_ROUNDS, 0, MAX_RESEARCH_PLANNING_ROUNDS,
	);
	return {
		maxPlanningRounds,
		maxQueries: boundedInteger(input.maxQueries, MAX_RESEARCH_TOTAL_QUERIES, 0, maxPlanningRounds),
		maxQueryChars: boundedInteger(input.maxQueryChars, MAX_RESEARCH_QUERY_CHARS, 1, MAX_RESEARCH_QUERY_CHARS),
		maxObservationChars: boundedInteger(
			input.maxObservationChars, MAX_RESEARCH_OBSERVATION_CHARS, 0, MAX_RESEARCH_OBSERVATION_CHARS,
		),
		maxFilesRead: boundedInteger(input.maxFilesRead, researchFileAllowance(plan), 0, MAX_RESEARCH_FILE_LIMIT),
		maxFilesProbed: boundedInteger(input.maxFilesProbed, DEFAULT_RESEARCH_PROBE_LIMIT, 0, MAX_RESEARCH_PROBE_LIMIT),
		maxEvidenceItems: boundedInteger(input.maxEvidenceItems, 16, 0, MAX_RESEARCH_EVIDENCE_LIMIT),
		maxEvidenceChars: boundedInteger(input.maxEvidenceChars, plan.budget.totalChars, 0, MAX_RESEARCH_CHAR_LIMIT),
		perEvidenceChars: boundedInteger(
			input.perEvidenceChars, plan.budget.perDocumentChars, 1,
			Math.min(MAX_RESEARCH_PER_EVIDENCE_CHARS, Math.max(1, plan.budget.totalChars)),
		),
		deadlineMs: boundedInteger(input.deadlineMs, DEFAULT_RESEARCH_DEADLINE_MS, 0, MAX_RESEARCH_DEADLINE_MS),
	};
}

function retrievalBudget(budget: ResearchBudget): ResearchRetrievalBudget {
	return {
		maxFilesRead: budget.maxFilesRead,
		maxFilesProbed: budget.maxFilesProbed,
		maxEvidenceItems: budget.maxEvidenceItems,
		maxEvidenceChars: budget.maxEvidenceChars,
		perEvidenceChars: Math.min(budget.perEvidenceChars, Math.max(1, budget.maxEvidenceChars)),
	};
}

function newReportState(): ReportState {
	return {
		backendCalls: 0, observationChars: 0, planningRounds: 0, retrievalRounds: 0, queriesRequested: 0, queriesExecuted: 0,
		initialEvidenceItems: 0, initialEvidenceChars: 0, addedEvidenceItems: 0,
		filesConsidered: 0, filesRead: 0, readFailures: 0, excludedByMetadata: 0,
		forcedSynthesis: false, fileLimitReached: false, evidenceLimitReached: false, charLimitReached: false,
		observationLimitReached: false,
	};
}

function mergeRetrievalReport(state: ReportState, report: ResearchRetrievalReport): void {
	state.addedEvidenceItems += report.evidenceAdded;
	// Every search reports the same eligible run inventory. It is a corpus
	// size, not work that should be added once per query.
	state.filesConsidered = Math.max(state.filesConsidered, report.filesConsidered);
	state.filesRead += report.filesRead;
	state.readFailures += report.readFailures;
	state.excludedByMetadata += report.excludedByMetadata;
	state.fileLimitReached ||= report.fileLimitReached;
	state.evidenceLimitReached ||= report.evidenceLimitReached;
	state.charLimitReached ||= report.charLimitReached;
}

function reportFor(
	state: ReportState, budget: ResearchBudget, status: ResearchTermination, finalEvidenceItems: number,
	finalEvidenceChars: number, deduplicatedEvidenceItems: number, citedEvidenceItems: number,
): ResearchContextReport {
	return {
		status, planningRounds: state.planningRounds, retrievalRounds: state.retrievalRounds,
		backendCalls: Math.min(MAX_RESEARCH_BACKEND_CALLS, state.backendCalls),
		observationChars: state.observationChars,
		queriesRequested: state.queriesRequested, queriesExecuted: state.queriesExecuted,
		initialEvidenceItems: state.initialEvidenceItems, finalEvidenceItems,
		addedEvidenceItems: state.addedEvidenceItems, deduplicatedEvidenceItems,
		initialEvidenceChars: state.initialEvidenceChars, finalEvidenceChars,
		filesConsidered: state.filesConsidered, filesRead: state.filesRead, readFailures: state.readFailures,
		excludedByMetadata: state.excludedByMetadata, citedEvidenceItems, forcedSynthesis: state.forcedSynthesis,
		...(state.planFallbackReason ? { planFallbackReason: state.planFallbackReason } : {}),
		limits: {
			maxPlanningRounds: budget.maxPlanningRounds, maxBackendCalls: MAX_RESEARCH_BACKEND_CALLS,
			maxObservationChars: budget.maxObservationChars,
			maxQueries: budget.maxQueries,
			maxQueryChars: budget.maxQueryChars, maxFilesRead: budget.maxFilesRead,
			maxEvidenceItems: budget.maxEvidenceItems, maxEvidenceChars: budget.maxEvidenceChars,
			perEvidenceChars: budget.perEvidenceChars, deadlineMs: budget.deadlineMs,
		},
		limitsReached: {
			planning: state.planningRounds >= budget.maxPlanningRounds, observations: state.observationLimitReached,
			queries: state.queriesExecuted >= budget.maxQueries, files: state.fileLimitReached,
			evidence: state.evidenceLimitReached, chars: state.charLimitReached, deadline: status === "deadline" || state.deadlineReached === true,
		},
	};
}

function failure(
	error: string, metadata: GenerationMetadata, requestIds: readonly string[], report: ResearchContextReport,
	cancelled = false, deadlineExceeded = false,
): ResearchRunFailure {
	return {
		ok: false, error, metadata, report, requestIds: [...requestIds],
		...(cancelled ? { cancelled: true } : {}),
		...(deadlineExceeded ? { deadlineExceeded: true } : {}),
	};
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

function mergeResultMetadata(
	metadata: GenerationMetadata,
	facts: TurnFacts,
	result: Extract<AIEvent, { type: "result" }>["metadata"],
): void {
	if (!result) return;
	replaceExecutionIdentity(metadata, result);
	if (result.usage) {
		metadata.usage = persistableUsage(result.usage);
		if (result.usage.cachedInputTokens !== undefined) facts.cachedInputTokens = result.usage.cachedInputTokens;
		if (result.usage.reasoningTokens !== undefined) facts.reasoningTokens = result.usage.reasoningTokens;
	}
	if (result.durationMs !== undefined) facts.runtimeMs = result.durationMs;
	if (result.attempts !== undefined) facts.attempts = result.attempts;
	if (result.fellBack && !metadata.fallback) metadata.fallback = result.provider ?? t("session.fellBack");
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

function callTrace(
	trace: readonly ResearchTraceEntry[],
	action: ResearchTraceEntry["action"],
	outcome: CallOutcome,
	overrides: Partial<Omit<ResearchTraceEntry, "sequence" | "action">> = {},
): ResearchTraceEntry {
	return {
		sequence: trace.length + 1, action, ok: outcome.ok,
		...traceCallMetrics(outcome),
		...(!outcome.ok ? { error: safeTraceCode(outcome.errorCode) } : {}),
		...(outcome.metadata.fallback ? { fallback: "backend" as const } : {}),
		...overrides,
	};
}

function retrievalTrace(
	trace: readonly ResearchTraceEntry[],
	decision: Exclude<ReturnType<typeof parseResearchAction>, { action: "synthesize" } | { action: "completeCorpus" }>,
	observation: ResearchToolObservation,
	outcome: CallOutcome,
	handle?: string,
): ResearchTraceEntry {
	const handles = observationHandles(observation);
	const ok = observation.ok;
	return callTrace(trace, decision.action, outcome, {
		args: decision.action === "search"
			? { queryChars: countChars(decision.query) }
			: decision.action === "read"
				? { ...(handle ? { handle } : {}) }
				: { handle: decision.handle, ...(decision.before !== undefined ? { before: decision.before } : {}),
					...(decision.after !== undefined ? { after: decision.after } : {}) },
		...(handles.length > 0 ? { handles } : {}),
		ok,
		...(!ok ? { error: observation.reason } : {}),
	});
}

function observationHandles(observation: ResearchToolObservation): string[] {
	if (observation.action === "search") return observation.results.map((item) => item.handle);
	if (!observation.ok) return [observation.handle];
	if (observation.action === "read") return uniqueHandles([observation.resultHandle, observation.evidence.handle]);
	return uniqueHandles([observation.sourceHandle, observation.evidence.handle]);
}

function uniqueHandles(handles: readonly string[]): string[] {
	return [...new Set(handles)];
}

function safeTraceCode(value: string | undefined): string {
	return value && SAFE_TRACE_ERROR_CODES.has(value) ? value : "backend";
}

/** Closed content-free categories; arbitrary backend codes may contain writer text. */
const SAFE_TRACE_ERROR_CODES = new Set([
	"cancelled",
	"connection_unavailable",
	"controller_busy",
	"deadline",
	"direct_api_empty_response",
	"effort_required",
	"effort_unavailable",
	"invalid_request",
	"local_busy",
	"local_configuration_error",
	"local_empty_response",
	"local_timeout",
	"local_unavailable",
	"model_required",
	"model_unavailable",
	"output_budget_exhausted",
	"provider_required",
	"provider_unavailable",
	"rate_limited",
	"remote_empty_response",
	"token_expired",
	"transport",
	"unauthorized",
	"v2_unavailable",
]);

function markUnconsumedSearch(
	trace: ResearchTrace,
	onTrace: ResearchRunOptions["onTrace"],
): void {
	const latest = trace.at(-1);
	if (!latest || latest.action !== "search") return;
	latest.ok = false;
	latest.error = "requires-follow-up";
	latest.fallback = "unconsumable-final-search";
	emitTraceSnapshot(onTrace, trace);
}

function traceCallMetrics(outcome: CallOutcome): Pick<ResearchTraceEntry, "usage" | "durationMs"> {
	return {
		...(outcome.metadata.usage ? { usage: { ...outcome.metadata.usage } } : {}),
		...(outcome.facts.runtimeMs !== undefined ? { durationMs: outcome.facts.runtimeMs } : {}),
	};
}

function cloneTrace(trace: readonly ResearchTraceEntry[]): ResearchTrace {
	return trace.map((entry) => ({
		...entry,
		...(entry.args ? { args: { ...entry.args } } : {}),
		...(entry.handles ? { handles: [...entry.handles] } : {}),
		...(entry.usage ? { usage: { ...entry.usage } } : {}),
	}));
}

function emitTraceSnapshot(
	onTrace: ResearchRunOptions["onTrace"],
	trace: readonly ResearchTraceEntry[],
): void {
	if (!onTrace) return;
	try {
		onTrace(cloneTrace(trace));
	} catch {
		// Diagnostics must never affect the foreground turn.
	}
}

interface BoundedObservationPrompt {
	text: string;
	chars: number;
	compacted: boolean;
}

/** Only the latest tool result is new information for the next stateless action call. */
/**
 * Keep this round's observations and drop the ones before it.
 *
 * Only the latest round is replayed — an earlier round's search previews would
 * be re-sent on every call for the rest of the run, which is what the whole-run
 * observation budget exists to prevent.
 *
 * Plural because one read action can now name several handles. Recording them
 * one at a time replaced each with the next, so a batch of three reported only
 * its last: the evidence still reached the model as documents, but nothing
 * confirmed the other two had been admitted at all.
 */
function rememberObservations(target: ResearchToolObservation[], round: readonly ResearchToolObservation[]): void {
	target.splice(0, target.length, ...round);
}

/**
 * Keep the client-only observation channel inside one whole-run character
 * budget. Search snippets are compacted as valid JSON; partial JSON is never
 * sent merely to fill the remaining allowance.
 */
function boundedObservationPrompt(
	observations: readonly ResearchToolObservation[],
	remainingChars: number,
): BoundedObservationPrompt {
	if (observations.length === 0 || remainingChars <= 0) {
		return { text: "", chars: 0, compacted: observations.length > 0 };
	}
	const full = researchToolObservationPrompt(observations);
	const fullChars = countChars(full);
	if (fullChars <= remainingChars) return { text: full, chars: fullChars, compacted: false };

	// Too large for what is left. A read observation is a handle and a label, so
	// it is small and worth keeping whole; the room goes to those first and a
	// search's previews are compacted into whatever remains.
	const reads = observations.filter((observation) => observation.action !== "search");
	const readsText = reads.length > 0 ? researchToolObservationPrompt(reads) : "";
	if (reads.length === observations.length) {
		return countChars(readsText) <= remainingChars
			? { text: readsText, chars: countChars(readsText), compacted: false }
			: { text: "", chars: 0, compacted: true };
	}
	const search = observations.find((observation) => observation.action === "search");
	const compacted = search ? compactObservation(search, Math.max(0, remainingChars - countChars(readsText))) : null;
	const kept = compacted ? [...reads, compacted] : reads;
	if (kept.length === 0) return { text: "", chars: 0, compacted: true };
	const text = researchToolObservationPrompt(kept);
	return countChars(text) <= remainingChars
		? { text, chars: countChars(text), compacted: true }
		: { text: "", chars: 0, compacted: true };
}

function compactObservation(
	observation: ResearchToolObservation,
	maxChars: number,
): ResearchToolObservation | null {
	if (observation.action === "search") {
		const result: ResearchToolObservation = { ...observation, results: [] };
		if (!observationFits(result, maxChars)) return null;
		for (const item of observation.results) {
			const exact = { ...item };
			const withExact = { ...result, results: [...result.results, exact] };
			if (observationFits(withExact, maxChars)) {
				result.results.push(exact);
				continue;
			}

			let shortened = {
				...item,
				label: truncateText(item.label, 120),
				heading: item.heading === null ? null : truncateText(item.heading, 120),
				snippet: "",
				truncated: true,
			};
			let withShortened = { ...result, results: [...result.results, shortened] };
			if (!observationFits(withShortened, maxChars)) {
				shortened = { ...shortened, label: "", heading: null };
				withShortened = { ...result, results: [...result.results, shortened] };
			}
			if (!observationFits(withShortened, maxChars)) break;

			shortened.snippet = longestFittingPrefix(item.snippet, (snippet) =>
				observationFits({ ...result, results: [...result.results, { ...shortened, snippet }] }, maxChars));
			result.results.push(shortened);
		}
		return result;
	}

	if (observation.ok) {
		let compacted = {
			...observation,
			evidence: { ...observation.evidence, label: "", truncated: true },
		};
		if (!observationFits(compacted, maxChars)) return null;
		const label = longestFittingPrefix(observation.evidence.label, (candidate) =>
			observationFits({ ...compacted, evidence: { ...compacted.evidence, label: candidate } }, maxChars));
		compacted = { ...compacted, evidence: { ...compacted.evidence, label } };
		return compacted;
	}

	return observationFits(observation, maxChars) ? observation : null;
}

function observationPrompt(observation: ResearchToolObservation): string {
	return researchToolObservationPrompt([observation]);
}

function observationFits(observation: ResearchToolObservation, maxChars: number): boolean {
	return countChars(observationPrompt(observation)) <= maxChars;
}

function longestFittingPrefix(value: string, fits: (candidate: string) => boolean): string {
	const chars = Array.from(value);
	let lower = 0;
	let upper = chars.length;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (fits(chars.slice(0, middle).join(""))) lower = middle;
		else upper = middle - 1;
	}
	return chars.slice(0, lower).join("");
}

function truncateText(value: string, maxChars: number): string {
	return Array.from(value).slice(0, maxChars).join("");
}

function nonBlank(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function resolveQuestion(options: ResearchRunOptions): string {
	if (options.question?.trim()) return options.question;
	for (let index = (options.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
		const message = options.messages?.[index];
		if (message?.role === "user" && message.content.trim()) return message.content;
	}
	for (let index = options.session.messages.length - 1; index >= 0; index -= 1) {
		const message = options.session.messages[index];
		if (message.role === "user" && message.text.trim()) return message.text;
	}
	return "";
}

/** A writing Skill's final-output contract belongs to the later rewrite call. */
function gatherSkill(skill: SkillPayload | undefined): SkillPayload | undefined {
	if (!skill || (skill.action !== "rewrite" && skill.action !== "continue")) return skill;
	const instructions = [sharedRewriteOutputInstruction(), sharedContinueOutputInstruction()]
		.reduce((text, finalOutput) => text.replace(finalOutput, ""), skill.instructions)
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
	return {
		...skill,
		action: "chat",
		instructions: [
			instructions,
			"Research phase only: do not write the candidate yet. Follow the research-action protocol in the latest user message. The rewrite or continuation output contract applies only to the later writing call.",
		].filter(Boolean).join("\n\n"),
	};
}

function boundedInteger(value: number | undefined, fallbackValue: number, minimum: number, maximum: number): number {
	if (!Number.isFinite(value)) return Math.max(minimum, Math.min(maximum, Math.floor(fallbackValue)));
	return Math.max(minimum, Math.min(maximum, Math.floor(value as number)));
}

/**
 * The part of a streaming decision reply that may be shown as an answer.
 *
 * `null` once the research sentinel has appeared: the reply is a plan and
 * nothing of it is shown. Otherwise the text, minus a tail that is still a
 * prefix of the sentinel — `<WB_RES` may become the frame on the next chunk.
 */
export function answerPrefixBeforeAction(text: string): string | null {
	if (text.includes(RESEARCH_PLAN_SENTINEL)) return null;
	const open = text.lastIndexOf("<");
	if (open === -1) return text;
	const tail = text.slice(open);
	return RESEARCH_PLAN_SENTINEL.startsWith(tail) ? text.slice(0, open) : text;
}

/** A call that failed because the research clock cut it, not because the model or the connection did. */
function researchClockRanOut(job: ActiveResearchJob, outcome: CallOutcome): boolean {
	return !job.cancelled && !outcome.cancelled && (job.deadlineExceeded || outcome.deadlineExceeded === true);
}
