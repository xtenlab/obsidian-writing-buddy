/**
 * WritingBuddy / 墨伴 — plugin entry point.
 *
 * Responsibilities kept here and nowhere else: wiring the stores, choosing a
 * backend, registering commands and the editor menu, and resolving which
 * editor corresponds to a manuscript path. Everything with behaviour of its own
 * lives in a module that can be tested without Obsidian.
 */

import { MarkdownView, Notice, Plugin, TFile, normalizePath, requestUrl, type TAbstractFile } from "obsidian";
import type { App } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { Editor } from "obsidian";

import { resolveInstructionLocale, resolveUiLocale, setInstructionLocale, setLocale, t } from "./i18n";
import type { AIBackend, Capabilities, EffortCapability, ModelCapability } from "./backend/AIBackend";
import { MockAIBackend } from "./backend/MockAIBackend";
import {
	effortsFor,
	modelsFor,
	providerDisplayName,
	providerNameFrom,
} from "./backend/capabilities";
import { setVaultConfigDir } from "./context/eligibility";
import { knownEvidenceKindLabels } from "./context/evidence";
import { ObsidianVaultFs } from "./obsidianVaultFs";
import { ObsidianVaultReader } from "./obsidianVaultReader";
import { revealExactCitation } from "./navigation/citationRange";
import { ContextAssembler } from "./context/ContextAssembler";
import { ProjectStore, type MigrationReport } from "./storage/ProjectStore";
import { SessionHistoryStore } from "./storage/SessionHistoryStore";
import { RestoreConversationModal, readableStamp, type RestorableRevision } from "./ui/restoreConversationModal";
import { parseSession } from "./storage/conversationSchema";
import { projectPaths } from "./storage/paths";
import { ProjectRootController } from "./projectRootController";
import { projectDataPath } from "./sync/projectDataEvents";
import {
	DeviceStore,
	VaultDeviceState,
	type DeviceSettings,
	type VaultScopedStorage,
} from "./storage/DeviceStore";
import { SkillRegistry } from "./skills/SkillRegistry";
import { SessionManager, SESSION_RECOMMENDED_LIMIT } from "./session/SessionManager";
import { ConversationController } from "./session/ConversationController";
import { FullCorpusController } from "./session/FullCorpusController";
import { FullCorpusMemoStore } from "./storage/FullCorpusMemoStore";
import { ResearchController } from "./session/ResearchController";
import { ForegroundTurnCoordinator, type ForegroundTurnLease } from "./session/ForegroundTurnCoordinator";
import { ProjectInstructions } from "./instructions";
import { WRITING_BUDDY_VIEW, WritingBuddyView } from "./ui/WritingBuddyView";
import { StartupProfile } from "./util/startupProfile";
import { WritingBuddySettingTab } from "./ui/settingsTab";
import { ICONS } from "./ui/icons";
import { locatePassage } from "./editing/reanchor";
import type { DocPosition, EditToken, ProjectMetadata, SelectionAttachment, SessionPreferences } from "./types";
import { EDIT_HISTORY_LIMIT } from "./storage/ProjectStore";
import { fetchStreamClient } from "./backend/streaming";
import { BackendRegistry, RoutingAIBackend } from "./connections/BackendRegistry";
import { upsertConnection } from "./connections/schema";
import { parseJsonBody, type HttpClient } from "./backend/HttpClient";
import type { AIConnection, ConnectionRecord } from "./connections/types";
import { connectionSnapshot } from "./connections/types";
import { activateOrOpenFileLeaf } from "./navigation/fileLeaf";
import { captureSelection, sameAttachment } from "./editing/selection";
import { SelectionBridgeCoordinator, type ProgrammaticSelectionTarget } from "./editing/selectionBridge";
import {
	codeMirrorViewForEditor,
	createSelectionBridgeExtension,
	selectProgrammaticRange,
	shouldObserveMarkdownSelection,
	showAttachedSelection,
} from "./editing/selectionBridgeExtension";
import type { EditorView } from "@codemirror/view";
import type { SkillDescriptor, SkillLoadProblem } from "./skills/SkillRegistry";

/** The stored language choice, resolved to a concrete locale. */
/** An editor together with the manuscript path it is showing. */
export interface ResolvedEditor {
	editor: Editor;
	filePath: string;
}

export default class WritingBuddyPlugin extends Plugin {
	projectStore!: ProjectStore;
	/** Where the project root is, and the follow/recover behaviour around it. */
	projectRoot!: ProjectRootController;
	deviceStore!: DeviceStore;
	deviceSettings!: DeviceSettings;
	skills!: SkillRegistry;
	sessions!: SessionManager;
	controller!: ConversationController;
	fullCorpusController!: FullCorpusController;
	researchController!: ResearchController;
	projectInstructions!: ProjectInstructions;
	/** The one view allowed to drive the plugin's singleton turn controllers. */
	readonly foregroundTurns = new ForegroundTurnCoordinator<WritingBuddyView>();
	/** Reads the local vault so WritingBuddy, not the Runtime, owns context. */
	contextAssembler!: ContextAssembler;

	projectMetadata: ProjectMetadata | null = null;
	/** Per-vault device state. Obsidian namespaces the storage for us. */
	vaultState!: VaultDeviceState;
	connectionRegistry!: BackendRegistry;
	editHistory: EditToken[] = [];

	/**
	 * Where startup time went, for the current session.
	 *
	 * Kept because "opening the vault is slow" is otherwise unanswerable: it
	 * separates time Obsidian spent before handing over from time this plugin
	 * spent, and attributes the latter to a phase and a number of vault I/O
	 * calls. Reported by the 启动耗时 command and in Settings.
	 */
	startup: StartupProfile | null = null;

	/** Set when project data failed to load, so the view can say so. */
	loadError: string | null = null;

	/** Message counts at the last automatic rename, by conversation. */
	private readonly titledAtBySession = new Map<string, number>();

	/**
	 * Why the last automatic title generation did not produce a title.
	 *
	 * A failure here is invisible by design — the conversation keeps its
	 * fallback name and nothing interrupts the writer — which is exactly how it
	 * stayed broken without anyone being able to say what was wrong. The reason
	 * is kept and shown under Settings → 诊断.
	 */
	/** Populated when data was migrated out of the legacy hidden root. */
	migration: MigrationReport | null = null;

	private vaultFs!: ObsidianVaultFs;
	private backend!: AIBackend;
	private ready!: Promise<void>;
	private markReady!: () => void;
	private settingTab: WritingBuddySettingTab | null = null;
	private readonly projectEventTimers = new Map<string, number>();
	private projectEventChain: Promise<void> = Promise.resolve();
	private readonly selectionEditorViews = new Set<EditorView>();
	private selectionBridge!: SelectionBridgeCoordinator<SelectionAttachment>;

	async onload(): Promise<void> {
		// Resolved once project data is on hand. The sidebar can be restored by
		// the workspace before — or after — layout-ready fires, so views wait on
		// this instead of assuming they were constructed in a useful order.
		this.ready = new Promise<void>((resolve) => {
			this.markReady = resolve;
		});

		// The configuration folder can be renamed by the user; nothing in it is manuscript.
		setVaultConfigDir(this.app.vault.configDir);

		this.deviceStore = new DeviceStore();
		this.deviceSettings = this.deviceStore.load();
		// Before anything can compose a sentence. The writer's device-local
		// choice wins; absent (the default) follows Obsidian's own UI language.
		setLocale(resolveUiLocale(this.deviceSettings.uiLocale));
		// Persist immediately: this makes legacy singleton migration one-time and
		// stops writing the old URL/token/default fields back to device storage.
		this.deviceStore.save(this.deviceSettings);
		this.vaultState = new VaultDeviceState(new ObsidianVaultScopedStorage(this.app));

		this.vaultFs = new ObsidianVaultFs(this.app.vault.adapter);
		this.projectInstructions = new ProjectInstructions(this.vaultFs);
		this.startup = new StartupProfile(() => this.vaultFs.callCount);
		this.projectStore = new ProjectStore(
			this.vaultFs,
			this.app.vault.getName(),
			new SessionHistoryStore(this.vaultFs),
		);
		this.projectRoot = new ProjectRootController(this, this.vaultFs);
		this.skills = new SkillRegistry(this.projectStore);
		this.sessions = new SessionManager(this.projectStore, (conflict) => {
			const preferences = this.vaultState.sessionPreferences(conflict.originalSessionId);
			if (preferences) {
				this.vaultState.setSessionPreferences(conflict.preservedSession.id, preferences);
			}
			this.vaultState.retainSessionPreferences(this.sessions.all().map((session) => session.id));
			new Notice(conflict.reason, 12_000);
			this.selectionBridge?.conversationChanged();
			this.rememberActiveSession();
			this.refreshViews();
			this.refreshSelectionHighlights();
		});
		const vaultReader = new ObsidianVaultReader(this.app);
		this.contextAssembler = new ContextAssembler(vaultReader);
		this.connectionRegistry = new BackendRegistry({
			connections: this.deviceSettings.connections,
			onChange: () => this.refreshViews(),
			httpClient: obsidianHttpClient,
			// Replies stream through the renderer's fetch where the server allows
			// it; anything else falls back to requestUrl and arrives whole.
			streamClient: fetchStreamClient(),
		});
		this.backend = this.deviceSettings.useMockBackend
			? new MockAIBackend({ chunkDelayMs: 25 })
			: new RoutingAIBackend(this.connectionRegistry);
		this.controller = new ConversationController(this.backend);
		this.fullCorpusController = new FullCorpusController(
			vaultReader,
			this.backend,
			undefined,
			undefined,
			new FullCorpusMemoStore(this.vaultFs),
		);
		this.researchController = new ResearchController(vaultReader, this.backend);
		this.selectionBridge = new SelectionBridgeCoordinator<SelectionAttachment>({
			activeSessionId: () => this.sessions.getActiveId(),
			ensureActiveSessionId: async () => (await this.sessions.ensureActive()).id,
			currentSelection: (sessionId) => this.sessions.get(sessionId)?.selection ?? null,
			writeSelection: (sessionId, selection) => this.sessions.setSelection(sessionId, selection),
			equals: sameAttachment,
			onApplied: (sessionId) => {
				if (sessionId === this.sessions.getActiveId()) {
					this.rememberActiveSession();
					this.refreshViews();
				}
				this.refreshSelectionHighlights();
			},
			onError: (error) => console.error("[WritingBuddy] Selection bridge failed", error),
		});
		this.registerEditorExtension(createSelectionBridgeExtension({
			currentSelection: () => this.sessions?.getActive()?.selection ?? null,
			onCreate: (view) => {
				this.selectionEditorViews.add(view);
			},
			onUpdate: (update) => {
				if (!this.sessions.isLoaded) return;
				if (!shouldObserveMarkdownSelection(update)) return;
				const attachment = captureSelection(
					update.editor,
					update.filePath,
				);
				this.selectionBridge.observeUserSelection(attachment);
			},
			onDestroy: (view) => this.selectionEditorViews.delete(view),
		}));

		this.registerView(WRITING_BUDDY_VIEW, (leaf) => new WritingBuddyView(leaf, this));
		this.settingTab = new WritingBuddySettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon(ICONS.brand, t("settings.pluginName"), () => void this.activateView());
		this.registerCommands();
		this.registerEditorMenu();
		this.registerProjectDataEvents();

		// Vault I/O is deferred until the workspace is ready: touching the
		// adapter during startup races Obsidian's own indexing. The wait is
		// recorded, because it is time this plugin did not spend — Obsidian and
		// everything else installed did.
		this.app.workspace.onLayoutReady(() => {
			this.startup?.mark(t("main.stepAwaitReady"));
			void this.initializeProjectData();
		});
	}

	setFullCorpusConcurrency(batches: number): Promise<void> {
		this.deviceSettings.fullCorpusConcurrency = batches;
		return this.saveDeviceSettings();
	}

	setFullCorpusDeadlineMinutes(minutes: number): Promise<void> {
		this.deviceSettings.fullCorpusDeadlineMinutes = minutes;
		return this.saveDeviceSettings();
	}

	/**
	 * Choose the language the model is instructed in, for this project.
	 *
	 * Saved into project.json so it travels with the vault, then applied to the
	 * running session: skills reload so the built-in set swaps language, and
	 * prompts pick it up per turn. Conversations already in flight keep the
	 * language they started with only until their next turn.
	 */
	async setInstructionLanguage(value: "zh" | "en" | "auto"): Promise<void> {
		if (!this.projectMetadata) return;
		this.projectMetadata = { ...this.projectMetadata, instructionLanguage: value };
		setInstructionLocale(resolveInstructionLocale(value));
		await this.projectStore.saveProjectMetadata(this.projectMetadata);
		await this.skills.reload();
		this.refreshViews();
	}

	/** Choose the interface language for this device and apply it right away. */
	async setUiLocale(value: "zh" | "en" | "auto"): Promise<void> {
		this.deviceSettings.uiLocale = value;
		setLocale(resolveUiLocale(value));
		// The instruction language follows the interface unless pinned, and the
		// built-in skills' names follow the interface always; both live in the
		// skill registry, so it reloads.
		setInstructionLocale(resolveInstructionLocale(this.projectMetadata?.instructionLanguage));
		await this.skills.reload();
		// Every visible surface re-reads its strings on render; commands and the
		// ribbon were registered at load and keep their names until a restart.
		this.refreshViews();
		return this.saveDeviceSettings();
	}

	onunload(): void {
		for (const timer of this.projectEventTimers.values()) window.clearTimeout(timer);
		this.projectEventTimers.clear();
		this.selectionBridge?.dispose();
		this.selectionEditorViews.clear();
		// Obsidian does not wait for unload; in-flight work is cancelled in the background.
		void this.cancelInFlightWork();
	}

	private async cancelInFlightWork(): Promise<void> {
		const foreground = this.foregroundTurns.activeLease;
		if (foreground) {
			await this.cancelGeneration(foreground);
			this.foregroundTurns.release(foreground);
		} else {
			for (const view of this.views()) view.cancelLocalPreparation();
			await Promise.allSettled([
				this.controller?.cancel(),
				this.researchController?.cancel(),
				this.fullCorpusController?.cancel(),
			]);
		}
	}

	/** Acquire the unique foreground slot before even asynchronous preflight. */
	acquireForegroundTurn(owner: WritingBuddyView): ForegroundTurnLease<WritingBuddyView> | null {
		return this.foregroundTurns.tryAcquire(owner);
	}

	/** Release only this exact turn; stale finally blocks are harmless. */
	releaseForegroundTurn(lease: ForegroundTurnLease<WritingBuddyView>): boolean {
		const released = this.foregroundTurns.release(lease);
		if (released) this.refreshViews();
		return released;
	}

	/** Stop the captured foreground lease, never a turn that replaced it. */
	async cancelGeneration(lease: ForegroundTurnLease<WritingBuddyView>): Promise<void> {
		try {
			await this.foregroundTurns.cancel(lease, async () => {
				lease.owner.cancelLocalPreparation();
				await Promise.allSettled([
					this.controller.cancel(),
					this.researchController.cancel(),
					this.fullCorpusController.cancel(),
				]);
			});
		} finally {
			this.refreshViews();
		}
	}

	/** Flush a debounced editor gesture before any turn reads its session. */
	flushPendingSelection(): Promise<void> {
		return this.selectionBridge.flushPending();
	}

	// --- initialization ----------------------------------------------------

	private async initializeProjectData(): Promise<void> {
		const profile = this.startup;
		/** Time a phase when profiling is on, and simply run it when it is not. */
		const step = <T>(label: string, run: () => Promise<T>): Promise<T> =>
			profile ? profile.measure(label, run) : run();

		try {
			// Where the root is comes first: everything below reads from it. A
			// root that is recorded but absent stops here — the writer is told,
			// and nothing is created (see `ProjectRootController`).
			const proceed = await step(t("main.stepResolveRoot"), () => this.projectRoot.resolveAtStartup());
			if (!proceed) {
				this.loadError = null;
				return;
			}
			// One-time copy out of the pre-1.0 hidden root, before anything else
			// looks at the new location.
			const migration = await step(t("main.stepMigrateLegacy"), () => this.projectStore.migrateLegacyRoot());
			if (migration.ran) {
				this.migration = migration;
				if (migration.failed.length > 0) {
					new Notice(
						t("main.migrationPartial", { from: migration.from ?? "", count: migration.failed.length }),
						15_000,
					);
				} else {
					new Notice(
						t("main.migrationDone", { from: migration.from ?? "", count: migration.copied.length, root: projectPaths.root }),
						12_000,
					);
				}
			}

			await this.loadProjectData(step);
			this.loadError = null;

			// Best-effort startup discovery lets the Composer offer only capabilities
			// the enabled Connections actually report. Failure is non-fatal and leaves
			// the selection explicitly unavailable; there is no synthetic default.
			void this.connectionRegistry.refreshAll();
		} catch (error) {
			this.loadError = describe(error);
			new Notice(t("main.initFailed", { reason: this.loadError }));
		} finally {
			// Views must be released even on failure, or the sidebar sits on a
			// loading state forever with no way to report what went wrong.
			this.markReady();
			this.refreshViews();
			this.refreshSelectionHighlights();
			profile?.mark(t("main.firstRender"));
		}
	}

	/**
	 * Read everything that lives under the project root.
	 *
	 * Shared by startup and by a root change: when the folder moves, or is
	 * chosen anew in Settings, what was read from the old location is read
	 * again from the new one rather than patched in place.
	 */
	private async loadProjectData(step: <T>(label: string, run: () => Promise<T>) => Promise<T>): Promise<void> {
		await step(t("main.stepEnsureLayout"), () => this.projectStore.ensureLayout());
		// Derived Full-analysis memos leave the synced root. Silent on purpose:
		// nothing the writer owns moves, and a partial move simply retries on
		// the next launch.
		void this.projectStore.migrateCacheOutOfProjectRoot().catch(() => undefined);
		const project = await step(t("main.stepReadProject"), () =>
			this.projectStore.loadProjectMetadata(),
		);
		this.projectMetadata = project.metadata;
		// The project's language for prompts and built-in skill instructions;
		// it must be resolved before the skill registry loads below.
		setInstructionLocale(resolveInstructionLocale(project.metadata.instructionLanguage));

		// An older version keyed the remembered conversation by a generated
		// project id. Carry that value over before the id disappears, so the
		// writer still lands where they left off.
		if (project.migratedFromProjectId) {
			const remembered = this.deviceStore.legacyLastActiveSession(project.migratedFromProjectId);
			if (remembered && !this.vaultState.lastActiveSession()) {
				this.vaultState.setLastActiveSession(remembered);
			}
			this.deviceStore.clearLegacyLastActiveSession(project.migratedFromProjectId);
		}

		await step(t("main.stepLoadSkills"), () => this.skills.reload());
		await step(t("main.stepLoadSessions"), () => this.sessions.load(this.vaultState.lastActiveSession()));
		this.vaultState.retainSessionPreferences(this.sessions.all().map((session) => session.id));
		if (this.sessions.count >= SESSION_RECOMMENDED_LIMIT) {
			new Notice(
				t("main.sessionLimit", { count: this.sessions.count, limit: SESSION_RECOMMENDED_LIMIT }),
				10_000,
			);
		}
		this.editHistory = await step(t("main.stepLoadEdits"), () => this.projectStore.loadEditHistory());
	}

	/**
	 * The root changed: re-read project data from where it is now.
	 *
	 * Sequenced behind pending project-data events so a reload never
	 * interleaves with a conversation refresh that was already queued.
	 */
	reloadProjectData(): Promise<void> {
		const run = async (): Promise<void> => {
			const previousActiveId = this.sessions.getActiveId();
			try {
				await this.loadProjectData((_label, task) => task());
				this.loadError = null;
			} catch (error) {
				this.loadError = describe(error);
				new Notice(t("main.initFailed", { reason: this.loadError }));
			}
			if (this.sessions.getActiveId() !== previousActiveId) this.conversationChanged();
			this.rememberActiveSession();
			this.refreshViews();
			this.refreshSelectionHighlights();
		};
		this.projectEventChain = this.projectEventChain.then(run).catch((error) => {
			console.error("[WritingBuddy] Project data reload failed", error);
		});
		return this.projectEventChain;
	}

	/** Something about the page changed that only Settings shows. */
	refreshSettings(): void {
		this.settingTab?.refresh();
	}

	/** Resolves once project data has been loaded (or has failed to load). */
	whenReady(): Promise<void> {
		return this.ready;
	}

	/** Remember, for this vault on this machine, which conversation was open. */
	rememberActiveSession(): void {
		this.vaultState.setLastActiveSession(this.sessions.getActiveId());
	}

	private registerCommands(): void {

		this.addCommand({
			id: "open-sidebar",
			name: t("main.cmdOpen"),
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "attach-selection",
			name: t("main.cmdAttachSelection"),
			editorCheckCallback: (checking, editor, view) => {
				if (!(view instanceof MarkdownView) || !view.file) return false;
				if (editor.getSelection().length === 0) return false;
				if (checking) return true;
				void this.attachSelection(editor, view.file);
				return true;
			},
		});

		this.addCommand({
			id: "undo-last-ai-edit",
			name: t("main.cmdUndoAI"),
			callback: () => void this.undoLatestEdit(),
		});

		this.addCommand({
			id: "restore-conversation-from-local-history",
			name: t("main.cmdRestoreConversation"),
			callback: () => void this.restoreConversationFromHistory(),
		});

		// Whole-manuscript analysis is an explicit operation, not a Context
		// setting: it runs the Composer's current question once with complete
		// coverage and leaves the conversation's ordinary Context untouched.
		this.addCommand({
			id: "analyze-whole-manuscript",
			name: t("main.cmdWholeManuscript"),
			callback: () => void this.activateView().then(() => this.views()[0]?.sendWholeManuscript()),
		});
	}

	/**
	 * Put the open conversation back to a revision saved on this device.
	 *
	 * The recovery half of `SessionHistoryStore`. Snapshots are worthless
	 * without a way back to them, and the failure they exist for — a sync
	 * replacing a conversation with content this device never read — leaves the
	 * writer with no other option: official version history does not cover
	 * `.json` at all.
	 */
	private async restoreConversationFromHistory(): Promise<void> {
		const active = this.sessions.getActive();
		if (!active) {
			new Notice(t("main.restoreNoSession"));
			return;
		}
		const entries = await this.projectStore.sessionHistory(active.id);
		const revisions: RestorableRevision[] = [];
		for (const entry of entries) {
			const contents = await this.projectStore.readSessionHistoryEntry(entry.path);
			if (contents === null) continue;
			const parsed = parseSession(contents);
			revisions.push({
				path: entry.path,
				stamp: entry.stamp,
				...(parsed.ok ? { messageCount: parsed.value.messages.length } : {}),
			});
		}
		if (revisions.length === 0) {
			new Notice(t("main.restoreNoHistory"));
			return;
		}

		const chosen = await new RestoreConversationModal(this.app, revisions).openAndPick();
		if (!chosen) return;
		const contents = await this.projectStore.readSessionHistoryEntry(chosen.path);
		const parsed = contents === null ? null : parseSession(contents);
		if (!parsed || !parsed.ok) {
			new Notice(t("main.restoreUnreadable", { reason: parsed ? parsed.reason : "" }), 10_000);
			return;
		}

		const restored = await this.sessions.restoreSession(active.id, parsed.value);
		if (!restored) {
			new Notice(t("main.restoreUnreadable", { reason: "" }), 10_000);
			return;
		}
		this.refreshViews();
		this.selectionBridge?.conversationChanged();
		new Notice(t("main.restoreDone", {
			stamp: readableStamp(chosen.stamp),
			title: restored.title,
			count: restored.messages.length,
		}), 12_000);
	}

	private registerEditorMenu(): void {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				if (!(view instanceof MarkdownView) || !view.file) return;
				if (editor.getSelection().length === 0) return;
				const file = view.file;

				// One entry, not two. `改写选区…` was a second route to the same
				// place: attaching a passage and then asking for a rewrite is
				// what the composer is for, and the writing actions are already
				// one click away once the passage is attached.
				menu.addItem((item) =>
					item
						.setTitle(t("main.cmdAttachSelection"))
						.setIcon("message-square")
						.onClick(() => void this.attachSelection(editor, file)),
				);

			}),
		);
	}

	private registerProjectDataEvents(): void {
		// The root controller sees every event first: a drag of the root is
		// adopted before its child events are classified against the new
		// location, and a rename of a fixed subfolder is put back rather than
		// processed as data leaving the project.
		this.registerEvent(this.app.vault.on("create", (file) => {
			this.projectRoot.onCreate(file);
			this.queueProjectDataEvent("create", file);
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			this.queueProjectDataEvent("modify", file);
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			this.projectRoot.onDelete(file);
			this.queueProjectDataEvent("delete", file);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (this.projectRoot.onRename(file, oldPath)) return;
			if (this.projectRoot.isRelocationEcho(oldPath, file.path)) return;
			this.queueProjectDataEvent("rename", file, oldPath);
		}));
	}

	private queueProjectDataEvent(
		kind: "create" | "modify" | "delete" | "rename",
		file: TAbstractFile,
		oldPath?: string,
	): void {
		if (!this.sessions.isLoaded) return;
		const current = projectDataPath(file.path);
		const previous = oldPath ? projectDataPath(oldPath) : null;
		if (!current && !previous) return;

		const key = current?.kind === "conversation" || previous?.kind === "conversation"
			? `conversation:${previous?.kind === "conversation" ? previous.sessionId : ""}:${current?.kind === "conversation" ? current.sessionId : ""}`
			: "skills";
		const existing = this.projectEventTimers.get(key);
		if (existing !== undefined) window.clearTimeout(existing);
		this.projectEventTimers.set(key, window.setTimeout(() => {
			this.projectEventTimers.delete(key);
			this.projectEventChain = this.projectEventChain
				.then(() => this.processProjectDataEvent(kind, current, previous))
				.catch((error) => console.error("[WritingBuddy] Project data refresh failed", error));
		}, 200));
	}

	private async processProjectDataEvent(
		kind: "create" | "modify" | "delete" | "rename",
		current: ReturnType<typeof projectDataPath>,
		previous: ReturnType<typeof projectDataPath>,
	): Promise<void> {
		const previousActiveId = this.sessions.getActiveId();
		if (current?.kind === "skill" || previous?.kind === "skill") {
			await this.skills.reload();
			this.refreshViews();
			return;
		}

		let result;
		if (kind === "rename" && previous?.kind === "conversation" && current?.kind === "conversation") {
			result = await this.sessions.renameExternalSession(previous.sessionId, current.sessionId);
		} else if (kind === "rename" && previous?.kind === "conversation") {
			result = await this.sessions.deleteExternalSession(previous.sessionId);
		} else if (kind === "rename" && current?.kind === "conversation") {
			result = await this.sessions.createExternalSession(current.sessionId);
		} else if (kind === "delete" && previous?.kind === "conversation") {
			result = await this.sessions.deleteExternalSession(previous.sessionId);
		} else if (kind === "delete" && current?.kind === "conversation") {
			result = await this.sessions.deleteExternalSession(current.sessionId);
		} else if (current?.kind === "conversation") {
			result = await this.sessions.upsertExternalSession(current.sessionId);
		} else {
			return;
		}

		if (result.kind === "conflict") {
			await this.sessions.preserveExternalConflict(result);
			this.vaultState.retainSessionPreferences(this.sessions.all().map((session) => session.id));
			return;
		}
		if (result.kind === "malformed") {
			new Notice(t("main.syncIncomplete", { reason: result.reason }));
			return;
		}
		if (result.kind === "deleted") {
			this.vaultState.clearSessionPreferences(result.sessionId);
		} else if (result.kind === "renamed") {
			this.vaultState.moveSessionPreferences(result.previousSessionId, result.sessionId);
		}
		if (result.kind === "created" || result.kind === "updated" || result.kind === "deleted" || result.kind === "renamed") {
			this.externalConversationChanged(previousActiveId);
			this.rememberActiveSession();
			this.conversationChangedOnDisk(result.sessionId, previousActiveId);
		}
	}

	/**
	 * A conversation changed on disk. Redraw only what is showing it.
	 *
	 * Sync writes conversation files continuously, and every write used to
	 * rebuild the whole panel — including for the nine conversations the writer
	 * is not reading. That is what the panel flashing was, and it was worse than
	 * cosmetic: a rebuild landing between a press and its release replaces the
	 * button, so the browser dispatches no `click` and 应用 does nothing.
	 *
	 * The panel shows one conversation, plus its parent for the branch link.
	 * Nothing else in the set is on screen there, so nothing else is a reason to
	 * rebuild it. The history list *does* show them all, so it is redrawn
	 * whenever it is open — a conversation started on another device still
	 * appears the moment it arrives, in the one place that displays it.
	 */
	private conversationChangedOnDisk(sessionId: string, previousActiveId: string | null): void {
		for (const view of this.views()) view.sessionListChanged();
		const active = this.sessions.getActive();
		// No conversation, or a different one than a moment ago: the panel is
		// showing something other than what it should be.
		if (!active || this.sessions.getActiveId() !== previousActiveId) {
			this.refreshViews();
			return;
		}
		if (sessionId === active.id || sessionId === active.branchedFrom?.sessionId) {
			this.refreshViews();
		}
	}

	// --- view plumbing -----------------------------------------------------

	async activateView(): Promise<WritingBuddyView | null> {
		const existing = this.app.workspace.getLeavesOfType(WRITING_BUDDY_VIEW);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return existing[0].view instanceof WritingBuddyView ? existing[0].view : null;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return null;
		await leaf.setViewState({ type: WRITING_BUDDY_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
		return leaf.view instanceof WritingBuddyView ? leaf.view : null;
	}

	private views(): WritingBuddyView[] {
		return this.app.workspace
			.getLeavesOfType(WRITING_BUDDY_VIEW)
			.map((leaf) => leaf.view)
			.filter((view): view is WritingBuddyView => view instanceof WritingBuddyView);
	}

	refreshViews(): void {
		for (const view of this.views()) view.render();
		this.settingTab?.refresh();
	}

	/** Keep editor marks in sync without moving or focusing any editor. */
	refreshSelectionHighlights(): void {
		for (const view of this.selectionEditorViews) this.refreshSelectionHighlight(view);
	}

	/** Conversation switches are presentation changes, never selection input. */
	conversationChanged(): void {
		this.selectionBridge.conversationChanged();
		this.refreshSelectionHighlights();
	}

	/** Session-specific selection after an externally detected conversation update. */
	externalConversationChanged(previousActiveId: string | null): void {
		if (this.sessions.getActiveId() !== previousActiveId) this.selectionBridge.conversationChanged();
		this.refreshSelectionHighlights();
	}

	/** Direct chip actions take precedence over a still-debouncing editor event. */
	selectionAttachmentChanged(): void {
		this.selectionBridge.attachmentChangedExternally();
		this.refreshSelectionHighlights();
	}

	private refreshSelectionHighlight(view: EditorView): void {
		showAttachedSelection(view, this.sessions?.getActive()?.selection ?? null);
	}

	// --- writing actions ---------------------------------------------------

	async attachSelection(editor: Editor, file: TFile): Promise<void> {
		const view = (await this.activateView()) ?? this.views()[0];
		if (!view) return;
		await view.attachSelectionFromEditor(editor, file.path);
	}

	async undoLatestEdit(): Promise<void> {
		const view = this.views()[0];
		if (!view) {
			new Notice(t("main.openSidebarFirst"));
			return;
		}
		await view.undoLatestEdit();
	}

	/** Open this plugin's settings page. */
	openSettings(): void {
		const settings = (this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		}).setting;
		if (!settings) {
			new Notice(t("main.openFromSettings"));
			return;
		}
		settings.open();
		settings.openTabById(this.manifest.id);
	}

	// --- editors -----------------------------------------------------------

	/**
	 * Find the open editor showing `filePath`.
	 *
	 * Apply and undo both need the editor for a *specific* manuscript, not
	 * whatever happens to be focused — the writer may well have clicked into
	 * the sidebar, or opened another chapter, between generating and applying.
	 */
	resolveEditorForPath(filePath: string): ResolvedEditor | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === filePath) {
				return { editor: view.editor, filePath };
			}
		}
		return null;
	}

	/** A provider id, written the way its maker writes it. */
	providerName(connectionId: string | undefined, id: string): string {
		return providerNameFrom(this.connectionCapabilities(connectionId), id);
	}

	/**
	 * How many messages a conversation had when it was last auto-named.
	 *
	 * In memory: this is bookkeeping about a background job, not something the
	 * manuscript should carry. Losing it on restart means at most one extra
	 * rename, which is harmless.
	 */
	titledAt(sessionId: string): number | undefined {
		return this.titledAtBySession.get(sessionId);
	}

	markTitled(sessionId: string, messageCount: number): void {
		this.titledAtBySession.set(sessionId, messageCount);
	}

	/**
	 * Resolve a saved citation label back to a file in this vault.
	 *
	 * Saved answers carry readable labels — `[第03章 · 长廊]` — because the
	 * request's evidence ids are meaningless once it is over. Resolution is by
	 * name against the vault, and it **refuses when the answer is not unique**:
	 * two files called `第03章` means no link, rather than a link to whichever
	 * one was listed first.
	 */
	resolveCitationLabel(label: string): { path: string; heading: string | null; anchorText: string } | null {
		const [namePart, headingPart] = label.split("·").map((part) => part.trim());
		if (!namePart) return null;

		// The kind prefixes are ours, so a label like `人物设定 · 青梧` names the
		// file on the right-hand side rather than the left.
		const known = knownEvidenceKindLabels();
		const name = known.includes(namePart) ? (headingPart ?? "") : namePart;
		const heading = known.includes(namePart) || /^\d+\/\d+$/u.test(headingPart ?? "")
			? null
			: (headingPart ?? null);
		if (!name) return null;

		const matches = this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.basename === name || file.path === name);
		if (matches.length !== 1) return null;

		return {
			path: matches[0].path,
			heading,
			anchorText: heading ? `# ${heading}` : "",
		};
	}

	/**
	 * Open a citation and select the exact text it points at.
	 *
	 * A citation names a section, so the heading line is what gets selected —
	 * real text that can be found again, rather than an offset that is wrong the
	 * moment anything above it is edited. When the anchor cannot be located the
	 * file still opens, and nothing is selected: sending the writer to a
	 * plausible-looking wrong place is worse than sending them to the top.
	 */
	async revealCitation(citation: {
		path: string;
		anchorText: string;
		heading: string | null;
		range?: { from: DocPosition; to: DocPosition };
		revision?: string;
		revisionKind?: "saved" | "editor";
	}): Promise<void> {
		if (citation.range && citation.revision) {
			await revealExactCitation(citation, {
				begin: () => this.selectionBridge.beginProgrammaticSelection(),
				open: async (path) => (await this.openVaultFile(path))?.editor ?? null,
				isCurrent: (target) => this.selectionBridge.isProgrammaticSelectionCurrent(target as ProgrammaticSelectionTarget),
				select: (editor, range) => {
					const passage = editor.getRange(range.from, range.to);
					return this.selectPassage(editor as Editor, passage, range, { label: citation.path });
				},
				finish: (target, editor, path, selected) => this.finishProgrammaticSelection(
					target as ProgrammaticSelectionTarget, editor as Editor, path, selected,
				),
				cancel: (target) => this.selectionBridge.cancelProgrammaticSelection(target as ProgrammaticSelectionTarget),
				stale: (path) => { new Notice(t("main.staleSource", { path })); },
			});
			return;
		}
		const target = this.selectionBridge.beginProgrammaticSelection();
		try {
			const view = await this.openVaultFile(citation.path);
			if (!view) {
				this.selectionBridge.cancelProgrammaticSelection(target);
				return;
			}
			if (!this.selectionBridge.isProgrammaticSelectionCurrent(target)) return;

			const fallback = this.firstNonEmptyLine(view.editor);
			const anchor = citation.anchorText.trim() || fallback?.text || "";
			const range = citation.range ?? fallback?.range;
			if (!anchor || !range) {
				this.selectionBridge.cancelProgrammaticSelection(target);
				return;
			}

			// New Full citations already returned through the revision-verified exact
			// branch above. Only legacy/range-less citations reach this anchor ladder.
			const selected = this.selectPassage(
				view.editor,
				anchor,
				range,
				{ label: citation.path, heading: citation.heading },
			);
			await this.finishProgrammaticSelection(target, view.editor, citation.path, selected);
		} catch (error) {
			this.selectionBridge.cancelProgrammaticSelection(target);
			throw error;
		}
	}

	/** The manuscript the writer is currently in, if any. */
	activeMarkdownPath(): string | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) return view.file.path;
		const recent = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
		if (recent instanceof MarkdownView && recent.file) return recent.file.path;
		return null;
	}


	/**
	 * Open the passage a citation points at, and select it.
	 *
	 * Three things went wrong in the first attempt at this, all of which showed
	 * up to the writer as "clicking does nothing":
	 *
	 *   1. If the file was already open in a background tab, the selection was
	 *      applied to a tab nobody could see while the sidebar stayed in front.
	 *      The leaf has to be revealed.
	 *   2. Reusing the most recent main-area leaf for a closed file replaced the
	 *      manuscript tab the writer was already using. A closed target needs a
	 *      newly-created tab instead.
	 *   3. Immediately after `openFile` the leaf's view is not necessarily a
	 *      usable editor yet, and the old code returned silently when it wasn't.
	 *
	 * Every failure path below now reports something. The passage-location
	 * ladder is unchanged after the destination tab has been activated.
	 */
	async revealAttachment(attachment: SelectionAttachment): Promise<void> {
		const target = this.selectionBridge.beginProgrammaticSelection();
		const path = normalizePath(attachment.filePath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.selectionBridge.cancelProgrammaticSelection(target);
			new Notice(t("main.fileNotFound", { path: attachment.filePath }));
			return;
		}

		try {
			const leaf = await this.activateOrOpenMarkdownFile(file);

			const view = await this.waitForMarkdownView(leaf, path);
			if (!view) {
				this.selectionBridge.cancelProgrammaticSelection(target);
				new Notice(t("main.noEditorView", { name: attachment.fileName }));
				return;
			}
			if (!this.selectionBridge.isProgrammaticSelectionCurrent(target)) return;

			// Reading mode has no editor to select in. The writer explicitly asked to
			// be taken to this passage, so switching to editing is the intent.
			if (view.getMode() === "preview") {
				await leaf.setViewState({
					...leaf.getViewState(),
					state: { ...leaf.getViewState().state, mode: "source" },
				});
				const editing = await this.waitForMarkdownView(leaf, path);
				if (!editing) {
					this.selectionBridge.cancelProgrammaticSelection(target);
					new Notice(t("main.switchToEditMode", { name: attachment.fileName }));
					return;
				}
				if (!this.selectionBridge.isProgrammaticSelectionCurrent(target)) return;
			}

			const editor = (leaf.view as MarkdownView).editor;
			const selected = this.selectPassage(editor, attachment.text, attachment, {
				label: attachment.fileName,
			});
			await this.finishProgrammaticSelection(target, editor, path, selected);
		} catch (error) {
			this.selectionBridge.cancelProgrammaticSelection(target);
			throw error;
		}
	}

	private firstNonEmptyLine(editor: Editor): { text: string; range: { from: DocPosition; to: DocPosition } } | null {
		for (let line = 0; line < editor.lineCount(); line += 1) {
			const text = editor.getLine(line);
			if (!text.trim()) continue;
			return {
				text,
				range: { from: { line, ch: 0 }, to: { line, ch: text.length } },
			};
		}
		return null;
	}

	/**
	 * Open a cited file and hand back its editor.
	 *
	 * Focus is taken here, before anything is selected: an unfocused editor
	 * holds a selection without painting one, which is the "it scrolled there
	 * but nothing is highlighted" report.
	 */
	async openVaultFile(filePath: string): Promise<MarkdownView | null> {
		const path = normalizePath(filePath);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(t("main.fileNotFound", { path: filePath }));
			return null;
		}

		const leaf = await this.activateOrOpenMarkdownFile(file);

		return this.waitForMarkdownView(leaf, path);
	}

	/**
	 * Reuse an open tab for `file`, or create a new tab when it is not open.
	 * This is shared by citations and selection attachments so neither path can
	 * silently drift back to replacing the writer's current manuscript leaf.
	 */
	private async activateOrOpenMarkdownFile(file: TFile): Promise<WorkspaceLeaf> {
		const path = normalizePath(file.path);
		return activateOrOpenFileLeaf(
			this.app.workspace.getLeavesOfType("markdown"),
			path,
			{
				pathOf: (leaf) => this.markdownPath(leaf),
				createTab: () => this.app.workspace.getLeaf("tab"),
				reveal: (leaf) => this.app.workspace.revealLeaf(leaf),
				open: (leaf) => leaf.openFile(file, { active: true }),
				activate: (leaf) => this.app.workspace.setActiveLeaf(leaf, { focus: true }),
			},
		);
	}

	/** Path represented by a Markdown leaf, including a deferred background tab. */
	private markdownPath(leaf: WorkspaceLeaf): string | null {
		const livePath = this.editableMarkdownPath(leaf);
		if (livePath) return livePath;

		const state = leaf.getViewState().state;
		return typeof state?.file === "string" ? normalizePath(state.file) : null;
	}

	/** Path of a currently-instantiated Markdown editor view. */
	private editableMarkdownPath(leaf: WorkspaceLeaf): string | null {
		const view = leaf.view;
		return view instanceof MarkdownView && view.file ? normalizePath(view.file.path) : null;
	}

	/**
	 * Select a passage, trying successively weaker evidence, and say which.
	 *
	 * Navigation used to refuse outright the moment the recorded range stopped
	 * matching — which is most of the time, because editing anything above a
	 * passage moves it. But a citation that stops working as soon as the writer
	 * edits is a citation that stops working almost immediately, and the cost of
	 * landing in the wrong place here is a glance, not a corrupted manuscript.
	 *
	 * So it keeps looking: the passage elsewhere, then the longest surviving run
	 * of it, then its section heading. What it never does is pretend — each
	 * outcome says what was actually found, so "here it is" and "this is what is
	 * left of it" are never confused for each other.
	 */
	private selectPassage(
		editor: Editor,
		passage: string,
		range: { from: DocPosition; to: DocPosition },
		context: { label: string; heading?: string | null; before?: string; after?: string },
	): boolean {
		const found = locatePassage(editor.getValue(), passage, range, {
			...(context.heading !== undefined ? { heading: context.heading } : {}),
			...(context.before !== undefined ? { before: context.before } : {}),
			...(context.after !== undefined ? { after: context.after } : {}),
		});

		if (found.kind === "lost") {
			new Notice(t("main.passageGone", { label: context.label }));
			return false;
		}

		// Focus before selecting: an unfocused editor holds a selection without
		// painting one, which reads as "it scrolled there and did nothing".
		const cmView = codeMirrorViewForEditor(this.selectionEditorViews, editor);
		if (cmView) {
			selectProgrammaticRange(
				cmView,
				editor.posToOffset(found.from),
				editor.posToOffset(found.to),
			);
		} else {
			editor.focus();
			editor.setSelection(found.from, found.to);
		}
		editor.scrollIntoView({ from: found.from, to: found.to }, true);

		if (found.kind === "partial") {
			new Notice(
				t("main.partialLocate", { matched: found.matched, of: found.of }),
			);
		} else if (found.kind === "section") {
			new Notice(t("main.headingLocate", { heading: found.heading }));
		}
		return true;
	}

	private async finishProgrammaticSelection(
		target: ProgrammaticSelectionTarget,
		editor: Editor,
		filePath: string,
		selected: boolean,
	): Promise<void> {
		const snapshot = selected
			? captureSelection(editor, filePath)
			: null;
		if (!snapshot) {
			this.selectionBridge.cancelProgrammaticSelection(target);
			return;
		}
		await this.selectionBridge.finishProgrammaticSelection(target, snapshot);
	}

	/**
	 * Wait for a leaf to actually be showing an editable Markdown view.
	 *
	 * `openFile` resolves before the view swap has necessarily produced an
	 * editor, so a single synchronous check after it is a race.
	 */
	private async waitForMarkdownView(
		leaf: WorkspaceLeaf,
		path: string,
		attempts = 12,
	): Promise<MarkdownView | null> {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path && view.editor) {
				return view;
			}
			await new Promise((resolve) => window.setTimeout(resolve, 25));
		}
		return null;
	}

	// --- backend -----------------------------------------------------------

	getBackend(): AIBackend {
		return this.backend;
	}

	async saveDeviceSettings(): Promise<void> {
		this.deviceStore.save(this.deviceSettings);
		this.connectionRegistry.replace(this.deviceSettings.connections);
		this.refreshViews();
	}

	connectionRecords(): ConnectionRecord[] { return this.connectionRegistry.all(); }
	connection(id: string | undefined): AIConnection | null { return this.connectionRegistry.get(id); }
	connectionCapabilities(id: string | undefined): Capabilities { return this.connectionRegistry.getCapabilities(id); }
	connectionAggregate(): { connected: number; enabled: number; checking: boolean } { return this.connectionRegistry.aggregate(); }

	async addConnection(connection: AIConnection): Promise<AIConnection> {
		this.deviceSettings.connections = upsertConnection(this.deviceSettings.connections, connection);
		await this.saveDeviceSettings();
		return connection;
	}

	async updateConnection(connection: AIConnection): Promise<void> {
		this.deviceSettings.connections = this.deviceSettings.connections.map((item) =>
			item.id === connection.id ? connection : item,
		);
		this.reconcileNewConversationDefaults(connection.id);
		this.connectionRegistry.invalidate(connection.id);
		await this.saveDeviceSettings();
	}

	async removeConnection(id: string): Promise<void> {
		this.deviceSettings.connections = this.deviceSettings.connections.filter((connection) => connection.id !== id);
		this.reconcileNewConversationDefaults(id);
		await this.saveDeviceSettings();
	}

	private reconcileNewConversationDefaults(changedId: string): void {
		const defaults = this.deviceSettings.newConversationDefaults;
		if (defaults.connectionId !== changedId) return;
		const connection = this.deviceSettings.connections.find((item) => item.id === changedId);
		if (!connection?.enabled) {
			this.deviceSettings.newConversationDefaults = defaults.contextDepth
				? { contextDepth: defaults.contextDepth }
				: {};
			return;
		}
		const snapshot = connectionSnapshot(connection);
		this.deviceSettings.newConversationDefaults = {
			...defaults,
			connectionName: snapshot.name,
			connectionType: snapshot.type,
			...(snapshot.detail ? { connectionDetail: snapshot.detail } : {}),
		};
	}

	setNewConversationDefaults(preferences: SessionPreferences): Promise<void> {
		this.deviceSettings.newConversationDefaults = preferences;
		return this.saveDeviceSettings();
	}

	async setConnectionEnabled(id: string, enabled: boolean): Promise<void> {
		const connection = this.connection(id);
		if (connection) await this.updateConnection({ ...connection, enabled });
	}

	async testConnection(id: string): Promise<ConnectionRecord> {
		return this.connectionRegistry.test(id);
	}

	async testConnectionDraft(connection: AIConnection): Promise<ConnectionRecord> {
		const registry = new BackendRegistry({ connections: [connection], httpClient: obsidianHttpClient });
		return registry.test(connection.id);
	}

	modelsForConnectionProvider(connectionId: string | undefined, providerId: string): ModelCapability[] {
		return providerId ? modelsFor(this.connectionCapabilities(connectionId), providerId) : [];
	}

	effortsForConnectionProvider(connectionId: string | undefined, providerId: string, modelId?: string): EffortCapability[] {
		return providerId ? effortsFor(this.connectionCapabilities(connectionId), providerId, modelId) : [];
	}

	async checkConnection(id: string): Promise<{ ok: boolean; message: string }> {
		const record = await this.connectionRegistry.test(id);
		const providers = record.capabilities?.providers ?? [];
		const models = providers.reduce((sum, provider) => sum + provider.models.length, 0);
		if (record.health.kind !== "connected") {
			return { ok: false, message: record.health.detail ?? t("main.connectionUnavailableShort") };
		}
		return {
			ok: true,
			message: t("main.connectionOk", { providers: providers.map((provider) => providerDisplayName(provider.id, provider.label)).join(t("msgList.sourceSeparator")), models }),
		};
	}

	// Typed Settings boundary. Registry mutations reload their own cache; the
	// plugin owns refreshing every open surface after the write completes.
	skillDescriptors(): SkillDescriptor[] {
		return this.skills.descriptors();
	}

	skillLoadProblems(): SkillLoadProblem[] {
		return this.skills.getProblems();
	}

	builtinSkillSource(id: string): string | null {
		return this.skills.builtinSource(id);
	}

	builtinSkillCustomizationSource(id: string): Promise<string | null> {
		return this.skills.customizationSource(id);
	}

	async saveBuiltinSkillCustomization(id: string, extension: string): Promise<void> {
		await this.skills.saveBuiltinCustomization(id, extension);
		this.refreshViews();
	}

	async saveBuiltinSkillReplacement(id: string, instruction: string): Promise<void> {
		await this.skills.saveBuiltinReplacement(id, instruction);
		this.refreshViews();
	}

	async resetBuiltinSkillCustomization(id: string): Promise<void> {
		await this.skills.resetBuiltinCustomization(id);
		this.refreshViews();
	}

	async saveCustomSkill(source: string, existingPath?: string): Promise<void> {
		await this.skills.saveCustomSkill(source, existingPath);
		this.refreshViews();
	}

	// --- edit history ------------------------------------------------------

	async recordEdit(token: EditToken): Promise<void> {
		this.editHistory = [...this.editHistory, token].slice(-EDIT_HISTORY_LIMIT);
		await this.projectStore.saveEditHistory(this.editHistory);
	}

	async updateEdit(token: EditToken): Promise<void> {
		this.editHistory = this.editHistory.map((entry) => (entry.id === token.id ? token : entry));
		await this.projectStore.saveEditHistory(this.editHistory);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const obsidianHttpClient: HttpClient = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	// `response.json` is a getter that throws on a body that is not JSON — a
	// proxy's "Bad Gateway" page, say — which hid the status behind a parse
	// error. Parse the text ourselves and let the caller report the status.
	const text = response.text;
	return {
		status: response.status,
		headers: new Headers(response.headers),
		text,
		json: parseJsonBody(text),
		ok: response.status >= 200 && response.status < 300,
	};
};

/**
 * Vault-scoped device storage backed by Obsidian's own per-vault local storage.
 *
 * This is why no project identifier is needed: the host already separates one
 * vault's state from another's, so opening a different vault cannot surface the
 * previous one's remembered conversation.
 */
class ObsidianVaultScopedStorage implements VaultScopedStorage {
	private static readonly PREFIX = "writing-buddy:";

	constructor(private readonly app: App) {}

	get(key: string): string | null {
		const value: unknown = this.app.loadLocalStorage(`${ObsidianVaultScopedStorage.PREFIX}${key}`);
		return typeof value === "string" ? value : null;
	}

	set(key: string, value: string | null): void {
		this.app.saveLocalStorage(`${ObsidianVaultScopedStorage.PREFIX}${key}`, value ?? undefined);
	}
}
