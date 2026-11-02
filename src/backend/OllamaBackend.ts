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
import { fetchHttpClient, type HttpClient } from "./HttpClient";
import { unsafeVaultPathMessage } from "./safePath";
import { t } from "../i18n";
import { MAX_REPLY_CHARS } from "./streaming";
import { fullEffortLadder, isOllamaLevelledThinkingFamily, ollamaThink } from "./effort";



export class OllamaBackend implements AIBackend {
	readonly displayName: string;
	private readonly baseUrl: string;
	private readonly httpClient: HttpClient;
	private readonly inFlight = new Map<string, AbortController>();
	private readonly cancelled = new Set<string>();
	/** Each model's trained context length from `/api/show`, or null when the server does not say. */
	private readonly contextLengths = new Map<string, number | null>();

	constructor(connection: LocalConnection, fetchImpl?: typeof fetch, httpClient?: HttpClient) {
		this.displayName = connection.name;
		this.baseUrl = connection.config.baseUrl.replace(/\/+$/, "");
		this.httpClient = httpClient ?? fetchHttpClient(fetchImpl);
	}

	async health(): Promise<HealthResult> {
		try {
			await this.models();
			return { ok: true, status: "ok" };
		} catch (error) {
			return { ok: false, status: "unreachable", detail: describe(error) };
		}
	}

	async getCapabilities(): Promise<Capabilities> {
		const models = await this.models();
		// Effort is offered only where Ollama's `think` takes a level: a model
		// the server reports as thinking-capable and of a family that reads one.
		// Other thinking models take `think` as a flag, which Ollama already
		// sets for them; a control that changed nothing would be a false one.
		const levelled = await Promise.all(models.map(async (id) => isOllamaLevelledThinkingFamily(id) && await this.thinks(id)));
		const mapped = models.map((id, index) => ({ id, efforts: levelled[index] ? fullEffortLadder() : [] }));
		return {
			providers: [{ id: "local", label: "Local", models: mapped, efforts: mapped.some((model) => model.efforts.length > 0) ? fullEffortLadder() : [] }],
			modes: ["chat", "rewrite"],
			streaming: false,
		};
	}

	chat(payload: TurnPayload): AsyncIterable<AIEvent> { return this.generate(payload, false); }
	rewrite(payload: RewritePayload): AsyncIterable<AIEvent> { return this.generate(payload, true); }
	async cancel(requestId: string): Promise<void> {
		const controller = this.inFlight.get(requestId);
		if (!controller) return;
		this.cancelled.add(requestId);
		controller.abort();
	}

	private async models(): Promise<string[]> {
		const response = await this.httpClient({ url: this.baseUrl + "/api/tags" });
		if (!response.ok) throw new Error("Ollama HTTP " + response.status);
		const raw = response.json as Record<string, unknown>;
		return Array.isArray(raw.models)
			? raw.models.flatMap((item) => {
				const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
				return typeof record.name === "string" ? [record.name] : [];
			})
			: [];
	}

	/** Whether `/api/show` lists `thinking` among the model's capabilities. A failed lookup counts as no. */
	private async thinks(model: string): Promise<boolean> {
		try {
			const response = await this.httpClient({
				url: this.baseUrl + "/api/show",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model }),
			});
			if (!response.ok) return false;
			const capabilities = object(response.json).capabilities;
			return Array.isArray(capabilities) && capabilities.includes("thinking");
		} catch {
			return false;
		}
	}

	/** The model's trained context length (`model_info["<arch>.context_length"]`), looked up once per model. */
	private async contextLength(model: string): Promise<number | null> {
		if (this.contextLengths.has(model)) return this.contextLengths.get(model) ?? null;
		let length: number | null = null;
		try {
			const response = await this.httpClient({
				url: this.baseUrl + "/api/show",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model }),
			});
			if (response.ok) {
				const info = object(object(response.json).model_info);
				const key = Object.keys(info).find((name) => name.endsWith(".context_length"));
				const value = key ? info[key] : undefined;
				if (typeof value === "number" && Number.isFinite(value) && value > 0) length = value;
			}
		} catch { /* the default window is used below */ }
		this.contextLengths.set(model, length);
		return length;
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
		const controller = new AbortController();
		this.inFlight.set(payload.requestId, controller);
		try {
			yield { type: "request.started", requestId: payload.requestId };
			const messages = rewrite
				? rewriteMessages(payload as RewritePayload)
				: adapterMessages(payload);
			const think = isOllamaLevelledThinkingFamily(payload.model) ? ollamaThink(payload.effort) : undefined;
			yield { type: "provider.selected", provider: "local", model: payload.model, ...(think ? { effort: payload.effort ?? undefined } : {}) };
			const instructions = adapterInstructions(payload);
			// Ollama's default window follows the machine's memory (4k under 24 GB)
			// and cuts a longer prompt silently, so the manuscript and the
			// instructions could vanish without an error (PC-024). The window is
			// sized to this request, within what the model was trained for.
			const promptChars = (instructions?.length ?? 0) + messages.reduce((total, message) => total + message.content.length, 0);
			const numCtx = ollamaContextWindow(promptChars, await this.contextLength(payload.model));
			const response = await this.httpClient({
				url: this.baseUrl + "/api/chat",
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: payload.model,
					stream: false,
					messages: withSystemMessage(instructions, messages),
					...(think ? { think } : {}),
					options: { num_ctx: numCtx },
				}),
			});
			if (!response.ok) throw new OllamaHttpError(response.status, "Ollama HTTP " + response.status + "：" + response.text.slice(0, 200));
			if (response.text.length > MAX_REPLY_CHARS) {
				yield { type: "error", code: "reply_too_large", message: t("backend.replyTooLarge") };
				return;
			}
			const raw = object(response.json);
			if (this.cancelled.delete(payload.requestId) || controller.signal.aborted) return;
			const message = typeof raw.message === "object" && raw.message !== null ? raw.message as Record<string, unknown> : {};
			const text = typeof message.content === "string" ? message.content : "";
			const doneReason = typeof raw.done_reason === "string" ? raw.done_reason : undefined;
			if (isOutputBudgetExhausted(doneReason)) {
				yield { type: "error", code: "output_budget_exhausted", message: t("backend.outputBudget") };
				return;
			}
			if (!text.trim()) {
				yield { type: "error", code: "local_empty_response", message: t("backend.localEmpty") };
				return;
			}
			const usage: UsageInfo = {
				...(typeof raw.prompt_eval_count === "number" ? { inputTokens: raw.prompt_eval_count } : {}),
				...(typeof raw.eval_count === "number" ? { outputTokens: raw.eval_count } : {}),
			};
			if (Object.keys(usage).length > 0) {
				yield { type: "usage", usage };
				if (this.cancelled.delete(payload.requestId) || controller.signal.aborted) return;
			}
			yield {
				type: "result",
				result: rewrite ? { replacement: text } : { text },
				metadata: {
					provider: "local",
					model: payload.model,
					...(think && payload.effort ? { effort: payload.effort } : {}),
					...(Object.keys(usage).length > 0 ? { usage } : {}),
				},
			};
		} catch (error) {
			if (this.cancelled.delete(payload.requestId) || controller.signal.aborted || isAbortError(error)) return;
			const message = describe(error);
			// The server answered and said no (a missing model, out of memory): the
			// status tells health it is reachable, so one bad model does not mark
			// the whole connection offline.
			yield { type: "error", code: message === unsafeVaultPathMessage() ? "invalid_request" : "local_unavailable", message, ...(error instanceof OllamaHttpError ? { status: error.status } : {}) };
		} finally {
			this.cancelled.delete(payload.requestId);
			this.inFlight.delete(payload.requestId);
			yield { type: "done" };
		}
	}
}

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
class OllamaHttpError extends Error {
	constructor(readonly status: number, message: string) { super(message); this.name = "OllamaHttpError"; }
}

/** Room for the answer, on top of the prompt. */
const OLLAMA_ANSWER_TOKENS = 4096;
/** The window when the model's own length is unknown. */
const OLLAMA_DEFAULT_CEILING = 32_768;

/**
 * The `num_ctx` for one request: the prompt (a token per character, which
 * holds for Chinese and over-counts English) plus room for the answer,
 * rounded up to a power of two so the server does not reload the model for
 * every small change in size, and never past what the model was trained for.
 */
export function ollamaContextWindow(promptChars: number, modelLength: number | null): number {
	const ceiling = modelLength ?? OLLAMA_DEFAULT_CEILING;
	let window = 8192;
	while (window < promptChars + OLLAMA_ANSWER_TOKENS && window < ceiling) window *= 2;
	return Math.min(window, ceiling);
}

function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function isOutputBudgetExhausted(reason: string | undefined): boolean {
	const normalized = reason?.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return normalized === "length" || normalized === "max_tokens";
}
