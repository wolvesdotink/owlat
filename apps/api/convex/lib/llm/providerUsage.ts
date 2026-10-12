/**
 * The one mapping from the AI SDK's `usage` shape to the ledger's: the
 * `TokenUsage` triple every caller already reads, plus the cache and reasoning
 * counts a ledger row breaks out (ADR-0073). Adding or rotating SDKs touches
 * this file.
 *
 * AI SDK field-name history: 4.x had `promptTokens/completionTokens`; 5.x
 * rotated to `inputTokens/outputTokens`; 6.x added `inputTokenDetails` and
 * `outputTokenDetails`. Pure (no ctx, no 'use node').
 */

import type { TokenUsage } from '../../agent/steps/types';

export type RawUsage =
	| {
			inputTokens?: number;
			outputTokens?: number;
			totalTokens?: number;
			inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
			outputTokenDetails?: { reasoningTokens?: number };
	  }
	| undefined;

export function normalizeUsage(usage: RawUsage): TokenUsage | undefined {
	if (!usage) return undefined;
	return {
		promptTokens: usage.inputTokens ?? 0,
		completionTokens: usage.outputTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
	};
}

/** A stream part's usage; a missing total is the sum of its two halves. */
export function streamUsage(u: NonNullable<RawUsage>): TokenUsage {
	const input = u.inputTokens ?? 0;
	const output = u.outputTokens ?? 0;
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: u.totalTokens ?? input + output,
	};
}

export interface UsageDetails {
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly reasoningTokens?: number;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The cache and reasoning counts a provider reported, each only when it reported one. */
export function usageDetails(usage: RawUsage): UsageDetails {
	if (!usage) return {};
	const cacheReadTokens = count(usage.inputTokenDetails?.cacheReadTokens);
	const cacheWriteTokens = count(usage.inputTokenDetails?.cacheWriteTokens);
	const reasoningTokens = count(usage.outputTokenDetails?.reasoningTokens);
	return {
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
	};
}
