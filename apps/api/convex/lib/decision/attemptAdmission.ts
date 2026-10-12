'use node';

/**
 * Spend admission for decision attempts (ADR-0073, Phase 1b), split out of
 * `./dispatch.ts` to hold it under the size cap: a native paid attempt's
 * hold, and the settlements an attempt's recorder writes with its rows.
 */

import { decisionProviderFor } from '../decisionProviders';
import { serializedBytes } from '../llm/admissionPort';
import { admitDispatch, type DispatchHold } from '../llm/dispatchAdmission';
import type { LlmCallMeter } from '../llm/requestMeter';
import type { ResolvedDecisionProvider, RunDecisionOptions } from './contract';
import type { QuestionSet } from './questions';

/** Output a native decision answer may bill: labels and probabilities, never text. */
export const NATIVE_DECISION_OUTPUT_TOKENS = 4_096;
/** The wire codec frames the state and questions; its body is at most this many times their JSON. */
export const NATIVE_WIRE_EXPANSION = 2;

/**
 * Reserve one native paid attempt. The language-backed adapter (`llm`) is
 * reserved by its own dispatch, and a local engine costs nothing.
 */
export async function admitNativeAttempt<Q extends QuestionSet>(
	meter: LlmCallMeter,
	provider: ResolvedDecisionProvider,
	options: RunDecisionOptions<Q>
): Promise<Pick<DispatchHold, 'end'>> {
	const adapter = decisionProviderFor(provider.kind);
	if (provider.kind === 'llm' || adapter.isLocal) return { end: async () => {} };
	const modelUsed = provider.modelId ?? adapter.defaultModel;
	return admitDispatch(
		meter,
		{
			maxOutputTokens: NATIVE_DECISION_OUTPUT_TOKENS,
			abortSignal: undefined,
			maxAttempts: 1,
			modelUsed,
			requestBase: { modelUsed },
		},
		{
			plane: 'decision',
			isIncremental: false,
			size: {
				bytes:
					NATIVE_WIRE_EXPANSION *
					serializedBytes({ state: options.state, questions: options.questions }),
				messages: 1,
			},
		}
	);
}

/** The holds this attempt closed, for the recorder to settle with its rows. */
export function holdSettlements(meter: LlmCallMeter): {
	args: { settlements?: { reservationId: string; expectedRequests: number }[] };
	markSent(): void;
} {
	const holds = meter.closedUnsettledHolds();
	const settlements = holds.map((hold) => ({
		reservationId: hold.reservationId,
		expectedRequests: meter.requestsUnder(hold.reservationId),
	}));
	return {
		args: settlements.length ? { settlements } : {},
		markSent: () => {
			for (const hold of holds) meter.markHoldSettled(hold.reservationId);
		},
	};
}
