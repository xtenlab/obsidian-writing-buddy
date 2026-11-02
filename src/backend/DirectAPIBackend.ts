import type {
	AIBackend,
	AIEvent,
	Capabilities,
	EffortCapability,
	HealthResult,
	RewritePayload,
	TurnPayload,
	UsageInfo,
} from "./AIBackend";
import type { DirectAPIConnection, DirectAPIProvider } from "../connections/types";
import { providerOf, requiresApiKey } from "../connections/providers";
import { adapterInstructions, adapterMessages, rewriteMessages, withSystemMessage, type AdapterMessage } from "./requestText";
import { fetchHttpClient, type HttpClient } from "./HttpClient";
import { MAX_REPLY_CHARS, ReplyTooLargeError, StreamInterruptedError, StreamUnavailableError, isEventStream, sseData, type StreamClient } from "./streaming";
import { redactCredential } from "../auth/redact";
import {
	ANTHROPIC_ANSWER_TOKENS,
	OPENAI_EFFORTS,
	advertisedEffortLadder,
	anthropicThinking,
	claudeAdvertisedEfforts,
	claudeEfforts,
	fullEffortLadder,
	googleThinkingConfig,
	isGoogleThinkingFamily,
	isOpenAIReasoningFamily,
} from "./effort";
import { unsafeVaultPathMessage } from "./safePath";
import { t } from "../i18n";

export interface DirectAPIBackendOptions {
	connection: DirectAPIConnection;
	fetchImpl?: typeof fetch;
	httpClient?: HttpClient;
	/** When given, replies are streamed through it; without one they arrive whole through the HTTP client. */
	streamClient?: StreamClient;
}



interface Completion {
	text: string;
	finishReason?: string;
	usage?: UsageInfo;
}

/**
 * One entry of a model listing. `efforts` is what the endpoint said about
 * reasoning effort for this model: a ladder it advertised, an empty list when
 * it explicitly declared none, and `undefined` when it said nothing at all.
 * `defaultEffort` is the level it named as the model's default, if any.
 */
export interface DiscoveredModel {
	id: string;
	efforts?: string[];
	defaultEffort?: string;
}

export class DirectAPIBackend implements AIBackend {
	readonly displayName: string;
	private readonly connection: DirectAPIConnection;
	private readonly httpClient: HttpClient;
	private readonly streamClient: StreamClient | undefined;
	/** Set once a stream could not be opened, so later turns go straight to the whole-reply path. */
	private streamingBlocked = false;
	private readonly inFlight = new Map<string, AbortController>();
	private readonly cancelled = new Set<string>();

	constructor(options: DirectAPIBackendOptions) {
		this.connection = options.connection;
		this.displayName = options.connection.name;
		this.httpClient = options.httpClient ?? fetchHttpClient(options.fetchImpl);
		this.streamClient = options.streamClient;
	}

	async health(): Promise<HealthResult> {
		try {
			await this.discoverModels(true);
			return { ok: true, status: "ok" };
		} catch (error) {
			const detail = redactCredential(describe(error), this.connection.config.apiKey);
			return {
				ok: false,
				status: isAuthError(detail) ? "unauthorized" : "unreachable",
				detail,
			};
		}
	}

	async getCapabilities(): Promise<Capabilities> {
		const models = await this.discoverModels();
		const provider = this.connection.config.provider;
		const mapped = models.map((model) => {
			const efforts = directEfforts(provider, model.id, model.efforts, model.defaultEffort);
			const defaultEffort = efforts.find((effort) => effort.default)?.id;
			return { id: model.id, efforts, ...(defaultEffort ? { defaultEffort } : {}) };
		});
		const efforts = uniqueEfforts(mapped.flatMap((model) => model.efforts));
		// A direct connection carries exactly one provider, and the writer knows
		// it by the name they gave the connection — "Tidewire", not the adapter.
		return {
			providers: [{
				id: provider,
				label: this.connection.name,
				models: mapped,
				efforts,
			}],
			modes: ["chat", "rewrite"],
			streaming: this.streamClient !== undefined,
		};
	}

	chat(payload: TurnPayload): AsyncIterable<AIEvent> {
		return this.generate(payload, false);
	}

	rewrite(payload: RewritePayload): AsyncIterable<AIEvent> {
		return this.generate(payload, true);
	}

	async cancel(requestId: string): Promise<void> {
		const controller = this.inFlight.get(requestId);
		if (!controller) return;
		this.cancelled.add(requestId);
		controller.abort();
	}

	private async *generate(payload: TurnPayload | RewritePayload, rewrite: boolean): AsyncIterable<AIEvent> {
		if (payload.provider !== this.connection.config.provider) {
			yield { type: "error", code: "provider_unavailable", message: t("backend.providerNotOnConnection") };
			yield { type: "done" };
			return;
		}
		const model = payload.model;
		if (!model) {
			yield { type: "error", code: "model_required", message: t("backend.modelRequired") };
			yield { type: "done" };
			return;
		}

		const controller = new AbortController();
		this.inFlight.set(payload.requestId, controller);
		try {
			yield { type: "request.started", requestId: payload.requestId };
			const messages = rewrite
				? rewriteMessages(payload as RewritePayload)
				: adapterMessages(payload);
			yield {
				type: "provider.selected",
				provider: this.connection.config.provider,
				model,
				...(payload.effort ? { effort: payload.effort } : {}),
			};
			const instructions = adapterInstructions(payload);
			let result: Completion;
			if (this.streamClient && !this.streamingBlocked) {
				// Stream when possible; a stream that cannot be opened at all falls
				// back to the whole reply, and stays there for this connection.
				let streamed = "";
				const stream = this.streamCompletion(this.streamClient, model, messages, instructions, payload.effort, payload.maxOutputTokens, controller.signal);
				try {
					let next = await stream.next();
					while (!next.done) {
						streamed += next.value;
						yield { type: "content.delta", text: next.value };
						if (this.cancelled.has(payload.requestId) || controller.signal.aborted) return;
						next = await stream.next();
					}
					result = next.value;
				} catch (error) {
					if (!(error instanceof StreamUnavailableError) || streamed) throw error;
					result = await this.complete(model, messages, instructions, payload.effort, payload.maxOutputTokens, controller.signal);
					// Only a whole reply that arrived proves the stream, not the endpoint,
					// was refused. A proxy's error page without CORS headers also fails the
					// fetch; blocking on it left a phone on the whole-reply path, whose
					// platform timeout then cut every long call (2026-09-23).
					this.streamingBlocked = true;
				}
			} else {
				result = await this.complete(model, messages, instructions, payload.effort, payload.maxOutputTokens, controller.signal);
			}
			if (this.cancelled.delete(payload.requestId) || controller.signal.aborted) return;
			if (isOutputBudgetExhausted(result.finishReason)) {
				yield { type: "error", code: "output_budget_exhausted", message: t("backend.outputBudget") };
				return;
			}
			// A reply the provider stopped for any reason but finishing is not an
			// answer, however much text came first: a rewrite cut there must never
			// become an Apply candidate (PC-022, PC-024).
			const withheld = withheldReply(result.finishReason);
			if (withheld) {
				yield { type: "error", code: withheld === "truncated" ? "reply_incomplete" : "reply_withheld", message: t(withheld === "truncated" ? "backend.replyIncomplete" : "backend.replyWithheld", { reason: result.finishReason ?? "" }) };
				return;
			}
			if (!result.text.trim()) {
				yield { type: "error", code: "direct_api_empty_response", message: t("backend.directEmpty") };
				return;
			}
			if (result.usage) {
				yield { type: "usage", usage: result.usage };
				if (this.cancelled.delete(payload.requestId) || controller.signal.aborted) return;
			}
			yield {
				type: "result",
				result: rewrite ? { replacement: result.text } : { text: result.text },
				metadata: {
					provider: this.connection.config.provider,
					model,
					...(payload.effort ? { effort: payload.effort } : {}),
					...(result.usage ? { usage: result.usage } : {}),
				},
			};
		} catch (error) {
			if (this.cancelled.delete(payload.requestId) || controller.signal.aborted || isAbortError(error)) return;
			if (error instanceof ReplyTooLargeError) {
				yield { type: "error", code: "reply_too_large", message: t("backend.replyTooLarge") };
				return;
			}
			if (error instanceof StreamInterruptedError) {
				yield { type: "error", code: "stream_interrupted", message: t("backend.streamInterrupted"), retryable: true };
				return;
			}
			const message = redactCredential(describe(error), this.connection.config.apiKey);
			yield {
				type: "error",
				code: message === unsafeVaultPathMessage() ? "invalid_request" : isAuthError(message) ? "unauthorized" : "direct_api_error",
				message,
				...(error instanceof HttpStatusError ? { status: error.status } : {}),
				...(error instanceof HttpStatusError && error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
			};
		} finally {
			this.cancelled.delete(payload.requestId);
			this.inFlight.delete(payload.requestId);
			yield { type: "done" };
		}
	}

	private async discoverModels(forceRemote = false): Promise<DiscoveredModel[]> {
		const pinned = this.connection.config.modelIds.map((id) => ({ id }));
		if (!forceRemote && pinned.length > 0) return pinned;
		const preset = providerOf(this.connection);
		if (requiresApiKey(preset) && !this.connection.config.apiKey) throw new Error(t("backend.missingApiKey"));
		// A provider whose API lists no models answers from its own catalogue entry — never from another provider's.
		if (preset.modelDiscovery === "preset" && preset.models?.length) return preset.models.map((id) => ({ id }));
		const provider = this.connection.config.provider;
		const base = baseUrl(this.connection);
		// Google and Anthropic list in pages (50 and 20 by default); a model past
		// the first page was simply missing. Twenty pages is far past either catalogue.
		const listed: unknown[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page += 1) {
			const request = modelRequest(provider, base, this.connection.config.apiKey, cursor);
			const response = await this.httpClient({ url: request.url, headers: request.headers });
			if (!response.ok) throw await httpError(response, this.connection.config.apiKey);
			const raw = object(response.json);
			const list = provider === "google" ? raw.models : raw.data;
			if (!Array.isArray(list)) break;
			listed.push(...(list as unknown[]));
			const next = provider === "google" ? string(raw.nextPageToken)
				: provider === "anthropic" && raw.has_more === true ? string(raw.last_id)
				: undefined;
			if (!next || next === cursor) break;
			cursor = next;
		}
		const discovered = listed.filter((item) => isChatModel(provider, item)).flatMap((item) => parseListedModel(provider, item));
		return pinned.length > 0 ? pinned : discovered;
	}

	private async complete(
		model: string,
		messages: AdapterMessage[],
		instructions: string | undefined,
		effort: string | null,
		maxOutputTokens: number | undefined,
		signal: AbortSignal,
	): Promise<Completion> {
		const provider = this.connection.config.provider;
		const key = this.connection.config.apiKey;
		const base = baseUrl(this.connection);
		const request = completionRequest(provider, base, key, model, messages, instructions, effort, maxOutputTokens);
		const response = await this.httpClient({
			url: request.url,
			method: "POST",
			signal,
			headers: request.headers,
			body: JSON.stringify(request.body),
		});
		if (!response.ok) throw await httpError(response, key);
		if (response.text.length > MAX_REPLY_CHARS) throw new ReplyTooLargeError();
		return parseCompletion(provider, object(response.json));
	}

	/**
	 * The same request with streaming asked for, its text handed out as it
	 * arrives and the completion returned at the end. A server that answers
	 * with plain JSON instead is read as one whole reply.
	 */
	private async *streamCompletion(
		streamClient: StreamClient,
		model: string,
		messages: AdapterMessage[],
		instructions: string | undefined,
		effort: string | null,
		maxOutputTokens: number | undefined,
		signal: AbortSignal,
	): AsyncGenerator<string, Completion> {
		const provider = this.connection.config.provider;
		const key = this.connection.config.apiKey;
		const request = streamingRequest(provider, completionRequest(provider, baseUrl(this.connection), key, model, messages, instructions, effort, maxOutputTokens));
		const response = await streamClient({ url: request.url, method: "POST", signal, headers: request.headers, body: JSON.stringify(request.body) });
		if (!response.ok) {
			const body = await response.text();
			// OpenAI streams some models only for verified organisations; the
			// same request without streaming is answered, so it is not an error
			// the writer should see.
			if (response.status === 400 && /organi[sz]ation must be verified/i.test(body) && /stream/i.test(body)) throw new StreamUnavailableError("streaming needs a verified organisation");
			throw await httpError({ status: response.status, text: body, headers: response.headers }, key);
		}
		if (!isEventStream(response.headers)) {
			// A server that ignored `stream: true` sent one whole reply; it is bounded like one.
			const whole = await response.text();
			if (whole.length > MAX_REPLY_CHARS) throw new ReplyTooLargeError();
			let json: unknown = null;
			try { json = JSON.parse(whole); } catch { /* an empty reply is reported below */ }
			return parseCompletion(provider, object(json));
		}
		if (!response.body) throw new StreamUnavailableError("the response carried no readable body");
		let text = "";
		let finishReason: string | undefined;
		let usage: UsageInfo | undefined;
		// Every provider says when a reply is over: `[DONE]`, a finish reason, or
		// Anthropic's `message_stop`. A connection that closes cleanly without
		// one — a proxy dropping its upstream, say — has cut the reply short, and
		// the text so far must not be offered as the answer (PC-022).
		let finished = false;
		for await (const data of sseData(response.body)) {
			if (data === "[DONE]") { finished = true; break; }
			if (data.trim() === "") continue;
			let raw: unknown;
			// Every provider frames its events as JSON; one that does not parse was
			// damaged on the way, and the text it carried would be silently missing.
			try { raw = JSON.parse(data); } catch { throw new StreamInterruptedError("a stream event was not JSON"); }
			const chunk = streamChunk(provider, object(raw));
			// Server-authored text, bounded like an HTTP error body. Redacted before
			// it is cut, so a key that straddles the cut cannot leave half of itself.
			if (chunk.error) throw new Error(redactCredential(chunk.error, key).slice(0, 200));
			if (chunk.text) {
				text += chunk.text;
				if (text.length > MAX_REPLY_CHARS) throw new ReplyTooLargeError();
				yield chunk.text;
			}
			if (chunk.finishReason) { finishReason = chunk.finishReason; finished = true; }
			if (chunk.stopped) finished = true;
			if (chunk.usage) usage = { ...usage, ...chunk.usage };
		}
		if (!finished) throw new StreamInterruptedError("the stream ended before the reply finished");
		return completion(text, finishReason, usage);
	}
}

/** The completion request, asked to stream: a flag for OpenAI-style and Anthropic bodies, a different method for Google. */
function streamingRequest(
	provider: DirectAPIProvider,
	request: { url: string; headers: Record<string, string>; body: unknown },
): { url: string; headers: Record<string, string>; body: unknown } {
	const body = object(request.body);
	if (provider === "google") return { ...request, url: request.url.replace(":generateContent", ":streamGenerateContent?alt=sse") };
	if (provider === "anthropic") {
		// Anthropic answers browser-originated requests only when told they are intentional.
		return { ...request, headers: { ...request.headers, "anthropic-dangerous-direct-browser-access": "true" }, body: { ...body, stream: true } };
	}
	// `stream_options` is OpenAI's; a compatible server may reject an unknown field, so only OpenAI is asked for usage.
	return { ...request, body: { ...body, stream: true, ...(provider === "openai" ? { stream_options: { include_usage: true } } : {}) } };
}

interface StreamChunk { text?: string; finishReason?: string; usage?: UsageInfo; error?: string; stopped?: boolean }

/** One streamed event, read in the provider's own shape. */
function streamChunk(provider: DirectAPIProvider, raw: Record<string, unknown>): StreamChunk {
	if (provider === "anthropic") {
		const type = string(raw.type);
		if (type === "content_block_delta") {
			const delta = object(raw.delta);
			return delta.type === "text_delta" && typeof delta.text === "string" ? { text: delta.text } : {};
		}
		if (type === "message_start") return { usage: parseUsage(object(raw.message).usage, "input_tokens", "output_tokens") };
		if (type === "message_delta") return { finishReason: string(object(raw.delta).stop_reason), usage: parseUsage(raw.usage, "input_tokens", "output_tokens") };
		if (type === "message_stop") return { stopped: true };
		if (type === "error") return { error: string(object(raw.error).message) ?? "stream error" };
		return {};
	}
	if (provider === "google") {
		if (raw.error !== undefined) return { error: string(object(raw.error).message) ?? "stream error" };
		const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
		const first = object(candidates[0]);
		const parts = Array.isArray(object(first.content).parts) ? (object(first.content).parts as unknown[]) : [];
		return {
			text: parts.flatMap(googleTextParts).join(""),
			finishReason: string(first.finishReason) ?? googlePromptBlock(raw),
			usage: googleUsage(raw.usageMetadata),
		};
	}
	// An OpenAI-style server that fails mid-stream sends `{"error": {...}}` in
	// place of a chunk; the text before it is not an answer.
	if (raw.error !== undefined) {
		const detail = object(raw.error);
		return { error: string(detail.message) ?? (typeof raw.error === "string" ? raw.error : "stream error") };
	}
	const choices = Array.isArray(raw.choices) ? raw.choices : [];
	const first = object(choices[0]);
	const content = object(first.delta).content;
	return {
		...(typeof content === "string" ? { text: content } : {}),
		finishReason: string(first.finish_reason),
		usage: parseUsage(raw.usage, "prompt_tokens", "completion_tokens", "total_tokens"),
	};
}

function baseUrl(connection: DirectAPIConnection): string {
	const configured = connection.config.baseUrl.trim().replace(/\/+$/, "");
	if (configured) return configured;
	switch (connection.config.provider) {
		case "openai": return "https://api.openai.com/v1";
		case "anthropic": return "https://api.anthropic.com/v1";
		case "google": return "https://generativelanguage.googleapis.com/v1beta";
		case "openai-compatible": return "";
	}
}

function modelRequest(provider: DirectAPIProvider, base: string, key: string, cursor?: string): { url: string; headers: Record<string, string> } {
	if (provider === "google") return { url: base + "/models?pageSize=1000" + (cursor ? "&pageToken=" + encodeURIComponent(cursor) : ""), headers: { "x-goog-api-key": key } };
	if (provider === "anthropic") return { url: base + "/models?limit=100" + (cursor ? "&after_id=" + encodeURIComponent(cursor) : ""), headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
	return { url: base + "/models", headers: bearer(key) };
}

/**
 * Whether a listed model can hold a conversation. Google says so itself
 * (`supportedGenerationMethods`); OpenAI's own list mixes in embedding,
 * speech, image and moderation models, and models served only by the
 * Responses API, none of which answers `/chat/completions`. A compatible
 * endpoint's list is the operator's and is taken as it is.
 */
function isChatModel(provider: DirectAPIProvider, item: unknown): boolean {
	const record = object(item);
	if (provider === "google") {
		const methods = record.supportedGenerationMethods;
		return !Array.isArray(methods) || methods.includes("generateContent");
	}
	if (provider === "openai") {
		const id = typeof item === "string" ? item : string(record.id) ?? "";
		return !/(embedding|tts|whisper|transcribe|dall-e|gpt-image|image|moderation|realtime|audio|sora|codex|computer-use|davinci|babbage|-pro(?:-|$))/i.test(id);
	}
	return true;
}

/** An unauthenticated OpenAI-compatible server gets no Authorization header rather than an empty one. */
function bearer(key: string): Record<string, string> {
	return key ? { Authorization: "Bearer " + key } : {};
}

function completionRequest(
	provider: DirectAPIProvider,
	base: string,
	key: string,
	model: string,
	messages: AdapterMessage[],
	instructions: string | undefined,
	effort: string | null,
	maxOutputTokens?: number,
): { url: string; headers: Record<string, string>; body: unknown } {
	if (provider === "anthropic") {
		// Effort is adaptive thinking at that effort on current Claude models and
		// a token budget on older ones; `max_tokens` leaves room for the answer
		// above the thinking. Thinking blocks in the reply are not text and are
		// dropped by the parsers; only the answer reaches the writer. A caller's
		// output budget takes the answer's share, above the same thinking.
		const thinking = anthropicThinking(model, effort);
		const budgeted = maxOutputTokens ? { ...thinking, max_tokens: thinking.max_tokens - ANTHROPIC_ANSWER_TOKENS + maxOutputTokens } : thinking;
		return {
			url: base + "/messages",
			headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
			body: { model, ...budgeted, ...(instructions ? { system: instructions } : {}), messages },
		};
	}
	if (provider === "google") {
		const thinkingConfig = googleThinkingConfig(effort);
		const generationConfig = { ...(thinkingConfig ? { thinkingConfig } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) };
		return {
			url: base + "/models/" + encodeURIComponent(model) + ":generateContent",
			headers: { "Content-Type": "application/json", "x-goog-api-key": key },
			body: {
				...(instructions ? { systemInstruction: { parts: [{ text: instructions }] } } : {}),
				contents: messages.map((message) => ({
					role: message.role === "assistant" ? "model" : "user",
					parts: [{ text: message.content }],
				})),
				...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
			},
		};
	}
	// OpenAI's reasoning models refuse `max_tokens` and want `max_completion_tokens`;
	// compatible servers are the other way round often enough that each gets its own.
	const outputLimit = maxOutputTokens ? (provider === "openai" ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }) : {};
	return {
		url: base + "/chat/completions",
		headers: { "Content-Type": "application/json", ...bearer(key) },
		body: {
			model,
			messages: withSystemMessage(instructions, messages),
			stream: false,
			...(effort ? { reasoning_effort: effort } : {}),
			...outputLimit,
		},
	};
}

function parseCompletion(provider: DirectAPIProvider, raw: Record<string, unknown>): Completion {
	if (provider === "anthropic") {
		const content = Array.isArray(raw.content) ? raw.content : [];
		const text = content.flatMap(anthropicTextParts).join("");
		return completion(text, string(raw.stop_reason), parseUsage(raw.usage, "input_tokens", "output_tokens"));
	}
	if (provider === "google") {
		const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
		const first = object(candidates[0]);
		const content = object(first.content);
		const parts = Array.isArray(content.parts) ? content.parts : [];
		return completion(
			parts.flatMap(googleTextParts).join(""),
			string(first.finishReason) ?? googlePromptBlock(raw),
			googleUsage(raw.usageMetadata),
		);
	}
	const choices = Array.isArray(raw.choices) ? raw.choices : [];
	const first = object(choices[0]);
	const message = object(first.message);
	return completion(
		typeof message.content === "string" ? message.content : "",
		string(first.finish_reason),
		parseUsage(raw.usage, "prompt_tokens", "completion_tokens", "total_tokens"),
	);
}

function anthropicTextParts(value: unknown): string[] {
	const record = object(value);
	return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
}
function googleTextParts(value: unknown): string[] {
	const record = object(value);
	return record.thought !== true && typeof record.text === "string" ? [record.text] : [];
}
function parseUsage(raw: unknown, inputKey: string, outputKey: string, totalKey?: string): UsageInfo | undefined {
	const value = object(raw);
	const input = number(value[inputKey]);
	const output = number(value[outputKey]);
	const total = totalKey ? number(value[totalKey]) : undefined;
	return input === undefined && output === undefined && total === undefined ? undefined : {
		...(input !== undefined ? { inputTokens: input } : {}),
		...(output !== undefined ? { outputTokens: output } : {}),
		...(total !== undefined ? { totalTokens: total } : {}),
	};
}
/**
 * A prompt Gemini refused outright: no candidates come back, only
 * `promptFeedback.blockReason`. Read as a finish reason so it is reported as
 * withheld, not as an empty reply or a dropped connection.
 */
function googlePromptBlock(raw: Record<string, unknown>): string | undefined {
	const reason = string(object(raw.promptFeedback).blockReason);
	return reason ? "PROMPT_" + reason : undefined;
}
/** Gemini counts thinking apart from the answer; both are output, as every other provider counts them. */
function googleUsage(raw: unknown): UsageInfo | undefined {
	const usage = parseUsage(raw, "promptTokenCount", "candidatesTokenCount", "totalTokenCount");
	const thoughts = number(object(raw).thoughtsTokenCount);
	if (!usage || thoughts === undefined) return usage;
	return { ...usage, outputTokens: (usage.outputTokens ?? 0) + thoughts };
}
/**
 * Why a reply that stopped is not an answer: the provider withheld it
 * (refusal, a safety or recitation block, a content filter) or cut it short
 * for a reason other than the output limit. Undefined for a normal finish
 * and for reasons this list does not know, so an unfamiliar server's own
 * word for "done" is not mistaken for a failure.
 */
export function withheldReply(reason: string | undefined): "withheld" | "truncated" | undefined {
	const normalized = reason?.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (!normalized) return undefined;
	if (["refusal", "content_filter", "safety", "recitation", "prohibited_content", "blocklist", "spii", "image_safety", "language", "other", "malformed_function_call", "malformed_response", "unexpected_tool_call"].includes(normalized) || normalized.startsWith("prompt_")) return "withheld";
	if (["model_context_window_exceeded", "continuation", "incomplete"].includes(normalized)) return "truncated";
	return undefined;
}
function completion(text: string, finishReason: string | undefined, usage: UsageInfo | undefined): Completion {
	return { text, ...(finishReason ? { finishReason } : {}), ...(usage ? { usage } : {}) };
}
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function isOutputBudgetExhausted(reason: string | undefined): boolean {
	const normalized = reason?.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return normalized === "length" || normalized === "max_tokens";
}
/**
 * One listed model, with whatever it said about reasoning effort.
 *
 * The OpenAI listing format carries no capability fields, so most entries
 * come back with `efforts` undefined and the ladder rule below decides. An
 * endpoint that does describe its models is believed instead: a ladder under
 * OpenAI's own catalogue name (`supported_reasoning_levels[].effort`, with
 * `default_reasoning_level`) or one of the other field names in use
 * (`efforts`, `effort_levels`, `effortLevels`, `reasoning_efforts`, or the same
 * inside a `capabilities` object) becomes the ladder offered, and an explicit
 * `supports_reasoning_effort: false` (or an empty ladder) means none.
 */
export function parseListedModel(provider: DirectAPIProvider, item: unknown): DiscoveredModel[] {
	if (typeof item === "string") return [{ id: item }];
	if (typeof item !== "object" || item === null) return [];
	const record = item as Record<string, unknown>;
	const rawId = record.id ?? record.name;
	if (typeof rawId !== "string") return [];
	const id = provider === "google" ? rawId.replace(/^models\//, "") : rawId;
	const capabilities = object(record.capabilities);
	const efforts = (provider === "anthropic" ? claudeAdvertisedEfforts(capabilities) : undefined) ?? advertisedEfforts(record) ?? advertisedEfforts(capabilities);
	if (efforts === undefined) return [{ id }];
	const defaultEffort = advertisedDefaultEffort(record) ?? advertisedDefaultEffort(capabilities);
	return [{ id, efforts, ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}) }];
}

function advertisedEfforts(record: Record<string, unknown>): string[] | undefined {
	const flag = record.supports_reasoning_effort ?? record.supportsReasoningEffort ?? record.reasoning_effort;
	if (flag === false) return [];
	for (const key of ["supported_reasoning_levels", "efforts", "effort_levels", "effortLevels", "reasoning_efforts", "reasoningEfforts", "supported_reasoning_efforts"]) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		return value.flatMap((entry) => {
			if (typeof entry === "string") return [entry];
			const effort = object(entry).effort ?? object(entry).id;
			return typeof effort === "string" ? [effort] : [];
		});
	}
	if (flag === true) return [...OPENAI_EFFORTS];
	// OpenRouter and Tidewire list what each model accepts; without a reasoning
	// parameter there, the model takes no effort at all.
	const parameters = record.supported_parameters;
	if (Array.isArray(parameters)) return parameters.includes("reasoning_effort") || parameters.includes("reasoning") ? [...OPENAI_EFFORTS] : [];
	return undefined;
}

function advertisedDefaultEffort(record: Record<string, unknown>): string | undefined {
	for (const key of ["default_reasoning_level", "default_effort", "defaultEffort"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * The effort ladder a model is offered (D-039, narrowed by D-057).
 *
 * What the endpoint advertised wins. Without that: OpenAI's reasoning
 * families get the three levels every one of them takes; Claude models get
 * what their generation takes (adaptive effort, or a thinking budget);
 * Gemini models with a thinking budget get the full ladder. A model on an
 * OpenAI-compatible endpoint that says nothing about reasoning gets none:
 * vendors such as Groq and Mistral refuse an unknown `reasoning_effort`
 * outright, so the field is sent only where the endpoint asked for it or the
 * model is one of OpenAI's own. A model documented not to take the control —
 * GPT-4-era OpenAI models, Claude 3.5 and earlier, Gemini 2.0 and earlier —
 * is offered none, so a request to it never carries a field it would refuse.
 */
export function directEfforts(provider: DirectAPIProvider, model: string, advertised?: string[], advertisedDefault?: string): EffortCapability[] {
	if (advertised !== undefined) return advertisedEffortLadder(advertised, advertisedDefault);
	switch (provider) {
		case "openai":
		case "openai-compatible": return isOpenAIReasoningFamily(model) ? OPENAI_EFFORTS.map((id) => ({ id })) : [];
		case "anthropic": return claudeEfforts(model);
		case "google": return isGoogleThinkingFamily(model) ? fullEffortLadder() : [];
	}
}
function uniqueEfforts(values: EffortCapability[]): EffortCapability[] {
	return [...new Map(values.map((value) => [value.id, { id: value.id }])).values()];
}
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
/** 401/403 everywhere, and Google's 400 for a key it does not recognise. */
function isAuthError(error: unknown): boolean { const value = describe(error); return value.includes("HTTP 401") || value.includes("HTTP 403") || value.includes("Authentication Error") || value.includes("API_KEY_INVALID") || /API key not valid/i.test(value); }
/** The endpoint answered, and said no. Carries the status so health can tell an answer from silence. */
class HttpStatusError extends Error {
	constructor(readonly status: number, message: string, readonly retryAfterSec?: number) { super(message); this.name = "HttpStatusError"; }
}

/** `Retry-After` as seconds from now: the header carries either a delay in seconds or an HTTP date. */
export function retryAfterSeconds(headers: Headers | null | undefined): number | undefined {
	const raw = headers?.get("retry-after")?.trim();
	if (!raw) return undefined;
	if (/^\d+$/u.test(raw)) return Number(raw);
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
async function httpError(response: { status: number; text: string; headers?: Headers | null }, credential: string): Promise<Error> {
	const safe = redactCredential(response.text, credential).slice(0, 200);
	return new HttpStatusError(response.status, "HTTP " + response.status + (safe ? "：" + safe : ""), retryAfterSeconds(response.headers));
}
