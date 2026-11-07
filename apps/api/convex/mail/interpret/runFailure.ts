/**
 * How an interpretation run that threw is recorded (`./runOnce.ts`): which
 * error code the failed extraction carries, and whether the attempt counts
 * against its retries.
 */

import { admissionRefusalOf } from '../../lib/llm/admissionPort';
import { AiNotConfiguredError } from '../../lib/aiNotConfigured';
import { isProviderAuthError } from '../../lib/llm/retryPolicy';
import type { RunBudgetRefusal } from './runShape';

export interface RunFailure {
	errorCode: 'budget' | 'ai_off' | 'provider_auth' | 'model_error';
	/** The spend refusal the run met, for a caller that holds on it. */
	budgetRefusal?: RunBudgetRefusal;
	/** Admitted attempts to record: a refusal is not one. */
	retryCount?: number;
}

/**
 * The failure a thrown run records. Pure.
 *
 *   - Spend admission refused the model call after the gate passed (the
 *     request did not fit, or another call took the headroom): a budget
 *     deferral like the gate's, not a model error, and no retry is spent.
 *   - No provider is set up: the instance cannot run AI at all, the same
 *     state as the `ai` flag being off. Recorded as that gate refusal, it is
 *     re-checked on every call instead of spending this thread's retries,
 *     and the reader names the instance, not the thread, as the cause.
 *   - The provider refused the key (401/403): the same on every thread
 *     until an admin fixes it, so it is a gate refusal too. Re-checking it
 *     costs one rejected request and no tokens.
 *   - Anything else is a model error, an admitted attempt.
 */
export function runFailureOf(error: unknown, retryCount: number | undefined): RunFailure {
	const refusal = admissionRefusalOf(error);
	const isAiUnavailable = error instanceof AiNotConfiguredError;
	const isKeyRejected = !refusal && !isAiUnavailable && isProviderAuthError(error);
	const errorCode = refusal
		? 'budget'
		: isAiUnavailable
			? 'ai_off'
			: isKeyRejected
				? 'provider_auth'
				: 'model_error';
	const isRefusal = refusal !== null || isAiUnavailable || isKeyRejected;
	const attempts = isRefusal && retryCount !== undefined ? retryCount - 1 : retryCount;
	return {
		errorCode,
		...(refusal ? { budgetRefusal: { reason: refusal.reason, limit: refusal.limit } } : {}),
		...(attempts !== undefined ? { retryCount: attempts } : {}),
	};
}
