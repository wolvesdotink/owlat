/**
 * Token-usage arithmetic for a step or surface that makes more than one model
 * call and reports them as one. Pure (no ctx, no 'use node').
 */

import type { TokenUsage } from '../../agent/steps/types';

/** Sum two optional token-usage records; an absent side contributes nothing. */
export function addTokenUsage(
	a: TokenUsage | undefined,
	b: TokenUsage | undefined
): TokenUsage | undefined {
	if (!a) return b;
	if (!b) return a;
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
	};
}
