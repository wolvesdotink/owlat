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

/**
 * True when a usage report carries no count at all. The SDK reports a provider
 * that sent no usage as an object whose totals are all `undefined`; that is
 * UNKNOWN usage, which the ledger records as an estimate, never as a genuine
 * zero.
 */
function isUnreported(usage: NonNullable<RawUsage>): boolean {
	return (
		usage.inputTokens === undefined &&
		usage.outputTokens === undefined &&
		usage.totalTokens === undefined
	);
}

/** The SDK usage as the ledger's triple; undefined when nothing was reported. */
export function normalizeUsage(usage: RawUsage): TokenUsage | undefined {
	if (!usage || isUnreported(usage)) return undefined;
	return {
		promptTokens: usage.inputTokens ?? 0,
		completionTokens: usage.outputTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
	};
}

/** A stream part's usage; a missing total is the sum of its two halves. Undefined when unreported. */
export function streamUsage(u: RawUsage): TokenUsage | undefined {
	if (!u || isUnreported(u)) return undefined;
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

/**
 * The usage a PROVIDER reports on its own stream (`LanguageModelV3` `finish`
 * part), before the SDK reshapes it: nested input and output totals.
 */
export interface ProviderUsageV3 {
	readonly inputTokens?: {
		readonly total?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
	};
	readonly outputTokens?: { readonly total?: number; readonly reasoning?: number };
}

/** A provider-level usage report as the ledger's usage triple and its details. */
export function providerReportedUsage(
	usage: ProviderUsageV3 | undefined
): { usage: TokenUsage; details: UsageDetails } | undefined {
	if (!usage) return undefined;
	const reportedInput = count(usage.inputTokens?.total);
	const reportedOutput = count(usage.outputTokens?.total);
	// The provider sent no counts: unknown, not zero.
	if (reportedInput === undefined && reportedOutput === undefined) return undefined;
	const input = reportedInput ?? 0;
	const output = reportedOutput ?? 0;
	return {
		usage: { promptTokens: input, completionTokens: output, totalTokens: input + output },
		details: usageDetails({
			inputTokenDetails: {
				cacheReadTokens: usage.inputTokens?.cacheRead,
				cacheWriteTokens: usage.inputTokens?.cacheWrite,
			},
			outputTokenDetails: { reasoningTokens: usage.outputTokens?.reasoning },
		}),
	};
}
