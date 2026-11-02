/**
 * Machine-local settings and secrets.
 *
 * SECURITY BOUNDARY — read this before adding a field.
 *
 * Everything in this store stays on one machine. It is deliberately *not*
 * written into the vault, because vault files are synced: a Remote AI token
 * that lands in `WritingBuddy/` would be copied to every device and every
 * backup the writer's sync provider touches, and would sit next to the
 * manuscript in plain text.
 *
 * What belongs here: Connection endpoints, credentials, per-device UI state.
 * What must never go in a vault file: any of the above.
 *
 * Current implementation is Electron `localStorage`, which means the value is
 * stored **unencrypted** in the Obsidian profile directory. That is a real
 * limitation of the storage schema. It is
 * protected by the OS user account and nothing more. The `DeviceStorage`
 * interface exists so this can be swapped for an OS credential store without
 * touching any caller.
 */

import type { AIConnection } from "../connections/types";
import { connectionSummary } from "../connections/types";
import type { SessionPreferences } from "../types";
import { CONNECTION_SETTINGS_VERSION, parseConnections } from "../connections/schema";
import {
	DEFAULT_FULL_CORPUS_DEADLINE_MINUTES,
	MAX_FULL_CORPUS_DEADLINE_MINUTES,
	MIN_FULL_CORPUS_DEADLINE_MINUTES,
	DEFAULT_FULL_CORPUS_CONCURRENCY,
	MAX_FULL_CORPUS_CONCURRENCY,
	MIN_FULL_CORPUS_CONCURRENCY,
} from "../session/fullCorpusLimits";
import { isUnroutableEffort } from "../backend/capabilities";

/** The minimum a storage backend must provide. `localStorage` satisfies it. */
export interface DeviceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface DeviceSettings {
	schemaVersion: number;
	/** All configured access targets. Credentials stay here, never in the vault. */
	connections: AIConnection[];
	/** Initial Composer choice on this machine for sessions without a local override. */
	newConversationDefaults: SessionPreferences;
	/**
	 * Use the offline mock backend instead of the remote service.
	 *
	 * No longer exposed in Settings — it is a development affordance, not a
	 * product feature. It stays here so tests and the smoke path can set it.
	 */
	useMockBackend: boolean;
	/**
	 * Whole-run time limit for a Full-manuscript analysis, in minutes.
	 *
	 * Per machine because it is a patience setting, not a project one: the same
	 * manuscript against a fast local model and against a remote queue are not
	 * the same wait. The limit exists to stop a runaway job, so it is bounded
	 * rather than removable.
	 */
	fullCorpusDeadlineMinutes: number;
	/**
	 * How many Full-analysis batches may be in flight at once.
	 *
	 * A ceiling, not a promise: a local connection serves one request at a time
	 * and quietly runs at one regardless of what is set here.
	 */
	fullCorpusConcurrency: number;
	/**
	 * Which language the interface speaks on this device.
	 *
	 * Device-local like Obsidian's own language setting: two machines showing
	 * one vault may legitimately disagree. Absent means Chinese — the plugin's
	 * source language — until the writer chooses otherwise; "auto" follows
	 * Obsidian's UI language.
	 */
	uiLocale?: "zh" | "en" | "auto";
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
	schemaVersion: CONNECTION_SETTINGS_VERSION,
	connections: [],
	newConversationDefaults: { contextDepth: "auto" },
	useMockBackend: false,
	fullCorpusDeadlineMinutes: DEFAULT_FULL_CORPUS_DEADLINE_MINUTES,
	fullCorpusConcurrency: DEFAULT_FULL_CORPUS_CONCURRENCY,
};

const KEY_PREFIX = "writing-buddy:device:";
const SETTINGS_KEY = `${KEY_PREFIX}settings`;

/** In-memory fallback for tests and for hosts without `localStorage`. */
export class MemoryDeviceStorage implements DeviceStorage {
	private readonly map = new Map<string, string>();

	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}

	removeItem(key: string): void {
		this.map.delete(key);
	}
}

/** Resolve the best available device storage for the current host. */
export function resolveDeviceStorage(): DeviceStorage {
	try {
		const candidate = (window as { localStorage?: DeviceStorage }).localStorage;
		if (candidate) {
			// Probe it: a disabled or full localStorage throws on write.
			const probe = `${KEY_PREFIX}probe`;
			candidate.setItem(probe, "1");
			candidate.removeItem(probe);
			return candidate;
		}
	} catch {
		// Fall through to memory storage.
	}
	return new MemoryDeviceStorage();
}

/** Keys older builds wrote that no current code reads. Dropped on the first load that sees them. */
export const STALE_DEVICE_KEYS = ["githubUpdateToken", "memoryService"] as const;

export class DeviceStore {
	constructor(private readonly storage: DeviceStorage = resolveDeviceStorage()) {}

	load(): DeviceSettings {
		const raw = this.storage.getItem(SETTINGS_KEY);
		if (!raw) return freshDefaultSettings();
		try {
			const decoded = JSON.parse(raw) as Record<string, unknown>;
			const parsed = parseConnections(decoded.connections);
			const connections = parsed;
			// Builds before Community distribution kept a GitHub token here for their own
			// update check, and builds with external memory kept that service's address
			// and key. Neither is read or shown any more; the first load after the
			// upgrade drops them from device storage so no credential lingers.
			const settings: DeviceSettings = {
				schemaVersion: CONNECTION_SETTINGS_VERSION,
				connections,
				newConversationDefaults: parseNewConversationDefaults(decoded, connections, undefined),
				useMockBackend: decoded.useMockBackend === true,
				fullCorpusDeadlineMinutes: boundedMinutes(decoded.fullCorpusDeadlineMinutes),
				fullCorpusConcurrency: boundedConcurrency(decoded.fullCorpusConcurrency),
				...(decoded.uiLocale === "zh" || decoded.uiLocale === "en" || decoded.uiLocale === "auto" ? { uiLocale: decoded.uiLocale } : {}),
			};
			if (STALE_DEVICE_KEYS.some((key) => key in decoded)) this.save(settings);
			return settings;
		} catch {
			return freshDefaultSettings();
		}
	}

	save(settings: DeviceSettings): void {
		this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	}

	clear(): void {
		this.storage.removeItem(SETTINGS_KEY);
	}

	/** Read a value an older version stored under a project-keyed name. */
	legacyLastActiveSession(projectId: string): string | null {
		if (!projectId) return null;
		return this.storage.getItem(`${KEY_PREFIX}lastSession:${projectId}`);
	}

	/** Forget a migrated project-keyed value. */
	clearLegacyLastActiveSession(projectId: string): void {
		if (!projectId) return;
		this.storage.removeItem(`${KEY_PREFIX}lastSession:${projectId}`);
	}
}

function freshDefaultSettings(): DeviceSettings {
	return { ...DEFAULT_DEVICE_SETTINGS, connections: [], newConversationDefaults: { contextDepth: "auto" } };
}

function parseNewConversationDefaults(
	decoded: Record<string, unknown>,
	connections: AIConnection[],
	legacyConnectionId?: string,
): SessionPreferences {
	const raw = typeof decoded.newConversationDefaults === "object" && decoded.newConversationDefaults !== null
		? decoded.newConversationDefaults as Record<string, unknown>
		: decoded;
	const connectionId = stringValue(raw.connectionId) ?? (legacyConnectionId && stringValue(decoded.defaultProvider) ? legacyConnectionId : undefined);
	const connection = connections.find((item) => item.id === connectionId && item.enabled);
	const contextDepth = raw.contextDepth ?? decoded.defaultContextDepth;
	const parsedContextDepth = parseContextDepth(contextDepth) ?? "auto";
	return {
		...(connection ? { connectionId: connection.id } : {}),
		...(connection ? {
			connectionName: connection.name,
			connectionType: connection.type,
			connectionDetail: connectionSummary(connection),
		} : {}),
		...(connection && stringValue(raw.provider ?? decoded.defaultProvider) ? { provider: stringValue(raw.provider ?? decoded.defaultProvider) } : {}),
		...(connection && stringValue(raw.model ?? decoded.defaultModel) ? { model: stringValue(raw.model ?? decoded.defaultModel) } : {}),
		...(connection && !isUnroutableEffort(stringValue(raw.effort ?? decoded.defaultEffort))
			? { effort: stringValue(raw.effort ?? decoded.defaultEffort) }
			: {}),
		contextDepth: parsedContextDepth,
	};
}

/**
 * A stored deadline that is missing, malformed or out of range falls back to
 * the default rather than to zero — a zero here would abort every Full run
 * immediately, which is a worse failure than waiting.
 */
function boundedMinutes(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FULL_CORPUS_DEADLINE_MINUTES;
	const rounded = Math.round(value);
	if (rounded < MIN_FULL_CORPUS_DEADLINE_MINUTES) return MIN_FULL_CORPUS_DEADLINE_MINUTES;
	if (rounded > MAX_FULL_CORPUS_DEADLINE_MINUTES) return MAX_FULL_CORPUS_DEADLINE_MINUTES;
	return rounded;
}

function boundedConcurrency(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_FULL_CORPUS_CONCURRENCY;
	const rounded = Math.round(value);
	if (rounded < MIN_FULL_CORPUS_CONCURRENCY) return MIN_FULL_CORPUS_CONCURRENCY;
	if (rounded > MAX_FULL_CORPUS_CONCURRENCY) return MAX_FULL_CORPUS_CONCURRENCY;
	return rounded;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Per-vault, per-device state.
 *
 * Which conversation was open is device state, not project data: two people
 * working on the same synced manuscript should each return to their own
 * conversation, not to whichever one the other person touched last.
 *
 * It used to be keyed by a generated project id, which was the only thing that
 * id was still doing. Obsidian already namespaces `loadLocalStorage` /
 * `saveLocalStorage` per vault, so the host provides the scoping and there is no
 * identifier to invent, store, or keep in sync.
 */
export interface VaultScopedStorage {
	get(key: string): string | null;
	set(key: string, value: string | null): void;
}

/** In-memory implementation, for tests and for hosts without the API. */
export class MemoryVaultScopedStorage implements VaultScopedStorage {
	private readonly map = new Map<string, string>();

	get(key: string): string | null {
		return this.map.get(key) ?? null;
	}

	set(key: string, value: string | null): void {
		if (value === null) this.map.delete(key);
		else this.map.set(key, value);
	}
}

const LAST_SESSION_KEY = "lastSession";
const SESSION_PREFERENCES_KEY = "composerPreferences";
const SESSION_PREFERENCES_VERSION = 1;

interface StoredSessionPreferences {
	schemaVersion: number;
	bySession: Record<string, SessionPreferences>;
}

/** Device state that belongs to one vault. */
export class VaultDeviceState {
	constructor(private readonly storage: VaultScopedStorage) {}

	lastActiveSession(): string | null {
		return this.storage.get(LAST_SESSION_KEY);
	}

	setLastActiveSession(sessionId: string | null): void {
		this.storage.set(LAST_SESSION_KEY, sessionId);
	}

	/**
	 * Composer choices made on this device, scoped by Obsidian to this vault.
	 *
	 * Conversation JSON is synced, so it cannot be the source of truth for an
	 * AI connection that may not even exist on another machine. Only the small,
	 * explicitly allow-listed preference shape is stored here; connection
	 * configs and credentials are never accepted.
	 */
	sessionPreferences(sessionId: string): SessionPreferences | null {
		if (!sessionId) return null;
		return this.loadSessionPreferences().bySession[sessionId] ?? null;
	}

	setSessionPreferences(sessionId: string, preferences: SessionPreferences | null): void {
		if (!sessionId) return;
		const state = this.loadSessionPreferences();
		if (preferences === null) {
			delete state.bySession[sessionId];
		} else {
			const parsed = parseStoredSessionPreferences(preferences);
			if (Object.keys(parsed).length === 0) delete state.bySession[sessionId];
			else state.bySession[sessionId] = parsed;
		}
		this.saveSessionPreferences(state);
	}

	clearSessionPreferences(sessionId: string): void {
		this.setSessionPreferences(sessionId, null);
	}

	/** Follow a conversation-file rename without changing its local selection. */
	moveSessionPreferences(previousSessionId: string, sessionId: string): void {
		if (!previousSessionId || !sessionId || previousSessionId === sessionId) return;
		const state = this.loadSessionPreferences();
		const preferences = state.bySession[previousSessionId];
		delete state.bySession[previousSessionId];
		if (preferences) state.bySession[sessionId] = preferences;
		else delete state.bySession[sessionId];
		this.saveSessionPreferences(state);
	}

	/** Drop entries for conversations that no longer exist in this vault. */
	retainSessionPreferences(sessionIds: Iterable<string>): void {
		const keep = new Set(sessionIds);
		const state = this.loadSessionPreferences();
		let changed = false;
		for (const sessionId of Object.keys(state.bySession)) {
			if (keep.has(sessionId)) continue;
			delete state.bySession[sessionId];
			changed = true;
		}
		if (changed) this.saveSessionPreferences(state);
	}

	private loadSessionPreferences(): StoredSessionPreferences {
		const raw = this.storage.get(SESSION_PREFERENCES_KEY);
		if (!raw) return emptyStoredSessionPreferences();
		try {
			const decoded = JSON.parse(raw) as unknown;
			if (typeof decoded !== "object" || decoded === null) return this.clearStoredSessionPreferences();
			const record = decoded as Record<string, unknown>;
			if (record.schemaVersion !== SESSION_PREFERENCES_VERSION || typeof record.bySession !== "object" || record.bySession === null) {
				return this.clearStoredSessionPreferences();
			}
			const bySession = Object.create(null) as Record<string, SessionPreferences>;
			for (const [sessionId, value] of Object.entries(record.bySession as Record<string, unknown>)) {
				if (!/^[a-z0-9_-]{1,64}$/.test(sessionId)) continue;
				const preferences = parseStoredSessionPreferences(value);
				if (Object.keys(preferences).length > 0) bySession[sessionId] = preferences;
			}
			const parsed = { schemaVersion: SESSION_PREFERENCES_VERSION, bySession };
			// Normalize older/hand-edited values on first read. This also scrubs
			// unknown keys such as accidentally embedded connection credentials.
			if (raw !== JSON.stringify(parsed)) this.saveSessionPreferences(parsed);
			return parsed;
		} catch {
			return this.clearStoredSessionPreferences();
		}
	}

	private clearStoredSessionPreferences(): StoredSessionPreferences {
		this.storage.set(SESSION_PREFERENCES_KEY, null);
		return emptyStoredSessionPreferences();
	}

	private saveSessionPreferences(state: StoredSessionPreferences): void {
		if (Object.keys(state.bySession).length === 0) {
			this.storage.set(SESSION_PREFERENCES_KEY, null);
			return;
		}
		this.storage.set(SESSION_PREFERENCES_KEY, JSON.stringify(state));
	}
}

function emptyStoredSessionPreferences(): StoredSessionPreferences {
	return { schemaVersion: SESSION_PREFERENCES_VERSION, bySession: Object.create(null) as Record<string, SessionPreferences> };
}

/** Parse only values that are safe and meaningful in vault-scoped local state. */
function parseStoredSessionPreferences(raw: unknown): SessionPreferences {
	if (typeof raw !== "object" || raw === null) return {};
	const record = raw as Record<string, unknown>;
	const preferences: SessionPreferences = {};
	const connectionId = stringValue(record.connectionId);
	const connectionName = stringValue(record.connectionName);
	const connectionDetail = stringValue(record.connectionDetail);
	const provider = stringValue(record.provider);
	const model = stringValue(record.model);
	const effort = stringValue(record.effort);
	if (connectionId) preferences.connectionId = connectionId;
	if (connectionName) preferences.connectionName = connectionName;
	if (record.connectionType === "remote-runtime" || record.connectionType === "direct-api" || record.connectionType === "local") {
		preferences.connectionType = record.connectionType;
	}
	if (connectionDetail) preferences.connectionDetail = connectionDetail;
	if (provider) preferences.provider = provider;
	if (model) preferences.model = model;
	// A stored `auto` is dropped rather than carried forward. It was offered as
	// an Effort for a while, is not one the Runtime accepts, and reading it back
	// would put a value in the row that the dropdown can no longer offer. Absent
	// means the same thing it now means everywhere: let the server decide.
	if (effort && !isUnroutableEffort(effort)) preferences.effort = effort;
	const contextDepth = parseContextDepth(record.contextDepth);
	if (contextDepth) preferences.contextDepth = contextDepth;
	return preferences;
}

/** Normalize retired user-facing modes at both device-local read boundaries. */
function parseContextDepth(value: unknown): SessionPreferences["contextDepth"] {
	if (value === "medium" || value === "high") return "auto";
	if (value === "auto" || value === "full" || value === "low") return value;
	return undefined;
}

/**
 * Guard used by the storage tests: no vault-bound payload may carry any field
 * whose name suggests a credential or a machine-specific path.
 *
 * This is a blunt instrument on purpose. It is cheaper to reject a
 * legitimately-named field and rename it than to leak a token into a synced
 * file and never notice.
 */
const FORBIDDEN_KEY_PATTERN =
	/(token|secret|password|passphrase|credential|apikey|api_key|privatekey|private_key|ssh|executable|binpath|bin_path|deviceid|device_id)/i;

/**
 * Keys that trip the pattern but are not credentials.
 *
 * "Token" is overloaded: a usage counter reports how many *language model*
 * tokens a turn cost, which is ordinary metadata and belongs in the vault
 * alongside the provider and model. The allowlist is exact-match and stays
 * short — anything added here is a claim that the name is safe, so it should
 * be a name the codebase actually controls.
 */
/**
 * Keys that contain "token" and are counts, not credentials.
 *
 * Exact matches only. The guard exists to stop a bearer token reaching a synced
 * vault file, and a list of substrings would be a hole in it — but a usage
 * report that says how many tokens a turn cost is not a secret, and flagging it
 * teaches people to ignore the alarm.
 */
const ALLOWED_KEYS = new Set([
	"inputtokens",
	"outputtokens",
	"totaltokens",
	"maxtokens",
	"cachedinputtokens",
	"reasoningtokens",
	"estimatedtokens",
]);

export function findForbiddenVaultKeys(value: unknown, path = "$"): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => findForbiddenVaultKeys(item, `${path}[${index}]`));
	}
	if (typeof value !== "object" || value === null) return [];

	const found: string[] = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (!ALLOWED_KEYS.has(key.toLowerCase()) && FORBIDDEN_KEY_PATTERN.test(key)) {
			found.push(`${path}.${key}`);
		}
		found.push(...findForbiddenVaultKeys(child, `${path}.${key}`));
	}
	return found;
}
