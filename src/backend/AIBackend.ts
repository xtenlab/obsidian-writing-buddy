/**
 * The one seam between WritingBuddy and whatever is generating text.
 *
 * Nothing above this interface may know about a specific provider, a CLI, a
 * wire format, or a vendor's event names. Remote Runtime, Direct API, and Local
 * adapters all implement this interface without leaking transport choices into
 * conversation or UI code.
 */

import type { DocPosition, SkillAction } from "../types";

// ---------------------------------------------------------------------------
// Health and capabilities
// ---------------------------------------------------------------------------

export interface HealthResult {
	ok: boolean;
	/** Short machine-ish status, e.g. `ok`, `degraded`, `unreachable`. */
	status: string;
	/** Free-form detail for the settings panel. Never parsed. */
	detail?: string;
	version?: string;
}

export interface EffortCapability {
	id: string;
	label?: string;
	default?: boolean;
}

export interface ModelCapability {
	id: string;
	label?: string;
	/** Marked by the server as its default for the provider. */
	default?: boolean;
	/**
	 * Effort levels this specific model supports. Genuinely narrower than the
	 * provider's union for some models, so a pinned model uses this list.
	 */
	efforts?: EffortCapability[];
	defaultEffort?: string;
}

export interface ProviderCapability {
	id: string;
	label?: string;
	models: ModelCapability[];
	/** The union of effort levels across this provider's models. */
	efforts: EffortCapability[];
	default?: boolean;
	/** False when the Runtime reports the provider as unusable right now. */
	available?: boolean;
}

export interface Capabilities {
	providers: ProviderCapability[];
	/** Modes the server admits to supporting, e.g. `chat`, `rewrite`. */
	modes: string[];
	streaming: boolean;
	defaultProvider?: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * A transcript entry as it goes on the wire.
 *
 * The field is `content`, not `text`. This is the frozen Runtime V2 contract:
 * sending `text` is rejected with
 * `400 malformed_request: messages[0].content must be a string`.
 */
export interface RequestMessage {
	role: "user" | "assistant";
	content: string;
}

/**
 * The resolved skill instruction sent alongside a request.
 *
 * The field is `instructions`, plural. The Runtime validates it and rejects the
 * singular spelling outright:
 * `400 malformed_request: context.skill.instructions must be a non-empty string`.
 * It also rejects an empty string, so a skill with no body must be omitted
 * rather than sent blank.
 *
 * The Runtime does apply these instructions to the model, so they must not also
 * be duplicated into `messages`.
 */
export interface SkillPayload {
	id: string;
	name: string;
	action: SkillAction;
	instructions: string;
}

/** Manuscript context. The backend reads it; it never writes the manuscript. */
export interface RequestContext {
	/** Vault-relative path of the file the writer is in, if any. */
	currentFile?: string;
	selection?: {
		filePath: string;
		text: string;
		from: DocPosition;
		to: DocPosition;
	};
	skill?: SkillPayload;
}

/**
 * What a turn needs, independent of protocol version.
 *
 * This is the vocabulary the interface speaks. Note the absence of a required
 * project id: under the client-owned-context architecture there is no server
 * directory to point at, because WritingBuddy has already read the vault and put
 * the evidence in messages.
 */
export interface TurnPayload {
	requestId: string;
	/** Stable user-configured execution target. Adapters never serialize this. */
	connectionId?: string;
	conversationId: string;
	/**
	 * Omitted when the writer has not pinned one.
	 *
	 * There is no `auto`: the Runtime routes to `codex` or `claude` and answers
	 * 400 to anything else, so "server decides" is the absence of the field.
	 */
	provider?: string;
	/** Null exists for defensive legacy parsing; the UI requires an explicit model. */
	model: string | null;
	effort: string | null;
	messages: RequestMessage[];
	/**
	 * The most output tokens this call may spend, when the caller has a
	 * budget (a conversation does not). Direct
	 * connections send it in the provider's own field.
	 */
	maxOutputTokens?: number;
	/** Vault-relative path of the file being worked on. Never absolute. */
	currentFile?: string;
	skill?: SkillPayload;
	selection?: {
		filePath: string;
		text: string;
		from: DocPosition;
		to: DocPosition;
	};
	/**
	 * Vault excerpts WritingBuddy read locally and is supplying as evidence.
	 *
	 * `text` must be non-empty — the Runtime rejects a blank one with
	 * `400 malformed_request: context.documents[0].text must be a non-empty
	 * string`. `path` is vault-relative and the model cites it back, so it is
	 * how a claim gets attributed to a file.
	 */
	documents?: ContextDocumentPayload[];
	instruction?: string;
}

/** One supplied vault excerpt. */
export interface ContextDocumentPayload {
	/** Vault-relative path. Never an absolute filesystem path. */
	path: string;
	text: string;
}

/** A turn that produces a replacement candidate for a captured range. */
export interface RewritePayload extends TurnPayload {
	selection: NonNullable<TurnPayload["selection"]>;
	instruction: string;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

export interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/**
	 * Input tokens the provider served from its own cache.
	 *
	 * The Runtime reports these and they were being dropped here. They are a
	 * real, checkable number about what a turn cost, which is exactly what the
	 * detail panel should be made of instead of invented progress.
	 */
	cachedInputTokens?: number;
	/** Tokens the provider spent reasoning. A count, never the content. */
	reasoningTokens?: number;
}

/** What the Runtime reports about a completed turn, alongside the result. */
export interface ResultMetadata {
	provider?: string;
	model?: string;
	effort?: string;
	/** Set by the Runtime when it fell back to another provider. */
	fellBack?: boolean;
	/**
	 * How the Runtime extracted a rewrite from the model's answer.
	 *
	 * `sentinel` means the model answered in the agreed format. `fallback` means
	 * it did not, and the Runtime salvaged what it could — so the replacement may
	 * still carry a preamble like "好的，这是改写后的版本：". That text would be
	 * written straight into the manuscript, so a fallback parse is never applied
	 * without asking.
	 */
	rewriteParse?: string;
	usage?: UsageInfo;
	/** How long the Runtime itself measured the turn taking. */
	durationMs?: number;
	/** How many provider attempts it took. More than one means a retry. */
	attempts?: number;
}

export type AIEvent =
	| { type: "request.started"; requestId: string }
	| {
			type: "provider.selected";
			provider: string;
			model?: string;
			effort?: string;
			/**
			 * `token` or `message`.
			 *
			 * Worth carrying because it explains something the writer can
			 * otherwise only find puzzling: at `message` granularity — which is
			 * what Codex does — nothing streams, so the panel sits on one state
			 * for the whole turn and then the answer appears at once.
			 */
			granularity?: string;
	  }
	| { type: "content.delta"; text: string }
	/**
	 * Something the assistant is doing, reported by the Runtime.
	 *
	 * `kind` decides how much weight it gets. `reasoning` and `narration` carry
	 * the model's own summary of what it is working on and are shown live;
	 * `command` is a tool invocation and is kept for the detail panel; anything
	 * else is a category this UI has no use for and is ignored rather than
	 * rendered, so a Runtime that adds a new kind cannot break an older plugin.
	 */
	| { type: "activity"; label: string; kind?: string; detail?: string }
	| { type: "usage"; usage: UsageInfo }
	| { type: "fallback"; from?: string; to: string; reason?: string }
	/** The Runtime attaches provider metadata to the result, so carry it. */
	| { type: "result"; result: ChatResult | RewriteResult; metadata?: ResultMetadata }
	/**
	 * `retryAfterSec` is the server's own instruction, not our guess. Note that
	 * `retryable` in the Runtime protocol means "another provider would help",
	 * not "you may retry this" — a `rate_limited` failure carries
	 * `retryable: false` and is still exactly the kind you wait out.
	 */
	| {
		type: "error";
		message: string;
		code?: string;
		retryable?: boolean;
		retryAfterSec?: number;
		/**
		 * The HTTP status the endpoint answered with, when it answered at all.
		 * An answer — even a refusal — is proof the endpoint is reachable, which
		 * a transport failure (no status) is not; connection health reads it.
		 */
		status?: number;
	}
	| { type: "done" };

export interface ChatResult {
	text: string;
}

export interface RewriteResult {
	/** The candidate replacement. The plugin applies it locally, or not at all. */
	replacement: string;
}

export function isRewriteResult(result: ChatResult | RewriteResult): result is RewriteResult {
	return typeof (result as RewriteResult).replacement === "string";
}

export function isChatResult(result: ChatResult | RewriteResult): result is ChatResult {
	return typeof (result as ChatResult).text === "string";
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface AIBackend {
	/** Human-readable backend name for the settings panel. */
	readonly displayName: string;

	health(): Promise<HealthResult>;
	getCapabilities(): Promise<Capabilities>;

	chat(payload: TurnPayload): AsyncIterable<AIEvent>;
	rewrite(payload: RewritePayload): AsyncIterable<AIEvent>;

	cancel(requestId: string): Promise<void>;
}
