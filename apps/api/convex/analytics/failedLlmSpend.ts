/**
 * The ledger side of a dispatch that failed after the provider billed it
 * (#1256, #1260). The dispatch helpers throw an `LlmPartialUsageError`
 * (lib/llm/partialUsage.ts) carrying that usage; a caller that ends the
 * failure itself records it here, through the same `recordLlmSpend` row its
 * success path writes. Kept beside `./llmUsage.ts` rather than in it, so it
 * reaches `recordLlmSpend` through the module's export: a test that stubs the
 * ledger write sees these rows too.
 */

import { LlmPartialUsageError } from '../lib/llm/partialUsage';
import { recordLlmSpend } from './llmUsage';

/**
 * Await one dispatch whose failure the caller ends itself: it fails soft, or
 * its error goes somewhere that records nothing. When the dispatch fails after
 * the provider billed it, that usage is recorded under `feature` and the
 * provider's original error is rethrown, so the caller's catch sees what it
 * saw before and nothing above it can record the same usage again. A failed
 * write is swallowed: the dispatch error is the one to surface. A success is
 * the caller's to record.
 */
export async function recordSpendOnFailure<T>(
	ctx: Parameters<typeof recordLlmSpend>[0],
	feature: string,
	dispatch: Promise<T>,
	write: typeof recordLlmSpend = recordLlmSpend
): Promise<T> {
	try {
		return await dispatch;
	} catch (error) {
		if (!(error instanceof LlmPartialUsageError)) throw error;
		try {
			await write(ctx, feature, error.tokenUsage, error.modelUsed);
		} catch {
			// ignore — spend accounting must not replace the dispatch error
		}
		throw error.cause;
	}
}
