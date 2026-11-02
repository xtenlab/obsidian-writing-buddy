/**
 * Domain vocabulary for WritingBuddy.
 *
 * The nouns here are deliberately writing nouns — manuscript, selection,
 * session, skill, edit — not "notes", "documents", or "workspace items".
 * Nothing in this file may reference a specific AI provider or transport.
 */

/** Zero-based line/character position, matching Obsidian's editor coordinates. */
export interface DocPosition {
	line: number;
	ch: number;
}

/** An exact, re-verifiable range inside one manuscript file. */
export interface DocRange {
	from: DocPosition;
	to: DocPosition;
}

/**
 * A piece of manuscript the writer explicitly handed to the assistant.
 *
 * This is *context*, never an instruction. Attaching a selection to a chat must
 * not, on its own, cause the document to change.
 */
export interface SelectionAttachment {
	/** Vault-relative path, e.g. `第一卷/第03章.md`. */
	filePath: string;
	/** Basename shown in the UI chip. */
	fileName: string;
	from: DocPosition;
	to: DocPosition;
	/** Exact selected text, never trimmed. */
	text: string;
	/** Code-point count, so one Han character counts as one 字. */
	charCount: number;
	/** Single-line preview for the chip. */
	preview: string;
	/** Read-only editor text immediately before the captured range. */
	before?: string;
	/** Read-only editor text immediately after the captured range. */
	after?: string;
	/** ISO timestamp of capture. */
	capturedAt: string;
}

/** Provider-neutral candidate persisted independently of model formatting. */
export interface MessageCandidate {
	replacement: string;
	kind: "replace" | "continue";
}

export type MessageRole = "user" | "assistant";

/**
 * Whatever the backend reported about how a turn was produced. The plugin
 * stores these verbatim and never invents or validates provider names.
 */
export interface GenerationMetadata {
	connectionId?: string;
	connectionName?: string;
	connectionType?: "remote-runtime" | "direct-api" | "local";
	connectionDetail?: string;
	errorCode?: string;
	/** Content-addressed identity for explicitly resuming an interrupted Full run. */
	fullCorpusResumeKey?: string;
	provider?: string;
	model?: string;
	effort?: string;
	contextReport?: ContextBuildReport;
	/** Client-measured wall time for a Full run, including pre-coverage failures. */
	corpusTimings?: CorpusPhaseTimings;
	/** Set when the backend fell back to another provider. */
	fallback?: string;
	/**
	 * How the Runtime got a rewrite out of the model's answer.
	 *
	 * `sentinel` is the agreed format. `fallback` means the model did not follow
	 * it and the Runtime salvaged what it could — so the replacement may still
	 * carry a preamble like "好的，这是改写后的版本：", which would otherwise be
	 * written straight into the manuscript.
	 */
	rewriteParse?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
}

export interface ConversationMessage {
	id: string;
	role: MessageRole;
	text: string;
	createdAt: string;
	/**
	 * Snapshot of the selection attached to *this* turn. Historical answers keep
	 * the selection that produced them even after the live attachment changes.
	 */
	selection?: SelectionAttachment;
	/** Skill that produced this turn, if any. */
	skillId?: string;
	/** Structured rewrite result. Older fenced replies remain supported. */
	candidate?: MessageCandidate;
	metadata?: GenerationMetadata;
	/** Set when the turn ended in a backend or transport failure. */
	error?: string;
}

/**
 * The persisted Context value for a turn.
 *
 * Separate from `effort` on purpose. Effort is the model's reasoning budget and
 * is the Runtime's business. Auto delegates research sufficiency to the Agent,
 * Full requests deterministic complete coverage, and Low restricts access to
 * local context. High remains in the wire type only for legacy compatibility.
 */
export type ContextDepth = "auto" | "low" | "high" | "full";

/** A concrete bounded budget after the visible Context mode is resolved. */
export type ResolvedContextDepth = "low" | "medium" | "high";

/** Historical mode values accepted when reading saved context reports. */
export type ContextReportMode = ContextDepth | "medium" | "full";

/** Retrieval strategy is independent from the amount of context requested. */
export type ContextProfile = "general" | "causal";

export type ContextTask =
	| "rewrite"
	| "continue"
	| "selection-qa"
	| "chapter-summary"
	| "continuity"
	| "project-review"
	| "qa";

/** Content-free transcript-selection accounting safe for synced metadata. */
export interface ConversationHistoryReport {
	consideredPairs: number;
	selectedPairs: number;
	droppedPairs: number;
	messageCount: number;
	characters: number;
	estimatedTokens: number;
	truncated: boolean;
}

/** Content-free instruction composition accounting; never contains prompt text. */
export interface InstructionCompositionReport {
	layerCount: number;
	characters: number;
	projectStatus: "absent" | "active" | "invalid";
	projectIncluded: boolean;
	skillIncluded: boolean;
}

export type ResearchTermination =
	| "completed"
	| "cancelled"
	| "deadline"
	| "backend-error"
	| "invalid-invocation";

export type ResearchPlanFallbackReason =
	| "missing-sentinel"
	| "multiple-sentinels"
	| "trailing-content"
	| "missing-json"
	| "malformed-json"
	| "invalid-shape"
	| "unsafe-query"
	| "empty-query"
	| "duplicate-query"
	| "query-limit"
	| "no-new-query";

/** Persistable bounded-research measurements; contains no query or model prose. */
export interface ResearchContextReport {
	status: ResearchTermination;
	planningRounds: number;
	retrievalRounds: number;
	backendCalls: number;
	/** Serialized observation-prompt characters sent across all planning calls. */
	observationChars?: number;
	queriesRequested: number;
	queriesExecuted: number;
	initialEvidenceItems: number;
	finalEvidenceItems: number;
	addedEvidenceItems: number;
	deduplicatedEvidenceItems: number;
	initialEvidenceChars: number;
	finalEvidenceChars: number;
	filesConsidered: number;
	filesRead: number;
	readFailures: number;
	excludedByMetadata: number;
	citedEvidenceItems: number;
	forcedSynthesis: boolean;
	planFallbackReason?: ResearchPlanFallbackReason;
	limits: {
		maxPlanningRounds: number;
		maxBackendCalls: number;
		/** Hard character ceiling across all client observation prompts in the run. */
		maxObservationChars?: number;
		maxQueries: number;
		/** Historical multi-query planner field; current actions issue one query. */
		maxQueriesPerRound?: number;
		maxQueryChars: number;
		maxFilesRead: number;
		maxEvidenceItems: number;
		/** Automatic evidence allowance; explicit task selections may exceed it. */
		maxEvidenceChars: number;
		perEvidenceChars: number;
		deadlineMs: number;
	};
	limitsReached: {
		planning: boolean;
		/** Observation context was compacted or omitted to honor its hard ceiling. */
		observations?: boolean;
		queries: boolean;
		files: boolean;
		evidence: boolean;
		chars: boolean;
		deadline: boolean;
	};
}

/** Content-free measurements explaining what local context was assembled. */
export interface ContextBuildReport {
	mode: ContextReportMode;
	resolvedDepth: ResolvedContextDepth;
	task: ContextTask;
	/** Optional for compatibility with reports saved before causal retrieval. */
	profile?: ContextProfile;
	sourceRevision: "saved" | "editor" | "mixed";
	selectionChars: number;
	surroundingChars: number;
	activeFileChars: number;
	retrievedChars: number;
	rawChars: number;
	deduplicatedChars: number;
	finalChars: number;
	estimatedTokens: number;
	includedSources: number;
	excludedArchiveCount: number;
	truncatedSources: number;
	omittedSources: number;
	budgetExpandedForSelection: boolean;
	/** Recent transcript entries included in the request. */
	conversationMessages?: number;
	/** Active skill, when this turn used one. */
	skillId?: string;
	/** Content-free list of Vault material made available to the model. */
	sources?: ContextSourceSnapshot[];
	/** Exact, client-measured coverage for an explicitly requested full-corpus run. */
	corpusCoverage?: CorpusCoverageReport;
	/** Content-free accounting for the bounded transcript sent to the backend. */
	history?: ConversationHistoryReport;
	/** Content-free accounting for the effective instruction layers. */
	instructions?: InstructionCompositionReport;
	/** Content-free accounting for a bounded research run. */
	research?: ResearchContextReport;
}

/**
 * What a full-current-manuscript orchestration actually covered.
 *
 * This is deliberately persisted as measurements rather than inferred later
 * from an answer. In particular, only `complete` with equal included/total
 * counts means the answer may be described as a whole-manuscript result.
 */
export interface CorpusCoverageReport {
	target: "current-manuscript";
	status: "complete" | "partial" | "degraded" | "failed" | "cancelled";
	includedFiles: number;
	totalFiles: number;
	includedChars: number;
	totalChars: number;
	completedBatches: number;
	/** Exact zero-based leaf indexes represented by this result. */
	completedBatchIndexes?: number[];
	totalBatches: number;
	reductionBatches: number;
	totalReductionBatches?: number;
	summaryStatus?: "complete" | "partial" | "degraded" | "failed";
	readFailures: number;
	uncoveredFiles: string[];
	/** Optional for compatibility with reports saved before whole-run bounds. */
	backendCalls?: number;
	maxBackendCalls?: number;
	deadlineMs?: number;
	limitReached?: "deadline" | "soft-deadline" | "backend-call-limit";
}

export interface CorpusPhaseTimings {
	snapshotMs: number;
	evidenceMs: number;
	leafMs: number;
	reduceMs: number;
	finalMs: number;
	totalMs: number;
}

export interface ContextSourceSnapshot {
	path: string;
	label: string;
	type: "selection" | "surroundings" | "current" | "linked" | "retrieved";
	heading?: string;
	/** Text fallback used for legacy/range-less navigation after reload. */
	anchorText?: string;
	from?: DocPosition;
	to?: DocPosition;
	/** Optional per-source content identity and saved/editor authority. */
	revision?: string;
	revisionKind?: "saved" | "editor";
	truncated: boolean;
}

/**
 * The effective Composer selection for one conversation on this device.
 *
 * Settings supplies the device default until this conversation is adjusted. A
 * local per-session override then wins as a whole; neither form is synced in
 * conversation JSON.
 */
export interface SessionPreferences {
	connectionId?: string;
	/** Historical display snapshot; never contains endpoint or credentials. */
	connectionName?: string;
	connectionType?: "remote-runtime" | "direct-api" | "local";
	connectionDetail?: string;
	provider?: string;
	model?: string;
	effort?: string;
	contextDepth?: ContextDepth;
}

/** Where a branched session came from. */
export interface BranchOrigin {
	sessionId: string;
	/** Index into the parent's `messages` that the branch forked after. */
	messageIndex: number;
}

/**
 * One conversation. Persisted as a single file under
 * `WritingBuddy/conversations/<id>.json` so that sync tools can merge at
 * file granularity instead of fighting over one giant blob.
 */
export interface ConversationSession {
	schemaVersion: number;
	id: string;
	title: string;
	/** A title the writer typed is never overwritten by generated titles. */
	titleIsManual: boolean;
	createdAt: string;
	updatedAt: string;
	/** Closed sessions stay on disk; closing is not deleting. */
	closed: boolean;
	messages: ConversationMessage[];
	/** Vault-relative paths this conversation has touched, most recent first. */
	relatedFiles: string[];
	/** The live attachment, persisted so it survives a reload. */
	selection?: SelectionAttachment;
	branchedFrom?: BranchOrigin;
	preferences: SessionPreferences;
}

/**
 * Project-local metadata, stored in `WritingBuddy/project.json`.
 *
 * There is deliberately **no generated project id**. The vault *is* the project
 * boundary: everything project-local already lives under `WritingBuddy/`, and
 * nothing is sent to the Runtime that needs naming. A random `wbp_…` added a
 * second identity to keep in sync with the first for no benefit.
 */
export interface ProjectMetadata {
	schemaVersion: number;
	/** Cosmetic, defaults to the vault name. */
	displayName: string;
	/**
	 * The language the model is instructed in: built-in skill content and every
	 * composed prompt. Project data, not device data — it follows the
	 * manuscript through sync. Absent means Chinese.
	 */
	/** Absent or `auto` follows the interface language. */
	instructionLanguage?: "zh" | "en" | "auto";
}

/** What a skill is allowed to do to the manuscript. */
export type SkillAction = "chat" | "rewrite" | "continue";

/** What a skill looks at. */
export type SkillScope = "selection" | "current-document" | "project";

/** Optional metadata used by the deterministic typed-intent router. */
export interface SkillRoutingMetadata {
	/** Phrases that identify this task. They are signals, never raw substring commands. */
	phrases: string[];
	/** Allow an analytical question as well as an imperative request. */
	allowQuestions?: boolean;
}

/** Shared instruction families a task Skill can opt into. */
export type SkillInstructionProfile = "review";

export interface Skill {
	id: string;
	name: string;
	action: SkillAction;
	scope: SkillScope;
	version: number;
	/** The prompt body, verbatim from the Markdown file. */
	instruction: string;
	/** Optional one-line explanation shown in the action list. */
	description?: string;
	/**
	 * Human-readable ask inserted when this Skill's action is clicked. Custom
	 * loaders may derive this from flat frontmatter; legacy files can omit it.
	 */
	/**
	 * Legacy quick-action phrasing. Read, written back, and never used.
	 *
	 * Selecting an action no longer types anything for the writer, so nothing
	 * consumes this. It is still parsed and re-serialized so a Skill file that
	 * declares it survives being loaded and saved. Do not start reading it
	 * again without deciding that the Composer should write on someone's behalf.
	 */
	composerPrompt?: string;
	/** Shared behavior kept out of the task-specific Markdown body. */
	instructionProfile?: SkillInstructionProfile;
	/**
	 * Structured routing metadata for built-in and user-authored Skills. Legacy
	 * `triggers` remain a supported flat-file representation.
	 */
	routing?: SkillRoutingMetadata;
	/**
	 * Phrases that should reach this skill when typed in the composer.
	 *
	 * The buttons are a shortcut, not the entrance: someone who types
	 * "帮我把这段收紧一点" is asking for 精简 and should get it. Declaring the
	 * words here is what makes that work for a skill a writer adds themselves,
	 * with no code change — which is the point of skills being files.
	 *
	 * Optional and additive: a skill file without it still loads, and falls back
	 * to matching on its own name.
	 */
	triggers?: string[];
	/** True for skills shipped with the plugin rather than read from the vault. */
	builtin: boolean;
	/** Vault path this skill was loaded from, when not builtin. */
	sourcePath?: string;
}

/**
 * A single applied selection edit, and the only thing an undo is allowed to
 * act on. Undo is range-level: it never restores a whole file.
 */
export interface EditToken {
	id: string;
	filePath: string;
	/** Exactly what was in the range before the edit. */
	originalText: string;
	/** Exactly what the plugin wrote into the range. */
	replacement: string;
	/** Start of the edit; unchanged by the edit itself. */
	from: DocPosition;
	/** End of the range *after* the replacement was written. */
	to: DocPosition;
	appliedAt: string;
	undone: boolean;
	/** Skill that produced the replacement, when applicable. */
	skillId?: string;
}
