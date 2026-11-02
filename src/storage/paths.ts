/**
 * Where WritingBuddy keeps project data.
 *
 * Everything under the project root lives *inside the vault*, so a
 * conversation belongs to the manuscript and travels with it through whatever
 * sync the writer already uses. Nothing here is machine-specific, and nothing
 * here may ever contain a credential — see `DeviceStore` for that.
 *
 * The root defaults to `WritingBuddy/`, deliberately **not** dot-prefixed:
 *
 *   - A dot-folder is hidden content as far as Obsidian is concerned. Syncing
 *     it requires Self-hosted LiveSync's Hidden File Sync, which is opt-in,
 *     slower, and conflict-prone. Ordinary folders sync with no special setup.
 *   - Hidden paths are also second-class to the vault adapter and are excluded
 *     from Obsidian's file index, which removes the ability to cross-check an
 *     enumeration against `vault.getFiles()`.
 *
 * It is a plain folder name, sitting among the writer's own. It carried a
 * leading underscore for a while to sort it to the top and mark it as
 * machinery, which is a convention from tooling rather than from manuscripts —
 * and this folder is the writer's data, not the plugin's scratch space.
 *
 * Because it is the writer's folder, **where it sits is the writer's choice**
 * (D-047). The root is a runtime value: the plugin reads it from its own
 * `data.json` at load, follows the folder when the writer drags or renames it
 * in the file tree, and offers a Settings row for the cases a drag cannot
 * cover. Every path below is therefore a getter that reads the current root,
 * never a constant captured at import time — a module that captured the
 * default would keep writing to the old location after a move.
 *
 * What is *not* the writer's choice is the shape inside the root. The fixed
 * children listed in `PROJECT_STRUCTURE` are the plugin's contract with
 * itself; moving one of them out is put back, not followed.
 *
 * Project data must never live inside `.obsidian/` either: that folder is
 * app configuration, is hidden, and is frequently excluded from sync.
 */

export const DEFAULT_PROJECT_ROOT = "WritingBuddy";

let currentRoot: string = DEFAULT_PROJECT_ROOT;

/** Point every project path at a new root. Callers validate first. */
export function setProjectRoot(root: string): void {
	currentRoot = root;
}

/**
 * The fixed layout under the root: the manifest and the folders the plugin
 * owns. A rename of one of these is reverted (see `main.ts`); the root itself
 * is the only thing the writer moves.
 */
export const PROJECT_STRUCTURE = [
	"project.json",
	"conversations",
	"edits",
	"instructions",
	"skills",
] as const;

/** The manifest file that marks a folder as a project root. */
export const PROJECT_FILE_NAME = "project.json";

export const projectPaths = {
	get root(): string {
		return currentRoot;
	},
	get projectFile(): string {
		return `${currentRoot}/${PROJECT_FILE_NAME}`;
	},
	/** Durable checkpoint for retryable migration from a pre-WritingBuddy root. */
	get legacyRootMigrationFile(): string {
		return `${currentRoot}/legacy-root-migration.json`;
	},
	get conversationsDir(): string {
		return `${currentRoot}/conversations`;
	},
	get editsDir(): string {
		return `${currentRoot}/edits`;
	},
	/** Parent for optional writer-owned project instructions. No file is seeded. */
	get instructionsDir(): string {
		return `${currentRoot}/instructions`;
	},
	get projectInstructionsFile(): string {
		return `${currentRoot}/instructions/project.md`;
	},
	get skillsDir(): string {
		return `${currentRoot}/skills`;
	},
	/** Writer-authored skills that do not derive from a packaged skill. */
	get customSkillsDir(): string {
		return `${currentRoot}/skills/custom`;
	},
	/** Writer-owned customizations of immutable packaged skills. */
	get skillOverridesDir(): string {
		return `${currentRoot}/skills/overrides`;
	},
	/** Skill bookkeeping. Active skill Markdown never lives in this directory. */
	get skillStateDir(): string {
		return `${currentRoot}/skills/state`;
	},
	/** Records how each legacy flat skill file was classified, without moving it. */
	get skillMigrationFile(): string {
		return `${currentRoot}/skills/state/migration.json`;
	},
	/** Independent receipt ledger written only by the explicit Reset operation. */
	get skillResetStateFile(): string {
		return `${currentRoot}/skills/state/resets.json`;
	},
	/** The applied-edit log. Reviewable history, not an undo stack. */
	get editHistoryFile(): string {
		return `${currentRoot}/edits/history.json`;
	},
	/** Where the cache lived while it was still inside the synced project root. */
	get legacyCacheDir(): string {
		return `${currentRoot}/cache`;
	},
	get legacyFullCorpusCacheDir(): string {
		return `${currentRoot}/cache/full-corpus`;
	},
	/**
	 * Every directory the plugin expects to exist under the visible project root.
	 *
	 * The cache is not here. It lives outside this root (see `CACHE_DIR`) and
	 * creates itself on first use, so a vault that never runs a Full analysis
	 * never grows the folder at all.
	 */
	get directories(): readonly string[] {
		return [
			currentRoot,
			this.conversationsDir,
			this.editsDir,
			this.instructionsDir,
			this.skillsDir,
			this.customSkillsDir,
			this.skillOverridesDir,
			this.skillStateDir,
		];
	},
};

/**
 * Durable, plugin-owned derived data. Never treated as manuscript context.
 *
 * Deliberately hidden, and the one place in this file where that is right.
 * Obsidian Sync uploads a whole file on every change and keeps each revision
 * as a complete copy against the writer's paid quota; a dot-prefixed folder is
 * never uploaded at all, with no setting to change that. Measured on the
 * long-novel test vault, a few days of Full analysis left 320 memo files and
 * 4.5 MB here, with nothing that ever removed one.
 *
 * What this costs is resuming a Full run on a *different* synced device. That
 * is rare, its failure mode is recomputation rather than loss, and it is not
 * worth a folder that grows without bound inside a quota. Local resume — the
 * common case, and the one `Continue` exists for — is unaffected.
 *
 * Conversations do not move here. They are the writer's own history, they are
 * meant to travel between devices, and PC-014 puts them somewhere visible.
 *
 * The cache also does not follow the project root when that moves. It is
 * invisible in Obsidian, so it cannot get in the way of how a writer arranges
 * the vault, and staying at the vault root keeps it outside sync wherever the
 * visible data goes.
 */
export const CACHE_DIR = ".writing-buddy-cache";
/** Content-addressed intermediate results for resumable Full analysis. */
export const FULL_CORPUS_CACHE_DIR = `${CACHE_DIR}/full-corpus`;
/**
 * Previous revisions of each conversation, kept before it is overwritten.
 *
 * Hidden for the same reason the rest of this root is, and additionally
 * because it must not itself become something sync can replace: it exists to
 * survive a sync that replaced the real file.
 */
export const SESSION_HISTORY_DIR = `${CACHE_DIR}/conversation-history`;

/**
 * Roots this plugin has used before, newest first.
 *
 * Read once each, for migration, then left alone — never written to, never
 * deleted. A writer who opens an old vault gets their conversations back; the
 * old folder stays where it is until they remove it themselves, because a
 * plugin quietly deleting a folder full of someone's work is not a risk worth
 * taking to save them one drag to the bin.
 *
 * These are always looked for at the vault root, whatever the current root is
 * set to: they predate the root being movable.
 */
export const LEGACY_PROJECT_ROOTS = ["_WritingBuddy", ".writing-buddy"] as const;

/** The pre-1.0 hidden root. Kept as a name for the migration notice. */
export const LEGACY_PROJECT_ROOT = ".writing-buddy";

/**
 * The manifest, and the filename every build has used for a conversation.
 *
 * Schema 6 keeps this path occupied on purpose: a build that predates it finds
 * a file it can refuse rather than an absence it would read as a deletion.
 */
export function conversationPath(sessionId: string): string {
	return `${projectPaths.conversationsDir}/${sessionId}.json`;
}

/** The shard folder beside the manifest, holding the transcript itself. */
export function conversationShardDir(sessionId: string): string {
	return `${projectPaths.conversationsDir}/${sessionId}`;
}

export function conversationShardPath(sessionId: string, name: string): string {
	return `${conversationShardDir(sessionId)}/${name}.json`;
}

/** One immutable JSON object per SHA-256 semantic-input address. */
export function fullCorpusMemoPath(key: string): string {
	return `${FULL_CORPUS_CACHE_DIR}/${key}.json`;
}

/** The same address under the pre-move synced location. Read-only. */
export function legacyFullCorpusMemoPath(key: string): string {
	return `${projectPaths.legacyFullCorpusCacheDir}/${key}.json`;
}

/** One folder of timestamped revisions per conversation. */
export function sessionHistoryDir(sessionId: string): string {
	return `${SESSION_HISTORY_DIR}/${sessionId}`;
}

// ---------------------------------------------------------------------------
// Root validation
// ---------------------------------------------------------------------------

/** Why a proposed root was refused. Each maps to one sentence in Settings. */
export type ProjectRootProblem =
	| "empty"
	| "hidden"
	| "config-dir"
	| "reserved"
	| "unsafe";

export type ProjectRootCheck =
	| { ok: true; root: string }
	| { ok: false; problem: ProjectRootProblem };

/** Tidy what a person typed into a vault-relative folder path, or `""`. */
export function normalizeProjectRootInput(input: string): string {
	return input
		.replace(/\\/gu, "/")
		.trim()
		.replace(/^(?:\.\/)+/u, "")
		.replace(/\/+/gu, "/")
		.replace(/^\/+|\/+$/gu, "");
}

/**
 * Decide whether a folder may hold project data.
 *
 * Refuses the vault root (there is nothing to move), anything hidden (see the
 * file comment: hidden folders do not sync and are outside Obsidian's index),
 * Obsidian's own configuration folder, the plugin's cache and legacy roots
 * (the migration code treats those names as sources, never destinations), and
 * any path that could walk outside the vault.
 */
export function checkProjectRoot(input: string, options: { configDir?: string | null } = {}): ProjectRootCheck {
	const root = normalizeProjectRootInput(input);
	if (root.length === 0) return { ok: false, problem: "empty" };
	// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(root) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(root)) {
		return { ok: false, problem: "unsafe" };
	}
	const segments = root.split("/");
	if (segments.some((segment) => segment.length === 0 || segment !== segment.trim() || segment === "." || segment === "..")) {
		return { ok: false, problem: "unsafe" };
	}
	if (segments.some((segment) => segment.startsWith("."))) return { ok: false, problem: "hidden" };
	const configDir = options.configDir ? normalizeProjectRootInput(options.configDir) : null;
	if (configDir && (root === configDir || root.startsWith(`${configDir}/`))) return { ok: false, problem: "config-dir" };
	const reserved: readonly string[] = [CACHE_DIR, ...LEGACY_PROJECT_ROOTS];
	if (reserved.some((name) => root === name || root.startsWith(`${name}/`))) return { ok: false, problem: "reserved" };
	return { ok: true, root };
}

/** True when `path` is `root` itself or lies beneath it. */
export function isWithinRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/**
 * Where `path` lands after the folder `from` is renamed to `to`, or `null`
 * when the rename does not touch it. Covers a rename of the root itself and a
 * rename of any ancestor: `03-tools` → `03-Tools` moves `03-tools/WritingBuddy`
 * just as surely as dragging the folder does.
 */
export function relocatedPath(path: string, from: string, to: string): string | null {
	if (path === from) return to;
	if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
	return null;
}

/**
 * A minimal filesystem, satisfied by Obsidian's vault adapter and by an
 * in-memory fake in the tests. Paths are always vault-relative and use `/`.
 */
export interface VaultFs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	/** Optional byte-preserving operations used by legacy-root migration. */
	readBinary?(path: string): Promise<ArrayBuffer>;
	writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
	mkdir(path: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	remove(path: string): Promise<void>;
	/**
	 * Optional atomic move, used to make a file appear whole (write beside it,
	 * then rename over it). Without it, writers fall back to a direct write and
	 * rely on the checksums inside the file to detect a torn one.
	 */
	rename?(from: string, to: string): Promise<void>;
	/**
	 * Optional file metadata, used only to evict the oldest cache entries.
	 *
	 * Optional because eviction degrades to an arbitrary but still bounded
	 * order without it, and because an in-memory fake has nothing useful to
	 * report. Nothing that affects correctness may depend on this.
	 */
	stat?(path: string): Promise<{ mtime: number; size: number } | null>;
}
