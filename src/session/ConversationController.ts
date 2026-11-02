/**
 * Runs one turn against the backend and folds the result into a session.
 *
 * This is where the product's central safety property is structural rather than
 * enforced by a check: **`runChat` has no access to an editor.** A chat turn
 * cannot modify the manuscript because nothing in its code path can write to
 * one, no matter what the model returns or what the writer typed. Editing only
 * happens through `runRewrite`, whose result is a *candidate* that the caller
 * must then put through the stale guard and apply explicitly.
 */

import { t } from "../i18n";
import type {
	AIBackend,
	RequestMessage,
	RewritePayload,
	SkillPayload,
	TurnPayload,
	UsageInfo,
} from "../backend/AIBackend";
import type { AssembledContext } from "../context/types";
import { toDocumentPayloads } from "../context/serialize";
import { evidenceDocumentPayloads, type EvidenceItem } from "../context/evidence";
import type {
	ConversationMessage,
	ConversationSession,
	GenerationMetadata,
	SelectionAttachment,
	SessionPreferences,
	Skill,
} from "../types";
import { createMessageId, createRequestId, nowIso } from "../util/id";
import { parseRewriteText, splitRewriteReply } from "../editing/rewriteParser";
import { conversationMessages } from "./conversationHistory";
import { composeEffectiveInstructions } from "../instructions";
import { buildInstructionPayload } from "./TurnPlan";
import { replaceExecutionIdentity, restoreSelectedExecutionIdentity, selectedExecutionIdentity } from "../util/executionIdentity";

/**
 * Facts about a turn that are true but not worth keeping forever.
 *
 * The Runtime reports these and they were being dropped between the parser and
 * the UI. They are deliberately *not* added to `GenerationMetadata`, which is
 * persisted into the conversation file: a token count is worth showing while the
 * conversation is open and not worth carrying in every vault file for the rest
 * of the manuscript's life.
 */
export interface TurnFacts {
	cachedInputTokens?: number;
	reasoningTokens?: number;
	/** What the Runtime measured, as opposed to what this client timed. */
	runtimeMs?: number;
	attempts?: number;
	/** `token` or `message` — why a turn may never visibly stream. */
	granularity?: string;
}

/**
 * One thing the Runtime reported the model doing.
 *
 * `kind` decides where it goes. `reasoning` and `narration` are the model's own
 * account of what it is working on and are shown live, above the answer, in
 * small grey text. `command` is a tool invocation and belongs in the collapsed
 * detail. Anything else is a category this UI has nothing useful to do with, so
 * it is kept but not displayed — a Runtime that adds a kind must not break an
 * older plugin, and silently dropping data is how you end up unable to explain
 * what happened.
 */
export interface ActivityEntry {
	kind: string;
	text: string;
}

/** Kinds whose text is the model telling you what it is doing. */
export const THINKING_KINDS = ["reasoning", "narration"];

/**
 * Kinds worth keeping in the detail panel afterwards.
 *
 * Not the thinking. `reasoning` and `narration` are the model working something
 * out, and they read that way — half-formed English fragments in the middle of
 * a Chinese manuscript tool. They are useful *while you wait*, as a sign that
 * something is happening, and they are noise once the answer is there. What is
 * worth keeping is what the model actually did: commands it ran.
 */
export const DETAIL_KINDS = ["command"];

/** Live state of a turn in progress, pushed to the view as it streams. */
export interface StreamingState {
	requestId: string;
	text: string;
	/** What the Runtime reported. Never anything this client invented. */
	activities: ActivityEntry[];
	metadata: GenerationMetadata;
	facts: TurnFacts;
}

/** The most recent line worth showing while a turn is running, if any. */
export function latestThinking(activities: ActivityEntry[]): string | undefined {
	for (let index = activities.length - 1; index >= 0; index -= 1) {
		const entry = activities[index];
		if (THINKING_KINDS.includes(entry.kind) && entry.text.trim().length > 0) return entry.text;
	}
	return undefined;
}

export type ChatTurnResult =
	| { ok: true; message: ConversationMessage; facts: TurnFacts }
	| { ok: false; error: string; partialText: string; metadata: GenerationMetadata; cancelled?: boolean };

export type RewriteTurnResult =
	| {
		ok: true;
		replacement: string;
		/** What the assistant said outside the passage fence, if anything. */
		prose: string;
		metadata: GenerationMetadata;
		facts: TurnFacts;
	}
	| { ok: false; error: string; metadata: GenerationMetadata; cancelled?: boolean };


const CONTROLLER_BUSY_CODE = "controller_busy";

export interface ChatTurnOptions {
	session: ConversationSession;
	/** Effective Composer choice from vault-scoped device state. */
	preferences: SessionPreferences;
	/**
	 * Vault context assembled locally by WritingBuddy.
	 *
	 * Serialised into the outgoing message, because the client owns the vault:
	 * the Runtime is not asked to read anything.
	 */
	context?: AssembledContext;
	/**
	 * The citeable pieces of manuscript this turn is being given.
	 *
	 * Passed in rather than derived here so the ids on the wire and the ids the
	 * UI resolves citations against are the *same objects*. Two derivations of
	 * the same list can drift; this cannot.
	 */
	evidence?: EvidenceItem[];
	/**
	 * The writer's turn — shown in the transcript and sent as the last message.
	 *
	 * A skill's own guidance is not put here: it travels in
	 * `context.skill.instructions`, which the Runtime applies to the model.
	 */
	question: string;
	/**
	 * Frozen transcript selected by the caller, including the current ask.
	 * When omitted, the compatibility path selects it from `session`.
	 */
	messages?: readonly RequestMessage[];
	/** Message already persisted for the visible transcript, excluded by id. */
	currentMessageId?: string;
	selection?: SelectionAttachment;
	skill?: Skill;
	/** Already-composed wire instructions. Authoritative when present. */
	instructionPayload?: SkillPayload;
	currentFile?: string;
	onUpdate?: (state: StreamingState) => void;
}

export interface RewriteTurnOptions {
	session: ConversationSession;
	/** Effective Composer choice from vault-scoped device state. */
	preferences: SessionPreferences;
	context?: AssembledContext;
	/** First-class prior-selection/context evidence supplied by the caller. */
	evidence?: EvidenceItem[];
	instruction: string;
	/** Frozen transcript selected by the caller, including the current ask. */
	messages?: readonly RequestMessage[];
	/** Message already persisted for the visible transcript, excluded by id. */
	currentMessageId?: string;
	selection: SelectionAttachment;
	/** The selection minus its outer whitespace — see `applyEdit.ts`. */
	core: string;
	skill?: Skill;
	/** Already-composed wire instructions. Authoritative when present. */
	instructionPayload?: SkillPayload;
	onUpdate?: (state: StreamingState) => void;
}

export class ConversationController {
	private activeRequestId: string | null = null;
	/** Requests the writer explicitly stopped; their partial output is unusable. */
	private readonly cancelledRequestIds = new Set<string>();

	constructor(private backend: AIBackend) {}

	setBackend(backend: AIBackend): void {
		this.backend = backend;
	}

	get isRunning(): boolean {
		return this.activeRequestId !== null;
	}

	async cancel(): Promise<void> {
		const requestId = this.activeRequestId;
		if (!requestId) return;
		// Record intent before awaiting the adapter. Its abort can end the stream
		// synchronously, and consume must still distinguish that EOF from an empty
		// backend response.
		this.cancelledRequestIds.add(requestId);
		await this.backend.cancel(requestId);
	}

	/**
	 * Ask a question. The selection travels as context; the answer is text.
	 * Nothing here can touch the document.
	 */
	async runChat(options: ChatTurnOptions): Promise<ChatTurnResult> {
		if (this.isRunning) {
			return {
				ok: false,
				error: t("session.busy"),
				partialText: "",
				metadata: { errorCode: CONTROLLER_BUSY_CODE },
			};
		}
		const requestId = createRequestId();
		const skillPayload = options.instructionPayload ?? buildSkillPayload(options.skill, Boolean(options.selection));

		// Vault evidence travels as structured documents. Every backend receives
		// this same provider-neutral list and translates it to its own transport.
		// Chat has no `context.selection` in the frozen V2 schema, so the passage
		// travels as a document.
		const documents = options.evidence
			? evidenceDocumentPayloads(options.evidence)
			: options.context
				? toDocumentPayloads(options.context, {
					includeSelection: true,
				})
				: [];

		const request: TurnPayload = {
			requestId,
			connectionId: options.preferences.connectionId,
			conversationId: options.session.id,
			provider: options.preferences.provider,
			model: options.preferences.model ?? null,
			effort: options.preferences.effort ?? null,
			messages: frozenMessages(options.messages) ?? conversationMessages(options.session, options.question, options.currentMessageId, options.selection),
			...(options.currentFile ? { currentFile: options.currentFile } : {}),
			...(options.selection
				? {
						selection: {
							filePath: options.selection.filePath,
							text: options.selection.text,
							from: options.selection.from,
							to: options.selection.to,
						},
					}
				: {}),
			...(skillPayload ? { skill: { ...skillPayload } } : {}),
			...(documents.length > 0 ? { documents } : {}),
		};

		const outcome = await this.consume(
			requestId,
			this.backend.chat(request),
			options.onUpdate,
			connectionMetadata(options.preferences, options.context),
		);
		if (outcome.cancelled) {
			restoreSelectedExecutionIdentity(outcome.metadata, options.preferences);
			return { ok: false, error: t("session.cancelled"), partialText: "", metadata: outcome.metadata, cancelled: true };
		}

		// A final structured result is authoritative when it contains prose. Some
		// backends also stream deltas and then send an empty result envelope; that
		// empty envelope must not erase text the writer already received.
		const text = nonBlank(outcome.resultText) ?? nonBlank(outcome.text);
		if (text === undefined) {
			restoreSelectedExecutionIdentity(outcome.metadata, options.preferences);
			return {
				ok: false,
				error: outcome.error ?? t("session.emptyResponse"),
				partialText: "",
				metadata: outcome.metadata,
			};
		}

		const message: ConversationMessage = {
			id: createMessageId(),
			role: "assistant",
			text,
			createdAt: nowIso(),
		};
		if (Object.keys(outcome.metadata).length > 0) message.metadata = outcome.metadata;
		// A wire-only policy payload is not a user-selected task Skill and must
		// never become persisted conversation identity.
		if (options.skill) message.skillId = options.skill.id;
		if (outcome.error) message.error = outcome.error;

		return { ok: true, message, facts: outcome.facts };
	}

	/**
	 * Generate a replacement candidate.
	 *
	 * Returns text and nothing else. Applying it is the caller's decision and
	 * runs through the stale guard first.
	 */
	async runRewrite(options: RewriteTurnOptions): Promise<RewriteTurnResult> {
		if (this.isRunning) {
			return {
				ok: false,
				error: t("session.busy"),
				metadata: { errorCode: CONTROLLER_BUSY_CODE },
			};
		}
		const requestId = createRequestId();
		const skillPayload = options.instructionPayload ?? buildSkillPayload(options.skill, true);

		// A rewrite carries the passage as the required top-level `selection`, so
		// it is not repeated among the documents.
		const documents = options.evidence
			? evidenceDocumentPayloads(options.evidence.filter((item) => !isActiveSelectionEvidence(item, options.selection)))
			: options.context
				? toDocumentPayloads(options.context, { includeSelection: false })
				: [];

		const request: RewritePayload = {
			requestId,
			connectionId: options.preferences.connectionId,
			conversationId: options.session.id,
			provider: options.preferences.provider,
			model: options.preferences.model ?? null,
			effort: options.preferences.effort ?? null,
			instruction: options.instruction,
			// Conversation continuity applies to rewrite too. The captured
			// selection remains the only editable target.
			messages: frozenMessages(options.messages) ?? conversationMessages(options.session, composeRewritePrompt(options), options.currentMessageId, options.selection),
			selection: {
				filePath: options.selection.filePath,
				// Only the editable core is sent; the outer whitespace stays local.
				text: options.core,
				from: options.selection.from,
				to: options.selection.to,
			},
			currentFile: options.selection.filePath,
			...(skillPayload ? { skill: { ...skillPayload } } : {}),
			...(documents.length > 0 ? { documents } : {}),
		};

		const outcome = await this.consume(
			requestId,
			this.backend.rewrite(request),
			options.onUpdate,
			connectionMetadata(options.preferences, options.context),
		);
		if (outcome.cancelled) {
			restoreSelectedExecutionIdentity(outcome.metadata, options.preferences);
			return { ok: false, error: t("session.cancelled"), metadata: outcome.metadata, cancelled: true };
		}

		// The split runs on the structured replacement too. A backend that returns
		// `result.replacement` is passing the model's text through, so a fence the
		// model wrote is inside that string, not around it.
		const replacement = nonBlank(outcome.replacement);
		if (replacement !== undefined) {
			const split = splitRewriteReply(replacement);
			const passage = nonBlank(split.replacement) ?? replacement;
			return { ok: true, replacement: passage, prose: split.prose, metadata: unverifiedWhenRaw(replacement, outcome.metadata), facts: outcome.facts };
		}

		// A non-empty chat-shaped structured result is still stronger than deltas.
		// Otherwise parse complete streamed text. An error makes unstructured deltas
		// unsafe to apply, but does not invalidate a complete structured result.
		const structuredText = nonBlank(outcome.resultText);
		if (outcome.error && structuredText === undefined) {
			restoreSelectedExecutionIdentity(outcome.metadata, options.preferences);
			return { ok: false, error: outcome.error, metadata: outcome.metadata };
		}
		const raw = structuredText ?? outcome.text;
		const parsed = parseRewriteText(raw);
		if (parsed.ok && parsed.replacement.trim().length > 0) {
			const split = splitRewriteReply(raw);
			const metadata = unverifiedWhenRaw(raw, outcome.metadata);
			return {
				ok: true,
				replacement: nonBlank(split.replacement) ?? parsed.replacement,
				prose: split.prose,
				metadata,
				facts: outcome.facts,
			};
		}
		restoreSelectedExecutionIdentity(outcome.metadata, options.preferences);
		return {
			ok: false,
			error: parsed.ok ? t("edit.noReplacement") : parsed.reason,
			metadata: outcome.metadata,
		};
	}

	// -----------------------------------------------------------------------

	private async consume(
		requestId: string,
		stream: AsyncIterable<import("../backend/AIBackend").AIEvent>,
		onUpdate?: (state: StreamingState) => void,
		initialMetadata: GenerationMetadata = {},
	): Promise<{
		text: string;
		resultText?: string;
		replacement?: string;
		activities: ActivityEntry[];
		metadata: GenerationMetadata;
		facts: TurnFacts;
		error?: string;
		cancelled: boolean;
	}> {
		this.activeRequestId = requestId;

		let text = "";
		let resultText: string | undefined;
		let replacement: string | undefined;
		let error: string | undefined;
		const activities: ActivityEntry[] = [];
		const metadata: GenerationMetadata = { ...initialMetadata };
		const facts: TurnFacts = {};

		const publish = (): void =>
			onUpdate?.({
				requestId,
				text,
				activities: [...activities],
				metadata: { ...metadata },
				facts: { ...facts },
			});

		try {
			for await (const event of stream) {
				switch (event.type) {
					case "provider.selected":
						metadata.provider = event.provider;
						if (event.model) metadata.model = event.model;
						if (event.effort) metadata.effort = event.effort;
						if (event.granularity) facts.granularity = event.granularity;
						publish();
						break;

					case "content.delta":
						text += event.text;
						publish();
						break;

					case "activity": {
						// `detail` is the readable text and may be missing; `kind`
						// may be one this version has never heard of. Both are
						// tolerated rather than validated.
						const text = event.detail ?? event.label;
						if (text.trim().length > 0) {
							activities.push({ kind: event.kind ?? "unknown", text });
							// Keep the list short: it is a running commentary, not
							// a log to be archived.
							if (activities.length > 40) activities.shift();
							publish();
						}
						break;
					}

					case "fallback":
						metadata.fallback = event.reason ? t("backend.withSuffix", { message: event.to, suffix: event.reason }) : event.to;
						publish();
						break;

					case "usage":
						// Only the three fields the persisted shape declares.
						// `event.usage` is wider, and assigning it whole quietly
						// wrote the cached and reasoning counts into every
						// conversation file — a schema change by accident, which
						// is exactly the kind that is never noticed until a
						// reader trips over it.
						metadata.usage = persistableUsage(event.usage);
						if (event.usage.cachedInputTokens !== undefined) {
							facts.cachedInputTokens = event.usage.cachedInputTokens;
						}
						if (event.usage.reasoningTokens !== undefined) {
							facts.reasoningTokens = event.usage.reasoningTokens;
						}
						break;

					case "result":
						if ("replacement" in event.result) {
							if (nonBlank(event.result.replacement) !== undefined) {
								replacement = event.result.replacement;
							}
						} else {
							if (nonBlank(event.result.text) !== undefined) {
								resultText = event.result.text;
							}
						}
						// The Runtime reports provider details on the result rather
						// than only on provider.selected, and it is authoritative:
						// it names what actually ran, including after a fallback.
						if (event.metadata) {
							replaceExecutionIdentity(metadata, event.metadata);
							if (event.metadata.rewriteParse) metadata.rewriteParse = event.metadata.rewriteParse;
							if (event.metadata.usage) {
								metadata.usage = persistableUsage(event.metadata.usage);
								if (event.metadata.usage.cachedInputTokens !== undefined) {
									facts.cachedInputTokens = event.metadata.usage.cachedInputTokens;
								}
								if (event.metadata.usage.reasoningTokens !== undefined) {
									facts.reasoningTokens = event.metadata.usage.reasoningTokens;
								}
							}
							if (event.metadata.durationMs !== undefined) facts.runtimeMs = event.metadata.durationMs;
							if (event.metadata.attempts !== undefined) facts.attempts = event.metadata.attempts;
							if (event.metadata.fellBack && !metadata.fallback) {
								metadata.fallback = event.metadata.provider ?? t("session.fellBack");
							}
						}
						break;

					case "error":
						if (event.code) metadata.errorCode = event.code;
						error = describeError(event.code, event.message);
						break;

					case "request.started":
					case "done":
						break;
				}
			}
		} catch (caught) {
			error = describeError(undefined, caught instanceof Error ? caught.message : String(caught));
		} finally {
			if (this.activeRequestId === requestId) this.activeRequestId = null;
		}
		const cancelled = this.cancelledRequestIds.delete(requestId);
		if (cancelled) metadata.errorCode = "cancelled";

		const outcome: {
			text: string;
			resultText?: string;
			replacement?: string;
			activities: ActivityEntry[];
			metadata: GenerationMetadata;
			facts: TurnFacts;
			error?: string;
			cancelled: boolean;
		} = { text, activities, metadata, facts, cancelled };
		if (resultText !== undefined) outcome.resultText = resultText;
		if (replacement !== undefined) outcome.replacement = replacement;
		if (error !== undefined) outcome.error = error;
		return outcome;
	}
}

/** Return the original value only when it contains visible output. */
function nonBlank(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** Copy a caller-owned/frozen transcript before handing it to an adapter. */
function frozenMessages(messages: readonly RequestMessage[] | undefined): RequestMessage[] | undefined {
	return messages?.map((message) => ({ ...message }));
}

function isActiveSelectionEvidence(item: EvidenceItem, selection: SelectionAttachment): boolean {
	return item.kind === "selection" &&
		item.path === selection.filePath &&
		item.excerpt === selection.text &&
		item.range?.from.line === selection.from.line &&
		item.range.from.ch === selection.from.ch &&
		item.range.to.line === selection.to.line &&
		item.range.to.ch === selection.to.ch;
}

function connectionMetadata(preferences: SessionPreferences, context?: AssembledContext): GenerationMetadata {
	return {
		...(preferences.connectionId ? { connectionId: preferences.connectionId } : {}),
		...(preferences.connectionName ? { connectionName: preferences.connectionName } : {}),
		...(preferences.connectionType ? { connectionType: preferences.connectionType } : {}),
		...(preferences.connectionDetail ? { connectionDetail: preferences.connectionDetail } : {}),
		...selectedExecutionIdentity(preferences),
		...(context?.report ? { contextReport: context.report } : {}),
	};
}

/**
 * Build `context.skill`, or nothing.
 *
 * The Runtime requires `instructions` to be a **non-empty** string whenever
 * `context.skill` is present, so a skill with a blank body must be omitted
 * entirely rather than sent with an empty field — that is a 400, not a no-op.
 */
export function buildSkillPayload(skill: Skill | undefined, hasSelection = false): SkillPayload {
	return buildInstructionPayload(
		composeEffectiveInstructions({ ...(skill ? { skill } : {}), hasSelection }),
		skill,
	);
}

/**
 * The user message for a rewrite.
 *
 * Just the writer's ask — their typed instruction, or the action's name when
 * they pressed a preset. The skill's own guidance is **not** repeated here: it
 * travels in `context.skill.instructions`, which the Runtime applies to the
 * model, and duplicating it would send the same paragraph twice.
 */
export function composeRewritePrompt(options: {
	instruction: string;
	skill?: { name: string };
}): string {
	const typed = options.instruction.trim();
	if (typed.length > 0) return typed;
	return options.skill?.name ?? t("session.defaultRewriteName");
}

/**
 * Say what a failure means for the writer, not just what the server called it.
 *
 * Quota exhaustion is the one that matters: the Runtime deliberately does *not*
 * fail over to the other provider, because a chapter half-written by Codex and
 * half by Claude reads like two people wrote it. So the writer has to choose,
 * and the message has to say so — "provider_quota_exceeded" does not.
 */
export function describeError(code: string | undefined, message: string): string {
	if (/backend returned (?:no text|only whitespace)/i.test(message)) {
		return t("session.emptyResponse");
	}
	if (code === "unauthorized") return t("connModal.tokenInvalid");
	if (code === "rate_limited") return message.includes(t("backend.rateLimited")) ? message : t("session.retryLater");
	if (code === "provider_quota_exceeded") {
		return t("session.quotaExhausted", { message });
	}
	return message;
}

/**
 * The part of a usage report that belongs in the vault.
 *
 * Cached and reasoning counts are real and worth showing while a conversation
 * is open, and they are carried in `TurnFacts` for that. They are not worth
 * writing into every conversation file for the life of the manuscript, and
 * putting them there by letting a wider object through would be a change to a
 * persisted schema that nobody decided to make.
 */
export function persistableUsage(usage: UsageInfo): GenerationMetadata["usage"] {
	const kept: NonNullable<GenerationMetadata["usage"]> = {};
	if (usage.inputTokens !== undefined) kept.inputTokens = usage.inputTokens;
	if (usage.outputTokens !== undefined) kept.outputTokens = usage.outputTokens;
	if (usage.totalTokens !== undefined) kept.totalTokens = usage.totalTokens;
	return kept;
}

/**
 * No fence and no JSON: the whole reply became the candidate, and it may be
 * the model's commentary ("好的，以下是……", "无需修改") rather than a passage.
 * Marked so the card opens on the diff and Apply asks first.
 */
function unverifiedWhenRaw(reply: string, metadata: GenerationMetadata): GenerationMetadata {
	const parsed = parseRewriteText(reply);
	return parsed.ok && parsed.source === "raw" ? { ...metadata, rewriteParse: "fallback" } : metadata;
}
