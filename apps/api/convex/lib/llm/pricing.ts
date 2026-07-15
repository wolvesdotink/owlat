/**
 * Rough USD cost estimation for LLM token usage, so the agent-health dashboard
 * can report dollars instead of a raw token count wearing a "$".
 *
 * Prices are per-million tokens (input, output), keyed by a model-id prefix and
 * matched most-specific-first. An unknown model is priced with a conservative
 * (mid-tier) default and flagged `estimated`, so a single unpriced call never
 * silently under-reports spend to $0. Prices are approximate list prices and
 * will drift — this is a dashboard estimate, not billing.
 */

import type { TokenUsage } from '../../agent/steps/types';

type Price = { prefix: string; inputPerM: number; outputPerM: number };

// Ordered most-specific-first so `gpt-4o-mini` matches before `gpt-4o`.
const PRICING: Price[] = [
	// OpenAI
	{ prefix: 'gpt-5.6-luna', inputPerM: 1, outputPerM: 6 },
	{ prefix: 'gpt-5.6-terra', inputPerM: 2.5, outputPerM: 15 },
	{ prefix: 'gpt-5.6-sol', inputPerM: 5, outputPerM: 30 },
	{ prefix: 'gpt-5.5', inputPerM: 5, outputPerM: 30 },
	{ prefix: 'gpt-4o-mini', inputPerM: 0.15, outputPerM: 0.6 },
	{ prefix: 'gpt-4o', inputPerM: 2.5, outputPerM: 10 },
	{ prefix: 'gpt-4.1-nano', inputPerM: 0.1, outputPerM: 0.4 },
	{ prefix: 'gpt-4.1-mini', inputPerM: 0.4, outputPerM: 1.6 },
	{ prefix: 'gpt-4.1', inputPerM: 2, outputPerM: 8 },
	{ prefix: 'o4-mini', inputPerM: 1.1, outputPerM: 4.4 },
	{ prefix: 'o3-mini', inputPerM: 1.1, outputPerM: 4.4 },
	// Anthropic (Claude) — covers both OpenAI-compat proxy ids and native ids.
	// Current-generation native ids first (most-specific-first): their exact
	// list prices differ from the generic `claude-*` fallbacks below — e.g.
	// claude-opus-4-8 is $5/$25, not the older Opus $15/$75 — so they must
	// match before the generic prefixes.
	{ prefix: 'claude-fable-5', inputPerM: 10, outputPerM: 50 },
	{ prefix: 'claude-opus-4-8', inputPerM: 5, outputPerM: 25 },
	// OpenRouter spells current Anthropic ids with a dot (anthropic/claude-opus-4.8).
	{ prefix: 'claude-opus-4.8', inputPerM: 5, outputPerM: 25 },
	{ prefix: 'claude-sonnet-5', inputPerM: 3, outputPerM: 15 },
	{ prefix: 'claude-sonnet-4-5', inputPerM: 3, outputPerM: 15 },
	{ prefix: 'claude-haiku-4-5', inputPerM: 1, outputPerM: 5 },
	{ prefix: 'claude-3-5-haiku', inputPerM: 0.8, outputPerM: 4 },
	{ prefix: 'claude-3-haiku', inputPerM: 0.25, outputPerM: 1.25 },
	{ prefix: 'claude-3-5-sonnet', inputPerM: 3, outputPerM: 15 },
	{ prefix: 'claude-3-opus', inputPerM: 15, outputPerM: 75 },
	{ prefix: 'claude-haiku', inputPerM: 0.8, outputPerM: 4 },
	{ prefix: 'claude-sonnet', inputPerM: 3, outputPerM: 15 },
	{ prefix: 'claude-opus', inputPerM: 15, outputPerM: 75 },
	// Google (Gemini) — native ids, and the same ids appear provider-prefixed via
	// OpenRouter (e.g. `google/gemini-2.5-flash`), where the `includes` fallback
	// still matches. Most-specific-first: `-lite`/`-8b` variants before the base.
	{ prefix: 'gemini-3.5-flash', inputPerM: 1.5, outputPerM: 9 },
	{ prefix: 'gemini-3.1-flash-lite', inputPerM: 0.25, outputPerM: 1.5 },
	{ prefix: 'gemini-3.1-pro', inputPerM: 2, outputPerM: 12 },
	{ prefix: 'gemini-2.5-flash-lite', inputPerM: 0.1, outputPerM: 0.4 },
	{ prefix: 'gemini-2.5-flash', inputPerM: 0.3, outputPerM: 2.5 },
	{ prefix: 'gemini-2.5-pro', inputPerM: 1.25, outputPerM: 10 },
	{ prefix: 'gemini-2.0-flash-lite', inputPerM: 0.075, outputPerM: 0.3 },
	{ prefix: 'gemini-2.0-flash', inputPerM: 0.1, outputPerM: 0.4 },
	{ prefix: 'gemini-1.5-flash-8b', inputPerM: 0.0375, outputPerM: 0.15 },
	{ prefix: 'gemini-1.5-flash', inputPerM: 0.075, outputPerM: 0.3 },
	{ prefix: 'gemini-1.5-pro', inputPerM: 1.25, outputPerM: 5 },
	// Popular OpenRouter upstreams (curated in the settings model picker). The ids
	// arrive provider-prefixed (deepseek/deepseek-v4-flash) and match via `includes`.
	{ prefix: 'deepseek-v4-flash', inputPerM: 0.077, outputPerM: 0.154 },
	{ prefix: 'deepseek-v4-pro', inputPerM: 0.435, outputPerM: 0.87 },
	{ prefix: 'minimax-m3', inputPerM: 0.3, outputPerM: 1.2 },
	{ prefix: 'mimo-v2.5-pro', inputPerM: 0.435, outputPerM: 0.87 },
	{ prefix: 'kimi-k2.6', inputPerM: 0.66, outputPerM: 3.41 },
];

// Conservative fallback (≈ a mid-tier model) — never price an unknown model $0.
const DEFAULT_INPUT_PER_M = 3;
const DEFAULT_OUTPUT_PER_M = 12;

function priceForModel(modelUsed: string | undefined): Price | undefined {
	const id = (modelUsed ?? '').toLowerCase();
	return id
		? PRICING.find((price) => id.startsWith(price.prefix) || id.includes(price.prefix))
		: undefined;
}

const ADMISSION_NAMESPACE_FAMILIES = {
	anthropic: ['claude-'],
	deepseek: ['deepseek-'],
	google: ['gemini-'],
	minimax: ['minimax-'],
	moonshotai: ['kimi-'],
	openai: ['gpt-', 'o3-', 'o4-'],
	xiaomi: ['mimo-'],
} as const satisfies Record<string, readonly string[]>;

/** Exact provider aliases whose non-numeric suffix is part of a curated model id. */
const ADMISSION_ALIASES: Readonly<Record<string, string>> = {
	'gemini-3.1-pro-preview': 'gemini-3.1-pro',
};

/**
 * Admission pricing is intentionally stricter than dashboard reporting. Model
 * ids are either bare native ids or one explicitly supported OpenRouter
 * namespace plus a compatible family. Catalog families may only gain a numeric
 * version/date suffix; custom names that merely contain a known family fail
 * closed.
 */
function admissionPriceForModel(modelUsed: string | undefined): Price | undefined {
	if (!modelUsed || modelUsed !== modelUsed.trim() || modelUsed !== modelUsed.toLowerCase()) {
		return undefined;
	}
	const segments = modelUsed.split('/');
	if (segments.length > 2 || segments.some((segment) => segment.length === 0)) return undefined;
	const [namespaceOrModel, namespacedModel] = segments;
	const modelId = namespacedModel ?? namespaceOrModel;
	if (!modelId || !/^[a-z0-9][a-z0-9.-]*$/.test(modelId)) return undefined;

	const aliasFamily = ADMISSION_ALIASES[modelId];
	const match = aliasFamily
		? PRICING.find((price) => price.prefix === aliasFamily)
		: PRICING.find((price) => matchesAdmissionFamily(modelId, price.prefix));
	if (!match) return undefined;
	if (namespacedModel === undefined) return match;

	const allowedFamilies =
		ADMISSION_NAMESPACE_FAMILIES[namespaceOrModel as keyof typeof ADMISSION_NAMESPACE_FAMILIES];
	return allowedFamilies?.some((family) => match.prefix.startsWith(family)) ? match : undefined;
}

function matchesAdmissionFamily(modelId: string, family: string): boolean {
	if (modelId === family) return true;
	if (!modelId.startsWith(`${family}-`)) return false;
	return /^\d+(?:-\d+){0,2}$/.test(modelId.slice(family.length + 1));
}

export interface CostEstimate {
	costUsd: number;
	/** True when the model id didn't match the table (priced with the default). */
	estimated: boolean;
}

export function estimateCost(
	modelUsed: string | undefined,
	usage: TokenUsage | undefined
): CostEstimate {
	if (!usage) return { costUsd: 0, estimated: modelUsed === undefined };
	const match = priceForModel(modelUsed);
	const inputPerM = match?.inputPerM ?? DEFAULT_INPUT_PER_M;
	const outputPerM = match?.outputPerM ?? DEFAULT_OUTPUT_PER_M;
	const costUsd =
		(usage.promptTokens / 1_000_000) * inputPerM +
		(usage.completionTokens / 1_000_000) * outputPerM;
	return { costUsd, estimated: match === undefined };
}

/**
 * Price a bounded request in integer micro-USD using the same model catalog as
 * dashboard estimates. Unlike reporting, admission control must fail closed:
 * unknown models return undefined instead of using the fallback price.
 */
export function estimateKnownCostMicrousd(
	modelUsed: string | undefined,
	usage: TokenUsage
): number | undefined {
	const price = admissionPriceForModel(modelUsed);
	if (!price) return undefined;
	const input = usage.promptTokens * price.inputPerM;
	const output = usage.completionTokens * price.outputPerM;
	const microusd = Math.ceil(input + output);
	return Number.isSafeInteger(microusd) && microusd >= 0 ? microusd : undefined;
}

/** Convenience: just the dollar figure. */
export function estimateCostUsd(
	modelUsed: string | undefined,
	usage: TokenUsage | undefined
): number {
	return estimateCost(modelUsed, usage).costUsd;
}

// Model-id prefix → provider-family label, most-specific-first (so
// `text-embedding-004` reads as Google before the generic `text-embedding-`
// OpenAI prefix). Used only to GROUP spend by backend in the usage dashboard.
const PROVIDER_LABELS: { prefix: string; label: string }[] = [
	{ prefix: 'text-embedding-004', label: 'Google' },
	{ prefix: 'text-embedding', label: 'OpenAI' },
	{ prefix: 'gpt-', label: 'OpenAI' },
	{ prefix: 'chatgpt', label: 'OpenAI' },
	{ prefix: 'o1', label: 'OpenAI' },
	{ prefix: 'o3', label: 'OpenAI' },
	{ prefix: 'o4', label: 'OpenAI' },
	{ prefix: 'claude', label: 'Anthropic' },
	{ prefix: 'gemini', label: 'Google' },
	{ prefix: 'llama', label: 'Local' },
	{ prefix: 'qwen', label: 'Local' },
	{ prefix: 'mistral', label: 'Local' },
	{ prefix: 'mixtral', label: 'Local' },
	{ prefix: 'gemma', label: 'Local' },
	{ prefix: 'phi', label: 'Local' },
	{ prefix: 'deepseek', label: 'Local' },
	{ prefix: 'nomic', label: 'Local' },
];

/**
 * Best-effort provider-family label for a model id, so the usage dashboard can
 * read spend PER BACKEND rather than only per feature. Derivation is by id
 * shape:
 *   • a provider-prefixed id (contains `/`, e.g. `anthropic/claude-opus-4-8`)
 *     comes from the OpenRouter aggregator → `OpenRouter`;
 *   • otherwise the id's prefix maps to its native provider.
 *
 * This is intentionally derived from the recorded model id (not threaded through
 * the ~40 call sites), so it CANNOT distinguish an Azure deployment named after
 * its base model (it reads as OpenAI) — an accepted limitation for a spend
 * summary. An unrecognized id is `Other`; an absent id is `Unknown`.
 */
export function providerLabelForModel(modelUsed: string | undefined): string {
	const id = (modelUsed ?? '').toLowerCase().trim();
	if (!id) return 'Unknown';
	if (id.includes('/')) return 'OpenRouter';
	const match = PROVIDER_LABELS.find((p) => id.startsWith(p.prefix));
	return match?.label ?? 'Other';
}
