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
	{ prefix: 'gpt-4o-mini', inputPerM: 0.15, outputPerM: 0.6 },
	{ prefix: 'gpt-4o', inputPerM: 2.5, outputPerM: 10 },
	{ prefix: 'gpt-4.1-nano', inputPerM: 0.1, outputPerM: 0.4 },
	{ prefix: 'gpt-4.1-mini', inputPerM: 0.4, outputPerM: 1.6 },
	{ prefix: 'gpt-4.1', inputPerM: 2, outputPerM: 8 },
	{ prefix: 'o4-mini', inputPerM: 1.1, outputPerM: 4.4 },
	{ prefix: 'o3-mini', inputPerM: 1.1, outputPerM: 4.4 },
	// Anthropic (Claude) — covers both OpenAI-compat proxy ids and native ids.
	{ prefix: 'claude-3-5-haiku', inputPerM: 0.8, outputPerM: 4 },
	{ prefix: 'claude-3-haiku', inputPerM: 0.25, outputPerM: 1.25 },
	{ prefix: 'claude-3-5-sonnet', inputPerM: 3, outputPerM: 15 },
	{ prefix: 'claude-3-opus', inputPerM: 15, outputPerM: 75 },
	{ prefix: 'claude-haiku', inputPerM: 0.8, outputPerM: 4 },
	{ prefix: 'claude-sonnet', inputPerM: 3, outputPerM: 15 },
	{ prefix: 'claude-opus', inputPerM: 15, outputPerM: 75 },
];

// Conservative fallback (≈ a mid-tier model) — never price an unknown model $0.
const DEFAULT_INPUT_PER_M = 3;
const DEFAULT_OUTPUT_PER_M = 12;

export interface CostEstimate {
	costUsd: number;
	/** True when the model id didn't match the table (priced with the default). */
	estimated: boolean;
}

export function estimateCost(modelUsed: string | undefined, usage: TokenUsage | undefined): CostEstimate {
	if (!usage) return { costUsd: 0, estimated: modelUsed === undefined };
	const id = (modelUsed ?? '').toLowerCase();
	const match = id ? PRICING.find((p) => id.startsWith(p.prefix) || id.includes(p.prefix)) : undefined;
	const inputPerM = match?.inputPerM ?? DEFAULT_INPUT_PER_M;
	const outputPerM = match?.outputPerM ?? DEFAULT_OUTPUT_PER_M;
	const costUsd =
		(usage.promptTokens / 1_000_000) * inputPerM + (usage.completionTokens / 1_000_000) * outputPerM;
	return { costUsd, estimated: match === undefined };
}

/** Convenience: just the dollar figure. */
export function estimateCostUsd(modelUsed: string | undefined, usage: TokenUsage | undefined): number {
	return estimateCost(modelUsed, usage).costUsd;
}
