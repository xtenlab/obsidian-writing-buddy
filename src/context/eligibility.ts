/**
 * One policy for deciding which Vault files may become manuscript evidence.
 *
 * Candidate discovery, bounded research, and full-manuscript snapshots all use
 * this module. Keeping the path and frontmatter rules here prevents a broad
 * workflow from accidentally reading WritingBuddy's own state or an archived
 * draft that the ordinary context path would have rejected.
 */

import { CACHE_DIR, LEGACY_PROJECT_ROOTS, projectPaths } from "../storage/paths";

export type ContextCorpusScope = "bounded" | "full-current-manuscript";

export interface ContextEligibilityOptions {
	/** Historical/discarded material is opt-in for bounded comparison tasks. */
	includeArchives?: boolean;
	/** Full-corpus scans are restricted to this already-resolved manuscript root. */
	root?: string;
	/** Kept in the shared contract for callers that bind policy to an editor. */
	activeFilePath?: string | null;
	scope?: ContextCorpusScope;
}

/**
 * Plugin-owned roots that never change: the hidden cache and the pre-1.0
 * folders the migration reads from. The current project root is read live
 * from `projectPaths`, because the writer can move it while the vault is open.
 */
const FIXED_INTERNAL_ROOTS = [CACHE_DIR, ...LEGACY_PROJECT_ROOTS] as const;

/**
 * Other folders in the vault that hold a `project.json` of ours — a backup
 * copied in from another vault, or the folder that was active before a
 * writer switched to a different one. Never the current root. They are
 * excluded from context for the same reason the root is: a folder of the
 * writer's own conversations is not manuscript.
 */
let inactiveProjectRoots: readonly string[] = [];

export function setInactiveProjectRoots(roots: readonly string[]): void {
	inactiveProjectRoots = roots.map(normaliseVaultPath).filter((root) => root.length > 0);
}

/**
 * Obsidian's own configuration folder, which the user can rename. The plugin
 * reports it from `Vault#configDir` at load; until then only plugin-owned
 * roots are internal.
 */
let vaultConfigDir: string | null = null;

export function setVaultConfigDir(dir: string | null): void {
	vaultConfigDir = dir ? normaliseVaultPath(dir) : null;
}

/** True for plugin-owned state and Obsidian's own configuration. Neither is ever context. */
export function isInternalContextPath(path: string): boolean {
	const normalised = normaliseVaultPath(path);
	const roots: string[] = [projectPaths.root, ...FIXED_INTERNAL_ROOTS, ...inactiveProjectRoots];
	if (vaultConfigDir) roots.push(vaultConfigDir);
	return roots.some((root) => normalised === root || normalised.startsWith(`${root}/`));
}

/** Explicit history/discard markers. Plain `草稿` / `draft` remain current work. */
export function isExplicitArchivePath(path: string): boolean {
	return normaliseVaultPath(path).split("/").some((segment) =>
		/(?:旧稿|旧版|修改稿|弃稿|废稿|作废|存档|归档|历史版本|备份|冲突副本)/iu.test(segment) ||
		/(?:^|[\s._-])(archives?|archived|discarded|deprecated|backup|backups|old[\s._-]*(?:drafts?|versions?)|conflicted?[\s._-]*cop(?:y|ies))(?:$|[\s._-])/iu.test(segment),
	);
}

/** Frontmatter can make an otherwise ordinary path explicitly historical. */
export function hasExplicitArchiveMetadata(text: string): boolean {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
	if (!match) return false;
	const frontmatter = match[1];
	if (/^(?:writingBuddyStatus|status|versionStatus|draftStatus)\s*:\s*(?:archive|archived|discarded|deprecated|old(?:[ _-]+version)?|backup|旧稿|旧版|修改稿|弃稿|废稿|作废|存档|存档参照|归档|历史版本|备份|冲突副本)\s*$/imu.test(frontmatter)) {
		return true;
	}
	const lines = frontmatter.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		const inlineTags = /^(?:tags?)\s*:\s*(.*)$/iu.exec(lines[index]);
		if (!inlineTags) continue;
		if (hasArchiveTag(inlineTags[1])) return true;
		for (let child = index + 1; child < lines.length && /^\s+-/u.test(lines[child]); child += 1) {
			if (hasArchiveTag(lines[child].replace(/^\s*-\s*/u, ""))) return true;
		}
	}
	return false;
}

/**
 * Path-only eligibility. Metadata is checked after the bounded read by callers.
 * The active file is not excluded: callers may need it even when their inventory
 * lags, and candidate-level duplicate suppression is a separate concern.
 */
export function isEligibleContextPath(path: string, options: ContextEligibilityOptions = {}): boolean {
	// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
	if (/[\\\u0000-\u001f\u007f-\u009f]/u.test(path) || path.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)) return false;
	const normalised = normaliseVaultPath(path);
	if (!isSafeVaultRelativePath(normalised) || !/\.md$/iu.test(normalised)) return false;

	if (isInternalContextPath(normalised)) return false;
	const scope = options.scope ?? (options.root !== undefined ? "full-current-manuscript" : "bounded");
	if (scope === "full-current-manuscript" && options.root !== undefined && !isWithinContextRoot(normalised, normaliseVaultPath(options.root))) return false;

	return options.includeArchives === true || !isExplicitArchivePath(normalised);
}

export function normaliseVaultPath(path: string): string {
	return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
}

export function isWithinContextRoot(path: string, root: string): boolean {
	// A root-level active file means other root-level Markdown files, not the
	// entire recursive Vault. This is a manuscript boundary, not a permission.
	return root.length === 0 ? !path.includes("/") : path === root || path.startsWith(`${root}/`);
}

function hasArchiveTag(value: string): boolean {
	const tags = value.replace(/^\[|\]$/gu, "").split(/[\s,]+/u).map((tag) =>
		tag.trim().replace(/^['"]|['"]$/gu, "").replace(/^#/u, ""),
	).filter(Boolean);
	return tags.some((tag) => /^(?:archive|archived|discarded|deprecated|old(?:[ _-]+version)?|backup|旧稿|旧版|修改稿|弃稿|废稿|作废|存档|存档参照|归档|历史版本|备份|冲突副本)$/iu.test(tag));
}

function isSafeVaultRelativePath(value: string): boolean {
	if (value.length === 0 || value.trim() !== value) return false;
	// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
	return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
