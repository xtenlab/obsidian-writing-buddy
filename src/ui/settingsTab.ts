/** WritingBuddy settings: connections, session defaults, and writer-owned Skills. */
import { buildLabel } from "../buildInfo";
import { defaultEffortFor, resolveEffort } from "../backend/effort";
import { App, Notice, PluginSettingTab, Setting, type SettingDefinition, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type WritingBuddyPlugin from "../main";
import { getLocale, t } from "../i18n";
import { ICONS, iconSpan } from "./icons";
import { ConfirmModal } from "./modals";
import { ConnectionModal } from "./connectionModal";
import { connectionSnapshot, connectionSummary, type ConnectionRecord } from "../connections/types";
import { healthLabel } from "./components/header";
import { SESSION_RECOMMENDED_LIMIT } from "../session/SessionManager";
import { CONTEXT_DEPTHS, contextDepthLabel } from "../context/types";
import type { Capabilities, ProviderCapability } from "../backend/AIBackend";
import { routeSkill, type SkillRouteResult } from "../session/skillRouting";
import { parseSkill } from "../skills/skillParser";
import type { ContextDepth, SessionPreferences, Skill } from "../types";
import type { SkillDescriptor } from "../skills/SkillRegistry";
import { BuiltinSkillModal, CustomSkillModal } from "./skillManagerModal";
import {
	clearProjectInstructionsAfterConfirmation,
	ProjectInstructionsModal,
	projectInstructionsPresentation,
} from "./projectInstructionsModal";
import { projectInstructionsPath, type ProjectInstructionsState } from "../instructions";
import { markDestructive } from "./components/destructiveButton";
import { ProjectLocationModal } from "./projectLocationModal";
import type { ProjectRootCandidate } from "../storage/projectLocation";
import { DEFAULT_PROJECT_ROOT } from "../storage/paths";
import {
	MAX_FULL_CORPUS_CONCURRENCY,
	MAX_FULL_CORPUS_DEADLINE_MINUTES,
	MIN_FULL_CORPUS_CONCURRENCY,
	MIN_FULL_CORPUS_DEADLINE_MINUTES,
} from "../session/fullCorpusLimits";

/** A dropdown the page offers, in a form both renderers understand. */
interface DropdownSpec {
	/** The key Obsidian 1.13 passes back through `getControlValue` / `setControlValue`. */
	key: string;
	name: string;
	desc: string;
	options: Record<string, string>;
	value: string;
	disabled?: boolean;
	onChange: (value: string) => Promise<void> | void;
}

export class WritingBuddySettingTab extends PluginSettingTab {
	private testingConnectionId: string | null = null;

	constructor(app: App, private readonly plugin: WritingBuddyPlugin) {
		super(app, plugin);
	}

	// -------------------------------------------------------------------------
	// Obsidian 1.13 and later: the page is described rather than drawn, so every
	// control below is indexed by Settings search. `display()` further down is
	// the same page drawn by hand, for installs between minAppVersion and 1.13;
	// Obsidian does not call it once definitions are returned.
	// -------------------------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The stylesheet's container queries measure the tab, on either path.
		this.containerEl.addClass("wb-settings");
		const [uiLanguage, instructionLanguage] = this.languageRows();
		const descriptors = this.plugin.skillDescriptors();
		const builtin = descriptors.filter((descriptor) => descriptor.ownership === "builtin");
		const own = descriptors.filter((descriptor) => descriptor.ownership !== "builtin");
		const problems = this.plugin.skillLoadProblems();
		const skills: SettingGroupItem[] = [
			{ name: t("settings.instructions.name"), render: (setting) => this.projectInstructionsRow(setting) },
		];
		if (builtin.length > 0) {
			skills.push({
				type: "page",
				name: `${t("settings.skills.groupBuiltin")} · ${builtin.length}`,
				items: [{ type: "group", items: builtin.map((descriptor) => this.skillDefinition(descriptor)) }],
			});
		}
		for (const descriptor of own) skills.push(this.skillDefinition(descriptor));
		skills.push({
			name: t("settings.skills.create"),
			desc: t("settings.skills.createDesc"),
			render: (setting) => this.createSkillRow(setting),
		});
		if (problems.length > 0) {
			skills.push({
				name: t("settings.skills.problemsTitle", { count: problems.length }),
				searchable: false,
				render: (setting) => this.skillProblemsRow(setting),
			});
		}
		return [
			this.dropdownDefinition(uiLanguage),
			this.dropdownDefinition(instructionLanguage),
			{
				type: "list",
				heading: t("settings.section.connections"),
				emptyState: t("settings.connections.empty"),
				items: this.plugin.connectionRecords().map((record) => ({
					name: record.connection.name,
					desc: connectionSummary(record.connection),
					render: (setting: Setting) => this.connectionRow(setting, record),
				})),
				addItem: {
					name: t("settings.connections.addButton"),
					action: () => new ConnectionModal(this.app, this.plugin, undefined, () => this.rerender()).open(),
				},
			},
			{
				type: "group",
				heading: t("settings.section.defaults"),
				items: this.newConversationDefaultRows().map((spec) => this.dropdownDefinition(spec)),
			},
			{ type: "group", heading: t("settings.section.skills"), items: skills },
			{
				type: "group",
				heading: t("settings.section.projectData"),
				items: [
					{ name: t("settings.location.name"), render: (setting) => this.locationRow(setting, null) },
					...this.locationExtraDefinitions(),
					{ name: t("settings.sessions.name"), render: (setting) => this.sessionsRow(setting, null) },
					{ name: t("settings.storage.name"), render: (setting) => this.storageRow(setting, null) },
				],
			},
			{
				type: "page",
				name: t("settings.section.advanced"),
				items: [{ type: "group", items: this.advancedRows().map((spec) => this.dropdownDefinition(spec)) }],
			},
			{
				type: "group",
				heading: t("settings.section.updates"),
				items: [{ name: buildLabel(this.plugin.manifest.version), desc: t("settings.version.installedDesc"), searchable: false }],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.dropdownSpecs().find((spec) => spec.key === key)?.value;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const spec = this.dropdownSpecs().find((item) => item.key === key);
		if (spec && typeof value === "string") await spec.onChange(value);
	}

	/** Plugin data changed elsewhere; on 1.13+ the described page re-reads it. */
	refresh(): void {
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
	}

	/** After an action on this page: re-read the definitions, or redraw by hand. */
	private rerender(): void {
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.display();
	}

	private dropdownSpecs(): DropdownSpec[] {
		return [...this.languageRows(), ...this.newConversationDefaultRows(), ...this.advancedRows()];
	}

	private dropdownDefinition(spec: DropdownSpec): SettingDefinition {
		return {
			name: spec.name,
			desc: spec.desc,
			control: { type: "dropdown", key: spec.key, options: spec.options, disabled: spec.disabled ?? false },
		};
	}

	private dropdownRow(containerEl: HTMLElement, spec: DropdownSpec): Setting {
		return new Setting(containerEl)
			.setName(spec.name)
			.setDesc(spec.desc)
			.addDropdown((dropdown) => dropdown
				.addOptions(spec.options)
				.setValue(spec.value)
				.setDisabled(spec.disabled ?? false)
				.onChange((value) => void spec.onChange(value)));
	}

	private skillDefinition(descriptor: SkillDescriptor): SettingDefinition {
		return {
			name: descriptor.skill.name,
			desc: this.skillRowDescription(descriptor),
			render: (setting) => this.skillRow(setting, descriptor),
		};
	}

	/** The two language choices; one per device, one per project. */
	private languageRows(): DropdownSpec[] {
		return [
			{
				key: "uiLocale",
				name: t("settings.language.name"),
				desc: t("settings.language.desc"),
				options: {
					auto: t("settings.language.auto"),
					en: t("settings.language.en"),
					zh: t("settings.language.zh"),
				},
				value: this.plugin.deviceSettings.uiLocale ?? "auto",
				onChange: async (value) => {
					await this.plugin.setUiLocale(value === "en" || value === "zh" ? value : "auto");
					this.rerender();
				},
			},
			{
				key: "instructionLanguage",
				name: t("settings.instrLang.name"),
				desc: this.plugin.projectMetadata ? t("settings.instrLang.desc") : t("settings.instrLang.loading"),
				options: { auto: t("settings.instrLang.auto"), en: t("settings.language.en"), zh: t("settings.language.zh") },
				value: this.plugin.projectMetadata?.instructionLanguage ?? "auto",
				disabled: !this.plugin.projectMetadata,
				onChange: async (value) => {
					await this.plugin.setInstructionLanguage(value === "en" || value === "zh" ? value : "auto");
					this.rerender();
				},
			},
		];
	}

	// -------------------------------------------------------------------------
	// Before Obsidian 1.13: the same page, drawn by hand.
	// -------------------------------------------------------------------------

	display(): void {
		const { containerEl } = this;
		// Every action in here re-renders the whole page, which sends the
		// scroller back to the top: pressing 检查更新 near the bottom threw the
		// button out of view before its own result could be read. The offset is
		// taken before the page is torn down and restored once it is rebuilt,
		// so a re-render leaves the reader where they were.
		const scroller = findScroller(containerEl);
		const scrollTop = scroller?.scrollTop ?? 0;
		containerEl.empty();
		containerEl.addClass("wb-settings");
		const content = containerEl.createDiv({ cls: "wb-settings-content" });
		// The plugin's name, not a section. It used to be built from the same
		// `setHeading()` as 项目数据 and 版本与更新 below it, so the page read as
		// five sections of equal rank with an odd one at the top. It is a page
		// title: larger, carrying the brand mark, and not competing with the
		// headings underneath.
		const title = content.createDiv({ cls: "wb-settings-title" });
		iconSpan(title, ICONS.brand, "wb-settings-title-icon");
		title.createSpan({ text: t("settings.pluginName") });
		// Above the sections: the interface language changes the words every row
		// below is written in; its sibling is the other axis, the language of the
		// manuscript's prompts and skills, stored with the project rather than the device.
		for (const spec of this.languageRows()) this.dropdownRow(content, spec);
		// Section headings carry no description. Obsidian's own settings state
		// the rule on the row it applies to, and a paragraph under every heading
		// pushed the first real control below the fold.
		this.renderSection(content, t("settings.section.connections"), (section) => this.renderConnections(section));
		this.renderSection(content, t("settings.section.defaults"), (section) => this.renderNewConversationDefaults(section));
		this.renderSection(content, t("settings.section.skills"), (section) => this.renderInstructionsAndSkills(section));
		this.renderSection(content, t("settings.section.projectData"), (section) => this.renderProjectData(section));
		this.renderSection(content, t("settings.section.advanced"), (section) => this.renderAdvanced(section), { collapsible: true });
		this.renderSection(content, t("settings.section.updates"), (section) => this.renderVersion(section));
		if (scroller && scrollTop > 0) scroller.scrollTop = scrollTop;
	}

	/**
	 * One section: a heading, then the rows inside Obsidian's own group panel.
	 *
	 * `.setting-group` / `.setting-items` is the structure every native settings
	 * page uses, and it does real work rather than decorate. A bare
	 * `.setting-item` *is* a card — the app gives it its own background, border,
	 * radius and bottom margin — so a run of rows renders as a stack of detached
	 * cards. Inside `.setting-items` the app strips all four back off every row
	 * and paints one panel instead, drawing the hairlines between rows itself
	 * and rounding only the first and last. That result is not reachable from
	 * our stylesheet without restating rules that belong to the app, so use the
	 * container it already ships.
	 *
	 * The heading sits in the group but outside the panel, which is where
	 * `.setting-group .setting-item-heading` expects to find it.
	 *
	 * Rendering into a nested element also keeps a bad record or an unavailable
	 * service from blanking every setting below it.
	 */
	/** Folds the writer toggled this session, by key; a fold not listed here shows its default. */
	private readonly folds = new Map<string, boolean>();

	/**
	 * A heading that folds the rows under it. Closed, only the heading and a
	 * count show; the page stays short until something is wanted.
	 */
	private renderCollapsibleHeading(host: HTMLElement, key: string, label: string, body: HTMLElement, defaultOpen = false): void {
		const open = this.folds.get(key) ?? defaultOpen;
		host.toggleClass("is-collapsed", !open);
		body.hidden = !open;
		const heading = new Setting(host).setName(label).setHeading().setClass("wb-collapsible-heading");
		heading.addExtraButton((button) => button
			.setIcon(open ? "chevron-down" : "chevron-right")
			.setTooltip(open ? t("settings.group.hide") : t("settings.group.show"))
			.onClick(() => { this.folds.set(key, !open); this.rerender(); }));
		heading.settingEl.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("button")) return;
			this.folds.set(key, !open);
			this.rerender();
		});
	}

	private renderSection(
		containerEl: HTMLElement,
		label: string,
		render: (section: HTMLElement) => void,
		options: { collapsible?: boolean } = {},
	): void {
		const section = containerEl.createEl("section", {
			cls: "wb-settings-section setting-group",
			attr: { "aria-label": label },
		});
		const renderHeading = (): void => {
			new Setting(section).setName(label).setHeading();
		};
		try {
			if (options.collapsible) {
				const body = section.createDiv({ cls: "setting-items" });
				this.renderCollapsibleHeading(section, "section:" + label, label, body);
				section.insertBefore(section.lastElementChild!, body);
				render(body);
				return;
			}
			renderHeading();
			render(section.createDiv({ cls: "setting-items" }));
		} catch (error) {
			console.error("[WritingBuddy] Failed to render settings section: " + label, error);
			section.empty();
			renderHeading();
			section.createDiv({
				cls: "wb-settings-section-error",
				text: t("settings.sectionError"),
				attr: { role: "status" },
			});
		}
	}

	private renderConnections(containerEl: HTMLElement): void {
		const records = this.plugin.connectionRecords();
		// Rendered as direct siblings of the 添加 row rather than inside a list
		// wrapper of our own: the panel here is `.setting-items`, and a wrapper
		// between it and the rows stops the app treating them as its rows.
		if (records.length === 0) {
			containerEl.createDiv({ cls: "wb-settings-note", text: t("settings.connections.empty") });
		}

		for (const record of records) {
			const setting = new Setting(containerEl);
			this.connectionRow(setting, record);
		}

		new Setting(containerEl)
			.setName(t("settings.connections.add"))
			.setDesc(t("settings.connections.addDesc"))
			.addButton((button) => button
				.setButtonText(t("settings.connections.addButton"))
				.setCta()
				.onClick(() => new ConnectionModal(this.app, this.plugin, undefined, () => this.rerender()).open()));
	}

	/** One connection: its name and health, a toggle, and Test / Edit. The whole row opens the editor. */
	private connectionRow(setting: Setting, record: ConnectionRecord): void {
		setting
			.setClass("mod-navigable")
			.setClass("wb-connection-card")
			.setName(record.connection.name);
		const row = setting.settingEl;
		row.tabIndex = 0;
		row.setAttribute("role", "button");
		row.setAttribute("aria-label", t("settings.connections.editAria", { name: record.connection.name }));
		row.addEventListener("click", () => new ConnectionModal(this.app, this.plugin, record.connection, () => this.rerender()).open());
		row.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				new ConnectionModal(this.app, this.plugin, record.connection, () => this.rerender()).open();
			}
		});
		setting.infoEl.addClass("wb-connection-card-copy");
		setting.nameEl.addClass("wb-connection-card-name");
		setting.nameEl.setAttribute("title", record.connection.name);
		// The dot belongs to the connection's name, so it sits after it. In
		// the row's first column it read as a bullet marking the whole row
		// and left the names indented away from every other setting on the
		// page. The name is rewrapped in its own span so it, not the dot,
		// is what an over-long name truncates.
		setting.nameEl.empty();
		setting.nameEl.createSpan({ cls: "wb-connection-card-label", text: record.connection.name });
		// It used to sit beside a 已连接 label that repeated it. With the label
		// gone the dot is the only carrier of health, so it stops being
		// decorative and has to name the state for a screen reader.
		setting.nameEl.createSpan({
			cls: "wb-connection-health-dot is-" + record.health.kind,
			attr: { role: "img", "aria-label": healthLabel(record.health.kind) },
		});
		setting.descEl.empty();
		setting.descEl.addClass("wb-connection-card-description");
		setting.descEl.createDiv({
			cls: "wb-connection-card-type",
			text: connectionSummary(record.connection),
		});
		// Only surfaced when something is wrong. A healthy connection says so
		// with the dot and otherwise stays quiet.
		if (record.health.detail) {
			setting.descEl.createDiv({ cls: "wb-connection-card-error", text: record.health.detail });
		}
		setting.controlEl.addEventListener("click", (event) => event.stopPropagation());
		setting.controlEl.addEventListener("keydown", (event) => event.stopPropagation());
		setting
			.addToggle((toggle) => toggle
				.setTooltip(record.connection.enabled ? t("settings.connections.disableTooltip") : t("settings.connections.enableTooltip"))
				.setValue(record.connection.enabled)
				.onChange(async (value) => {
					await this.plugin.setConnectionEnabled(record.connection.id, value);
					this.rerender();
				}))
			.addButton((button) => {
				const testing = this.testingConnectionId === record.connection.id;
				button.setButtonText(testing ? t("settings.connections.testing") : t("settings.connections.test")).setDisabled(this.testingConnectionId !== null).onClick(async () => {
					this.testingConnectionId = record.connection.id;
					this.rerender();
					try { await this.plugin.testConnection(record.connection.id); }
					catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
					finally { this.testingConnectionId = null; this.rerender(); }
				});
			})
			.addButton((button) => button.setButtonText(t("common.edit")).onClick(() => {
				new ConnectionModal(this.app, this.plugin, record.connection, () => this.rerender()).open();
			}));
	}

	private renderNewConversationDefaults(containerEl: HTMLElement): void {
		for (const spec of this.newConversationDefaultRows()) this.dropdownRow(containerEl, spec);
	}

	/**
	 * Connection → Model → Effort, each narrowing the next, then Context.
	 *
	 * Provider has no row. Every Connection carries exactly one, so the row
	 * only ever repeated the Connection's name; it is derived here and stored
	 * with the Model, and the request contract still carries it.
	 */
	private newConversationDefaultRows(): DropdownSpec[] {
		const defaults = this.plugin.deviceSettings.newConversationDefaults;
		const enabled = this.plugin.connectionRecords().filter((record) => record.connection.enabled);
		const capabilities = this.plugin.connectionCapabilities(defaults.connectionId);
		const provider = capabilities.providers.find((item) => item.id === defaults.provider) ?? soleProvider(capabilities);
		const models = provider?.models ?? [];
		const model = models.find((item) => item.id === defaults.model);
		const efforts = model?.efforts ?? provider?.efforts ?? [];

		const connectionOptions: Record<string, string> = { "": t("common.unset") };
		for (const record of enabled) connectionOptions[record.connection.id] = record.connection.name;
		const modelOptions: Record<string, string> = { "": t("common.unset") };
		for (const item of models) modelOptions[item.id] = item.label ?? item.id;
		const effortOptions: Record<string, string> = efforts.length ? {} : { "": t("common.unsupported") };
		for (const item of efforts) effortOptions[item.id] = item.label ?? item.id;
		const contextOptions: Record<string, string> = {};
		for (const depth of CONTEXT_DEPTHS) contextOptions[depth.id] = contextDepthLabel(depth.id);

		return [
			{
				key: "defaults.connection",
				name: t("label.connection"),
				desc: t("settings.defaults.connectionDesc"),
				options: connectionOptions,
				value: defaults.connectionId ?? "",
				onChange: async (connectionId) => {
					const connection = this.plugin.connection(connectionId);
					const next: SessionPreferences = defaults.contextDepth ? { contextDepth: defaults.contextDepth } : {};
					if (connection) {
						const snapshot = connectionSnapshot(connection);
						next.connectionId = snapshot.id;
						next.connectionName = snapshot.name;
						next.connectionType = snapshot.type;
						if (snapshot.detail) next.connectionDetail = snapshot.detail;
					}
					await this.plugin.setNewConversationDefaults(next);
					this.rerender();
					if (connection) {
						void this.plugin.testConnection(connection.id).then(() => this.rerender());
					}
				},
			},
			{
				key: "defaults.model",
				name: t("label.model"),
				desc: defaults.connectionId ? t("settings.defaults.modelDesc") : t("settings.defaults.selectConnectionFirst"),
				options: modelOptions,
				value: defaults.model ?? "",
				disabled: !defaults.connectionId || !provider,
				onChange: async (modelId) => {
					const selectedModel = models.find((item) => item.id === modelId);
					const selectedEfforts = selectedModel?.efforts ?? provider?.efforts ?? [];
					await this.plugin.setNewConversationDefaults({
						...this.plugin.deviceSettings.newConversationDefaults,
						provider: modelId ? provider?.id : undefined,
						model: modelId || undefined,
						effort: modelId ? defaultEffortFor(selectedEfforts) : undefined,
					});
					this.rerender();
				},
			},
			{
				key: "defaults.effort",
				name: t("label.effort"),
				desc: defaults.model ? (efforts.length ? t("settings.defaults.effortDesc") : t("settings.defaults.effortUnsupported")) : t("settings.defaults.selectModelFirst"),
				options: effortOptions,
				value: resolveEffort(defaults.effort, efforts) ?? "",
				disabled: !defaults.model || efforts.length === 0,
				onChange: async (effort) => {
					await this.plugin.setNewConversationDefaults({
						...this.plugin.deviceSettings.newConversationDefaults,
						effort: effort || undefined,
					});
				},
			},
			{
				key: "defaults.context",
				name: t("label.context"),
				desc: t("settings.defaults.contextDesc"),
				options: contextOptions,
				value: defaults.contextDepth ?? "",
				onChange: async (depth) => {
					await this.plugin.setNewConversationDefaults({
						...this.plugin.deviceSettings.newConversationDefaults,
						contextDepth: depth as ContextDepth,
					});
				},
			},
		];
	}

	/** The two full-text limits: rarely touched, so they sit folded at the end. */
	private renderAdvanced(containerEl: HTMLElement): void {
		for (const spec of this.advancedRows()) this.dropdownRow(containerEl, spec);
	}

	private advancedRows(): DropdownSpec[] {
		// This bounds explicit Full execution. It used to be a
		// fixed fifteen minutes with nothing in the UI, so a manuscript that
		// legitimately took longer simply failed and there was nothing to adjust.
		const deadline = this.plugin.deviceSettings.fullCorpusDeadlineMinutes;
		const choices = [5, 15, 30, 60, 120].filter(
			(minutes) => minutes >= MIN_FULL_CORPUS_DEADLINE_MINUTES && minutes <= MAX_FULL_CORPUS_DEADLINE_MINUTES,
		);
		// A value stored by another build must stay selectable, or opening
		// Settings would silently reset it to whatever the list starts with.
		if (!choices.includes(deadline)) choices.push(deadline);
		const deadlineOptions: Record<string, string> = {};
		for (const minutes of choices.sort((a, b) => a - b)) deadlineOptions[String(minutes)] = t("settings.defaults.minutes", { minutes });
		const concurrencyOptions: Record<string, string> = {};
		for (let n = MIN_FULL_CORPUS_CONCURRENCY; n <= MAX_FULL_CORPUS_CONCURRENCY; n += 1) concurrencyOptions[String(n)] = String(n);

		return [
			{
				key: "fullCorpusDeadlineMinutes",
				name: t("settings.defaults.deadlineName"),
				desc: t("settings.defaults.deadlineDesc"),
				options: deadlineOptions,
				value: String(deadline),
				onChange: (value) => this.plugin.setFullCorpusDeadlineMinutes(Number(value)),
			},
			{
				key: "fullCorpusConcurrency",
				name: t("settings.defaults.concurrencyName"),
				desc: t("settings.defaults.concurrencyDesc"),
				options: concurrencyOptions,
				value: String(this.plugin.deviceSettings.fullCorpusConcurrency),
				onChange: (value) => this.plugin.setFullCorpusConcurrency(Number(value)),
			},
		];
	}

	private renderInstructionsAndSkills(containerEl: HTMLElement): void {
		this.renderProjectInstructions(containerEl);

		const descriptors = this.plugin.skillDescriptors();
		this.renderSkillGroup(
			containerEl,
			"builtin",
			t("settings.skills.groupBuiltin"),
			descriptors.filter((descriptor) => descriptor.ownership === "builtin"),
		);
		this.renderSkillGroup(
			containerEl,
			"customized",
			t("settings.skills.groupCustomizedBuiltin"),
			descriptors.filter((descriptor) => descriptor.ownership === "customized-builtin"),
		);
		this.renderSkillGroup(
			containerEl,
			"custom",
			t("settings.skills.groupCustom"),
			descriptors.filter((descriptor) => descriptor.ownership === "custom"),
		);

		this.createSkillRow(new Setting(containerEl).setName(t("settings.skills.create")).setDesc(t("settings.skills.createDesc")));

		const problems = this.plugin.skillLoadProblems();
		if (problems.length > 0) {
			const problemBox = containerEl.createDiv({
				cls: "wb-skill-problems",
				attr: { role: "status" },
			});
			problemBox.createDiv({ cls: "wb-skill-problems-title", text: t("settings.skills.problemsTitle", { count: problems.length }) });
			for (const problem of problems) {
				problemBox.createDiv({ text: `${basename(problem.path)} · ${skillProblemDescription(problem.reason)}` });
			}
		}
	}

	private renderProjectInstructions(containerEl: HTMLElement): void {
		this.projectInstructionsRow(new Setting(containerEl));
	}

	/**
	 * The project-instructions row. It renders as "checking" and fills itself
	 * in once the file has been read; a row torn down before that is simply a
	 * detached element receiving the answer.
	 */
	private projectInstructionsRow(setting: Setting): void {
		setting
			.setClass("wb-project-instructions-row")
			.setName(t("settings.instructions.name"))
			.setDesc(t("settings.instructions.checking", { path: projectInstructionsPath() }));

		void this.plugin.projectInstructions.load().then((state) => {
			this.renderProjectInstructionsState(setting, state);
		}).catch(() => {
			this.renderProjectInstructionsState(setting, {
				status: "invalid",
				text: "",
				error: "Could not load project instructions.",
				path: projectInstructionsPath(),
			});
		});
	}

	private renderProjectInstructionsState(row: Setting, state: ProjectInstructionsState): void {
		const presentation = projectInstructionsPresentation(state);
		row
			.setClass(presentation.statusClass)
			.setName(t("settings.instructions.name"))
			.setDesc(t("settings.instructions.stateDesc", { status: presentation.statusLabel, path: state.path }));
		row.controlEl.empty();

		if (presentation.canView) {
			row.addButton((button) => button
				.setButtonText(state.status === "active" ? t("settings.instructions.viewText") : t("settings.instructions.viewStatus"))
				.onClick(() => new ProjectInstructionsModal(this.app, { mode: "view", state }).open()));
		}

		row.addButton((button) => button
			.setButtonText(presentation.editLabel)
			.setCta()
			.onClick(() => new ProjectInstructionsModal(this.app, {
				mode: state.status === "absent" ? "create" : "edit",
				state,
				onSave: (source) => this.plugin.projectInstructions.save(source),
				onSaved: () => {
					this.plugin.refreshViews();
					this.rerender();
					new Notice(t("settings.instructions.saved"));
				},
			}).open()));

		if (presentation.canClear) {
			row.addButton((button) => markDestructive(button
				.setButtonText(t("settings.instructions.clear")))
				.onClick(() => void this.clearProjectInstructions()));
		}
	}

	private async clearProjectInstructions(): Promise<void> {
		try {
			const state = await clearProjectInstructionsAfterConfirmation(
				() => new ConfirmModal(this.app, {
					title: t("settings.instructions.clearTitle"),
					body: t("settings.instructions.clearBody", { path: projectInstructionsPath() }),
					confirmText: t("settings.instructions.clearConfirm"),
					destructive: true,
				}).openAndConfirm(),
				() => this.plugin.projectInstructions.clear(),
			);
			if (!state) return;
			if (state.status === "invalid") {
				new Notice(t("settings.instructions.clearFailed"));
				return;
			}
			this.plugin.refreshViews();
			this.rerender();
			new Notice(t("settings.instructions.cleared"));
		} catch {
			new Notice(t("settings.instructions.clearFailed"));
		}
	}

	private renderSkillGroup(
		containerEl: HTMLElement,
		groupKey: string,
		label: string,
		descriptors: SkillDescriptor[],
	): void {
		// A group with nothing in it is not shown: an empty list explaining
		// itself is one more thing to read on a page that is already long.
		if (descriptors.length === 0) return;
		const group = containerEl.createDiv({ cls: "wb-skill-group", attr: { "aria-label": label } });
		// `.setting-items` so the rows share one panel with hairlines between them,
		// as the connection rows do, rather than a gapped stack of cards.
		const list = group.createDiv({ cls: "wb-skill-list setting-items" });
		this.renderCollapsibleHeading(group, "skills:" + groupKey, `${label} · ${descriptors.length}`, list, groupKey !== "builtin");
		group.insertBefore(group.lastElementChild!, list);

		for (const descriptor of descriptors) this.skillRow(new Setting(list), descriptor);
	}

	private skillRowDescription(descriptor: SkillDescriptor): string {
		const skill = descriptor.skill;
		const version = descriptor.builtinVersion ?? skill.version;
		const customized = descriptor.ownership === "customized-builtin" || descriptor.customized;
		const ownership = descriptor.ownership === "custom"
			? t("settings.skills.ownedByUser")
			: customized ? t("settings.skills.builtinMetaCustomized", { version }) : t("settings.skills.builtinMeta", { version });
		const review = descriptor.status === "needs-review" ? t("settings.skills.needsReview") : "";
		return `${ownership}${review}${skill.description ? ` · ${skill.description}` : ""}`;
	}

	/** One skill: who owns it, then View / Customize / Reset, or Edit for the writer's own. */
	private skillRow(setting: Setting, descriptor: SkillDescriptor): void {
		const skill = descriptor.skill;
		const customized = descriptor.ownership === "customized-builtin" || descriptor.customized;
		setting
			.setClass("wb-skill-row")
			.setName(skill.name)
			.setDesc(this.skillRowDescription(descriptor));
		if (descriptor.status && descriptor.status !== "active") setting.setClass("is-attention");

		if (descriptor.ownership === "custom") {
			setting.addButton((button) => button
				.setButtonText(t("common.edit"))
				.onClick(() => this.openCustomSkillEditor(descriptor)));
			return;
		}

		setting.addButton((button) => button.setButtonText(t("settings.skills.viewBuiltin")).onClick(() => {
			const builtin = this.builtinSkill(skill.id);
			if (!builtin) { new Notice(t("settings.skills.cantReadBuiltin")); return; }
			new BuiltinSkillModal(this.app, {
				mode: "view",
				skill: builtin,
				routingProbe: (message) => this.probeRouting(message),
			}).open();
		}));
		setting.addButton((button) => button
			.setButtonText(t("settings.skills.editCustomization"))
			.onClick(() => void this.openBuiltinCustomization(skill.id)));

		setting.addButton((button) => button
			.setButtonText(t("settings.skills.resetCustomization"))
			.setDisabled(!customized)
			.setTooltip(customized ? t("settings.skills.resetTooltip") : t("settings.skills.noCustomization"))
			.onClick(() => void this.resetBuiltinCustomization(skill)));
	}

	private createSkillRow(setting: Setting): void {
		setting.addButton((button) => button
			.setButtonText(t("settings.skills.createButton"))
			.setCta()
			.setTooltip(t("settings.skills.createTooltip"))
			.onClick(() => this.openCustomSkillEditor()));
	}

	/** Skill files that could not be loaded, one line each, under a count. */
	private skillProblemsRow(setting: Setting): void {
		const problems = this.plugin.skillLoadProblems();
		setting.setClass("wb-skill-problems").setName(t("settings.skills.problemsTitle", { count: problems.length }));
		setting.settingEl.setAttribute("role", "status");
		setting.descEl.empty();
		for (const problem of problems) {
			setting.descEl.createDiv({ text: `${basename(problem.path)} · ${skillProblemDescription(problem.reason)}` });
		}
	}

	/**
	 * Route one typed sentence exactly as a real turn would.
	 *
	 * The live registry matters: a Skill's phrases compete with every other
	 * Skill's, so a probe against the built-ins alone would answer a question
	 * nobody asked. `hasSelection: true` assumes the writer has selected a
	 * passage, which is the only state in which a selection-scoped Skill can
	 * fire at all — probing without one would report "needs a selection" for
	 * every phrase and teach nothing about the phrase.
	 */
	private probeRouting(message: string): SkillRouteResult {
		return routeSkill({
			message,
			hasSelection: true,
			skills: this.plugin.skills.list(),
		});
	}

	private builtinSkill(id: string): Skill | null {
		const source = this.plugin.builtinSkillSource(id);
		if (source) {
			const parsed = parseSkill(source, `${id}.md`);
			if (parsed.ok) return { ...parsed.skill, builtin: true };
		}
		return null;
	}

	private async openBuiltinCustomization(id: string): Promise<void> {
		try {
			const builtin = this.builtinSkill(id);
			if (!builtin) throw new Error(t("settings.skills.cantReadBuiltin"));
			const descriptor = this.plugin.skillDescriptors().find((item) => item.id === id);
			const source = await this.plugin.builtinSkillCustomizationSource(id);
			let initialCustomization = "";
			if (source) {
				const parsed = parseSkill(source, `${id}.md`);
				if (!parsed.ok) throw new Error("invalid-skill-customization");
				initialCustomization = parsed.skill.instruction;
			}
			new BuiltinSkillModal(this.app, {
				mode: "customize",
				skill: builtin,
				initialCustomization,
				...(descriptor?.customizationMode ? { customizationMode: descriptor.customizationMode } : {}),
				onSave: async (extension) => {
					if (descriptor?.customizationMode === "replace") {
						await this.plugin.saveBuiltinSkillReplacement(id, extension);
					} else {
						await this.plugin.saveBuiltinSkillCustomization(id, extension);
					}
					this.rerender();
				},
			}).open();
		} catch {
			new Notice(t("settings.skills.cantOpenCustomization"));
		}
	}

	private async resetBuiltinCustomization(skill: Skill): Promise<void> {
		const confirmed = await new ConfirmModal(this.app, {
			title: t("settings.skills.resetTitle", { name: skill.name }),
			body: t("settings.skills.resetBody"),
			confirmText: t("settings.skills.resetCustomization"),
		}).openAndConfirm();
		if (!confirmed) return;
		try {
			await this.plugin.resetBuiltinSkillCustomization(skill.id);
			this.rerender();
			new Notice(t("settings.skills.resetDone", { name: skill.name }));
		} catch {
			new Notice(t("settings.skills.resetFailed"));
		}
	}

	private openCustomSkillEditor(descriptor?: SkillDescriptor): void {
		new CustomSkillModal(this.app, {
			skill: descriptor?.skill,
			existingPath: descriptor?.customizationPath ?? descriptor?.skill.sourcePath,
			reservedIds: this.plugin.skillDescriptors().map((item) => item.id),
			onSave: async (source, existingPath) => {
				await this.plugin.saveCustomSkill(source, existingPath);
				this.rerender();
			},
		}).open();
	}

	private renderProjectData(containerEl: HTMLElement): void {
		const status = containerEl.createDiv({ cls: "wb-settings-status" });
		this.locationRow(new Setting(containerEl), status);
		for (const item of this.locationExtraDefinitions()) item.render(new Setting(containerEl));
		this.sessionsRow(new Setting(containerEl), status);
		this.storageRow(new Setting(containerEl), status);
	}

	// -------------------------------------------------------------------------
	// Data folder: where it is, and the way back when it is not there.
	//
	// This row is the last resort behind every automatic path (following a
	// drag, recovering after sync): whatever notice was missed, here the writer
	// can always see where the data is and act on it. Three shapes — present,
	// missing, and the extra rows for other roots the scan found.
	// -------------------------------------------------------------------------

	/** Scan results shown under the row, kept across re-renders of the page. */
	private scanResults: ProjectRootCandidate[] | null = null;
	private scanning = false;

	private locationRow(row: Setting, status: HTMLElement | null): void {
		const controller = this.plugin.projectRoot;
		row.setName(t("settings.location.name"));
		row.setClass("wb-location-row");
		// The path is the point of this row, so it is the largest thing in it:
		// body size, body colour, with the label above it in the usual place.
		const desc = row.descEl;
		desc.empty();
		const path = desc.createDiv({ cls: "wb-location-path" });
		iconSpan(path, controller.state.kind === "missing" ? "folder-x" : "folder", "wb-location-path-icon");
		path.createSpan({ cls: "wb-location-path-text", text: controller.root });
		const detail = desc.createDiv({ cls: "wb-location-detail" });
		if (controller.state.kind === "missing") {
			path.addClass("is-missing");
			detail.setText(t("settings.location.missingDesc"));
			row.addButton((button) => {
				button.setButtonText(this.scanning ? t("settings.location.scanning") : t("settings.location.scan"));
				button.setDisabled(this.scanning);
				button.onClick(() => void this.scanForRoots(status));
			});
			row.addButton((button) => {
				button.setButtonText(t("settings.location.pick"));
				button.onClick(() => new ProjectLocationModal(this.app, this.plugin, () => this.rerender()).open());
			});
			row.addButton((button) => {
				button.setButtonText(t("settings.location.createHere"));
				button.onClick(() => void (async () => {
					const confirmed = await new ConfirmModal(this.app, {
						title: t("settings.location.createHereTitle", { root: controller.root }),
						body: t("settings.location.createHereBody"),
						confirmText: t("settings.location.createHereConfirm"),
					}).openAndConfirm();
					if (!confirmed) return;
					await controller.createHere();
					this.scanResults = null;
					new Notice(t("settings.location.created", { root: controller.root }));
					this.rerender();
				})());
			});
			return;
		}
		// What is in there and the two ways to move it; counts and sizes are
		// the rows below this one.
		detail.setText(t("settings.location.hint", { name: controller.root.split("/").pop() ?? controller.root }));
		row.addButton((button) => {
			button.setButtonText(t("settings.location.move"));
			button.onClick(() => new ProjectLocationModal(this.app, this.plugin, () => this.rerender()).open());
		});
	}

	/** Rows for the other roots in the vault: scan results while missing, inactive roots while ready. */
	private locationExtraDefinitions(): Array<{ name: string; searchable?: boolean; render: (setting: Setting) => void }> {
		const controller = this.plugin.projectRoot;
		if (controller.state.kind === "missing") {
			const results = this.scanResults ?? controller.state.candidates;
			if (this.scanResults !== null && results.length === 0) {
				return [{
					name: t("settings.location.scanEmpty"),
					searchable: false,
					render: (setting) => {
						setting.setName(t("settings.location.scanEmpty")).setClass("wb-location-empty");
					},
				}];
			}
			return results.map((candidate) => ({
				name: candidate.root,
				searchable: false,
				render: (setting: Setting) => this.candidateRow(setting, candidate),
			}));
		}
		return controller.inactiveRoots.map((candidate) => ({
			name: t("settings.location.inactiveName", { path: candidate.root }),
			searchable: false,
			render: (setting: Setting) => this.inactiveRootRow(setting, candidate),
		}));
	}

	private candidateRow(setting: Setting, candidate: ProjectRootCandidate): void {
		setting.setClass("wb-location-candidate");
		setting.nameEl.empty();
		setting.nameEl.createEl("code", { text: candidate.root });
		const detail = candidate.updatedAt !== null
			? t("settings.location.candidate", { count: candidate.conversations, date: formatDate(candidate.updatedAt) })
			: t("settings.location.candidateNoDate", { count: candidate.conversations });
		const hint = candidate.root === DEFAULT_PROJECT_ROOT && this.plugin.projectRoot.root !== DEFAULT_PROJECT_ROOT
			? ` ${t("settings.location.candidateDefaultHint")}`
			: "";
		setting.setDesc(detail + hint);
		setting.addButton((button) => {
			button.setButtonText(t("settings.location.use")).setCta();
			button.onClick(() => void (async () => {
				await this.plugin.projectRoot.useCandidate(candidate.root);
				this.scanResults = null;
				new Notice(t("settings.location.switched", { root: candidate.root }));
				this.rerender();
			})());
		});
	}

	private inactiveRootRow(setting: Setting, candidate: ProjectRootCandidate): void {
		setting.setClass("wb-location-candidate");
		setting.setName(t("settings.location.inactiveName", { path: candidate.root }));
		setting.setDesc(t("settings.location.inactiveDesc", { count: candidate.conversations }));
		setting.addButton((button) => {
			button.setButtonText(t("settings.location.use"));
			button.onClick(() => void (async () => {
				await this.plugin.projectRoot.useCandidate(candidate.root);
				new Notice(t("settings.location.switched", { root: candidate.root }));
				this.rerender();
			})());
		});
	}

	private async scanForRoots(status: HTMLElement | null): Promise<void> {
		this.scanning = true;
		this.rerender();
		try {
			this.scanResults = await this.plugin.projectRoot.scan();
			if (this.scanResults.length === 0) status?.setText(t("settings.location.scanEmpty"));
		} finally {
			this.scanning = false;
			this.rerender();
		}
	}

	/** How many conversations there are, and a way to drop the archived ones. */
	private sessionsRow(setting: Setting, status: HTMLElement | null): void {
		const sessions = this.plugin.sessions;
		const archived = sessions.archivedSessions();
		const limitReached = sessions.count >= SESSION_RECOMMENDED_LIMIT;

		setting
			.setName(t("settings.sessions.name"))
			.setDesc(
				t("settings.sessions.desc", { count: sessions.count, limit: SESSION_RECOMMENDED_LIMIT, archived: archived.length }) +
				(limitReached ? t("settings.sessions.limitReached") : ""),
			)
			.addButton((button) => {
				button.setButtonText(t("settings.sessions.cleanArchived"));
				button.setDisabled(archived.length === 0);
				button.onClick(async () => {
					if (archived.length === 0) return;
					const dates = archived.map((session) => Date.parse(session.updatedAt)).filter(Number.isFinite);
					const range = dates.length > 0
						? t("settings.sessions.dateRange", { from: formatDate(Math.min(...dates)), to: formatDate(Math.max(...dates)) })
						: t("settings.sessions.dateUnknown");
					const confirmed = await new ConfirmModal(this.app, {
						title: t("settings.sessions.deleteTitle", { count: archived.length }),
						body: t("settings.sessions.deleteBody", { range }),
						confirmText: t("settings.sessions.deleteConfirm", { count: archived.length }),
						destructive: true,
					}).openAndConfirm();
					if (!confirmed) return;
					const deleted = await sessions.deleteArchivedSessions();
					this.plugin.vaultState.retainSessionPreferences(sessions.all().map((session) => session.id));
					this.plugin.conversationChanged();
					this.plugin.rememberActiveSession();
					this.plugin.refreshViews();
					status?.setText(t("settings.sessions.deleted", { count: deleted }));
					new Notice(t("settings.sessions.deleted", { count: deleted }));
					this.rerender();
				});
			});
	}

	/**
	 * What the plugin occupies, split into what sync charges for and what it
	 * does not.
	 *
	 * Obsidian Sync uploads a whole file per change and keeps every revision
	 * against a paid quota, so "how much of this is my sync bill" is a fair
	 * question with no other answer in the app. Measuring is asynchronous and
	 * the row renders before it finishes; the description fills itself in.
	 */
	private storageRow(row: Setting, status: HTMLElement | null): void {
		row.setName(t("settings.storage.name"));
		row.setDesc("…");
		void (async () => {
			const usage = await this.plugin.projectStore.storageUsage();
			row.setDesc(t("settings.storage.desc", {
				syncedFiles: usage.synced.files,
				syncedSize: formatBytes(usage.synced.bytes),
				localFiles: usage.local.files,
				localSize: formatBytes(usage.local.bytes),
			}));
			// Obsidian 1.13 keeps the row across re-renders, so a measurement
			// that started before the last one must not add a second button.
			row.controlEl.empty();
			row.addButton((button) => {
				button.setButtonText(t("settings.storage.clear"));
				button.setDisabled(usage.local.files === 0);
				button.onClick(async () => {
					const confirmed = await new ConfirmModal(this.app, {
						title: t("settings.storage.clearTitle"),
						body: t("settings.storage.clearBody", {
							files: usage.local.files,
							size: formatBytes(usage.local.bytes),
						}),
						confirmText: t("settings.storage.clearConfirm", { files: usage.local.files }),
						destructive: true,
					}).openAndConfirm();
					if (!confirmed) return;
					const { removed } = await this.plugin.projectStore.clearLocalCache();
					status?.setText(t("settings.storage.cleared", { count: removed }));
					new Notice(t("settings.storage.cleared", { count: removed }));
					this.rerender();
				});
			});
		})();
	}

	private renderVersion(containerEl: HTMLElement): void {
		// Read-only. Installation and updates belong to Obsidian's Community plugins;
		// the line names the build so a writer can quote it when asking for help.
		new Setting(containerEl)
			.setName(buildLabel(this.plugin.manifest.version))
			.setDesc(t("settings.version.installedDesc"));
	}
}

/** Sizes a person can compare at a glance; exact bytes help nobody here. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString(getLocale() === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
}

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function skillProblemDescription(reason: string): string {
	if (/duplicate skill id/iu.test(reason)) return t("settings.skillProblem.duplicateId");
	if (/conflicts with built-in/iu.test(reason)) return t("settings.skillProblem.conflictsBuiltin");
	if (/override targets unknown built-in/iu.test(reason)) return t("settings.skillProblem.unknownBuiltin");
	if (/missing frontmatter/iu.test(reason)) return t("settings.skillProblem.missingFrontmatter");
	if (/unterminated|yaml|frontmatter/iu.test(reason)) return t("settings.skillProblem.invalidFrontmatter");
	if (/skill body is empty/iu.test(reason)) return t("settings.skillProblem.emptyBody");
	if (/schemaVersion/iu.test(reason)) return t("settings.skillProblem.schemaVersion");
	if (/baseVersion|baseHash/iu.test(reason)) return t("settings.skillProblem.baseVersion");
	if (/routingAllowQuestions/iu.test(reason)) return t("settings.skillProblem.routing");
	if (/instructionProfile/iu.test(reason)) return t("settings.skillProblem.instructionProfile");
	if (/action/iu.test(reason)) return t("settings.skillProblem.action");
	if (/scope/iu.test(reason)) return t("settings.skillProblem.scope");
	if (/id/iu.test(reason)) return t("settings.skillProblem.id");
	return t("settings.skillProblem.generic");
}

/**
 * The nearest ancestor that actually scrolls, starting from the element itself.
 *
 * Obsidian has moved which element owns the settings scrollbar between
 * versions, so this asks the DOM rather than naming a class that may not be
 * the scroller in the next release. Called before the page is emptied, while
 * the overflow it is looking for still exists.
 */
function findScroller(from: HTMLElement): HTMLElement | null {
	for (let node: HTMLElement | null = from; node; node = node.parentElement) {
		if (node.scrollHeight > node.clientHeight + 1) return node;
	}
	return null;
}

/** The Provider a Connection carries when it carries one, which every Connection does today. */
function soleProvider(capabilities: Capabilities): ProviderCapability | undefined {
	return capabilities.providers.length === 1 ? capabilities.providers[0] : undefined;
}
