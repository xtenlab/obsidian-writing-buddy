/**
 * One effort ladder for every connection.
 *
 * Vendors spell reasoning effort differently — OpenAI takes a word, Anthropic
 * a thinking budget in tokens, Google a `thinkingConfig`, Ollama a `think`
 * flag — and none of them lets a client ask which values a model accepts.
 * The plugin therefore offers the same six words everywhere and each backend
 * translates them into its own request shape. What the writer picks is what
 * the request carries: nothing is downgraded quietly, and an endpoint that
 * refuses a level says so in the ordinary error path.
 *
 * An endpoint that does describe its models (`supported_reasoning_levels` in
 * OpenAI's own catalogue format, or one of the field names in use elsewhere)
 * is believed over this ladder: it knows its models and the plugin does not.
 */

import type { EffortCapability } from "./AIBackend";

export const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LADDER)[number];

/** Pre-selected when a model offers a ladder and the endpoint named no default. */
export const DEFAULT_EFFORT: EffortLevel = "medium";

export function isEffortLevel(value: unknown): value is EffortLevel {
	return typeof value === "string" && (EFFORT_LADDER as readonly string[]).includes(value);
}

/** The full ladder as capability entries, labelled by the wire value itself. */
export function fullEffortLadder(): EffortCapability[] {
	return EFFORT_LADDER.map((id) => ({ id }));
}

/**
 * An advertised ladder as capability entries.
 *
 * Known levels come first, in ladder order, so a dropdown reads low to high
 * whatever order the endpoint listed them in; a level the ladder does not
 * know (`none`, `ultra`) is kept after them in the endpoint's order, because
 * the endpoint said the model takes it. The advertised default, when one is
 * named and listed, is flagged so it is pre-selected.
 */
export function advertisedEffortLadder(ids: readonly string[], defaultId?: string | null): EffortCapability[] {
	const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
	const known = EFFORT_LADDER.filter((level) => unique.includes(level));
	const unknown = unique.filter((id) => !isEffortLevel(id));
	return [...known, ...unknown].map((id) => (id === defaultId ? { id, default: true } : { id }));
}

/**
 * The effort a fresh selection starts with.
 *
 * The endpoint's default when it named one, `medium` when the ladder has it,
 * otherwise the middle of whatever was offered. Undefined only when the
 * model offers no effort at all.
 */
export function defaultEffortFor(efforts: readonly EffortCapability[]): string | undefined {
	if (efforts.length === 0) return undefined;
	const flagged = efforts.find((effort) => effort.default === true);
	if (flagged) return flagged.id;
	if (efforts.some((effort) => effort.id === DEFAULT_EFFORT)) return DEFAULT_EFFORT;
	return efforts[Math.floor((efforts.length - 1) / 2)].id;
}

/**
 * The effort a request carries for a model.
 *
 * A stored value the model still offers is kept. A value it does not offer —
 * from an older install, or from a model change — becomes the default rather
 * than an error the writer has to click through. A model with no ladder
 * carries none.
 */
export function resolveEffort(stored: string | undefined, efforts: readonly EffortCapability[]): string | undefined {
	if (efforts.length === 0) return undefined;
	if (stored && efforts.some((effort) => effort.id === stored)) return stored;
	return defaultEffortFor(efforts);
}

/**
 * Anthropic: how each Claude model takes thinking (Anthropic's documentation,
 * 2026-10). Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5 and later, and
 * Fable/Mythos refuse `budget_tokens` with a 400 and take only adaptive
 * thinking, its depth set by `output_config.effort` (`low` … `max`, no
 * `minimal`). Opus and Sonnet 4.6 take adaptive thinking too, without `xhigh`.
 * 3.7 and the 4.0–4.5 lines take a budget in tokens, which the answer's own
 * share must exceed. 3.5 and earlier have no thinking. A Claude model whose
 * version cannot be read is a newer one, so it is treated as adaptive. A
 * model that is not Claude at all is another vendor's behind the Messages
 * wire (Kimi, DeepSeek, GLM), and those take a budget.
 */
export type ClaudeThinking = "adaptive" | "budget" | "none";

export function claudeThinking(model: string): ClaudeThinking {
	const bare = bareModelId(model).replace(/[-@]\d{8}$/, "");
	if (!bare.startsWith("claude")) return "budget";
	if (/^claude-(fable|mythos)\b/.test(bare)) return "adaptive";
	const version = claudeVersion(bare);
	if (!version) return "adaptive";
	const [major, minor] = version;
	if (major >= 5 || (major === 4 && minor >= 6)) return "adaptive";
	if (major === 4 || (major === 3 && minor >= 7)) return "budget";
	return "none";
}

/** `claude-opus-4-6`, `claude-sonnet-4`, `claude-3-7-sonnet`: the model's version as [major, minor]. */
function claudeVersion(bare: string): [number, number] | null {
	const named = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(bare);
	if (named) return [Number(named[1]), Number(named[2] ?? 0)];
	const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-(?:opus|sonnet|haiku)/.exec(bare);
	if (legacy) return [Number(legacy[1]), Number(legacy[2] ?? 0)];
	return null;
}

/** The ladder a Claude model is offered when its Models API entry says nothing about effort. */
export function claudeEfforts(model: string): EffortCapability[] {
	const mode = claudeThinking(model);
	if (mode === "none") return [];
	// Another vendor's model on the Messages wire: the three budgets every one of them takes.
	if (!bareModelId(model).startsWith("claude")) return (["low", "medium", "high"] as const).map((id) => ({ id }));
	if (mode === "budget") return fullEffortLadder();
	const bare = bareModelId(model).replace(/[-@]\d{8}$/, "");
	const levels: EffortLevel[] = /^claude-(?:opus|sonnet)-4-6$/.test(bare) ? ["low", "medium", "high", "max"] : ["low", "medium", "high", "xhigh", "max"];
	return levels.map((id) => ({ id }));
}

/**
 * Anthropic's Models API entry, read the way Anthropic publishes it:
 * `capabilities.effort.<level>.supported` names the levels a model takes, and
 * `capabilities.thinking.types.enabled` a model that thinks on a budget.
 * Undefined when the entry does not say, so the model table above decides.
 */
export function claudeAdvertisedEfforts(capabilities: Record<string, unknown>): string[] | undefined {
	const supported = (value: unknown): boolean | undefined => {
		const flag = typeof value === "object" && value !== null ? (value as { supported?: unknown }).supported : undefined;
		return typeof flag === "boolean" ? flag : undefined;
	};
	const thinking = capabilities.thinking;
	if (supported(thinking) === false) return [];
	const effort = capabilities.effort;
	if (supported(effort) === true && typeof effort === "object" && effort !== null) {
		const levels = EFFORT_LADDER.filter((level) => supported((effort as Record<string, unknown>)[level]) === true);
		if (levels.length > 0) return levels;
	}
	const types = typeof thinking === "object" && thinking !== null ? (thinking as { types?: unknown }).types : undefined;
	if (typeof types === "object" && types !== null && supported((types as Record<string, unknown>).enabled) === true) return [...EFFORT_LADDER];
	return undefined;
}

/** Tokens for thinking at each level: a budget on older models, the room adaptive thinking gets on newer ones. */
const ANTHROPIC_THINKING_BUDGET: Record<EffortLevel, number> = {
	minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768,
};
/** Output tokens reserved for the answer itself, on top of the thinking budget. */
export const ANTHROPIC_ANSWER_TOKENS = 8192;

export type AnthropicThinkingFields =
	| { max_tokens: number }
	| { thinking: { type: "enabled"; budget_tokens: number }; max_tokens: number }
	| { thinking: { type: "adaptive"; display: "summarized" }; output_config: { effort: string }; max_tokens: number };

/**
 * The thinking fields of one Claude request. Adaptive thinking is asked to
 * return summaries: the plugin drops thinking from the reply either way, but
 * with the newer models' default of omitted thinking the stream stays silent
 * for as long as the model thinks, and a proxy in between may give up on it.
 */
export function anthropicThinking(model: string, effort: string | null): AnthropicThinkingFields {
	if (!isEffortLevel(effort)) return { max_tokens: ANTHROPIC_ANSWER_TOKENS };
	const mode = claudeThinking(model);
	const budget = ANTHROPIC_THINKING_BUDGET[effort];
	if (mode === "adaptive") return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort }, max_tokens: budget + ANTHROPIC_ANSWER_TOKENS };
	if (mode === "budget") return { thinking: { type: "enabled", budget_tokens: budget }, max_tokens: budget + ANTHROPIC_ANSWER_TOKENS };
	return { max_tokens: ANTHROPIC_ANSWER_TOKENS };
}

/**
 * Google: `thinkingBudget` in tokens. The top of the ladder stays inside
 * the smallest ceiling among thinking Gemini models (24 576 on Flash) so no
 * level is refused merely for being too large.
 */
const GOOGLE_THINKING_BUDGET: Record<EffortLevel, number> = {
	minimal: 512, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576,
};

export function googleThinkingConfig(effort: string | null): { thinkingBudget: number } | undefined {
	return isEffortLevel(effort) ? { thinkingBudget: GOOGLE_THINKING_BUDGET[effort] } : undefined;
}

/**
 * Ollama: `think` is a flag, and only gpt-oss reads a level from it. Six
 * words onto three values is the coarsest translation on the ladder; the
 * pairs are adjacent, so a writer moving one step still moves or stays in the
 * direction they chose.
 */
export function ollamaThink(effort: string | null): "low" | "medium" | "high" | undefined {
	if (!isEffortLevel(effort)) return undefined;
	if (effort === "minimal" || effort === "low") return "low";
	if (effort === "medium") return "medium";
	return "high";
}

/** The vendor-prefix-free tail of a model id, as gateways and routers write them. */
export function bareModelId(model: string): string {
	return model.slice(model.lastIndexOf("/") + 1).toLowerCase();
}

/** OpenAI's own reasoning families: GPT-5 and the o-series, behind any vendor prefix. */
export function isOpenAIReasoningFamily(model: string): boolean {
	return /^(gpt-5|o[134])(?![a-z])/.test(bareModelId(model));
}

/**
 * The levels every OpenAI reasoning model takes. OpenAI's set is wider
 * (`none`, `minimal`, `xhigh`), but which of those a model accepts differs
 * from model to model and the API does not say; `max` is not an OpenAI value
 * at all. These three are the ones no reasoning model refuses.
 */
export const OPENAI_EFFORTS: readonly EffortLevel[] = ["low", "medium", "high"];

/** Gemini models with a `thinkingConfig`: 2.5 and later text models. 1.5 and 2.0, and image, speech and embedding models, refuse it. */
export function isGoogleThinkingFamily(model: string): boolean {
	const bare = bareModelId(model);
	return /^gemini-(2\.5|[3-9])/.test(bare) && !/(image|tts|embedding|live|audio)/.test(bare);
}

/** Ollama models whose `think` takes a level rather than a flag. */
export function isOllamaLevelledThinkingFamily(model: string): boolean {
	return /^gpt-oss/.test(bareModelId(model));
}
