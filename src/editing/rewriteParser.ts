/**
 * Extracting a replacement candidate from what the backend returned.
 *
 * The contract is that a rewrite adapter ends with
 * `{"type":"result","result":{"replacement":"…"}}`, and when that happens this
 * module has nothing to do. The rest of the file exists because models are
 * imperfect: a replacement can arrive wrapped in a code fence, prefixed with a
 * sentence of commentary, or as a bare JSON object in the streamed text.
 *
 * The i18n import below serves only the two user-facing failure reasons; the
 * fence labels further down are model-protocol vocabulary and stay literal.
 *
 * The one rule that must not bend: **the replacement string itself is never
 * trimmed.** Leading and trailing whitespace inside the candidate is content —
 * it may be an indented line or a deliberate blank. Only the envelope around it
 * (the JSON wrapper, the code fence, the stray commentary) may be stripped.
 */

import { t } from "../i18n";

export type RewriteParse =
	| { ok: true; replacement: string; source: "result" | "json" | "fenced" | "raw" }
	| { ok: false; reason: string };

/** Parse a candidate out of raw streamed text. */
export function parseRewriteText(raw: string): RewriteParse {
	if (raw.length === 0) {
		return { ok: false, reason: t("edit.noReplacement") };
	}

	const fromJson = extractJsonReplacement(raw);
	if (fromJson !== null) {
		return { ok: true, replacement: fromJson, source: "json" };
	}

	const fenced = extractFencedBlock(raw);
	if (fenced !== null) {
		// A fenced block may itself contain the JSON envelope.
		const nested = extractJsonReplacement(fenced);
		if (nested !== null) {
			return { ok: true, replacement: nested, source: "json" };
		}
		return { ok: true, replacement: fenced, source: "fenced" };
	}

	// Nothing structured: treat the whole answer as the candidate. Only the
	// outer envelope whitespace introduced by the transport is removed.
	const withoutEnvelope = raw.replace(/^\s+/, "").replace(/\s+$/, "");
	if (withoutEnvelope.length === 0) {
		return { ok: false, reason: t("edit.noReplacement") };
	}
	return { ok: true, replacement: withoutEnvelope, source: "raw" };
}

/**
 * Find a `{"replacement": "..."}` object anywhere in the text.
 *
 * Scans for balanced braces rather than using a regex, so a replacement that
 * itself contains braces or newlines still parses.
 */
function extractJsonReplacement(text: string): string | null {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		const end = findMatchingBrace(text, start);
		if (end === -1) continue;
		const candidate = text.slice(start, end + 1);
		try {
			const decoded = JSON.parse(candidate) as unknown;
			if (typeof decoded === "object" && decoded !== null) {
				const value = (decoded as Record<string, unknown>).replacement;
				if (typeof value === "string") return value;
			}
		} catch {
			// Not a complete JSON object; keep scanning.
		}
	}
	return null;
}

/** Index of the `}` closing the `{` at `start`, honouring strings and escapes. */
function findMatchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** Contents of the first fenced code block, without the fences. */
function extractFencedBlock(text: string): string | null {
	const match = /```[^\n]*\r?\n([\s\S]*?)```/.exec(text);
	if (!match) return null;
	// Drop only the newline the fence itself contributed.
	return match[1].replace(/\r?\n$/, "");
}

// ---------------------------------------------------------------------------
// Candidates inside a conversational reply
// ---------------------------------------------------------------------------

/**
 * The fence label a writing action asks the model to use.
 *
 * Anything in `CANDIDATE_FENCE_LABELS` is accepted, because a model that
 * answers in Chinese will not always echo an English tag back.
 */
export const CANDIDATE_FENCE_LABEL = "改写后";

export const CANDIDATE_FENCE_LABELS = ["改写后", "改写", "替换", "正文", "续写", "rewrite", "result", "continue", "continuation"];

/**
 * Labels that mark the *original* a following replacement is for.
 *
 * A reply proposing several changes has to say which text each one replaces.
 * Quoting the original exactly is the only way to establish that safely — the
 * quote is then located in the file by unique match, and an ambiguous one
 * produces no diff rather than a diff aimed at a guess.
 */
export const SOURCE_FENCE_LABELS = ["原文", "原句", "改写前", "source", "before", "original"];

export interface ReplyCandidate {
	/** What the assistant said, with the passage block removed. */
	prose: string;
	/** The passage itself, exactly as written inside the fence. */
	replacement: string;
	/** True when the fence carried one of the expected labels. */
	labelled: boolean;
}

export interface Fence {
	label: string;
	body: string;
	/** Offset of the opening fence in the reply. */
	start: number;
	/** Offset just past the closing fence. */
	end: number;
}

/**
 * Split a writing action's reply into the passage and whatever was said around it.
 *
 * Writing actions used to forbid explanation outright, so this had nowhere to
 * put one: `extractFencedBlock` returned the fence body and everything outside
 * it was dropped on the floor. The passage was right and the sentence that
 * would have told the writer *why* was gone.
 *
 * Now the output contract asks for the passage inside a labelled fence and
 * leaves the space outside it available. So a fence, when there is one, is the
 * boundary between what goes into the manuscript and what goes into the answer.
 *
 * **A reply with no fence still becomes the candidate, exactly as before.** It
 * is tempting to read a bare reply as "an answer, not a rewrite" now that prose
 * is allowed — but nothing here can tell an unfenced rewrite from a refusal to
 * rewrite, and guessing wrong either drops a passage the writer wanted or
 * writes commentary into their manuscript. A model that ignores the fence gets
 * the behaviour it has always had, and `parseRewriteText` still reports that as
 * a fallback parse.
 */
export function splitRewriteReply(raw: string): { replacement: string; prose: string } {
	const parsed = parseRewriteText(raw);
	if (!parsed.ok) return { replacement: "", prose: "" };
	if (parsed.source !== "fenced") return { replacement: parsed.replacement, prose: "" };

	const reply = extractCandidateFromReply(raw);
	// `fenced` guarantees a block, so a null here would mean the two disagree.
	if (!reply) return { replacement: parsed.replacement, prose: "" };
	return { replacement: reply.replacement, prose: reply.prose };
}

/**
 * Pull a replacement passage out of an ordinary conversational answer.
 *
 * Writing actions are conversations, not silent tool calls: the assistant
 * replies normally and puts the finished passage in a fenced block, which is
 * what becomes the diff. Returns null when there is no block — then the turn is
 * simply an answer, and nothing offers to touch the manuscript.
 *
 * The passage is never trimmed. Only the fence around it is removed, for the
 * same reason `parseRewriteText` does not trim: interior whitespace is content.
 */
export function extractCandidateFromReply(raw: string): ReplyCandidate | null {
	const fences = allFences(raw);
	if (fences.length === 0) return null;

	const labelled = fences.filter((fence) =>
		CANDIDATE_FENCE_LABELS.includes(fence.label.trim().toLowerCase()),
	);
	// A labelled block is the model doing as asked. Otherwise the last block is
	// the best guess: an answer that shows a passage shows it at the end.
	const chosen = labelled.length > 0 ? labelled[labelled.length - 1] : fences[fences.length - 1];
	if (chosen.body.trim().length === 0) return null;

	const prose = `${raw.slice(0, chosen.start)}\n${raw.slice(chosen.end)}`.replace(/\n{3,}/g, "\n\n").trim();
	return { prose, replacement: chosen.body, labelled: labelled.length > 0 };
}

/** Every fenced block in the text, in order. */
export function allFences(text: string): Fence[] {
	// Two backticks or three, backticks or tildes, and a closing fence that need
	// not match the opening one exactly. Models get this wrong often enough that
	// insisting on the canonical form leaves a perfectly good passage rendered as
	// a literal ``改写后 in the middle of an answer — which is what happened.
	// Both fences stand on a line of their own, as Markdown has them: `~~` and
	// paired backticks are ordinary in Chinese web fiction, and a closing fence
	// read in the middle of a line cut the candidate there and lost the rest of
	// the selection on Apply.
	// The newline before an opening fence is matched rather than looked behind
	// for: lookbehind does not compile on iOS before 16.4.
	const pattern = /(^|\n)[ \t]*(?:`{2,}|~{2,})([^\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*(?:`{2,}|~{2,})[ \t]*(?=\r?\n|$)/g;
	const fences: Fence[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const start = match.index + match[1].length;
		fences.push({
			label: match[2] ?? "",
			body: match[3],
			start,
			end: match.index + match[0].length,
		});
	}
	return fences;
}
