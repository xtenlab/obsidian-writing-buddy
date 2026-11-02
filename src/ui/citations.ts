/**
 * Turning an answer's evidence markers into references beside the claims.
 *
 * The model is given every piece of manuscript with a short id and asked to put
 * that id after the sentence it supports. This module is the other half: it
 * finds `[S3]`, resolves it against the evidence that was *actually sent*, and
 * renders a chip reading `第03章 · 长廊` in that exact position.
 *
 * Why not scan the reply for filenames, as before? Because the answers that most
 * need a citation are the ones written as ordinary prose — "第三章里她没有继续
 * 往前" — and requiring the model to type `第一卷/第03章.md` mid-sentence buys a
 * link at the cost of the sentence. Name-matching survives here only as a
 * fallback for a model that ignores the ids.
 *
 * Two rules are absolute:
 *
 *   - **An id that does not resolve is removed, never guessed at.** It refers to
 *     nothing, and leaving `[S9]` in the prose would be showing the writer our
 *     own bookkeeping.
 *   - **Nothing is ever inserted.** A claim gets a reference only where the
 *     model put one. An answer that cited nothing renders exactly as written.
 */

import type { AssembledContext } from "../context/types";
import type { ContextSourceSnapshot, DocRange } from "../types";
import type { EvidenceItem } from "../context/evidence";
import { EVIDENCE_KIND_LABELS, buildEvidence, withUniqueEvidenceLabels } from "../context/evidence";
import { baseName } from "../util/text";

/** One clickable source under, or rather inside, an answer. */
export interface ContextCitation {
	/** Request-local evidence id. Kept in memory; saved prose uses `label`. */
	id?: string;
	/** Vault-relative path. Always a real file in this vault. */
	path: string;
	/** The document's short name, e.g. `第03章`. */
	name: string;
	/** What the chip reads, e.g. `第03章 · 长廊`. */
	label: string;
	/** The heading this citation points at, when it has one. */
	heading: string | null;
	/** Text fallback for legacy/range-less navigation. */
	anchorText: string;
	range?: DocRange;
	revision?: string;
	revisionKind?: "saved" | "editor";
	/** True when only part of the file was sent. */
	truncated: boolean;
}

/** Drop the extension: `第三章.md` is a file, `第三章` is a chapter. */
export function citationName(path: string): string {
	return baseName(path).replace(/\.md$/i, "");
}

/** The citation an evidence item becomes once it is referenced. */
export function citationOf(item: EvidenceItem): ContextCitation {
	return {
		id: item.id,
		path: item.path,
		name: item.name,
		label: item.label,
		heading: item.heading,
		anchorText: item.anchorText,
		...(item.range ? { range: item.range } : {}),
		...(item.revision ? { revision: item.revision } : {}),
		...(item.revisionKind ? { revisionKind: item.revisionKind } : {}),
		truncated: item.truncated,
	};
}

/** Restore one persisted source without re-deriving its provenance. */
export function citationOfSource(source: ContextSourceSnapshot, selectionText?: string): ContextCitation {
	return {
		path: source.path,
		name: citationName(source.path),
		label: source.label,
		heading: source.heading ?? null,
		anchorText: source.anchorText ?? selectionText ?? (source.heading ? `# ${source.heading}` : ""),
		...(source.from && source.to ? { range: { from: source.from, to: source.to } } : {}),
		...(source.revision ? { revision: source.revision } : {}),
		...(source.revisionKind ? { revisionKind: source.revisionKind } : {}),
		truncated: source.truncated,
	};
}

/**
 * Every citation a turn *could* carry, by evidence id.
 *
 * Built from the same assembled context that was sent, so the id space here and
 * the id space upstream are the same one by construction.
 */
export function citationsFor(context: AssembledContext): Map<string, ContextCitation> {
	return keyEvidence(buildEvidence(context).map(citationOf));
}

/**
 * Key citations by id **and** by label.
 *
 * The saved transcript carries labels rather than ids, and the same message is
 * re-rendered from that text the moment it is written — so a map with only ids
 * showed live references as chips and the identical saved answer as literal
 * brackets. Both keys, one map, one code path.
 */
export function keyEvidence(citations: ContextCitation[]): Map<string, ContextCitation> {
	const byKey = new Map<string, ContextCitation>();
	const labelled = withUniqueEvidenceLabels(citations);
	// Labels first, then ids: a strangely named file such as `S1.md` must not
	// overwrite the request-local S1 key. Request ids are authoritative while
	// the turn is live.
	labelled.forEach((citation) => {
		byKey.set(citation.label, citation);
	});
	labelled.forEach((citation, index) => {
		byKey.set(citation.id ?? `S${index + 1}`, citation);
	});
	return byKey;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A run of an answer: prose, or a reference the writer can click. */
export type ProseSegment =
	| { kind: "text"; text: string }
	| { kind: "citation"; text: string; citation: ContextCitation };

/**
 * Any bracketed reference: `[S3]`, `[S3][S7]`, `[S3, S7]`, `[第05章 · 追问]`,
 * and the full-width forms.
 *
 * Deliberately not limited to the id shape. The saved transcript carries
 * readable labels rather than ids — see `persistCitationMarkers` — and the same
 * message is rendered from that text immediately after it is saved. Matching
 * only `S\d+` meant a live answer showed its references as chips and the very
 * same answer, one save later, showed them as literal brackets in the prose.
 */
const MARKER = /[[【]\s*([^\][【】\n]{1,300})\s*[\]】]/g;

/** True when a reference looks like our own bookkeeping rather than prose. */
function looksLikeId(reference: string): boolean {
	return /^S\d+$/i.test(reference.trim());
}

/**
 * Split an answer into prose and resolved references.
 *
 * Adjacent markers collapse into adjacent chips, so a claim supported by three
 * passages shows three references — which is the normal case for an argument
 * about a manuscript, not an edge case.
 *
 * A bracket that resolves to nothing is left **exactly as the assistant wrote
 * it**, unless it is one of our ids: `[S9]` refers to nothing and is our own
 * notation, so it is removed, while `[某某]` is the writer's prose and stays.
 */
export function splitProseWithCitations(
	text: string,
	citations: Map<string, ContextCitation>,
): ProseSegment[] {
	if (text.length === 0) return [{ kind: "text", text }];

	const segments: ProseSegment[] = [];
	let cursor = 0;
	let resolvedAny = false;

	MARKER.lastIndex = 0;
	for (let match = MARKER.exec(text); match !== null; match = MARKER.exec(text)) {
		const references = splitReferences(match[1], citations);
		const resolved = references
			.map((reference) => lookup(citations, reference))
			.filter((citation): citation is ContextCitation => citation !== undefined);

		// Nothing recognised and not our notation: it is the assistant's own
		// punctuation. Leave the whole thing alone.
		if (resolved.length === 0 && !references.every(looksLikeId)) continue;

		if (match.index > cursor) {
			segments.push({ kind: "text", text: text.slice(cursor, match.index) });
		}
		for (const citation of resolved) {
			segments.push({ kind: "citation", text: citation.label, citation });
			resolvedAny = true;
		}
		cursor = match.index + match[0].length;
	}

	if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
	if (!resolvedAny && cursor === 0) return fallbackByName(text, citations);
	return tidy(segments);
}

/** `S2, S4` and `S2、S4` are both two references. */
function splitReferences(group: string, citations?: Map<string, ContextCitation>): string[] {
	const whole = group.trim();
	// A saved readable label commonly contains spaces around `·`. Prefer it
	// whole when it is a known key; whitespace is only a separator for id lists.
	if (citations && lookup(citations, whole)) return [whole];
	return group
		.split(/[\s,，、]+/)
		.map((reference) => reference.trim())
		.filter((reference) => reference.length > 0);
}

/**
 * Resolve one reference, by id or by label.
 *
 * Both are in the same map: ids while the request's evidence is still in
 * memory, labels once the message has been saved and reloaded. One lookup means
 * the live and the restored rendering cannot diverge.
 */
function lookup(
	citations: Map<string, ContextCitation>,
	reference: string,
): ContextCitation | undefined {
	return citations.get(reference) ?? citations.get(reference.toUpperCase());
}

/**
 * The old behaviour, kept only for a reply that used no references at all.
 *
 * Better than nothing when a model ignores the convention, and never the
 * primary mechanism: it can only find a source the model happened to name.
 */
function fallbackByName(text: string, citations: Map<string, ContextCitation>): ProseSegment[] {
	const unique = new Map<string, ContextCitation>();
	for (const citation of citations.values()) {
		if (!unique.has(citation.path)) unique.set(citation.path, citation);
	}

	interface Hit {
		start: number;
		end: number;
		citation: ContextCitation;
	}
	const hits: Hit[] = [];
	for (const citation of unique.values()) {
		// Two characters is the shortest name that is not also ordinary prose.
		if (Array.from(citation.name).length < 2) continue;
		const at = text.indexOf(citation.name);
		if (at !== -1) hits.push({ start: at, end: at + citation.name.length, citation });
	}
	if (hits.length === 0) return [{ kind: "text", text }];

	hits.sort((a, b) => a.start - b.start);
	const segments: ProseSegment[] = [];
	let cursor = 0;
	for (const hit of hits) {
		if (hit.start < cursor) continue;
		if (hit.start > cursor) segments.push({ kind: "text", text: text.slice(cursor, hit.start) });
		segments.push({ kind: "citation", text: hit.citation.name, citation: hit.citation });
		cursor = hit.end;
	}
	if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
	return segments;
}

/** Merge neighbouring text runs and drop empty ones. */
function tidy(segments: ProseSegment[]): ProseSegment[] {
	const out: ProseSegment[] = [];
	for (const segment of segments) {
		if (segment.kind === "text" && segment.text.length === 0) continue;
		const last = out[out.length - 1];
		if (segment.kind === "text" && last && last.kind === "text") {
			out[out.length - 1] = { kind: "text", text: last.text + segment.text };
			continue;
		}
		out.push(segment);
	}
	return out.length > 0 ? out : [{ kind: "text", text: "" }];
}

/**
 * Remove every reference marker from a piece of text.
 *
 * Used on a replacement passage before it becomes a diff. The instructions tell
 * the model to keep references out of drafted prose, but an instruction is not a
 * guarantee, and the consequence of it being ignored is `[第05章 · 茶棚]` written
 * into a novel by pressing 应用. This is the guarantee: whatever the model does,
 * our notation cannot end up in the manuscript.
 *
 * Only markers that actually resolve, plus our own `[Sn]` ids, are removed —
 * a bracket the writer's own prose contains is left alone.
 */
export function stripCitationMarkers(text: string, citations: Map<string, ContextCitation>): string {
	MARKER.lastIndex = 0;
	const stripped = text.replace(MARKER, (whole, group: string) => {
		const references = splitReferences(group, citations);
		const known = references.every(
			(reference) => looksLikeId(reference) || lookup(citations, reference) !== undefined,
		);
		return known ? "" : whole;
	});
	// Removing a marker can leave the space that preceded it stranded.
	return stripped.replace(/[ \t]+([,，。；;：:!！?？）)】\]])/g, "$1").replace(/[ \t]{2,}/g, " ");
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Rewrite ids into readable labels before the message is saved.
 *
 * `[S3]` means nothing once the request that defined it is over, so the saved
 * transcript would lose its references on the next reload — and a conversation
 * file a writer might open in a text editor should not be full of our
 * bookkeeping either. `[第03章 · 长廊]` survives both, and can be resolved back
 * to a file by name when the conversation is reopened.
 */
export function persistCitationMarkers(text: string, citations: Map<string, ContextCitation>): string {
	MARKER.lastIndex = 0;
	return text.replace(MARKER, (whole: string, group: string) => {
		const references = splitReferences(group, citations);
		const labels = references
			.map((reference) => lookup(citations, reference)?.label)
			.filter((label): label is string => label !== undefined);
		if (labels.length > 0) return labels.map((label) => `[${label}]`).join("");
		// An id this request never issued is our bookkeeping gone stale and is
		// dropped. Anything else in brackets is the model's text — 【回忆】, [注1],
		// a line of dialogue in a candidate — and is kept exactly as written.
		return references.length > 0 && references.every(looksLikeId) ? "" : whole;
	});
}

/** `[第03章 · 长廊]` in a saved message, so it can be resolved on reload. */
const SAVED_MARKER = /\[([^\][\n]{1,300})\]/g;

/**
 * Recover the citations in a saved message.
 *
 * `resolve` is given a label and answers with the file it names, or null. It is
 * the vault that decides — a label naming a file that no longer exists, or one
 * that is ambiguous, simply does not become a link. Nothing is invented, and
 * nothing is inferred from the prose.
 */
export function restoreCitations(
	text: string,
	resolve: (label: string) => { path: string; heading: string | null; anchorText: string } | null,
): Map<string, ContextCitation> {
	const byId = new Map<string, ContextCitation>();
	SAVED_MARKER.lastIndex = 0;
	for (let match = SAVED_MARKER.exec(text); match !== null; match = SAVED_MARKER.exec(text)) {
		const label = match[1].trim();
		if (byId.has(label)) continue;
		const found = resolve(label);
		if (!found) continue;
		byId.set(label, {
			path: found.path,
			name: citationName(found.path),
			label,
			heading: found.heading,
			anchorText: found.anchorText,
			truncated: false,
		});
	}
	return byId;
}

/** `[第03章 · 长廊]` markers in a saved message, split into prose and chips. */
export function splitSavedProse(
	text: string,
	citations: Map<string, ContextCitation>,
): ProseSegment[] {
	// Saved answers carry explicit readable citation markers. Do not apply the
	// legacy filename fallback here: an incidental chapter name in ordinary
	// prose must not become a citation or a "source used" claim after reload.
	return splitExplicitCitations(text, citations);
}

function splitExplicitCitations(text: string, citations: Map<string, ContextCitation>): ProseSegment[] {
	if (text.length === 0) return [{ kind: "text", text }];
	const segments: ProseSegment[] = [];
	let cursor = 0;
	MARKER.lastIndex = 0;
	for (let match = MARKER.exec(text); match !== null; match = MARKER.exec(text)) {
		const references = splitReferences(match[1], citations);
		const resolved = references
			.map((reference) => lookup(citations, reference))
			.filter((citation): citation is ContextCitation => citation !== undefined);
		if (resolved.length === 0 && !references.every(looksLikeId)) continue;
		if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) });
		for (const citation of resolved) segments.push({ kind: "citation", text: citation.label, citation });
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
	return cursor === 0 ? [{ kind: "text", text }] : tidy(segments);
}

/** Exported so the label parser and the evidence builder cannot drift apart. */
export { EVIDENCE_KIND_LABELS };
