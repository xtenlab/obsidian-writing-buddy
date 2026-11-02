/**
 * Deliberate, bounded selection of the transcript sent to a backend.
 *
 * History is selected as complete user-led turns, not as an arbitrary number
 * of messages.  Nothing is summarised or re-labelled as user-authored fact:
 * assistant text always remains an assistant message, which prevents an old
 * model guess from quietly becoming canon merely because it survived trimming.
 */

import type { RequestMessage } from "../backend/AIBackend";
import type { ConversationMessage, ConversationSession, SelectionAttachment } from "../types";
import { conversationMessageWithSelectionReferent, type SelectionReferentOptions } from "./messageText";

/** Roughly twelve user/assistant exchanges, rather than twelve messages. */
export const DEFAULT_HISTORY_TARGET_PAIRS = 12;

/**
 * History has its own bounded share of a request.  The current ask is mandatory
 * and therefore is measured separately rather than truncated to satisfy these
 * limits.
 */
export const DEFAULT_HISTORY_MAX_CHARACTERS = 24_000;
export const DEFAULT_HISTORY_MAX_ESTIMATED_TOKENS = 8_000;

const DEFAULT_RECENT_PAIRS = 8;
const REQUEST_MESSAGE_TOKEN_OVERHEAD = 4;

export interface ConversationHistoryOptions {
	/** Desired number of complete user-led turns. */
	targetPairs?: number;
	/**
	 * Newest turns reserved before older semantic anchors are considered.
	 * Defaults to two thirds of `targetPairs`; remaining slots can retain an
	 * older correction, constraint, candidate, or selection referent.
	 */
	recentPairs?: number;
	/** Code-point cap for historical message content. */
	maxCharacters?: number;
	/** Conservative estimated-token cap, including per-message overhead. */
	maxEstimatedTokens?: number;
}

/** The concrete policy shared by chat, rewrite, full-corpus, and research. */
export const DEFAULT_CONVERSATION_HISTORY_BUDGET: Readonly<Required<ConversationHistoryOptions>> = Object.freeze({
	targetPairs: DEFAULT_HISTORY_TARGET_PAIRS,
	recentPairs: DEFAULT_RECENT_PAIRS,
	maxCharacters: DEFAULT_HISTORY_MAX_CHARACTERS,
	maxEstimatedTokens: DEFAULT_HISTORY_MAX_ESTIMATED_TOKENS,
});

export interface ConversationHistoryInput {
	/** A whole session or just its persisted transcript. */
	session: Pick<ConversationSession, "messages">;
	/** The current user ask, appended verbatim exactly once. */
	current: string;
	/**
	 * Id of the current ask when the UI persisted it before starting the call.
	 * History stops before this message, so neither it nor later stale output can
	 * be replayed in addition to `current`.
	 */
	currentMessageId?: string;
	/** Complete current selection, supplied elsewhere in the request. */
	activeSelection?: SelectionAttachment;
	/**
	 * True for a historical passage that is provably gone from the document.
	 *
	 * The same instance is used for costing and for rendering, so a predicate
	 * that answers consistently keeps the character/token accounting exact.
	 * Callers that cannot see live text simply omit it.
	 */
	supersededSelection?: SupersededSelectionCheck;
	budget?: ConversationHistoryOptions;
	/**
	 * `selection`: a rewrite or continuation of `activeSelection`. Only turns
	 * about the same passage travel — earlier versions of it and what the writer
	 * said about them — within `SELECTION_HISTORY_BUDGET`. A month-old
	 * discussion of something else outweighed a two-character "改写" and the
	 * model rewrote that discussion instead of the selection (2026-11-01).
	 */
	scope?: "conversation" | "selection";
}

/** History for a turn that rewrites or continues the selection. */
export const SELECTION_HISTORY_BUDGET: Readonly<Required<ConversationHistoryOptions>> = Object.freeze({
	targetPairs: 4,
	recentPairs: 4,
	maxCharacters: 9_000,
	maxEstimatedTokens: 3_000,
});

export type SupersededSelectionCheck = (selection: SelectionAttachment) => boolean;

export interface ConversationHistorySelection {
	/** Selected history followed by the current user ask. */
	messages: RequestMessage[];
	/** Selected history only, convenient for retrieval continuity. */
	history: RequestMessage[];
	consideredPairs: number;
	selectedPairs: number;
	droppedPairs: number;
	historyMessageCount: number;
	historyCharacters: number;
	estimatedHistoryTokens: number;
	truncated: boolean;
}

interface CompleteTurn {
	index: number;
	messages: ConversationMessage[];
	user: ConversationMessage;
}

interface TurnCost {
	characters: number;
	tokens: number;
}

interface ResolvedBudget {
	targetPairs: number;
	recentPairs: number;
	maxCharacters: number;
	maxEstimatedTokens: number;
}

/**
 * Select and serialise request history.
 *
 * Selection order is deterministic:
 *
 * 1. reserve the newest complete turns;
 * 2. consider older user-authored corrections/constraints and structural
 *    selection/candidate anchors (plus their immediate referent);
 * 3. fill remaining room by recency;
 * 4. restore chronological order for the request.
 *
 * A turn is admitted whole or omitted whole.  This avoids cutting a candidate
 * into text that looks like a complete replacement, and never starts history
 * with a detached assistant answer.
 */
export function selectConversationHistory(input: ConversationHistoryInput): ConversationHistorySelection {
	const scoped = input.scope === "selection" && input.activeSelection !== undefined;
	const budget = resolveBudget(input.budget ?? (scoped ? SELECTION_HISTORY_BUDGET : undefined));
	const prior = messagesBeforeCurrent(input.session.messages, input.currentMessageId);
	const allTurns = completeTurns(prior);
	const turns = scoped ? allTurns.filter((turn) => aboutSelection(turn, input.activeSelection!)) : allTurns;
	const selected = selectTurns(turns, input.current, input.activeSelection, budget, input.supersededSelection);
	const history = renderTurns(selected, input.activeSelection, input.supersededSelection);
	const cost = requestMessagesCost(history);
	const current: RequestMessage = { role: "user", content: input.current };

	return {
		messages: [...history, current],
		history,
		consideredPairs: turns.length,
		selectedPairs: selected.length,
		droppedPairs: turns.length - selected.length,
		historyMessageCount: history.length,
		historyCharacters: cost.characters,
		estimatedHistoryTokens: cost.tokens,
		truncated: selected.length < turns.length,
	};
}

/**
 * Compatibility-shaped API for ConversationController, FullCorpusController,
 * and ResearchController.  Existing call sites can switch their import without
 * changing arguments; callers needing diagnostics can use the selector above.
 */
export function conversationMessages(
	session: Pick<ConversationSession, "messages">,
	current: string,
	currentMessageId?: string,
	activeSelection?: SelectionAttachment,
	budget?: ConversationHistoryOptions,
): RequestMessage[] {
	return selectConversationHistory({
		session,
		current,
		...(currentMessageId ? { currentMessageId } : {}),
		...(activeSelection ? { activeSelection } : {}),
		...(budget ? { budget } : {}),
	}).messages;
}

/**
 * Conservative deterministic estimate.  CJK, kana, Hangul, emoji and
 * punctuation are charged individually; ASCII word runs are charged at one
 * token per four characters.  It is intentionally a budget guard, not a claim
 * about any provider's exact tokenizer.
 */
export function estimateConversationTokens(text: string): number {
	let tokens = 0;
	let asciiRun = 0;
	const flushAscii = (): void => {
		if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4);
		asciiRun = 0;
	};

	for (const character of text) {
		if (/[A-Za-z0-9_]/.test(character)) {
			asciiRun += 1;
			continue;
		}
		flushAscii();
		if (!/\s/u.test(character)) tokens += 1;
	}
	flushAscii();
	return tokens;
}

function messagesBeforeCurrent(
	messages: readonly ConversationMessage[],
	currentMessageId: string | undefined,
): readonly ConversationMessage[] {
	if (!currentMessageId) return messages;
	const currentIndex = messages.findIndex((message) => message.id === currentMessageId);
	return currentIndex < 0 ? messages : messages.slice(0, currentIndex);
}

/**
 * Group each user with any following assistant messages up to the next user.
 *
 * A user-only turn is still meaningful history: cancellation can leave the
 * writer's correction or constraint without an assistant reply. Dropping that
 * turn would make the very next request forget what the writer just said. An
 * assistant that has no preceding user remains an orphan and is still ignored.
 */
function completeTurns(messages: readonly ConversationMessage[]): CompleteTurn[] {
	const turns: CompleteTurn[] = [];
	let pending: ConversationMessage[] | null = null;
	let user: ConversationMessage | null = null;

	const flush = (): void => {
		if (pending && user) {
			turns.push({ index: turns.length, messages: pending, user });
		}
		pending = null;
		user = null;
	};

	for (const message of messages) {
		if (message.role === "user") {
			flush();
			user = message;
			pending = [message];
		} else if (pending) {
			pending.push(message);
		}
	}
	flush();
	return turns;
}

function selectTurns(
	turns: CompleteTurn[],
	current: string,
	activeSelection: SelectionAttachment | undefined,
	budget: ResolvedBudget,
	superseded: SupersededSelectionCheck | undefined,
): CompleteTurn[] {
	if (budget.targetPairs === 0 || budget.maxCharacters === 0 || budget.maxEstimatedTokens === 0) return [];

	const newestFirst = [...turns].reverse();
	const recent = newestFirst.slice(0, budget.recentPairs);
	const recentIds = new Set(recent.map((turn) => turn.index));
	const older = newestFirst.filter((turn) => !recentIds.has(turn.index));
	const semantic = older
		.map((turn) => ({ turn, priority: semanticPriority(turn, current, activeSelection) }))
		.filter((entry) => entry.priority > 0)
		.sort((left, right) => right.priority - left.priority || right.turn.index - left.turn.index);

	// A correction like "not that version" can depend on the preceding
	// candidate/selection.  It receives lower priority than the user-authored
	// correction itself, and is retained only if a slot and budget remain.
	const dependencies = semantic
		.map(({ turn, priority }) => ({ turn: referentBefore(turn, turns), priority: priority - 1 }))
		.filter((entry): entry is { turn: CompleteTurn; priority: number } => entry.turn !== undefined)
		.sort((left, right) => right.priority - left.priority || right.turn.index - left.turn.index);

	const ordered = uniqueTurns([
		...recent,
		...semantic.map((entry) => entry.turn),
		...dependencies.map((entry) => entry.turn),
		...older,
	]);

	const selected: CompleteTurn[] = [];
	let characters = 0;
	let tokens = 0;
	for (const turn of ordered) {
		if (selected.length >= budget.targetPairs) break;
		const cost = requestMessagesCost(renderTurn(turn, activeSelection, superseded));
		const exceedsBudget = characters + cost.characters > budget.maxCharacters ||
			tokens + cost.tokens > budget.maxEstimatedTokens;
		if (exceedsBudget) {
			// A giant newest candidate is still one indivisible semantic result.
			// Keep that one deliberate soft overflow instead of pretending an
			// older, cheaper turn is the latest state of the conversation.
			if (selected.length > 0 || turn !== newestFirst[0]) continue;
		}
		selected.push(turn);
		characters += cost.characters;
		tokens += cost.tokens;
	}

	return selected.sort((left, right) => left.index - right.index);
}

function semanticPriority(
	turn: CompleteTurn,
	current: string,
	activeSelection: SelectionAttachment | undefined,
): number {
	let priority = 0;
	// Only the user's own words can elevate a correction or constraint.
	if (isUserCorrectionOrConstraint(turn.user.text)) priority = Math.max(priority, 40);

	const selections = turn.messages.flatMap((message) => message.selection ? [message.selection] : []);
	if (activeSelection && selections.some((selection) => sameSelectionSnapshot(selection, activeSelection))) {
		priority = Math.max(priority, 35);
	}
	if (referencesCandidate(current) && turn.messages.some((message) => message.candidate !== undefined)) {
		priority = Math.max(priority, 30);
	}
	if (referencesSelection(current) && selections.length > 0) priority = Math.max(priority, 25);
	return priority;
}

function referentBefore(turn: CompleteTurn, turns: readonly CompleteTurn[]): CompleteTurn | undefined {
	if ((!referencesPrior(turn.user.text) && !isUserCorrectionOrConstraint(turn.user.text)) || turn.index === 0) {
		return undefined;
	}
	const previous = turns[turn.index - 1];
	return previous.messages.some((message) => message.selection || message.candidate) ? previous : undefined;
}

function renderTurns(
	turns: readonly CompleteTurn[],
	activeSelection?: SelectionAttachment,
	superseded?: SupersededSelectionCheck,
): RequestMessage[] {
	const flattened = turns.flatMap((turn) => turn.messages);
	return flattened.map((message, index) => ({
		role: message.role,
		content: conversationMessageWithSelectionReferent(
			message,
			activeSelection,
			flattened[index - 1]?.selection,
			referentOptions(message, superseded),
		),
	}));
}

function renderTurn(
	turn: CompleteTurn,
	activeSelection?: SelectionAttachment,
	superseded?: SupersededSelectionCheck,
): RequestMessage[] {
	return turn.messages.map((message, index) => ({
		role: message.role,
		content: conversationMessageWithSelectionReferent(
			message,
			activeSelection,
			turn.messages[index - 1]?.selection,
			referentOptions(message, superseded),
		),
	}));
}

/**
 * Ask the predicate once per rendered message. `renderTurn` costs a turn and
 * `renderTurns` renders it, so both must reach the same answer or the reported
 * character count would not describe what was sent.
 */
function referentOptions(
	message: ConversationMessage,
	superseded: SupersededSelectionCheck | undefined,
): SelectionReferentOptions | undefined {
	if (!superseded || !message.selection) return undefined;
	return superseded(message.selection) ? { superseded: true } : undefined;
}

function requestMessagesCost(messages: readonly RequestMessage[]): TurnCost {
	return messages.reduce<TurnCost>((total, message) => ({
		characters: total.characters + Array.from(message.content).length,
		tokens: total.tokens + estimateConversationTokens(message.content) + REQUEST_MESSAGE_TOKEN_OVERHEAD,
	}), { characters: 0, tokens: 0 });
}

function resolveBudget(options: ConversationHistoryOptions | undefined): ResolvedBudget {
	const targetPairs = nonNegativeInteger(options?.targetPairs, DEFAULT_HISTORY_TARGET_PAIRS);
	const defaultRecent = Math.min(targetPairs, DEFAULT_RECENT_PAIRS);
	const recentPairs = Math.min(targetPairs, nonNegativeInteger(options?.recentPairs, defaultRecent));
	return {
		targetPairs,
		recentPairs,
		maxCharacters: nonNegativeInteger(options?.maxCharacters, DEFAULT_HISTORY_MAX_CHARACTERS),
		maxEstimatedTokens: nonNegativeInteger(
			options?.maxEstimatedTokens,
			DEFAULT_HISTORY_MAX_ESTIMATED_TOKENS,
		),
	};
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

function uniqueTurns(turns: readonly CompleteTurn[]): CompleteTurn[] {
	const seen = new Set<number>();
	return turns.filter((turn) => {
		if (seen.has(turn.index)) return false;
		seen.add(turn.index);
		return true;
	});
}

function isUserCorrectionOrConstraint(text: string): boolean {
	return /(?:不对|不是(?:这个|这样|说)?|纠正|改成|更正|别再?|不要|不可|不能|务必|必须|只(?:能|保留|写|用|要)|仅(?:限|保留|用)|保持|遵循|记住|注意[:：]?|约束|要求)|\b(?:actually|correction|instead|must|need to|do not|don't|never|only|keep|constraint|requirement)\b/iu.test(text);
}

function referencesPrior(text: string): boolean {
	return /(?:刚才|上(?:一|个)\s*(?:版|条|段|次|个)?|之前|前面|那个|这(?:个|版|段|句)|候选|改写)|\b(?:previous|earlier|above|that|this|candidate|version)\b/iu.test(text);
}

function referencesCandidate(text: string): boolean {
	return /(?:候选|版本|改写|润色|续写|刚才那(?:个|版))|\b(?:candidate|draft|rewrite|version|previous answer)\b/iu.test(text);
}

function referencesSelection(text: string): boolean {
	return /(?:选区|所选|这段|那段|这句|那句|刚才.*(?:段|句))|\b(?:selection|selected (?:text|passage)|this passage|that passage)\b/iu.test(text);
}

function sameSelectionSnapshot(left: SelectionAttachment, right: SelectionAttachment): boolean {
	return left.filePath === right.filePath &&
		left.text === right.text &&
		left.from.line === right.from.line &&
		left.from.ch === right.from.ch &&
		left.to.line === right.to.line &&
		left.to.ch === right.to.ch;
}

/** A turn whose selection is the same passage as `active`: the same file, and an overlapping range or text. */
function aboutSelection(turn: CompleteTurn, active: SelectionAttachment): boolean {
	return turn.messages.some((message) => {
		const selection = message.selection;
		if (!selection || selection.filePath !== active.filePath) return false;
		if (selection.text && active.text && (selection.text.includes(active.text) || active.text.includes(selection.text))) return true;
		return !(before(selection.to, active.from) || before(active.to, selection.from));
	});
}

function before(left: { line: number; ch: number }, right: { line: number; ch: number }): boolean {
	return left.line < right.line || (left.line === right.line && left.ch < right.ch);
}
