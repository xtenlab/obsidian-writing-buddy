/**
 * The transcript.
 *
 * Assistant prose is the primary content, so it gets the reading size and no
 * container chrome at all. User turns are a compact bubble. Everything about
 * *how* an answer was produced lives behind a `用时 … · 详情` footnote rather
 * than under the prose, where it competed with the writing.
 *
 * Four things here are load-bearing.
 *
 * **Structure is a property of the message, not of "the latest response".** An
 * answer is split into prose, citations and rewrite candidates every time it is
 * rendered, from the message itself — so sending the next message, switching
 * conversations, or restarting Obsidian leaves it looking the same. It used to
 * be built once, into ephemeral state, and collapsed to plain text as soon as
 * anything else happened.
 *
 * **Sources sit inside the answer.** A reference is rendered where the
 * assistant put it, not collected into a bibliography underneath, and a single
 * claim can carry several.
 *
 * **A quoted passage belongs to its own message.** The chip is printed on every
 * turn that carried one; a later message never inherits an earlier attachment.
 *
 * **The action row is fixed.** 分支 is always visible — it is navigation, and
 * navigation that appears only on hover is navigation most people never find —
 * and expanding 详情 renders below the row rather than moving it.
 */

import { t } from "../../i18n";
import { displayTitle } from "../../session/titles";
import type { ConversationMessage, ConversationSession, SelectionAttachment } from "../../types";
import { ICONS, iconSpan } from "../icons";
import { type ActivityDetails, renderActivityDisclosure, replyTimeLabel } from "./activity";

/** Where a rendered reply time keeps the timestamp it was derived from. */
export const REPLY_TIME_ATTRIBUTE = "data-wb-reply-at";
import { renderAttachmentChip } from "./attachmentChip";
import { type ContextCitation, type ProseSegment } from "../citations";
import type { MessageBlock } from "../messageBlocks";
import { renderCandidateCard } from "./candidateCard";
import type { DiffViewMode } from "../diffView";

/** Where a branch was taken, and where this conversation came from. */
export interface BranchContext {
	/** Direct children, keyed by the message index they branched from. */
	childrenByIndex: Map<number, ConversationSession[]>;
	/** The conversation this one was branched from, if any. */
	parent?: { session: ConversationSession; messageIndex: number };
}

/** What a message looks like once it has been read for structure. */
export interface RenderedMessage {
	blocks: MessageBlock[];
	details: ActivityDetails;
}

export interface MessageListOptions {
	session: ConversationSession;
	/** Reads a message into prose, citations and candidates. */
	present: (message: ConversationMessage, index: number) => RenderedMessage;
	expandedActivity: Set<string>;
	branches: BranchContext;
	onToggleActivity: (messageId: string) => void;
	onBranch: (messageIndex: number) => void;
	onOpenSession: (sessionId: string) => void;
	onOpenAttachment: (attachment: SelectionAttachment) => void;
	onOpenCitation: (citation: ContextCitation) => void;
	/** Retry a persisted whole-manuscript failure without duplicating its user turn. */
	onContinueFull: (messageIndex: number) => void;
	canContinueFull: (message: ConversationMessage, messageIndex: number) => boolean;
	/**
	 * A rewrite or continuation turn whose reply carries no candidate: it is
	 * said so under the reply instead of passing for an answer. `retry` is set
	 * only on the latest turn, where the writer's selection is still the one.
	 */
	missingCandidate: (message: ConversationMessage, messageIndex: number, blocks: readonly MessageBlock[]) => { retry: boolean } | null;
	onRetryCandidate: (messageIndex: number) => void;
	busy: boolean;
	/** Candidate actions, addressed by the key the presenter assigned. */
	onSetDiffMode: (key: string, mode: DiffViewMode) => void;
	onApply: (key: string) => void;
	onUndo: (key: string) => void;
	onCopy: (key: string) => void;
	onEdit: (key: string, text: string) => void;
	onEditCommitted: (key: string) => void;
	onRevertEdit: (key: string) => void;
}

export function renderMessages(parent: HTMLElement, options: MessageListOptions): void {
	const { session, branches } = options;

	session.messages.forEach((message, index) => {
		const element = parent.createDiv({ cls: `wb-msg wb-msg-${message.role}` });
		const rendered = options.present(message, index);

		// Printed on every turn that carried a passage. The old de-duplication
		// assumed a later message inherited the same attachment; it no longer
		// does, so each chip now marks a passage that turn was actually about.
		if (message.role === "user" && message.selection) {
			renderAttachmentChip(element.createDiv({ cls: "wb-msg-attachment" }), {
				attachment: message.selection,
				onOpen: options.onOpenAttachment,
			});
		}

		for (const block of rendered.blocks) {
			if (block.kind === "prose") {
				const body = element.createDiv({ cls: "wb-msg-text" });
				renderProse(body, block.segments, options.onOpenCitation);
				continue;
			}
			renderCandidateCard(element, {
				blockKey: block.key,
				candidate: block.candidate,
				onSetMode: (mode) => options.onSetDiffMode(block.key, mode),
				onApply: () => options.onApply(block.key),
				onUndo: () => options.onUndo(block.key),
				onCopy: () => options.onCopy(block.key),
				onEdit: (text) => options.onEdit(block.key, text),
				onEditCommitted: () => options.onEditCommitted(block.key),
				onRevertEdit: () => options.onRevertEdit(block.key),
			});
		}

		if (message.error) {
			element.createDiv({ cls: "wb-msg-error", text: message.error });
		}

		const missing = message.role === "assistant" && !message.error ? options.missingCandidate(message, index, rendered.blocks) : null;
		if (missing) {
			const notice = element.createDiv({ cls: "wb-msg-no-candidate", attr: { role: "note" } });
			notice.createSpan({ text: t("msgList.noCandidate") });
			if (missing.retry) {
				const retry = notice.createEl("button", { cls: "wb-ghost-btn", text: t("msgList.retryCandidate"), attr: { type: "button" } });
				retry.disabled = options.busy;
				retry.addEventListener("click", () => options.onRetryCandidate(index));
			}
		}

		if (message.role === "assistant") {
			renderAssistantFooter(element, message, index, rendered.details, options);
		}

		// Where this conversation came from, and where it split — both at the
		// exact message they belong to.
		if (branches.parent && branches.parent.messageIndex === index) {
			renderParentMarker(parent, branches.parent.session, options.onOpenSession);
		}
		const children = branches.childrenByIndex.get(index);
		if (children && children.length > 0) {
			renderBranchMarker(parent, children, options.onOpenSession);
		}
	});
}

/**
 * Render prose with its source references in place.
 *
 * The text is split rather than rewritten: every character the assistant wrote
 * is still there, and the only change is that some of it is now clickable.
 */
function renderProse(
	parent: HTMLElement,
	segments: ProseSegment[],
	onOpenCitation: (citation: ContextCitation) => void,
): void {
	let previousWasCitation = false;
	for (const segment of segments) {
		if (segment.kind === "text") {
			parent.createSpan({ text: segment.text });
			previousWasCitation = false;
			continue;
		}
		// Two references supporting one claim are two references, not one long
		// one: without a separator `卷01` and `第03章` ran together into a single
		// underlined blur.
		if (previousWasCitation) {
			parent.createSpan({ cls: "wb-source-separator", text: t("msgList.sourceSeparator") });
		}
		previousWasCitation = true;
		const link = parent.createEl("button", {
			cls: "wb-source-inline",
			text: segment.text,
			// One label carries both jobs — the action and the full path — so a
			// single Obsidian tooltip shows it, with no native `title` doubling it.
			attr: {
				type: "button",
				"aria-label": t("msgList.openSourceAria", { path: `${segment.citation.path}${segment.citation.truncated ? t("msgList.truncatedSuffix") : ""}` }),
			},
		});
		link.addEventListener("click", () => onOpenCitation(segment.citation));
	}
}

function renderAssistantFooter(
	parent: HTMLElement,
	message: ConversationMessage,
	index: number,
	details: ActivityDetails,
	options: MessageListOptions,
): void {
	const footer = parent.createDiv({ cls: "wb-msg-footer" });
	// The disclosure body lands here, under the row, so expanding it cannot
	// move the buttons on the row itself.
	const detailsEl = parent.createDiv({ cls: "wb-msg-details" });

	const left = footer.createDiv({ cls: "wb-msg-footer-left" });

	// When the reply was produced, ahead of how long it took: the time is a
	// fact about the thread you are scanning, the disclosure is a control you
	// press. Reading order puts the fact first. The timestamp is carried on the
	// element so a refresh can rewrite the text without a re-render, and
	// without any path back into session state.
	const when = replyTimeLabel(message.createdAt, Date.now());
	if (when) {
		left.createSpan({
			cls: "wb-msg-time", text: when,
			attr: { [REPLY_TIME_ATTRIBUTE]: message.createdAt },
		});
	}

	renderActivityDisclosure(
		left,
		details,
		options.expandedActivity.has(message.id),
		() => options.onToggleActivity(message.id),
		detailsEl,
		options.onOpenCitation,
	);

	const right = footer.createDiv({ cls: "wb-msg-footer-right" });
	if (options.canContinueFull(message, index)) {
		const resume = right.createEl("button", {
			cls: "wb-full-resume-btn",
			text: t("msgList.continue"),
			attr: {
				type: "button",
				"aria-label": t("msgList.continueAria"),
			},
		});
		resume.disabled = options.busy;
		resume.addEventListener("click", () => options.onContinueFull(index));
	}
	const branch = right.createEl("button", {
		cls: "wb-ghost-btn",
		attr: { type: "button", "aria-label": t("msgList.branchAria") },
	});
	iconSpan(branch, ICONS.branch);
	branch.createSpan({ text: t("msgList.branch") });
	branch.addEventListener("click", () => options.onBranch(index));
}

/**
 * Where this conversation split.
 *
 * A rule across the thread with the count in the middle, and the direct children
 * named underneath so each can be opened without going through history.
 */
function renderBranchMarker(
	parent: HTMLElement,
	branches: ConversationSession[],
	onOpenSession: (sessionId: string) => void,
): void {
	const marker = parent.createDiv({ cls: "wb-branch-marker" });
	renderRule(marker, t("msgList.branchesHere", { count: branches.length }));

	const list = marker.createDiv({ cls: "wb-branch-list" });
	for (const branch of branches) {
		const title = displayTitle(branch.title);
		link(list, ICONS.branch, title, t("msgList.openBranch", { title }), () => onOpenSession(branch.id));
	}
}

/**
 * Where this conversation came from.
 *
 * Placed at the message it was branched from — the last one carried over from
 * the parent — rather than as a permanent button pinned above the transcript.
 * The relationship is a property of that point in the conversation, and a piece
 * of global chrome cannot say which point.
 */
function renderParentMarker(
	parent: HTMLElement,
	parentSession: ConversationSession,
	onOpenSession: (sessionId: string) => void,
): void {
	const marker = parent.createDiv({ cls: "wb-branch-marker is-parent" });
	renderRule(marker, t("msgList.branchedFromHere"));

	const list = marker.createDiv({ cls: "wb-branch-list" });
	link(
		list,
		ICONS.parent,
		t("msgList.parentSession", { title: displayTitle(parentSession.title) }),
		t("msgList.backToParent", { title: displayTitle(parentSession.title) }),
		() => onOpenSession(parentSession.id),
	);
}

function renderRule(parent: HTMLElement, text: string): void {
	const rule = parent.createDiv({ cls: "wb-branch-rule" });
	rule.createSpan({ cls: "wb-branch-rule-line", attr: { "aria-hidden": "true" } });
	rule.createSpan({ cls: "wb-branch-rule-text", text });
	rule.createSpan({ cls: "wb-branch-rule-line", attr: { "aria-hidden": "true" } });
}

function link(
	parent: HTMLElement,
	icon: string,
	text: string,
	label: string,
	onClick: () => void,
): void {
	const button = parent.createEl("button", {
		cls: "wb-branch-link",
		attr: { type: "button", "aria-label": label },
	});
	iconSpan(button, icon);
	button.createSpan({ text });
	button.addEventListener("click", onClick);
}

/** Identity of an attached passage, for comparing two attachments. */
export function attachmentKey(attachment: SelectionAttachment): string {
	return `${attachment.filePath}:${attachment.from.line}:${attachment.from.ch}:${attachment.to.line}:${attachment.to.ch}:${attachment.charCount}`;
}
