/**
 * Evidence: the manuscript a turn was given, in citeable pieces.
 *
 * The previous citation mechanism scanned the reply for filenames and linked
 * whatever it recognised. That fails exactly where it matters — an answer that
 * says "第三章里她没有继续往前" is making a claim about a specific passage and
 * offering no way to check it, because the model wrote prose rather than a path.
 * Asking the model to type `设定/林昭.md` mid-sentence would fix the link and
 * ruin the sentence.
 *
 * So provenance is carried by the request instead. Every piece of manuscript
 * sent upstream gets a short id, and the model is asked to put that id next to
 * the claim it supports. The renderer turns `[S3]` into a chip reading
 * `第03章 · 长廊`, and the prose stays prose.
 *
 * Three properties make this safe rather than convenient:
 *
 *   - **Only what was sent can be cited.** The id space is built from this
 *     request's own documents. An id that does not resolve is dropped, not
 *     guessed at. A file the model invents has no id and cannot become a link.
 *   - **Every item has a real location.** Documents are split at their Markdown
 *     headings, so a citation points at a section — and the heading line itself
 *     is recorded as the anchor, which is exact text that can be found again
 *     and selected rather than a line number that rots.
 *   - **Nothing here changes the protocol.** The ids live in the `path` field of
 *     `context.documents[]`, which is already a free-form label, and the guidance
 *     travels as one more document. Runtime V2 is untouched.
 */

import type { ContextDocumentPayload } from "../backend/AIBackend";
import type { AssembledContext, ContextDocument } from "./types";
import type { DocRange } from "../types";
import { baseName, countChars, truncateChars } from "../util/text";
import { annotateWithCitationBlocks, type CitationBlock } from "./citationBlocks";
import { getLocale, instructionLocale, type Locale } from "../i18n";

/** What kind of material a piece of evidence is, in the writer's terms. */
export type EvidenceKind =
	| "selection"
	| "current"
	| "related"
	| "character"
	| "world"
	| "outline";

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
	selection: "所选正文",
	current: "当前章节",
	related: "相关章节",
	character: "人物设定",
	world: "世界设定",
	outline: "大纲",
};

const EVIDENCE_KIND_LABELS_EN: Record<EvidenceKind, string> = {
	selection: "Selection",
	current: "Current chapter",
	related: "Related chapter",
	character: "Character sheet",
	world: "World sheet",
	outline: "Outline",
};

/** The heading given to the text around a selection; a label prefix like the kinds above. */
const CONTEXT_HEADING: Record<Locale, string> = { zh: "选区上下文", en: "Selection context" };

/**
 * A kind's name in one language. Chips and activity rows read it in the
 * interface language; the document names sent to the model read it in the
 * instruction language, so a Chinese manuscript is described in Chinese
 * whatever the interface shows.
 */
export function evidenceKindLabel(kind: EvidenceKind, locale: Locale = getLocale()): string {
	return (locale === "en" ? EVIDENCE_KIND_LABELS_EN : EVIDENCE_KIND_LABELS)[kind];
}

export function contextHeadingLabel(locale: Locale = getLocale()): string {
	return CONTEXT_HEADING[locale];
}

/** Every label prefix a saved citation may carry, in either language. */
export function knownEvidenceKindLabels(): string[] {
	return [...Object.values(EVIDENCE_KIND_LABELS), ...Object.values(EVIDENCE_KIND_LABELS_EN), ...Object.values(CONTEXT_HEADING)];
}

/**
 * The kind a saved label was made for, read back from its prefix or suffix in
 * either language. Labels are persisted in prose, so nothing else records it.
 */
export function evidenceKindFromLabel(label: string): EvidenceKind | "context" | null {
	const parts = label.split("·").map((part) => part.trim());
	for (const [kind, name] of [...Object.entries(EVIDENCE_KIND_LABELS), ...Object.entries(EVIDENCE_KIND_LABELS_EN)] as Array<[EvidenceKind, string]>) {
		if (parts.includes(name)) return kind;
	}
	if (Object.values(CONTEXT_HEADING).some((name) => parts.includes(name))) return "context";
	return null;
}

/** One citeable piece of manuscript. */
export interface EvidenceItem {
	/** Short id used in the request and in the reply, e.g. `S3`. */
	id: string;
	/** Vault-relative path. Never an absolute filesystem path. */
	path: string;
	/** File name without its extension, e.g. `第03章`. */
	name: string;
	kind: EvidenceKind;
	/** The Markdown heading this section sits under, if any. */
	heading: string | null;
	/** What the chip reads, e.g. `第03章 · 长廊`. */
	label: string;
	/** The text actually sent for this item. */
	excerpt: string;
	/**
	 * Relocation fallback used when no revision-verified exact range exists.
	 * Full citations carry range + content revision; ordinary evidence normally
	 * uses a heading or representative first line here.
	 */
	anchorText: string;
	range?: DocRange;
	/** Content identity and authority captured with this source, when available. */
	revision?: string;
	revisionKind?: "saved" | "editor";
	/**
	 * Finer citeable blocks inside this item, in item-local offsets.
	 *
	 * Present only where an item is large enough that citing it whole would be
	 * poor evidence — today, a Full processing chunk. The item still travels as
	 * one document; these only name its parts.
	 */
	citationBlocks?: readonly CitationBlock[];
	truncated: boolean;
	/**
	 * Characters in the source this excerpt was cut from, when it was cut.
	 *
	 * Without it the note below is just "（已截断）", which a model cannot act on:
	 * it reads the same whether it saw all but twenty-five characters of a
	 * setting note or two percent of a three-hundred-thousand-character volume.
	 * Faced with that, the honest thing for it to do is decline — and it did,
	 * repeatedly, on material that was almost entirely present.
	 */
	sourceChars?: number;
}

/** How many sections one document may contribute. */
export const MAX_SECTIONS_PER_DOCUMENT = 6;

/** How many citeable items a single request may carry. */
export const MAX_EVIDENCE_ITEMS = 16;

/**
 * Split assembled context into citeable evidence.
 *
 * The selected passage comes first and always keeps its own id — it is the
 * thing most likely to be discussed, and it is the one item whose exact range is
 * already known.
 */
export function buildEvidence(context: AssembledContext): EvidenceItem[] {
	const items: EvidenceItem[] = [];
	const seen = new Set<string>();
	let next = 1;

	const take = (item: Omit<EvidenceItem, "id">): void => {
		if (items.length >= MAX_EVIDENCE_ITEMS) return;

		// A section is the same evidence however it was found. Retrieval can
		// surface one file as the active file, as a link *and* as a lexical
		// match, and without this each arrival became its own id — so an answer
		// cited `[S1][S2][S3]` and the reader saw `卷01卷01卷01`, three labels
		// for one place. It was also being *sent* three times.
		const identity = item.kind === "selection"
			? `selection:${item.path}:${item.range?.from.line ?? ""}:${item.range?.from.ch ?? ""}:${item.range?.to.line ?? ""}:${item.range?.to.ch ?? ""}`
			: `${item.path}#${item.heading ?? ""}`;
		if (seen.has(identity)) return;
		seen.add(identity);

		items.push({ ...item, id: `S${next}` });
		next += 1;
	};

	if (context.selection && context.selection.text.trim().length > 0) {
		const name = fileName(context.selection.filePath);
		take({
			path: context.selection.filePath,
			name,
			kind: "selection",
			heading: null,
			label: `${evidenceKindLabel("selection")} · ${name}`,
			excerpt: context.selection.text,
			anchorText: firstLine(context.selection.text),
			range: { from: context.selection.from, to: context.selection.to },
			truncated: false,
		});
	}

	// The prose either side of the passage travels as its own item: it is what
	// makes a judgement about rhythm or continuity possible, and losing it would
	// quietly narrow every answer about a selection.
	if (context.selection && (context.selection.before || context.selection.after)) {
		const name = fileName(context.selection.filePath);
		const parts: string[] = [];
		const en = instructionLocale() === "en";
		if (context.selection.before) parts.push(`${en ? "[Before the selection]" : "【选区前文】"}
${context.selection.before}`);
		if (context.selection.after) parts.push(`${en ? "[After the selection]" : "【选区后文】"}
${context.selection.after}`);
		take({
			path: context.selection.filePath,
			name,
			kind: "current",
			heading: contextHeadingLabel(),
			label: `${name} · ${contextHeadingLabel()}`,
			excerpt: parts.join("\n\n"),
			anchorText: "",
			range: { from: context.selection.from, to: context.selection.to },
			truncated: false,
		});
	}

	for (const document of context.documents) {
		const kind = kindOf(document);
		const name = fileName(document.path);

		for (const section of splitSections(document.text)) {
			take({
				path: document.path,
				name,
				kind,
				heading: section.heading,
				label: labelFor(kind, name, section.heading),
				excerpt: section.text,
				anchorText: section.anchorText,
				truncated: document.truncated,
			});
		}
	}

	return withUniqueEvidenceLabels(items);
}

interface EvidenceLabelSource {
	path: string;
	name: string;
	heading: string | null;
	label: string;
	range?: DocRange;
}

/**
 * Keep the familiar short label unless it names more than one source.
 *
 * A persisted marker has no request-local id left to disambiguate it, so two
 * `第01章 · 开场` labels must not survive as-is when they came from
 * different files. For collisions we replace the basename with the shortest
 * suffix the reload resolver can identify without guessing: the complete
 * Vault-relative path. The `.md` stays deliberately so it matches that exact
 * path branch rather than an ambiguous basename.
 */
export function withUniqueEvidenceLabels<T extends EvidenceLabelSource>(items: readonly T[]): T[] {
	const groups = new Map<string, number[]>();
	items.forEach((item, index) => {
		const group = groups.get(item.label) ?? [];
		group.push(index);
		groups.set(item.label, group);
	});

	const colliding = [...groups.entries()]
		.filter(([, indices]) => new Set(indices.map((index) => evidenceLabelIdentity(items[index]))).size > 1)
		.sort(([left], [right]) => left.localeCompare(right));
	if (colliding.length === 0) return [...items];

	// Reserve unchanged labels first. A generated path-qualified label should
	// never steal a key that already identifies another source.
	const taken = new Map<string, string>();
	for (const [label, indices] of groups) {
		if (colliding.some(([candidate]) => candidate === label)) continue;
		taken.set(label, evidenceLabelIdentity(items[indices[0]]));
	}

	const replacements = new Map<number, string>();
	for (const [, indices] of colliding) {
		const candidates = new Map<string, { label: string; indices: number[] }>();
		for (const index of indices) {
			const item = items[index];
			const identity = evidenceLabelIdentity(item);
			const existing = candidates.get(identity);
			if (existing) {
				existing.indices.push(index);
				continue;
			}
			candidates.set(identity, {
				label: pathQualifiedLabel(item, vaultRelativePath(item.path)),
				indices: [index],
			});
		}

		for (const [identity, candidate] of [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right))) {
			let label = candidate.label;
			let ordinal = 2;
			while (taken.has(label) && taken.get(label) !== identity) {
				label = `${candidate.label} · ${ordinal}`;
				ordinal += 1;
			}
			taken.set(label, identity);
			for (const index of candidate.indices) replacements.set(index, label);
		}
	}

	return items.map((item, index) => {
		const label = replacements.get(index);
		return label && label !== item.label ? { ...item, label } : item;
	});
}

function evidenceLabelIdentity(item: EvidenceLabelSource): string {
	const range = item.range
		? `${item.range.from.line}:${item.range.from.ch}-${item.range.to.line}:${item.range.to.ch}`
		: "";
	return `${item.path}#${item.heading ?? ""}#${range}`;
}

function vaultRelativePath(path: string): string {
	return path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0).join("/");
}

function pathQualifiedLabel(item: EvidenceLabelSource, pathSuffix: string): string {
	if (item.label === item.name) return pathSuffix;
	if (item.label.startsWith(`${item.name} · `)) {
		return `${pathSuffix}${item.label.slice(item.name.length)}`;
	}
	// Selection labels and headingless canon labels put their readable kind
	// before the filename. Preserve that wording while replacing only the
	// ambiguous filename.
	if ((item.range || item.heading === null) && item.label.endsWith(` · ${item.name}`)) {
		return `${item.label.slice(0, -item.name.length)}${pathSuffix}`;
	}
	return item.heading ? `${pathSuffix} · ${item.heading}` : pathSuffix;
}

/** The chip's text: chapter and section for prose, kind and subject for canon. */
export function labelFor(kind: EvidenceKind, name: string, heading: string | null): string {
	if (kind === "character" || kind === "world" || kind === "outline") {
		return `${evidenceKindLabel(kind)} · ${heading ?? name}`;
	}
	return heading ? `${name} · ${heading}` : name;
}

/**
 * What sort of material a document is.
 *
 * Guessed from the retrieval role first, then from the path, using the folder
 * names a Chinese manuscript actually uses. A wrong guess only changes a label;
 * it cannot make anything citeable that was not sent.
 */
export function kindOf(document: ContextDocument): EvidenceKind {
	if (document.role === "active-file") return "current";

	const path = document.path;
	if (/人物|角色|character/i.test(path)) return "character";
	if (/大纲|outline/i.test(path)) return "outline";
	if (/世界观|设定集|world/i.test(path)) return "world";
	if (/设定|canon/i.test(path)) return "world";
	return "related";
}

interface Section {
	heading: string | null;
	text: string;
	anchorText: string;
}

/**
 * Split a document at its Markdown headings.
 *
 * A chapter cited as a whole is barely a citation — it points at four thousand
 * characters. Sections are what a claim is actually about, and a manuscript
 * already marks them.
 */
export function splitSections(text: string): Section[] {
	const lines = text.split(/\r?\n/);
	const sections: Section[] = [];
	let heading: string | null = null;
	let headingLine: string | null = null;
	let body: string[] = [];
	let inFence = false;

	const flush = (): void => {
		const joined = body.join("\n");
		if (joined.trim().length === 0 && heading === null) return;
		const text = headingLine ? `${headingLine}\n${joined}` : joined;
		// Past the section limit the rest joins the last section rather than
		// being dropped: a chapter of ten scenes, or a cast sheet with a heading
		// per character, was read as its first six and the rest silently lost.
		if (sections.length >= MAX_SECTIONS_PER_DOCUMENT) {
			const last = sections[sections.length - 1];
			last.text = `${last.text}\n${text}`;
			return;
		}
		sections.push({ heading, text, anchorText: headingLine ?? firstLine(joined) });
	};

	for (const line of lines) {
		if (/^\s*```/.test(line)) inFence = !inFence;
		const match = inFence ? null : /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line);
		if (match) {
			flush();
			heading = match[2].trim();
			headingLine = line.trim();
			body = [];
			continue;
		}
		body.push(line);
	}
	flush();

	// A document with no headings is one section: still citeable, just coarser.
	if (sections.length === 0 && text.trim().length > 0) {
		return [{ heading: null, text, anchorText: firstLine(text) }];
	}
	return sections.filter((section) => section.text.trim().length > 0);
}

/**
 * The documents to send, one per evidence item, each carrying its id.
 *
 * The id goes in `path`, which the Runtime treats as an opaque label, so this
 * needs no protocol change at all.
 */
export function evidenceDocumentPayloads(items: EvidenceItem[]): ContextDocumentPayload[] {
	return withUniqueEvidenceLabels(items).map((item) => {
		// Block ids are inserted into the text the item already carries. The
		// document count, the grouping and the bytes sent are unchanged; the
		// model simply gains a name for each paragraph it can point at.
		const body = item.citationBlocks && item.citationBlocks.length > 0
			? annotateWithCitationBlocks(item.excerpt, item.citationBlocks)
			: item.excerpt;
		return {
			// The full-width parentheses are the label grammar `safePath.ts`
			// verifies before anything is sent, so they stay in both languages;
			// only the kind inside them follows the instruction locale.
			path: `[${item.id}] ${item.path}${item.heading ? ` · ${item.heading}` : ""}（${evidenceKindLabel(item.kind, instructionLocale())}）`,
			text: item.truncated ? [body, truncationNote(item, body)].join(String.fromCharCode(10)) : body,
		};
	});
}

/**
 * Say how much of the source this excerpt is, not merely that it is a part.
 *
 * The share is what decides whether an answer can be given: most of a note
 * supports a confident claim, a sliver of a volume supports a scoped one. Both
 * used to arrive labelled identically.
 */
function truncationNote(item: EvidenceItem, body: string): string {
	const shown = countChars(body);
	const total = item.sourceChars;
	const en = instructionLocale() === "en";
	if (total === undefined || total <= 0 || shown >= total) return en ? "(This is a relevant excerpt.)" : "（本段为相关节选）";
	const percent = Math.max(1, Math.round((shown / total) * 100));
	return en
		? `(This is a relevant excerpt of about ${shown} characters, ${percent}% of the ${total}-character source.)`
		: `（本段为相关节选，约 ${shown} 字，占原文 ${total} 字的 ${percent}%）`;
}

function fileName(path: string): string {
	return baseName(path).replace(/\.md$/i, "");
}

/** The first non-empty line, trimmed, capped so an anchor stays findable. */
function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
	return truncateChars(line.trim(), 80).replace(/…$/, "");
}
