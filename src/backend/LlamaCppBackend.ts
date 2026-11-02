import type {
	AIBackend,
	AIEvent,
	Capabilities,
	HealthResult,
	RewritePayload,
	TurnPayload,
	UsageInfo,
} from "./AIBackend";
import type { LocalConnection } from "../connections/types";
import { adapterInstructions, adapterMessages, rewriteMessages, withSystemMessage } from "./requestText";
import { fetchHttpClient, type HttpClient, type HttpRequest, type HttpResponse } from "./HttpClient";
import { unsafeVaultPathMessage } from "./safePath";
import { redactCredential } from "../auth/redact";
import { t } from "../i18n";
import { MAX_REPLY_CHARS } from "./streaming";
import { fullEffortLadder } from "./effort";
import { asError } from "../util/errors";

export const LOCAL_OPENAI_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_OPENAI_MODEL = "gemma4-12b-writing";



/**
 * llama.cpp accepts the plugin's whole ladder for `reasoning_effort`. Which of
 * the levels a model does anything useful with is the chat template's
 * business, so they are only offered when the server says the template
 * understands them.
 */

/** What `GET /props` tells us about the loaded model. llama.cpp's own capability document. */
interface ServerProps {
	supportsReasoningEffort: boolean;
	vision: boolean;
}

interface GenerationProfile {
	temperature: number;
	topK: number;
	topP: number;
	minP: number;
	repeatPenalty: number;
}

interface Completion {
	text: string;
	finishReason?: string;
	usage?: UsageInfo;
}

/**
 * Local llama.cpp through its OpenAI-compatible HTTP API. The server is
 * usually unauthenticated, but a key is server-wide once set: `--api-key`
 * challenges loopback callers too, on `/props` and every `/v1` route (`/health`
 * stays open). So the connection carries one optionally, and it is sent on
 * every request rather than only on generation.
 */
export class LlamaCppBackend implements AIBackend {
	readonly displayName: string;
	private readonly apiBaseUrl: string;
	private readonly healthEndpoint: string;
	private readonly propsEndpoint: string;
	/** Empty when the server runs without `--api-key`. */
	private readonly apiKey: string;
	private readonly authHeaders: Record<string, string>;
	/** Cached `GET /props`; what the loaded model actually supports. */
	private props: ServerProps | null = null;
	private readonly configurationError: string | null;
	private readonly httpClient: HttpClient;
	private readonly inFlight = new Map<string, AbortController>();
	private readonly cancelled = new Set<string>();
	private activeRequestId: string | null = null;
	/** requestUrl cannot abort its transport; keep the server slot reserved. */
	private generationTransportBusy = false;

	constructor(connection: LocalConnection, fetchImpl?: typeof fetch, httpClient?: HttpClient) {
		if (connection.config.engine !== "openai-compatible") {
			throw new Error("LlamaCppBackend requires a Local OpenAI-compatible connection.");
		}
		this.displayName = connection.name;
		const endpoints = localEndpoints(connection.config.baseUrl);
		this.apiBaseUrl = endpoints.apiBaseUrl;
		this.healthEndpoint = endpoints.healthEndpoint;
		this.propsEndpoint = endpoints.propsEndpoint;
		this.configurationError = endpoints.error ?? null;
		this.apiKey = connection.config.apiKey?.trim() ?? "";
		this.authHeaders = this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {};
		this.httpClient = httpClient ?? fetchHttpClient(fetchImpl);
	}

	async health(): Promise<HealthResult> {
		if (this.configurationError) {
			return { ok: false, status: "invalid_configuration", detail: this.configurationError };
		}
		try {
			const response = await this.requestWithTimeout({ url: this.healthEndpoint });
			if (!response.ok) return { ok: false, status: "unreachable", detail: httpFailure(response, this.apiKey) };
			const raw = object(response.json);
			const healthy = raw.ok !== false && raw.status !== "error";
			return {
				ok: healthy,
				status: healthy ? string(raw.status) ?? "ok" : "unhealthy",
				...(string(raw.detail) ? { detail: string(raw.detail) } : {}),
				...(string(raw.version) ? { version: string(raw.version) } : {}),
			};
		} catch (error) {
			return { ok: false, status: "unreachable", detail: localErrorMessage(error, this.apiKey) };
		}
	}

	async getCapabilities(): Promise<Capabilities> {
		if (this.configurationError) throw new Error(this.configurationError);
		try {
			const response = await this.requestWithTimeout({ url: this.apiBaseUrl + "/models" });
			if (!response.ok) throw new Error(httpFailure(response, this.apiKey));
			const raw = object(response.json);
			const models = Array.isArray(raw.data)
				? raw.data.flatMap((item) => {
					const id = typeof item === "string" ? item : string(object(item).id);
					return id ? [id] : [];
				})
				: [];
			const uniqueModels = [...new Set(models.map((id) => id.trim()).filter(Boolean))];
			if (uniqueModels.length === 0) throw new Error(t("backend.localNoModels"));
			// Ask the server what the loaded model can do rather than assuming.
			// `/props` is llama.cpp's equivalent of the Runtime's /v2/capabilities;
			// swapping in a model that understands reasoning effort makes the
			// control appear here on its own, with no code change.
			const props = await this.serverProps();
			const efforts = props.supportsReasoningEffort ? fullEffortLadder() : [];
			return {
				providers: [{
					id: "local",
					label: "Local",
					default: true,
					models: uniqueModels.map((id) => ({
						id,
						...(id === DEFAULT_LOCAL_OPENAI_MODEL ? { default: true } : {}),
						efforts,
					})),
					efforts,
				}],
				modes: ["chat", "rewrite"],
				streaming: false,
				defaultProvider: "local",
			};
		} catch (error) {
			throw new Error(localErrorMessage(error, this.apiKey));
		}
	}

	/**
	 * `GET /props`, cached for the life of the backend. Best-effort: a server too
	 * old to serve it, or one that answers with something unexpected, simply
	 * advertises nothing rather than failing the whole capability lookup.
	 */
	private async serverProps(): Promise<ServerProps> {
		if (this.props) return this.props;
		let resolved: ServerProps = { supportsReasoningEffort: false, vision: false };
		try {
			const response = await this.requestWithTimeout({ url: this.propsEndpoint });
			if (response.ok) {
				const raw = object(response.json);
				const caps = object(raw.chat_template_caps);
				const modalities = object(raw.modalities);
				resolved = {
					supportsReasoningEffort: caps.supports_reasoning_effort === true,
					vision: modalities.vision === true,
				};
			}
		} catch { /* leave the conservative default */ }
		this.props = resolved;
		return resolved;
	}

	chat(payload: TurnPayload): AsyncIterable<AIEvent> { return this.generate(payload, false); }
	rewrite(payload: RewritePayload): AsyncIterable<AIEvent> { return this.generate(payload, true); }

	async cancel(requestId: string): Promise<void> {
		const controller = this.inFlight.get(requestId);
		if (!controller) return;
		this.cancelled.add(requestId);
		controller.abort();
	}

	private async *generate(payload: TurnPayload | RewritePayload, rewrite: boolean): AsyncIterable<AIEvent> {
		if (payload.provider !== "local") {
			yield { type: "error", code: "provider_unavailable", message: t("backend.providerNotOnConnection") };
			yield { type: "done" };
			return;
		}
		if (!payload.model) {
			yield { type: "error", code: "model_required", message: t("backend.modelRequired") };
			yield { type: "done" };
			return;
		}
		if (this.configurationError) {
			yield { type: "error", code: "local_configuration_error", message: this.configurationError };
			yield { type: "done" };
			return;
		}
		if (this.activeRequestId !== null || this.generationTransportBusy) {
			yield { type: "error", code: "local_busy", message: t("backend.localBusy"), retryable: true };
			yield { type: "done" };
			return;
		}

		const controller = new AbortController();
		this.activeRequestId = payload.requestId;
		this.inFlight.set(payload.requestId, controller);
		try {
			yield { type: "request.started", requestId: payload.requestId };
			const profile = generationProfile(payload, rewrite);
			// Only pass an effort the loaded model's template actually reads;
			// sending one it ignores would put a control in the UI that changes
			// nothing.
			const effort = payload.effort && (await this.serverProps()).supportsReasoningEffort
				? payload.effort
				: null;
			const messages = rewrite
				? rewriteMessages(payload as RewritePayload)
				: adapterMessages(payload);
			yield { type: "provider.selected", provider: "local", model: payload.model };
			const request: HttpRequest = {
				url: this.apiBaseUrl + "/chat/completions",
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.authHeaders },
				body: JSON.stringify({
					model: payload.model,
					messages: withSystemMessage(adapterInstructions(payload), messages),
					stream: false,
					// No `max_tokens`. The server owns the budget, the way the
					// Runtime does: llama.cpp runs with `n_predict = -1`, so it
					// generates until the model's own end-of-turn and only stops
					// early when the context is genuinely full. A client-side
					// ceiling here was a guess that truncated ordinary prose.
					...(effort ? { reasoning_effort: effort } : {}),
					temperature: profile.temperature,
					top_k: profile.topK,
					top_p: profile.topP,
					min_p: profile.minP,
					repeat_penalty: profile.repeatPenalty,
				}),
				signal: controller.signal,
			};
			const transport = this.httpClient(request);
			this.generationTransportBusy = true;
			void transport.finally(() => { this.generationTransportBusy = false; }).catch(() => undefined);
			const response = await settleWithTimeout(transport, controller, LOCAL_OPENAI_REQUEST_TIMEOUT_MS);
			if (this.cancelled.delete(payload.requestId) || controller.signal.aborted) return;
			if (!response.ok) throw new Error(httpFailure(response, this.apiKey));
			if (response.text.length > MAX_REPLY_CHARS) {
				yield { type: "error", code: "reply_too_large", message: t("backend.replyTooLarge") };
				return;
			}

			const completion = parseCompletion(response.json);
			if (completion.finishReason === "length") {
				yield {
					type: "error",
					code: "output_budget_exhausted",
					message: t("backend.outputBudget"),
				};
				return;
			}
			if (!completion.text.trim()) {
				yield { type: "error", code: "local_empty_response", message: t("backend.localEmpty") };
				return;
			}
			if (completion.usage) {
				yield { type: "usage", usage: completion.usage };
				if (this.cancelled.delete(payload.requestId) || controller.signal.aborted) return;
			}
			yield {
				type: "result",
				result: rewrite ? { replacement: completion.text } : { text: completion.text },
				metadata: {
					provider: "local",
					model: payload.model,
					...(effort ? { effort } : {}),
					...(completion.usage ? { usage: completion.usage } : {}),
				},
			};
		} catch (error) {
			if (this.cancelled.delete(payload.requestId) || isAbortError(error)) return;
			const timeout = error instanceof LocalTimeoutError;
			const message = localErrorMessage(error, this.apiKey);
			yield {
				type: "error",
				code: timeout ? "local_timeout" : message === unsafeVaultPathMessage() ? "invalid_request" : "local_unavailable",
				message: timeout ? t("backend.localTimeout") : message,
				...(timeout ? { retryable: true } : {}),
			};
		} finally {
			this.cancelled.delete(payload.requestId);
			this.inFlight.delete(payload.requestId);
			if (this.activeRequestId === payload.requestId) this.activeRequestId = null;
			yield { type: "done" };
		}
	}

	private requestWithTimeout(request: HttpRequest, existingController?: AbortController): Promise<HttpResponse> {
		const controller = existingController ?? new AbortController();
		return settleWithTimeout(
			this.httpClient({ ...request, headers: { ...this.authHeaders, ...request.headers }, signal: controller.signal }),
			controller,
			LOCAL_OPENAI_REQUEST_TIMEOUT_MS,
		);
	}
}

function generationProfile(payload: TurnPayload, rewrite: boolean): GenerationProfile {
	const action = payload.skill?.action;
	const skillId = payload.skill?.id.toLowerCase() ?? "";
	const creative = action === "continue" || skillId === "continue" || skillId === "expand";
	const precise = !creative && (rewrite || action === "rewrite");
	const analytical = !creative && !precise && ["consistency", "pacing", "character-consistency", "continuity", "foreshadow"].includes(skillId);
	return {
		temperature: creative ? 0.8 : precise ? 0.45 : analytical ? 0.35 : 0.6,
		topK: 64,
		topP: creative ? 0.95 : analytical ? 0.85 : 0.9,
		minP: 0.05,
		repeatPenalty: 1.1,
	};
}

function parseCompletion(rawValue: unknown): Completion {
	const raw = object(rawValue);
	const choices = Array.isArray(raw.choices) ? raw.choices : [];
	const first = object(choices[0]);
	const message = object(first.message);
	// llama.cpp may return `reasoning_content`, but normal WritingBuddy output
	// deliberately carries only final content. A numeric usage count is safe.
	const usage = parseUsage(raw.usage);
	return {
		text: string(message.content) ?? "",
		...(string(first.finish_reason) ? { finishReason: string(first.finish_reason) } : {}),
		...(usage ? { usage } : {}),
	};
}

function parseUsage(rawValue: unknown): UsageInfo | undefined {
	const raw = object(rawValue);
	const details = object(raw.completion_tokens_details);
	const inputTokens = finiteNumber(raw.prompt_tokens);
	const outputTokens = finiteNumber(raw.completion_tokens);
	const totalTokens = finiteNumber(raw.total_tokens);
	const reasoningTokens = finiteNumber(details.reasoning_tokens) ?? finiteNumber(raw.reasoning_tokens);
	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && reasoningTokens === undefined) return undefined;
	return {
		...(inputTokens !== undefined ? { inputTokens } : {}),
		...(outputTokens !== undefined ? { outputTokens } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
	};
}

interface LocalEndpoints {
	apiBaseUrl: string;
	healthEndpoint: string;
	propsEndpoint: string;
	error?: string;
}

function localEndpoints(value: string): LocalEndpoints {
	const fallback = value.trim().replace(/\/+$/, "");
	try {
		const api = new URL(value.trim());
		if (api.protocol !== "http:" && api.protocol !== "https:") throw new Error("unsupported protocol");
		if (!isLoopbackHost(api.hostname)) throw new Error("non-loopback host");
		if (api.username || api.password || api.search || api.hash) throw new Error("credentials, query, or fragment");
		const path = api.pathname.replace(/\/+$/, "");
		if (path !== "" && path !== "/v1") throw new Error("unexpected API path");
		api.pathname = "/v1";
		const apiBaseUrl = api.toString().replace(/\/$/, "");
		const health = new URL(api.origin);
		health.pathname = "/health";
		const props = new URL(api.origin);
		props.pathname = "/props";
		return {
			apiBaseUrl,
			healthEndpoint: health.toString().replace(/\/$/, ""),
			propsEndpoint: props.toString().replace(/\/$/, ""),
		};
	} catch {
		// Keep invalid persisted configuration recoverable: health() reports the
		// problem instead of making construction blank the Settings UI.
		return {
			apiBaseUrl: fallback,
			healthEndpoint: fallback,
			propsEndpoint: fallback,
			error: t("backend.localBaseUrlInvalid"),
		};
	}
}

function isLoopbackHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function settleWithTimeout<T>(promise: Promise<T>, controller: AbortController, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: number | undefined;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) window.clearTimeout(timer);
			controller.signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(abortError()));
		timer = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			controller.signal.removeEventListener("abort", onAbort);
			controller.abort();
			reject(new LocalTimeoutError());
		}, timeoutMs);
		controller.signal.addEventListener("abort", onAbort, { once: true });
		if (controller.signal.aborted) onAbort();
		promise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(asError(error))),
		);
	});
}

class LocalTimeoutError extends Error {
	constructor() { super("Local request timed out"); this.name = "TimeoutError"; }
}

function abortError(): Error { const error = new Error("Aborted"); error.name = "AbortError"; return error; }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function httpFailure(response: HttpResponse, credential?: string): string { return "Local OpenAI-compatible HTTP " + response.status + (response.text ? "：" + redactCredential(response.text, credential).slice(0, 200) : ""); }
function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function localErrorMessage(error: unknown, credential?: string): string {
	const detail = redactCredential(describe(error), credential);
	if (detail.includes("LOCAL LLM CORS CHANGE REQUIRED")) return detail;
	return /cors|cross-origin|failed to fetch|networkerror when attempting to fetch resource/i.test(detail)
		? detail + " · LOCAL LLM CORS CHANGE REQUIRED"
		: detail;
}
