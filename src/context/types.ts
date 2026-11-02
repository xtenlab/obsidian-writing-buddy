/**
 * Client-owned vault context.
 *
 * The architectural correction this module exists for: **WritingBuddy owns the
 * vault.** It reads the manuscript from the local, currently-open Obsidian vault
 * and serialises what a turn needs into the request. The Runtime is compute and
 * provider orchestration; it is never asked to know a filesystem path, hold a
 * synced copy of the vault, or map an id to a server directory.
 *
 * Everything here is pure and testable. The only Obsidian-aware piece is the
 * `VaultReader` implementation in `src/obsidianVaultReader.ts`.
 */

import { t } from "../i18n";
import type {
	ContextBuildReport,
	ContextDepth,
	ContextTask,
	DocPosition,
	ResolvedContextDepth,
} from "../types";

/**
 * The slice of the vault the assembler needs.
 *
 * Deliberately narrow: paths in, text out. `activeFileText` is separate from
 * `read` because the *editor's* buffer is the truth — a writer's unsaved and
 * unsynced edits have to be visible to the model immediately, and reading the
 * file from disk would miss them.
 */
export interface VaultReader {
	/** Vault-relative paths of every Markdown file. */
	listMarkdownFiles(): string[];
	/** File contents from disk. */
	read(path: string): Promise<string>;
	/** Vault-relative paths this file links to, resolved. */
	linksFrom(path: string): string[];
	/** The manuscript the writer is in, if any. */
	activeFilePath(): string | null;
	/** The live editor buffer, used for selection-local tasks and continuations. */
	activeFileText(): string | null;
	/** Optional live editor cursor, as a UTF-16 offset into `activeFileText`. */
	activeFileCursorOffset?(): number | null;
}

/** One piece of manuscript supplied to the model, with its citation. */
export interface ContextDocument {
	/** Vault-relative path. Never an absolute filesystem path. */
	path: string;
	/** Why this document is here, for the serialised header. */
	role: "active-file" | "selection-context" | "linked" | "retrieved";
	text: string;
	/** True when `text` was cut to fit the budget. */
	truncated: boolean;
	revision?: "saved" | "editor";
}

/** The exact passage under discussion, straight from the editor. */
export interface ContextSelection {
	filePath: string;
	text: string;
	from: DocPosition;
	to: DocPosition;
	/** Text immediately before the selection, for continuity. */
	before: string;
	/** Text immediately after. */
	after: string;
}

/** Everything assembled for one turn. */
export interface AssembledContext {
	activeFilePath: string | null;
	selection: ContextSelection | null;
	documents: ContextDocument[];
	/** Code points used, so the caller can report and tests can assert. */
	charsUsed: number;
	/** Paths considered but dropped for budget, for transparency. */
	omitted: string[];
	report?: ContextBuildReport;
}

/**
 * Bounds. Context assembly must be predictable, so every limit is explicit
 * rather than emergent, and nothing here scales with vault size.
 */
export interface ContextBudget {
	/** Total code points across all documents. */
	totalChars: number;
	/** Per-document cap. */
	perDocumentChars: number;
	/** Characters of surrounding text captured either side of a selection. */
	surroundingChars: number;
	/** How many candidate files may be read during scoring. */
	maxFilesRead: number;
	/** How many retrieved documents may be attached. */
	maxDocuments: number;
}

export interface ContextPlan {
	mode: ContextDepth;
	resolvedDepth: ResolvedContextDepth;
	task: ContextTask;
	/** The orchestration path chosen locally before any backend call. */
	execution: "single-turn" | "bounded-research" | "full-current-manuscript";
	/** Bounded retrieval unless the writer explicitly asks to scan the current manuscript in full. */
	coverage: "bounded" | "full-current-manuscript";
	/** Full-manuscript prose generation requires an explicit product flow; never downgrade it silently. */
	blockingReason?: "full-not-supported-for-writing-action";
	sourceRevision: "saved" | "editor";
	includeActiveFile: boolean;
	includeArchives: boolean;
	preserveActiveFile: boolean;
	budgetExpandedForSelection: boolean;
	budget: ContextBudget;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
	// Roughly a chapter's worth of Chinese prose. Large enough to carry the
	// passage plus real evidence, small enough to stay fast and cheap.
	totalChars: 24_000,
	perDocumentChars: 6_000,
	surroundingChars: 1_200,
	maxFilesRead: 12,
	maxDocuments: 6,
};

/**
 * The bounded budgets used by the execution paths selected through Context.
 *
 * This used to be driven by the model's Effort setting. That conflated two
 * Model reasoning and information access are separate controls. Full's budget
 * only seeds its existing complete-corpus workflow; it does not make Full a
 * linear depth above Auto.
 *
 * Low keeps a fixed local budget. Auto starts with the Agent decision loop,
 * which may use bounded research or request the existing deterministic corpus
 * workflow. Full selects that workflow directly; it is not a linear depth
 * above Auto. High remains accepted only by compatibility plumbing.
 */
export function contextBudgetFor(depth: ContextDepth | ResolvedContextDepth | undefined): ContextBudget {
	switch (depth) {
		case "low":
			return {
				totalChars: 14_000,
				perDocumentChars: 5_000,
				surroundingChars: 900,
				maxFilesRead: 8,
				maxDocuments: 3,
			};
		case "auto":
		case "medium":
			return DEFAULT_CONTEXT_BUDGET;
		case "high":
		case "full":
		default:
			// The default, and the widest: a question about a manuscript is
			// usually a question about more of it than one chapter.
			return {
				totalChars: 40_000,
				perDocumentChars: 8_000,
				surroundingChars: 1_600,
				maxFilesRead: 24,
				maxDocuments: 10,
			};
	}
}

/** Formal user-facing Context choices, in product order. */
/**
 * The Context choices the Composer and Settings offer for ordinary turns.
 *
 * `full` is no longer among them. Whole-manuscript analysis is a separate,
 * explicit operation — the command "Analyze whole manuscript" and the Continue
 * offered after an Auto turn that needs it — not a setting a conversation
 * carries into every generation.
 * The `ContextDepth` type keeps `full` so stored turns and those explicit
 * operations still plan exactly as they did.
 */
export const CONTEXT_DEPTHS: Array<{ id: ContextDepth }> = [{ id: "auto" }, { id: "low" }];

/** The depth's name in the interface language. */
export function contextDepthLabel(id: ContextDepth): string {
	return t(id === "auto" ? "context.auto" : id === "full" ? "context.full" : "context.low");
}
