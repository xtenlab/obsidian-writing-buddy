/**
 * Serialization for conversation files.
 *
 * These files sit in the vault, which means they get synced, merged, restored
 * from backups, and occasionally opened in a text editor by a curious writer.
 * So parsing is defensive: a damaged or partially-synced file must degrade to
 * "this one session failed to load" and never take the plugin down with it.
 */

import type {
	BranchOrigin,
	ConversationMessage,
	ConversationSession,
	GenerationMetadata,
	ContextBuildReport,
	ConversationHistoryReport,
	InstructionCompositionReport,
	ResearchContextReport,
	ResearchPlanFallbackReason,
	SelectionAttachment,
	ContextSourceSnapshot,
} from "../types";
import { countChars, previewOf } from "../util/text";
import { UNTITLED } from "../session/titles";
import { parseFullCorpusCoverage } from "../context/FullCorpusContext";
import { executionIdentity } from "../util/executionIdentity";
import { contentRevision, isContentRevision } from "../context/revision";

export const CONVERSATION_SCHEMA_VERSION = 5;

/**
 * The last format that stored a selection inline on every message.
 *
 * Kept so a vault can be written back to it. A schema this build cannot read is
 * refused rather than guessed at, which means shipping a new one has to come
 * with a way back; `serializeSessionAsInline` is that way.
 */
export const INLINE_SELECTION_SCHEMA_VERSION = 4;

/**
 * The fields a stored selection actually needs.
 *
 * `fileName`, `charCount` and `preview` are re-derived by `parseSelection` from
 * the validated path and text, so storing them again would be storing a value
 * nobody reads. Two selections agreeing on these seven agree completely.
 */
const SELECTION_FIELDS = ["filePath", "from", "to", "text", "before", "after", "capturedAt"] as const;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Pretty-printed so the files stay human-readable and diff well in sync.
 *
 * A selection is written once into a content-addressed table and referenced by
 * the messages that carry it. A writer who selects a passage and asks four
 * questions about it used to store that passage four times; in a real session
 * of 630 messages, duplicated selections were 74% of the file and the
 * conversation itself was under 2%.
 *
 * This is a change of representation and nothing else. Parsing puts the whole
 * object back on the message, so navigation, the Apply freshness check and the
 * message comparison that tells a fork from a fast-forward all still see what
 * they saw. Reference ids are content hashes rather than counters, so two
 * devices independently writing the same session produce the same bytes.
 */
export function serializeSession(session: ConversationSession): string {
	const table = new Map<string, Record<string, unknown>>();
	const reference = (selection: SelectionAttachment): string => {
		const stored = storedSelection(selection);
		const key = selectionKey(stored);
		if (!table.has(key)) table.set(key, stored);
		return key;
	};

	const serializable = { ...session, schemaVersion: CONVERSATION_SCHEMA_VERSION } as Record<string, unknown>;
	// Composer routing is device-local. In-memory sessions retain an empty
	// compatibility object, but no selector belongs in a synced vault file.
	delete serializable.preferences;
	// Nor does the passage the Composer is currently holding. It is draft state
	// on this device: not yet sent, not part of the transcript, and no more the
	// other device's business than half a typed sentence would be. A sent turn
	// carries its own frozen snapshot, which is what history keeps.
	delete serializable.selection;

	serializable.messages = session.messages.map((message) => {
		if (!message.selection) return message;
		const { selection, ...rest } = message;
		void selection;
		return { ...rest, selectionRef: reference(message.selection) };
	});
	// Sorted, so the table's order depends on its contents and not on the order
	// a particular device happened to encounter them.
	if (table.size > 0) {
		serializable.selections = Object.fromEntries(
			[...table.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		);
	}

	return `${JSON.stringify(serializable, null, "\t")}\n`;
}

/**
 * The same session in the inline format that schema 4 wrote.
 *
 * The escape hatch. Because parsing inlines every reference, a session read
 * from either format is the same object, and writing it back this way restores
 * exactly what schema 4 held — which is what makes rolling back to an older
 * build a supported operation rather than a restore from backup.
 */
export function serializeSessionAsInline(session: ConversationSession): string {
	const serializable = {
		...session,
		schemaVersion: INLINE_SELECTION_SCHEMA_VERSION,
	} as Record<string, unknown>;
	delete serializable.preferences;
	delete serializable.selection;
	return `${JSON.stringify(serializable, null, "\t")}\n`;
}

/** Only what is persisted, in a fixed key order so the hash is stable. */
export function storedSelection(selection: SelectionAttachment): Record<string, unknown> {
	const stored: Record<string, unknown> = {};
	for (const field of SELECTION_FIELDS) {
		const value = (selection as unknown as Record<string, unknown>)[field];
		if (value !== undefined) stored[field] = value;
	}
	return stored;
}

/**
 * Content address for a stored selection.
 *
 * `contentRevision` is the codebase's existing content identity, two 64-bit
 * lanes over the exact characters. A counter would have been shorter and wrong:
 * two devices assigning different numbers to identical passages would change
 * the bytes of an otherwise identical session, and every sync would read as a
 * conflict again.
 */
export function selectionKey(stored: Record<string, unknown>): string {
	return contentRevision(JSON.stringify(stored));
}

export function parseSession(raw: string): ParseResult<ConversationSession> {
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch (error) {
		return { ok: false, reason: `not valid JSON: ${(error as Error).message}` };
	}
	return validateSession(decoded);
}

export function validateSession(decoded: unknown): ParseResult<ConversationSession> {
	if (typeof decoded !== "object" || decoded === null) {
		return { ok: false, reason: "top level is not an object" };
	}
	const record = decoded as Record<string, unknown>;

	const id = str(record.id);
	if (!id) return { ok: false, reason: "missing session id" };

	const version = num(record.schemaVersion) ?? CONVERSATION_SCHEMA_VERSION;
	if (version > CONVERSATION_SCHEMA_VERSION) {
		return {
			ok: false,
			reason: `written by a newer version of WritingBuddy (schema ${version})`,
		};
	}

	const createdAt = str(record.createdAt) ?? new Date(0).toISOString();
	// Schema 5 stores each selection once and references it. Older files carry
	// the object inline, and both forms may appear in one file after a partial
	// sync, so resolution accepts either and produces the same message either way.
	const selections = parseSelectionTable(record.selections);
	const messages = Array.isArray(record.messages)
		? record.messages
			.map((message) => parseMessage(message, selections))
			.filter((message): message is ConversationMessage => message !== null)
		: [];

	const session: ConversationSession = {
		schemaVersion: CONVERSATION_SCHEMA_VERSION,
		id,
		title: str(record.title) ?? UNTITLED,
		titleIsManual: record.titleIsManual === true,
		createdAt,
		updatedAt: str(record.updatedAt) ?? createdAt,
		closed: record.closed === true,
		messages,
		relatedFiles: Array.isArray(record.relatedFiles)
			? record.relatedFiles.filter(isSafeVaultRelativePath)
			: [],
		// Schema <= 3 stored Composer selectors in the synced conversation. They
		// remain parseable, but are deliberately ignored rather than imported on
		// a new device or allowed to influence canonical LiveSync fingerprints.
		preferences: {},
	};

	// A live selection an older build stored is deliberately not restored. It
	// was the Composer's draft state when that file was written, possibly on
	// another device, days ago; presenting it as the passage this turn will
	// carry would be presenting someone else's cursor as the writer's own.
	const branch = parseBranch(record.branchedFrom);
	if (branch) session.branchedFrom = branch;

	return { ok: true, value: session };
}

/**
 * Read the stored selection table.
 *
 * A malformed entry is dropped rather than failing the session: a reference
 * that cannot be resolved costs a message its attached passage, which is the
 * same degradation an unparseable inline selection has always had, while
 * failing the file would cost the writer the whole conversation.
 */
export function parseSelectionTable(raw: unknown): Map<string, SelectionAttachment> {
	const table = new Map<string, SelectionAttachment>();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return table;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const selection = parseSelection(value);
		if (selection) table.set(key, selection);
	}
	return table;
}

/** A selection given inline, or named by reference. Inline wins if both exist. */
function resolveSelection(
	record: Record<string, unknown>,
	selections: ReadonlyMap<string, SelectionAttachment>,
): SelectionAttachment | undefined {
	const inline = parseSelection(record.selection);
	if (inline) return inline;
	const reference = str(record.selectionRef);
	return reference ? selections.get(reference) : undefined;
}

export function parseMessage(
	raw: unknown,
	selections: ReadonlyMap<string, SelectionAttachment>,
): ConversationMessage | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const role = record.role === "assistant" ? "assistant" : record.role === "user" ? "user" : null;
	if (!role) return null;

	const message: ConversationMessage = {
		id: str(record.id) ?? `m_${Math.random().toString(36).slice(2, 12)}`,
		role,
		text: str(record.text) ?? "",
		createdAt: str(record.createdAt) ?? new Date(0).toISOString(),
	};

	const selection = resolveSelection(record, selections);
	if (selection) message.selection = selection;

	const skillId = str(record.skillId);
	if (skillId) message.skillId = skillId;

	const candidate = parseCandidate(record.candidate);
	if (candidate) message.candidate = candidate;

	const metadata = parseMetadata(record.metadata);
	if (metadata) message.metadata = metadata;

	const error = str(record.error);
	if (error) message.error = error;

	return message;
}

/**
 * Selections are re-derived rather than trusted: `charCount` and `preview` are
 * recomputed from the text so a hand-edited file cannot make the UI lie about
 * how much manuscript was attached.
 */
export function parseSelection(raw: unknown): SelectionAttachment | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const filePath = isSafeVaultRelativePath(record.filePath) ? record.filePath : undefined;
	const text = str(record.text);
	if (!filePath || text === undefined) return undefined;

	const from = parsePosition(record.from);
	const to = parsePosition(record.to);
	if (!from || !to) return undefined;

	return {
		filePath,
		// The display name is derived from the validated path. A hand-edited
		// conversation must not smuggle a second path-shaped value into prompts.
		fileName: filePath.split("/").pop() ?? filePath,
		from,
		to,
		text,
		charCount: countChars(text),
		preview: previewOf(text),
		...(str(record.before) ? { before: str(record.before) } : {}),
		...(str(record.after) ? { after: str(record.after) } : {}),
		capturedAt: str(record.capturedAt) ?? new Date(0).toISOString(),
	};
}

function parseCandidate(raw: unknown): ConversationMessage["candidate"] | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const replacement = str(record.replacement);
	const kind = record.kind;
	if (replacement === undefined || (kind !== "replace" && kind !== "continue")) return undefined;
	return { replacement, kind };
}

function parsePosition(raw: unknown): { line: number; ch: number } | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const line = num(record.line);
	const ch = num(record.ch);
	if (line === undefined || ch === undefined) return null;
	if (!Number.isSafeInteger(line) || !Number.isSafeInteger(ch) || line < 0 || ch < 0) return null;
	return { line, ch };
}

function parseMetadata(raw: unknown): GenerationMetadata | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const metadata: GenerationMetadata = {};
	const connectionId = str(record.connectionId);
	const connectionName = str(record.connectionName);
	const connectionType = parseConnectionType(record.connectionType);
	const connectionDetail = str(record.connectionDetail);
	const errorCode = str(record.errorCode);
	const fullCorpusResumeKey = parseFullCorpusResumeKey(record.fullCorpusResumeKey);
	if (connectionId) metadata.connectionId = connectionId;
	if (connectionName) metadata.connectionName = connectionName;
	if (connectionType) metadata.connectionType = connectionType;
	if (connectionDetail) metadata.connectionDetail = connectionDetail;
	if (errorCode) metadata.errorCode = errorCode;
	if (fullCorpusResumeKey) metadata.fullCorpusResumeKey = fullCorpusResumeKey;
	const provider = executionIdentity(record.provider);
	const model = executionIdentity(record.model, true);
	const effort = executionIdentity(record.effort);
	const fallback = str(record.fallback);
	if (provider) metadata.provider = provider;
	if (model) metadata.model = model;
	if (effort) metadata.effort = effort;
	if (fallback) metadata.fallback = fallback;
	const contextReport = parseContextReport(record.contextReport);
	if (contextReport) metadata.contextReport = contextReport;
	const corpusTimings = parseCorpusTimings(record.corpusTimings);
	if (corpusTimings) metadata.corpusTimings = corpusTimings;
	// How the Runtime got a rewrite out of the answer. `fallback` means it had
	// to salvage one, which is why the candidate asks before applying.
	const rewriteParse = str(record.rewriteParse);
	if (rewriteParse) metadata.rewriteParse = rewriteParse;

	if (typeof record.usage === "object" && record.usage !== null) {
		const usage = record.usage as Record<string, unknown>;
		const input = num(usage.inputTokens);
		const output = num(usage.outputTokens);
		const total = num(usage.totalTokens);
		if (input !== undefined || output !== undefined || total !== undefined) {
			metadata.usage = {
				...(input !== undefined ? { inputTokens: input } : {}),
				...(output !== undefined ? { outputTokens: output } : {}),
				...(total !== undefined ? { totalTokens: total } : {}),
			};
		}
	}

	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Only controller-issued SHA-256 identities may make a stored turn resumable. */
export function parseFullCorpusResumeKey(value: unknown): string | undefined {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function parseCorpusTimings(raw: unknown): GenerationMetadata["corpusTimings"] | undefined {
	const record = objectRecord(raw);
	if (!record) return undefined;
	const keys = ["snapshotMs", "evidenceMs", "leafMs", "reduceMs", "finalMs", "totalMs"] as const;
	const values = nonNegativeIntegers(record, keys);
	if (!values) return undefined;
	const measured = values.snapshotMs + values.evidenceMs + values.leafMs + values.reduceMs + values.finalMs;
	return values.totalMs >= measured ? values : undefined;
}

function parseContextReport(raw: unknown): ContextBuildReport | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const mode = str(record.mode);
	const resolvedDepth = str(record.resolvedDepth);
	const task = str(record.task);
	const sourceRevision = str(record.sourceRevision);
	if (!isContextDepth(mode) || mode === undefined) return undefined;
	if (resolvedDepth !== "low" && resolvedDepth !== "medium" && resolvedDepth !== "high") return undefined;
	if (!isContextTask(task) || !isSourceRevision(sourceRevision)) return undefined;

	const numericKeys = [
		"selectionChars", "surroundingChars", "activeFileChars", "retrievedChars",
		"rawChars", "deduplicatedChars", "finalChars", "estimatedTokens",
		"includedSources", "excludedArchiveCount", "truncatedSources", "omittedSources",
	] as const;
	const values: Partial<Record<typeof numericKeys[number], number>> = {};
	for (const key of numericKeys) {
		const value = num(record[key]);
		if (value === undefined || value < 0) return undefined;
		values[key] = value;
	}
	const sources = parseContextSources(record.sources);
	const corpusCoverage = parseFullCorpusCoverage(record.corpusCoverage);
	const history = parseHistoryAccounting(record.history);
	const instructions = parseInstructionAccounting(record.instructions);
	const research = parseResearchAccounting(record.research);

	return {
		mode,
		resolvedDepth,
		task,
		...(record.profile === "general" || record.profile === "causal" ? { profile: record.profile } : {}),
		sourceRevision,
		selectionChars: values.selectionChars!,
		surroundingChars: values.surroundingChars!,
		activeFileChars: values.activeFileChars!,
		retrievedChars: values.retrievedChars!,
		rawChars: values.rawChars!,
		deduplicatedChars: values.deduplicatedChars!,
		finalChars: values.finalChars!,
		estimatedTokens: values.estimatedTokens!,
		includedSources: values.includedSources!,
		excludedArchiveCount: values.excludedArchiveCount!,
		truncatedSources: values.truncatedSources!,
		omittedSources: values.omittedSources!,
		budgetExpandedForSelection: record.budgetExpandedForSelection === true,
		...(num(record.conversationMessages) !== undefined ? { conversationMessages: Math.max(0, num(record.conversationMessages)!) } : {}),
		...(str(record.skillId) ? { skillId: str(record.skillId) } : {}),
		...(sources.length > 0 ? { sources } : {}),
		...(corpusCoverage ? { corpusCoverage } : {}),
		...(history ? { history } : {}),
		...(instructions ? { instructions } : {}),
		...(research ? { research } : {}),
	};
}

function parseHistoryAccounting(raw: unknown): ConversationHistoryReport | undefined {
	const record = objectRecord(raw);
	if (!record) return undefined;
	const values = nonNegativeIntegers(record, [
		"consideredPairs", "selectedPairs", "droppedPairs", "messageCount", "characters", "estimatedTokens",
	] as const);
	if (!values || typeof record.truncated !== "boolean") return undefined;
	return {
		consideredPairs: values.consideredPairs,
		selectedPairs: values.selectedPairs,
		droppedPairs: values.droppedPairs,
		messageCount: values.messageCount,
		characters: values.characters,
		estimatedTokens: values.estimatedTokens,
		truncated: record.truncated,
	};
}

function parseInstructionAccounting(raw: unknown): InstructionCompositionReport | undefined {
	const record = objectRecord(raw);
	if (!record) return undefined;
	const layerCount = nonNegativeInteger(record.layerCount);
	const characters = nonNegativeInteger(record.characters);
	if (layerCount === undefined || characters === undefined ||
		typeof record.projectIncluded !== "boolean" || typeof record.skillIncluded !== "boolean") {
		return undefined;
	}
	const projectStatus = record.projectStatus;
	if (projectStatus !== "absent" && projectStatus !== "active" && projectStatus !== "invalid") {
		return undefined;
	}
	return {
		layerCount,
		characters,
		projectStatus,
		projectIncluded: record.projectIncluded,
		skillIncluded: record.skillIncluded,
	};
}

function parseResearchAccounting(raw: unknown): ResearchContextReport | undefined {
	const record = objectRecord(raw);
	if (!record || !isResearchStatus(record.status)) return undefined;
	const values = nonNegativeIntegers(record, [
		"planningRounds", "retrievalRounds", "backendCalls", "queriesRequested", "queriesExecuted",
		"initialEvidenceItems", "finalEvidenceItems", "addedEvidenceItems", "deduplicatedEvidenceItems",
		"initialEvidenceChars", "finalEvidenceChars", "filesConsidered", "filesRead", "readFailures",
		"excludedByMetadata", "citedEvidenceItems",
	] as const);
	const limits = parseResearchLimits(record.limits);
	const limitsReached = parseResearchLimitsReached(record.limitsReached);
	if (!values || !limits || !limitsReached || typeof record.forcedSynthesis !== "boolean") return undefined;
	const observationChars = nonNegativeInteger(record.observationChars);
	const planFallbackReason = isResearchFallbackReason(record.planFallbackReason) ? record.planFallbackReason : undefined;
	return {
		status: record.status,
		planningRounds: values.planningRounds,
		retrievalRounds: values.retrievalRounds,
		backendCalls: values.backendCalls,
		...(observationChars !== undefined ? { observationChars } : {}),
		queriesRequested: values.queriesRequested,
		queriesExecuted: values.queriesExecuted,
		initialEvidenceItems: values.initialEvidenceItems,
		finalEvidenceItems: values.finalEvidenceItems,
		addedEvidenceItems: values.addedEvidenceItems,
		deduplicatedEvidenceItems: values.deduplicatedEvidenceItems,
		initialEvidenceChars: values.initialEvidenceChars,
		finalEvidenceChars: values.finalEvidenceChars,
		filesConsidered: values.filesConsidered,
		filesRead: values.filesRead,
		readFailures: values.readFailures,
		excludedByMetadata: values.excludedByMetadata,
		citedEvidenceItems: values.citedEvidenceItems,
		forcedSynthesis: record.forcedSynthesis,
		...(planFallbackReason ? { planFallbackReason } : {}),
		limits,
		limitsReached,
	};
}

function parseResearchLimits(raw: unknown): ResearchContextReport["limits"] | undefined {
	const record = objectRecord(raw);
	if (!record) return undefined;
	const values = nonNegativeIntegers(record, [
		"maxPlanningRounds", "maxBackendCalls", "maxQueries", "maxQueryChars",
		"maxFilesRead", "maxEvidenceItems", "maxEvidenceChars", "perEvidenceChars", "deadlineMs",
	] as const);
	if (!values) return undefined;
	const maxObservationChars = nonNegativeInteger(record.maxObservationChars);
	const maxQueriesPerRound = nonNegativeInteger(record.maxQueriesPerRound);
	return {
		...values,
		...(maxObservationChars !== undefined ? { maxObservationChars } : {}),
		...(maxQueriesPerRound !== undefined ? { maxQueriesPerRound } : {}),
	};
}

function parseResearchLimitsReached(raw: unknown): ResearchContextReport["limitsReached"] | undefined {
	const record = objectRecord(raw);
	if (!record) return undefined;
	const keys = ["planning", "queries", "files", "evidence", "chars", "deadline"] as const;
	if (keys.some((key) => typeof record[key] !== "boolean")) return undefined;
	return {
		planning: record.planning as boolean,
		...(typeof record.observations === "boolean" ? { observations: record.observations } : {}),
		queries: record.queries as boolean,
		files: record.files as boolean,
		evidence: record.evidence as boolean,
		chars: record.chars as boolean,
		deadline: record.deadline as boolean,
	};
}

function parseContextSources(raw: unknown): NonNullable<ContextBuildReport["sources"]> {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const record = entry as Record<string, unknown>;
		const path = isSafeVaultRelativePath(record.path) ? record.path : undefined;
		const label = str(record.label);
		const type = record.type;
		if (!path || !label || !isContextSourceType(type)) return [];
		const from = parsePosition(record.from);
		const to = parsePosition(record.to);
		const revision = isContentRevision(record.revision) ? record.revision : undefined;
		const revisionKind = record.revisionKind === "saved" || record.revisionKind === "editor"
			? record.revisionKind : undefined;
		const hasRevisionFields = Object.hasOwn(record, "revision") || Object.hasOwn(record, "revisionKind");
		// Exact Full provenance is atomic. A hand-edited or damaged revision must
		// not leave a clickable source that can be mistaken for a legacy anchor.
		// Historical selection sources legitimately have a range but no revision,
		// so preserve that older shape when no revision fields were written at all.
		if (hasRevisionFields && (!from || !to || !revision || !revisionKind)) return [];
		const orderedRange = from && to && (from.line < to.line || (from.line === to.line && from.ch <= to.ch));
		if (hasRevisionFields && !orderedRange) return [];
		const location: Pick<ContextSourceSnapshot, "from" | "to" | "revision" | "revisionKind"> = hasRevisionFields
			? { from: from!, to: to!, revision: revision!, revisionKind: revisionKind! }
			: (orderedRange ? { from, to } : {});
		return [{
			path, label, type, truncated: record.truncated === true,
			...(str(record.heading) ? { heading: str(record.heading) } : {}),
			...(str(record.anchorText) ? { anchorText: str(record.anchorText) } : {}),
			...location,
		}];
	});
}

function isContextSourceType(value: unknown): value is NonNullable<ContextBuildReport["sources"]>[number]["type"] {
	return value === "selection" || value === "surroundings" || value === "current" ||
		value === "linked" || value === "retrieved";
}

function isContextDepth(value: string | undefined): value is ContextBuildReport["mode"] {
	return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "full";
}

function isContextTask(value: string | undefined): value is ContextBuildReport["task"] {
	return value === "rewrite" || value === "continue" || value === "selection-qa" ||
		value === "chapter-summary" || value === "continuity" || value === "project-review" || value === "qa";
}

function isSourceRevision(value: string | undefined): value is ContextBuildReport["sourceRevision"] {
	return value === "saved" || value === "editor" || value === "mixed";
}

/**
 * Conversation files are synced, user-editable input. Keep every persisted
 * Vault path relative and canonical before it can reach context serialization
 * or a click-to-open action. Obsidian paths use forward slashes, so accepting a
 * backslash would also accept Windows absolute and UNC spellings.
 */
function isSafeVaultRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) return false;
	// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
	if (/[\\\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
	if (value.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseConnectionType(raw: unknown): "remote-runtime" | "direct-api" | "local" | undefined {
	return raw === "remote-runtime" || raw === "direct-api" || raw === "local" ? raw : undefined;
}

export function parseBranch(raw: unknown): BranchOrigin | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const sessionId = str(record.sessionId);
	const messageIndex = num(record.messageIndex);
	if (!sessionId || messageIndex === undefined) return undefined;
	return { sessionId, messageIndex };
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeIntegers<const Keys extends readonly string[]>(
	record: Record<string, unknown>,
	keys: Keys,
): { [Key in Keys[number]]: number } | undefined {
	const result = Object.create(null) as Record<string, number>;
	for (const key of keys) {
		const value = nonNegativeInteger(record[key]);
		if (value === undefined) return undefined;
		result[key] = value;
	}
	return result as { [Key in Keys[number]]: number };
}

function isResearchStatus(value: unknown): value is ResearchContextReport["status"] {
	return value === "completed" || value === "cancelled" || value === "deadline" ||
		value === "backend-error" || value === "invalid-invocation";
}

const RESEARCH_FALLBACK_REASONS = new Set([
	"missing-sentinel", "multiple-sentinels", "trailing-content", "missing-json", "malformed-json",
	"invalid-shape", "unsafe-query", "empty-query", "duplicate-query", "query-limit", "no-new-query",
]);

function isResearchFallbackReason(value: unknown): value is ResearchPlanFallbackReason {
	return typeof value === "string" && RESEARCH_FALLBACK_REASONS.has(value);
}
