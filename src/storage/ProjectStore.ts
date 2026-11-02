/**
 * Vault-native project storage.
 *
 * The invariant this class exists to enforce: **a conversation belongs to the
 * project, not to the machine.** Nothing here writes to plugin `data.json`, and
 * nothing here may accept a token, a key, an executable path, or a device id —
 * those belong in `DeviceStore`.
 */

import { t } from "../i18n";
import type { ConversationSession, EditToken, ProjectMetadata } from "../types";
import { isSafeSessionId, nowIso } from "../util/id";
import { mapWithConcurrency } from "../util/pool";
import {
	LEGACY_PROJECT_ROOTS,
	CACHE_DIR,
	FULL_CORPUS_CACHE_DIR,
	type VaultFs,
	conversationPath,
	conversationShardDir,
	conversationShardPath,
	projectPaths,
} from "./paths";
import {
	serializeSession, serializeSessionAsInline, validateSession,
	type ParseResult,
} from "./conversationSchema";
import {
	SHARDED_CONVERSATION_SCHEMA_VERSION, assembleSession, isShardFileName, isShardedManifest,
	parseManifest, serializeShardedSession, type ConversationShard,
} from "./conversationShards";
import type { SessionHistoryStore } from "./SessionHistoryStore";

export const PROJECT_SCHEMA_VERSION = 1;

/** A write was refused because the project root is not there to write into. */
export class ProjectRootUnavailableError extends Error {
	constructor() {
		super(t("main.rootUnavailableWrite"));
		this.name = "ProjectRootUnavailableError";
	}
}

/** How many applied edits are kept for review. Undo is separate and narrower. */
export const EDIT_HISTORY_LIMIT = 50;

/** A session that exists on disk but could not be read. */
export interface BrokenSession {
	sessionId: string;
	reason: string;
}

/** `project.json` plus anything an older version left behind in it. */
export interface LoadedProjectMetadata {
	metadata: ProjectMetadata;
	/**
	 * A `projectId` from an older version, if one was present. Reported so the
	 * caller can migrate device-local state that was keyed by it; the field is
	 * removed from the file at the same time.
	 */
	migratedFromProjectId: string | null;
}

/** What a one-time migration out of an older root actually did. */
export interface MigrationReport {
	ran: boolean;
	/** The folder the data came from, when one was found. */
	from?: string;
	copied: string[];
	failed: string[];
}

interface LegacyRootMigrationCheckpoint {
	schemaVersion: 1;
	source: typeof LEGACY_PROJECT_ROOTS[number];
	status: "in-progress" | "complete";
}

function legacyRootCheckpoint(
	source: typeof LEGACY_PROJECT_ROOTS[number],
	status: LegacyRootMigrationCheckpoint["status"],
): string {
	return `${JSON.stringify({ schemaVersion: 1, source, status } satisfies LegacyRootMigrationCheckpoint, null, "\t")}\n`;
}

export interface LoadedSessions {
	sessions: ConversationSession[];
	broken: BrokenSession[];
}

export type StoredSkillLocation = "legacy" | "custom" | "override";

export interface StoredSkillFile {
	path: string;
	location: StoredSkillLocation;
}

/** A defensive read used by vault-event handlers. */
export type SessionFileReadResult =
	| { kind: "loaded"; sessionId: string; session: ConversationSession; fingerprint: string }
	| { kind: "missing"; sessionId: string }
	| { kind: "malformed"; sessionId: string; reason: string; fingerprint?: string };

/** The exact bytes and fingerprint produced by a local conversation write. */
export interface SessionWriteReceipt {
	sessionId: string;
	path: string;
	fingerprint: string;
	/** The canonical session represented by the bytes that were written. */
	session: ConversationSession;
}

export class ProjectStore {
	/**
	 * Set once the directory layout is known to exist.
	 *
	 * Every write path calls `ensureLayout` first, which is correct but was
	 * costing five vault round-trips on **every saved message** to re-check
	 * directories that had existed since startup. Remembering the answer makes
	 * the check free after the first one; `withLayout` handles the case where it
	 * turns out to be stale.
	 */
	private layoutReady = false;

	constructor(
		private readonly fs: VaultFs,
		private readonly defaultDisplayName: string,
		/**
		 * Optional local history, taken before each conversation overwrite.
		 *
		 * Optional so tests and any caller that does not want the extra read can
		 * leave it out; production always supplies one.
		 */
		private readonly history?: SessionHistoryStore,
	) {}

	/**
	 * Set while the project root is known to be gone.
	 *
	 * Every write path creates missing directories on its way, which is the
	 * right reflex for a deleted subfolder and exactly the wrong one for a root
	 * that sync is in the middle of moving or that the writer just dragged to
	 * the bin: the next saved message would conjure an empty root at the old
	 * location and the vault would end up with two. While this is set, writes
	 * fail with `ProjectRootUnavailableError` instead; reads are unaffected.
	 */
	private rootUnavailable = false;

	/** Create the directory layout. Safe to call on every load. */
	async ensureLayout(): Promise<void> {
		if (this.layoutReady) return;
		if (this.rootUnavailable) throw new ProjectRootUnavailableError();
		// The root can sit several folders deep; the adapter is not relied on
		// to create the folders above it. Below the root, every directory is
		// listed parent-first, so one existence check each is enough.
		await this.ensureParentDirectories(projectPaths.root);
		for (const directory of projectPaths.directories) {
			if (!(await this.fs.exists(directory))) {
				await this.fs.mkdir(directory);
			}
		}
		this.layoutReady = true;
	}

	/**
	 * The root moved or came back: forget the cached layout so the next write
	 * checks the new location, and allow writes again.
	 */
	rootChanged(): void {
		this.layoutReady = false;
		this.rootUnavailable = false;
	}

	/** The root is gone. Refuse writes until `rootChanged` says otherwise. */
	markRootUnavailable(): void {
		this.layoutReady = false;
		this.rootUnavailable = true;
	}

	get isRootUnavailable(): boolean {
		return this.rootUnavailable;
	}

	private async ensureDirectory(directory: string): Promise<void> {
		const parts = directory.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.fs.exists(current))) await this.fs.mkdir(current);
		}
	}

	/**
	 * Move Full-analysis memos out of the synced project root.
	 *
	 * They used to sit under `WritingBuddy/cache/`, where Obsidian Sync uploaded
	 * every one of them and kept each against the writer's quota, for derived
	 * data whose worst-case loss is a recomputation. The new home is hidden and
	 * never synced (see `CACHE_DIR`).
	 *
	 * Moved rather than deleted: these files are completed model work, and a
	 * `Continue` running right after an upgrade should still find them. An entry
	 * already present at the destination wins, because both are immutable values
	 * for the same content address. A file that cannot be moved is left where it
	 * is and retried next launch; the old folder is removed only once it is
	 * genuinely empty, so nothing unexpected is swept away with it.
	 */
	async migrateCacheOutOfProjectRoot(): Promise<{ moved: number; remaining: number }> {
		if (!(await this.fs.exists(projectPaths.legacyFullCorpusCacheDir))) return { moved: 0, remaining: 0 };
		let moved = 0;
		let remaining = 0;
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.fs.list(projectPaths.legacyFullCorpusCacheDir);
		} catch {
			return { moved: 0, remaining: 0 };
		}
		for (const from of listed.files) {
			const name = from.split("/").pop();
			if (!name) continue;
			try {
				const to = `${FULL_CORPUS_CACHE_DIR}/${name}`;
				if (await this.fs.exists(to)) {
					await this.fs.remove(from);
					moved += 1;
					continue;
				}
				const contents = await this.fs.read(from);
				await this.ensureCacheDirectories();
				await this.fs.write(to, contents);
				await this.fs.remove(from);
				moved += 1;
			} catch {
				remaining += 1;
			}
		}
		if (remaining === 0) {
			for (const directory of [projectPaths.legacyFullCorpusCacheDir, projectPaths.legacyCacheDir]) {
				try {
					const rest = await this.fs.list(directory);
					if (rest.files.length === 0 && rest.folders.length === 0) await this.fs.remove(directory);
				} catch {
					// An unremovable empty folder is cosmetic. Leave it.
				}
			}
		}
		return { moved, remaining };
	}

	private async ensureCacheDirectories(): Promise<void> {
		for (const directory of [CACHE_DIR, FULL_CORPUS_CACHE_DIR]) {
			if (!(await this.fs.exists(directory))) {
				try {
					await this.fs.mkdir(directory);
				} catch {
					if (!(await this.fs.exists(directory))) throw new Error(`Cannot create ${directory}`);
				}
			}
		}
	}

	/**
	 * Write, and if the layout turned out not to be there after all, rebuild it
	 * and write again.
	 *
	 * This is what makes caching the layout safe: someone deleting
	 * `WritingBuddy/conversations/` while Obsidian is open is rare, but losing a
	 * message to it would not be. One retry costs nothing and removes the risk
	 * entirely.
	 */
	private async withLayout(write: () => Promise<void>): Promise<void> {
		await this.ensureLayout();
		try {
			await write();
		} catch (error) {
			if (this.rootUnavailable) throw error;
			this.layoutReady = false;
			await this.ensureLayout();
			try {
				await write();
			} catch {
				throw error;
			}
		}
	}

	/**
	 * Copy project data out of the pre-1.0 hidden `.writing-buddy/` root.
	 *
	 * The legacy folder is **copied, never moved or deleted**. A durable
	 * in-progress checkpoint makes partial writes retryable after restart; only
	 * a completely copied tree is marked complete. Existing destination bytes
	 * are never overwritten when they differ from the legacy source.
	 */
	async migrateLegacyRoot(): Promise<MigrationReport> {
		const report: MigrationReport = { ran: false, copied: [], failed: [] };
		const rootExists = await this.fs.exists(projectPaths.root);
		const checkpointFileExists = rootExists && await this.fs.exists(projectPaths.legacyRootMigrationFile);
		const checkpoint = checkpointFileExists ? await this.readLegacyRootMigrationCheckpoint() : null;
		if (checkpoint?.status === "complete") return report;

		// The newest root that actually exists. Vaults have been through two
		// renames now, and one of them may be several versions behind.
		let source: typeof LEGACY_PROJECT_ROOTS[number] | null =
			checkpoint?.status === "in-progress" ? checkpoint.source : null;
		if (source === null) {
			// A current root containing established project data is authoritative and
			// may intentionally coexist with an old backup. A directory-only root,
			// however, can be the residue of a crash between ensureLayout() and the
			// first checkpoint write; allow that empty layout to resume migration.
			// A malformed/truncated checkpoint is itself positive evidence that a
			// migration had begun. Retry from an existing known legacy root; the
			// non-overwrite checks below still protect any destination bytes that made
			// it across before the crash.
			if (rootExists && await this.hasEstablishedCurrentData()) return report;
			for (const candidate of LEGACY_PROJECT_ROOTS) {
				if (await this.fs.exists(candidate)) {
					source = candidate;
					break;
				}
			}
		}
		if (source === null) return report;

		report.ran = true;
		report.from = source;
		if (!(await this.fs.exists(source))) {
			report.failed.push(`${source}: legacy migration source is missing`);
			return report;
		}

		// Read and enumerate the entire source before creating a new current root.
		// A source-side failure therefore cannot leave a first-run migration that
		// looks complete merely because WritingBuddy/ now exists.
		const binaryMigration = typeof this.fs.readBinary === "function" && typeof this.fs.writeBinary === "function";
		const plan: Array<{ from: string; to: string; contents: string | ArrayBuffer }> = [];
		const stageFile = async (from: string, to: string): Promise<void> => {
			try {
				if (!(await this.fs.exists(from))) return;
				plan.push({ from, to, contents: binaryMigration
					? await this.fs.readBinary!(from)
					: await this.fs.read(from) });
			} catch (error) {
				report.failed.push(`${from}: ${(error as Error).message}`);
			}
		};
		const stageTree = async (fromDir: string, toDir: string): Promise<void> => {
			try {
				if (!(await this.fs.exists(fromDir))) return;
				const listed = await this.fs.list(fromDir);
				for (const file of listed.files) {
					const name = file.slice(fromDir.length + 1);
					if (name && !name.includes("/")) await stageFile(file, `${toDir}/${name}`);
				}
				for (const folder of listed.folders) {
					const name = folder.slice(fromDir.length + 1);
					if (name && !name.includes("/")) await stageTree(folder, `${toDir}/${name}`);
				}
			} catch (error) {
				report.failed.push(`${fromDir}: ${(error as Error).message}`);
			}
		};

		await stageFile(`${source}/project.json`, projectPaths.projectFile);

		for (const [legacySub, target] of [
			["conversations", projectPaths.conversationsDir],
			["edits", projectPaths.editsDir],
			["skills", projectPaths.skillsDir],
		] as const) {
			await stageTree(`${source}/${legacySub}`, target);
		}

		if (report.failed.length > 0) return report;
		await this.ensureLayout();
		try {
			await this.fs.write(projectPaths.legacyRootMigrationFile, legacyRootCheckpoint(source, "in-progress"));
		} catch (error) {
			report.failed.push(`${projectPaths.legacyRootMigrationFile}: ${(error as Error).message}`);
			return report;
		}

		for (const item of plan) {
			try {
				await this.ensureParentDirectories(item.to);
				if (await this.fs.exists(item.to)) {
					const identical = typeof item.contents === "string"
						? await this.fs.read(item.to) === item.contents
						: equalBytes(await this.fs.readBinary!(item.to), item.contents);
					if (!identical) {
						report.failed.push(`${item.from}: destination already contains different data`);
					}
					continue;
				}
				if (typeof item.contents === "string") await this.fs.write(item.to, item.contents);
				else await this.fs.writeBinary!(item.to, item.contents);
				report.copied.push(item.to);
			} catch (error) {
				report.failed.push(`${item.from}: ${(error as Error).message}`);
			}
		}
		if (report.failed.length === 0) {
			try {
				await this.fs.write(projectPaths.legacyRootMigrationFile, legacyRootCheckpoint(source, "complete"));
			} catch (error) {
				report.failed.push(`${projectPaths.legacyRootMigrationFile}: ${(error as Error).message}`);
			}
		}

		return report;
	}

	private async hasEstablishedCurrentData(): Promise<boolean> {
		for (const path of [projectPaths.projectFile, projectPaths.editHistoryFile, projectPaths.skillMigrationFile, projectPaths.skillResetStateFile]) {
			if (await this.fs.exists(path)) return true;
		}
		for (const directory of [projectPaths.conversationsDir, projectPaths.instructionsDir, projectPaths.skillsDir]) {
			if (await this.treeContainsAnyFile(directory)) return true;
		}
		return false;
	}

	private async treeContainsAnyFile(directory: string): Promise<boolean> {
		if (!(await this.fs.exists(directory))) return false;
		try {
			const listed = await this.fs.list(directory);
			if (listed.files.length > 0) return true;
			for (const folder of listed.folders) {
				if (await this.treeContainsAnyFile(folder)) return true;
			}
			return false;
		} catch {
			// An unreadable current root is established data, not permission to
			// merge a retained backup into an unknown destination.
			return true;
		}
	}

	private async readLegacyRootMigrationCheckpoint(): Promise<LegacyRootMigrationCheckpoint | null> {
		try {
			if (!(await this.fs.exists(projectPaths.legacyRootMigrationFile))) return null;
			const decoded = JSON.parse(await this.fs.read(projectPaths.legacyRootMigrationFile)) as Record<string, unknown>;
			if (decoded.schemaVersion !== 1 || !LEGACY_PROJECT_ROOTS.includes(decoded.source as typeof LEGACY_PROJECT_ROOTS[number]) ||
				(decoded.status !== "in-progress" && decoded.status !== "complete")) return null;
			return { schemaVersion: 1, source: decoded.source as typeof LEGACY_PROJECT_ROOTS[number], status: decoded.status };
		} catch {
			return null;
		}
	}

	private async ensureParentDirectories(filePath: string): Promise<void> {
		const parent = filePath.split("/").slice(0, -1).join("/");
		if (parent.length > 0) await this.ensureDirectory(parent);
	}

	/**
	 * Read `WritingBuddy/project.json`, creating it if absent.
	 *
	 * No identifier is generated. The vault is the project boundary, so the file
	 * holds only metadata; a missing or damaged one is simply rewritten with
	 * defaults rather than left to block the plugin.
	 *
	 * A `projectId` written by an older version is tolerated and reported back
	 * once — the caller needs it to migrate device-local state keyed by it — and
	 * then dropped, so the obsolete field stops being written.
	 */
	async loadProjectMetadata(): Promise<LoadedProjectMetadata> {
		const fallback: ProjectMetadata = {
			schemaVersion: PROJECT_SCHEMA_VERSION,
			displayName: this.defaultDisplayName,
		};

		if (!(await this.fs.exists(projectPaths.projectFile))) {
			await this.saveProjectMetadata(fallback);
			return { metadata: fallback, migratedFromProjectId: null };
		}

		let decoded: Record<string, unknown>;
		try {
			decoded = JSON.parse(await this.fs.read(projectPaths.projectFile)) as Record<string, unknown>;
		} catch {
			// A corrupted metadata file must not make the vault unusable, and it
			// holds nothing that cannot be regenerated.
			await this.saveProjectMetadata(fallback);
			return { metadata: fallback, migratedFromProjectId: null };
		}

		const metadata: ProjectMetadata = {
			schemaVersion: PROJECT_SCHEMA_VERSION,
			displayName:
				typeof decoded.displayName === "string" && decoded.displayName.length > 0
					? decoded.displayName
					: this.defaultDisplayName,
			...(decoded.instructionLanguage === "en" || decoded.instructionLanguage === "zh" || decoded.instructionLanguage === "auto"
				? { instructionLanguage: decoded.instructionLanguage }
				: {}),
		};

		const legacy = typeof decoded.projectId === "string" ? decoded.projectId : null;
		if (legacy !== null) {
			// Rewrite without the obsolete field. Nothing else in the vault is
			// touched: conversations, edits and skills are separate files.
			await this.saveProjectMetadata(metadata);
		}

		return { metadata, migratedFromProjectId: legacy };
	}

	async saveProjectMetadata(metadata: ProjectMetadata): Promise<void> {
		await this.withLayout(() =>
			this.fs.write(projectPaths.projectFile, `${JSON.stringify(metadata, null, "\t")}\n`),
		);
	}

	// --- conversations -----------------------------------------------------

	async listSessionIds(): Promise<string[]> {
		if (!(await this.fs.exists(projectPaths.conversationsDir))) return [];
		const { files } = await this.fs.list(projectPaths.conversationsDir);
		return files
			.map((path) => path.split("/").pop() ?? "")
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.slice(0, -".json".length))
			.filter(isSafeSessionId);
	}

	async loadSession(sessionId: string): Promise<ConversationSession | null> {
		const result = await this.readSessionFile(sessionId);
		return result.kind === "loaded" ? result.session : null;
	}

	/**
	 * One conversation from either layout.
	 *
	 * Schema 6 puts the transcript in shards beside a metadata-only manifest;
	 * every earlier schema keeps everything in the one file. Which it is, is a
	 * property of the file, so both remain readable indefinitely and no
	 * migration has to have run first.
	 *
	 * A shard that is absent or unreadable yields no messages rather than
	 * failing the conversation. That is the design's load-bearing simplification:
	 * a half-delivered sync reads as a *shorter* transcript, and "the other side
	 * has fewer messages" is a relationship D-011 already resolves in favour of
	 * the longer one, without preserving anything as a copy.
	 */
	private async parseConversationFile(sessionId: string, raw: string): Promise<ParseResult<ConversationSession>> {
		let decoded: unknown;
		try {
			decoded = JSON.parse(raw);
		} catch (error) {
			return { ok: false, reason: (error as Error).message };
		}
		if (!isShardedManifest(decoded)) return validateSession(decoded);

		const manifest = parseManifest(decoded);
		if (!manifest.ok) return manifest;
		return { ok: true, value: assembleSession(manifest.value, await this.readShards(sessionId)) };
	}

	/**
	 * The conversation currently on disk, as one self-contained document.
	 *
	 * Snapshots are taken from this rather than from the manifest bytes: since
	 * schema 6 the manifest holds no messages, so archiving it would archive
	 * nothing worth recovering. Serialized in the single-file format so a
	 * snapshot stays readable on its own, and by a build that predates shards.
	 */
	private async assembledOnDisk(sessionId: string): Promise<string | null> {
		try {
			const path = conversationPath(sessionId);
			if (!(await this.fs.exists(path))) return null;
			const parsed = await this.parseConversationFile(sessionId, await this.fs.read(path));
			if (!parsed.ok) return null;
			return serializeSession({ ...parsed.value, id: sessionId });
		} catch {
			return null;
		}
	}

	private async readShards(sessionId: string): Promise<Array<{ name: string; contents: string }>> {
		const directory = conversationShardDir(sessionId);
		try {
			if (!(await this.fs.exists(directory))) return [];
			const listed = await this.fs.list(directory);
			const shards: Array<{ name: string; contents: string }> = [];
			for (const path of listed.files) {
				const name = path.split("/").pop() ?? "";
				if (!isShardFileName(name)) continue;
				try {
					shards.push({ name: name.slice(0, -".json".length), contents: await this.fs.read(path) });
				} catch {
					// Mid-sync placeholders read as missing turns, not a broken file.
				}
			}
			return shards;
		} catch {
			return [];
		}
	}

	/**
	 * Read one conversation without letting a partially-synced file throw through
	 * a vault event callback. The filename remains authoritative even when the
	 * JSON carries a stale id from a copied or renamed file.
	 */
	async readSessionFile(sessionId: string): Promise<SessionFileReadResult> {
		if (!isSafeSessionId(sessionId)) {
			return { kind: "malformed", sessionId, reason: "unsafe session id" };
		}

		const path = conversationPath(sessionId);
		try {
			if (!(await this.fs.exists(path))) return { kind: "missing", sessionId };
			const raw = await this.fs.read(path);
			const parsed = await this.parseConversationFile(sessionId, raw);
			if (!parsed.ok) {
				return {
					kind: "malformed",
					sessionId,
					reason: parsed.reason,
					fingerprint: fingerprintSessionContents(raw),
				};
			}
			const session = { ...parsed.value, id: sessionId };
			return {
				kind: "loaded",
				sessionId,
				session,
				// Fingerprint the validated representation. Whitespace, key order and
				// stale JSON ids should not turn an idempotent event into a change.
				fingerprint: fingerprintSessionContents(serializeSession(session)),
			};
		} catch (error) {
			return { kind: "malformed", sessionId, reason: (error as Error).message };
		}
	}

	/**
	 * Load every session, reporting rather than throwing on damaged files.
	 *
	 * Read a few files at a time rather than one after another. Every read is a
	 * round-trip through Obsidian's adapter, and this runs at startup, so a
	 * strictly sequential loop made opening the vault cost one latency per
	 * conversation — a number that only grows as a writer accumulates history.
	 * Nothing about the result changes: the outcome per file is independent, and
	 * the list is sorted afterwards regardless.
	 */
	async loadAllSessions(): Promise<LoadedSessions> {
		const ids = await this.listSessionIds();

		const outcomes = await mapWithConcurrency(ids, async (sessionId) => {
			try {
				// The same parser the event path uses, so a conversation reads
				// identically at startup and mid-session, in either layout.
				const parsed = await this.parseConversationFile(sessionId, await this.fs.read(conversationPath(sessionId)));
				return parsed.ok
					? { session: { ...parsed.value, id: sessionId } }
					: { broken: { sessionId, reason: parsed.reason } };
			} catch (error) {
				return { broken: { sessionId, reason: (error as Error).message } };
			}
		});

		const sessions: ConversationSession[] = [];
		const broken: BrokenSession[] = [];
		for (const outcome of outcomes) {
			if ("session" in outcome && outcome.session) sessions.push(outcome.session);
			else if ("broken" in outcome && outcome.broken) broken.push(outcome.broken);
		}

		sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return { sessions, broken };
	}

	async saveSession(session: ConversationSession): Promise<void> {
		await this.saveSessionWithReceipt(session);
	}

	/** Save a conversation and expose the exact revision to a vault-event guard. */
	async saveSessionWithReceipt(session: ConversationSession): Promise<SessionWriteReceipt> {
		if (!isSafeSessionId(session.id)) {
			throw new Error(`Refusing to write a session with an unsafe id: ${session.id}`);
		}
		const toWrite: ConversationSession = {
			...session,
			schemaVersion: SHARDED_CONVERSATION_SCHEMA_VERSION,
			updatedAt: nowIso(),
		};
		const path = conversationPath(session.id);
		const { manifest, shards } = serializeShardedSession(toWrite);
		// Whatever is on disk right now goes to local history first. Usually that
		// is our own previous revision; when it is not, it is the thing a sync put
		// there, which is exactly the content nothing else can recover.
		await this.history?.snapshot(session.id, await this.assembledOnDisk(session.id));
		await this.withLayout(async () => {
			await this.writeShards(session.id, shards);
			await this.fs.write(path, manifest);
		});

		const canonical = assembleSession(
			(() => {
				const parsed = parseManifest(JSON.parse(manifest));
				if (!parsed.ok) throw new Error(`WritingBuddy serialized an invalid manifest: ${parsed.reason}`);
				return parsed.value;
			})(),
			shards,
		);
		return {
			sessionId: session.id,
			path,
			// Fingerprint the assembled conversation, not the manifest: two
			// revisions differing only in where the bytes sit say the same thing,
			// and conflict classification compares what a conversation says.
			fingerprint: fingerprintSessionContents(serializeSession(canonical)),
			session: { ...canonical, id: session.id },
		};
	}

	/**
	 * Write only the shards whose bytes changed, and drop any left over.
	 *
	 * This is where the saving actually happens. A shard that did not change is
	 * not written, so sync neither uploads it again nor stores another revision
	 * of it; appending a turn touches the one shard it lands in. Leftovers are
	 * removed so a conversation that shrank — a branch, a restore — does not
	 * keep reading its own deleted tail back on the next load.
	 */
	private async writeShards(sessionId: string, shards: readonly ConversationShard[]): Promise<void> {
		const directory = conversationShardDir(sessionId);
		if (shards.length > 0 && !(await this.fs.exists(directory))) {
			try {
				await this.fs.mkdir(directory);
			} catch {
				if (!(await this.fs.exists(directory))) throw new Error(`Cannot create ${directory}`);
			}
		}

		const wanted = new Set(shards.map((shard) => `${shard.name}.json`));
		for (const shard of shards) {
			const shardPath = conversationShardPath(sessionId, shard.name);
			let existing: string | null = null;
			try {
				if (await this.fs.exists(shardPath)) existing = await this.fs.read(shardPath);
			} catch {
				existing = null;
			}
			if (existing === shard.contents) continue;
			await this.fs.write(shardPath, shard.contents);
		}

		try {
			if (!(await this.fs.exists(directory))) return;
			for (const path of (await this.fs.list(directory)).files) {
				const name = path.split("/").pop() ?? "";
				if (isShardFileName(name) && !wanted.has(name)) await this.fs.remove(path);
			}
		} catch {
			// A stale shard that cannot be removed is re-checked on the next write.
		}
	}

	/**
	 * Rewrite every conversation in the inline format an older build can read.
	 *
	 * The way back. A schema this build writes is refused by a build that
	 * predates it, so the new format is only safe to ship alongside an
	 * operation that undoes it. Parsing inlines every reference, so writing the
	 * parsed session back inline restores exactly what the older format held —
	 * asserted, not assumed, by a round-trip test.
	 *
	 * A session that cannot be read is left exactly as it is: it is already
	 * beyond what this can help with, and rewriting a guess would be worse.
	 */
	async rewriteAllSessionsInline(): Promise<{ written: string[]; skipped: Array<{ sessionId: string; reason: string }> }> {
		const written: string[] = [];
		const skipped: Array<{ sessionId: string; reason: string }> = [];
		for (const sessionId of await this.listSessionIds()) {
			const read = await this.readSessionFile(sessionId);
			if (read.kind !== "loaded") {
				skipped.push({ sessionId, reason: read.kind === "missing" ? t("session.fileMissing") : read.reason });
				continue;
			}
			try {
				await this.withLayout(() => this.fs.write(
					conversationPath(sessionId),
					serializeSessionAsInline(read.session),
				));
				// The transcript is back inside the one file, so the shards are now
				// a second copy that an older build cannot see and this one would
				// still read. Removing them is what makes the downgrade complete
				// rather than a file an upgrade would immediately contradict.
				await this.removeShardDirectory(sessionId);
				written.push(sessionId);
			} catch (error) {
				skipped.push({ sessionId, reason: (error as Error).message });
			}
		}
		return { written, skipped };
	}

	/**
	 * Permanently remove a session file.
	 *
	 * Closing a session is *not* this — closed sessions stay on disk and can be
	 * reopened. This is only for an explicit, confirmed delete.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		if (!isSafeSessionId(sessionId)) return;
		const path = conversationPath(sessionId);
		if (await this.fs.exists(path)) {
			// One last revision before it goes. A deliberate delete is still the
			// most common way to lose a conversation by accident.
			await this.history?.snapshot(sessionId, await this.assembledOnDisk(sessionId));
			await this.fs.remove(path);
		}
		// The manifest is what makes a conversation exist, but shards left behind
		// would be read back the moment anything recreated that id.
		await this.removeShardDirectory(sessionId);
	}

	private async removeShardDirectory(sessionId: string): Promise<void> {
		const directory = conversationShardDir(sessionId);
		try {
			if (!(await this.fs.exists(directory))) return;
			for (const shardPath of (await this.fs.list(directory)).files) {
				if (isShardFileName(shardPath.split("/").pop() ?? "")) await this.fs.remove(shardPath);
			}
			await this.fs.remove(directory);
		} catch {
			// An undeletable folder is cosmetic once the manifest no longer points
			// at it; the next write re-checks and cleans up.
		}
	}

	/** Previous local revisions of one conversation, newest first. */
	async sessionHistory(sessionId: string): Promise<Array<{ path: string; stamp: string }>> {
		return (await this.history?.list(sessionId)) ?? [];
	}

	/**
	 * What this plugin is taking up, split by what the writer can decide about.
	 *
	 * `synced` is the visible project root — the writer's own conversations and
	 * material, which Obsidian Sync uploads and keeps revisions of against a
	 * paid quota. `local` is the hidden root: derived analysis memos and the
	 * conversation safety net, which sync never touches and which are safe to
	 * clear. Splitting them is the point; a single total would say nothing
	 * about what is safe to delete.
	 */
	async storageUsage(): Promise<{
		synced: { files: number; bytes: number };
		local: { files: number; bytes: number };
	}> {
		return {
			synced: await this.measureTree(projectPaths.root),
			local: await this.measureTree(CACHE_DIR),
		};
	}

	/**
	 * Delete the hidden, regenerable half.
	 *
	 * Analysis memos cost a recomputation; conversation snapshots cost the
	 * ability to recover a conversation this device has already replaced. Both
	 * are the writer's call, which is why nothing here runs on its own.
	 */
	async clearLocalCache(): Promise<{ removed: number }> {
		return { removed: await this.removeTree(CACHE_DIR) };
	}

	private async measureTree(root: string): Promise<{ files: number; bytes: number }> {
		let files = 0;
		let bytes = 0;
		const pending = [root];
		while (pending.length > 0) {
			const directory = pending.pop();
			if (directory === undefined) break;
			let listed: { files: string[]; folders: string[] };
			try {
				if (!(await this.fs.exists(directory))) continue;
				listed = await this.fs.list(directory);
			} catch {
				continue;
			}
			pending.push(...listed.folders);
			for (const path of listed.files) {
				files += 1;
				bytes += await this.byteSize(path);
			}
		}
		return { files, bytes };
	}

	private async byteSize(path: string): Promise<number> {
		try {
			if (this.fs.stat) {
				const stat = await this.fs.stat(path);
				if (stat) return stat.size;
			}
			return (await this.fs.read(path)).length;
		} catch {
			return 0;
		}
	}

	private async removeTree(root: string): Promise<number> {
		if (!(await this.fs.exists(root))) return 0;
		let removed = 0;
		const directories: string[] = [];
		const pending = [root];
		while (pending.length > 0) {
			const directory = pending.pop();
			if (directory === undefined) break;
			directories.push(directory);
			let listed: { files: string[]; folders: string[] };
			try {
				listed = await this.fs.list(directory);
			} catch {
				continue;
			}
			pending.push(...listed.folders);
			for (const path of listed.files) {
				try {
					await this.fs.remove(path);
					removed += 1;
				} catch {
					// A file held open elsewhere stays; the count reports what went.
				}
			}
		}
		// Deepest first, so a folder is empty by the time it is removed.
		for (const directory of directories.reverse()) {
			await this.fs.remove(directory).catch(() => undefined);
		}
		return removed;
	}

	/** The exact bytes of one archived revision, for a recovery command. */
	async readSessionHistoryEntry(path: string): Promise<string | null> {
		return (await this.history?.read(path)) ?? null;
	}

	// --- edit history ------------------------------------------------------

	async loadEditHistory(): Promise<EditToken[]> {
		if (!(await this.fs.exists(projectPaths.editHistoryFile))) return [];
		try {
			const decoded: unknown = JSON.parse(await this.fs.read(projectPaths.editHistoryFile));
			if (!Array.isArray(decoded)) return [];
			return decoded.filter(isEditToken);
		} catch {
			return [];
		}
	}

	async saveEditHistory(tokens: EditToken[]): Promise<void> {
		const trimmed = tokens.slice(-EDIT_HISTORY_LIMIT);
		await this.withLayout(() =>
			this.fs.write(projectPaths.editHistoryFile, `${JSON.stringify(trimmed, null, "\t")}\n`),
		);
	}

	// --- skills ------------------------------------------------------------

	/**
	 * Vault-relative paths of every active Markdown skill file.
	 *
	 * Flat files are legacy inputs. Structured custom/override files are the
	 * writer-owned active store; state and future history folders stay inert.
	 */
	async listSkillFiles(): Promise<string[]> {
		return (await this.listStoredSkillFiles()).map((entry) => entry.path);
	}

	async listStoredSkillFiles(options: { includeLegacy?: boolean } = {}): Promise<StoredSkillFile[]> {
		const groups: StoredSkillFile[][] = [];
		const locations: Array<readonly [string, StoredSkillLocation]> = [
			[projectPaths.customSkillsDir, "custom"],
			[projectPaths.skillOverridesDir, "override"],
		];
		if (options.includeLegacy !== false) locations.push([projectPaths.skillsDir, "legacy"]);
		for (const [directory, location] of locations) {
			if (!(await this.fs.exists(directory))) {
				groups.push([]);
				continue;
			}
			const { files } = await this.fs.list(directory);
			groups.push(files
				.filter((path) => path.toLowerCase().endsWith(".md"))
				.sort((left, right) => left.localeCompare(right))
				.map((path) => ({ path, location })));
		}
		return groups.flat();
	}

	async readSkillFile(path: string): Promise<string> {
		return this.fs.read(path);
	}

	async writeSkillFile(path: string, contents: string): Promise<void> {
		await this.withLayout(() => this.fs.write(path, contents));
	}

	async removeSkillFile(path: string): Promise<void> {
		if (await this.fs.exists(path)) await this.fs.remove(path);
	}

	async readSkillMigrationManifest(): Promise<string | null> {
		if (!(await this.fs.exists(projectPaths.skillMigrationFile))) return null;
		return this.fs.read(projectPaths.skillMigrationFile);
	}

	async writeSkillMigrationManifest(contents: string): Promise<void> {
		await this.withLayout(() => this.fs.write(projectPaths.skillMigrationFile, contents));
	}

	async readSkillResetState(): Promise<string | null> {
		if (!(await this.fs.exists(projectPaths.skillResetStateFile))) return null;
		return this.fs.read(projectPaths.skillResetStateFile);
	}

	async writeSkillResetState(contents: string): Promise<void> {
		await this.withLayout(() => this.fs.write(projectPaths.skillResetStateFile, contents));
	}

	async fileExists(path: string): Promise<boolean> {
		return this.fs.exists(path);
	}
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
	return true;
}

/**
 * Stable, synchronous content fingerprint for event de-duplication. This is not
 * a security primitive; FNV-1a over UTF-16 code units is sufficient to tell a
 * local write notification from different bytes delivered by sync.
 */
export function fingerprintSessionContents(contents: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < contents.length; index += 1) {
		const code = contents.charCodeAt(index);
		hash ^= code & 0xff;
		hash = Math.imul(hash, 0x01000193);
		hash ^= code >>> 8;
		hash = Math.imul(hash, 0x01000193);
	}
	return `${contents.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function isEditToken(value: unknown): value is EditToken {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.filePath === "string" &&
		typeof record.originalText === "string" &&
		typeof record.replacement === "string" &&
		typeof record.from === "object" &&
		typeof record.to === "object"
	);
}
