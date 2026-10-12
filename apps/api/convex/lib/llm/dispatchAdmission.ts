/**
 * Spend admission inside the dispatch (ADR-0073, Phase 1b): a call reserves
 * before EVERY provider request it makes, so the ceiling bounds what is sent
 * and a hold never has to cover a worst case that rarely happens.
 *
 * {@link admitDispatch} runs before the call's first request and reserves that
 * request (the prompt it is about to send, at the output ceiling, at the
 * model's price). Every later request (a retry, a tool round, a stream step,
 * the SDK's own re-send of a stream's opening request) grows the hold by its
 * own estimate first ({@link DispatchHold.beforeRequest}); a refusal there
 * stops the call before the request leaves. Language models are wrapped with a
 * middleware that sees each provider request; the embedding dispatch calls
 * `beforeRequest` itself, once per attempt. A model the middleware cannot wrap
 * (not a v3 model object) is held at the call's worst case up front instead.
 *
 * Every request the call records carries the hold's id (the meter stamps it
 * while the hold is open), and the meter's writer settles the hold against
 * those rows (`analytics/meteredSpend.ts`). A call that sent nothing releases
 * its hold when it ends.
 *
 * No port (a meter built outside an action, a plugin's meter, a test), a local
 * model, or a meter under a caller's own hold: nothing is reserved here.
 * Runtime-neutral.
 */

import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { LlmCallMeter } from './requestMeter';
import type { CallShape } from './callShape';
import type { LlmUsagePlane } from '../llmUsageTags';
import { MAX_LLM_ATTEMPTS } from './retryPolicy';
import { modelMaxOutputTokens } from './modelOutputLimits';
import { taskPolicy } from './taskPolicy';
import {
	dispatchHoldMicrousd,
	FALLBACK_OUTPUT_TOKENS,
	inputTokensFor,
	requestHoldMicrousd,
} from './admissionPort';

/** The shape of one dispatch, as {@link admitDispatch} prices it. */
export interface DispatchShape {
	/** Absent: the meter task's plane, else language. */
	readonly plane?: LlmUsagePlane;
	/** The first request's prompt, in characters (tool definitions included). */
	readonly inputChars: number;
	/** Steps a non-wrappable model is held for up front. */
	readonly steps?: number;
	readonly retries?: 'every_step' | 'opening_only';
	/** Embeddings have no output. */
	readonly hasOutput?: boolean;
	/**
	 * Whether every later request will pass through {@link DispatchHold.beforeRequest}
	 * (a wrapped v3 model, or the embedding dispatch). False: hold the worst case now.
	 */
	readonly isIncremental: boolean;
}

/** A dispatch's hold, while the call runs. */
export interface DispatchHold {
	/** Wrap a language model so each of its provider requests is reserved first. */
	wrap(model: LanguageModel): LanguageModel;
	/** Reserve one more request before it is sent (the first is already held). */
	beforeRequest(request?: {
		readonly inputChars?: number;
		readonly outputTokens?: number;
	}): Promise<void>;
	/** The call ended: close the hold, and release it when nothing was sent. */
	end(): Promise<void>;
}

const NO_HOLD: DispatchHold = Object.freeze({
	wrap: (model: LanguageModel) => model,
	beforeRequest: async () => {},
	end: async () => {},
});

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;

/** Whether the admission middleware can wrap `model`. */
export function isWrappableModel(model: unknown): model is LanguageModelV3 {
	return (
		typeof model === 'object' &&
		model !== null &&
		(model as { specificationVersion?: unknown }).specificationVersion === 'v3'
	);
}

/** Characters of a provider request's prompt and tool definitions, as the middleware sees them. */
function requestChars(params: { readonly prompt?: unknown; readonly tools?: unknown }): number {
	try {
		return (
			(JSON.stringify(params.prompt ?? '')?.length ?? 0) +
			(JSON.stringify(params.tools ?? [])?.length ?? 0)
		);
	} catch {
		return 0;
	}
}

/**
 * Admit one dispatch before its first request, or throw
 * `AdmissionRefusedError`. Returns the hold the dispatch threads through the
 * call and ends when the call is over.
 */
export async function admitDispatch(
	meter: LlmCallMeter | undefined,
	call: CallShape,
	shape: DispatchShape
): Promise<DispatchHold> {
	const port = meter?.admission;
	if (!meter || !port || meter.hasOuterHold || call.requestBase.isLocalEngine) return NO_HOLD;
	const plane = shape.plane ?? (meter.task ? taskPolicy(meter.task).plane : 'language');
	const outputTokens =
		shape.hasOutput === false
			? 0
			: (call.maxOutputTokens ?? modelMaxOutputTokens(call.modelUsed) ?? FALLBACK_OUTPUT_TOKENS);
	const first = shape.isIncremental
		? {
				microusd: requestHoldMicrousd({
					modelId: call.modelUsed,
					plane,
					inputChars: shape.inputChars,
					outputTokens,
				}),
				maxRequests: 1,
			}
		: dispatchHoldMicrousd({
				modelId: call.modelUsed,
				plane,
				inputTokens: inputTokensFor(shape.inputChars),
				outputTokens,
				steps: shape.steps ?? 1,
				attempts: call.maxAttempts ?? MAX_LLM_ATTEMPTS,
				retries: shape.retries ?? 'every_step',
			});
	const admitted = await port.admit({
		task: meter.task,
		plane,
		modelId: call.modelUsed,
		...(call.requestBase.endpoint ? { endpoint: call.requestBase.endpoint } : {}),
		microusd: first.microusd,
		maxRequests: first.maxRequests,
	});
	if (!admitted) return NO_HOLD;
	const { reservationId } = admitted;
	meter.openHold(reservationId, first.maxRequests);

	let covered = first.maxRequests;
	let started = 0;
	const beforeRequest: DispatchHold['beforeRequest'] = async (request = {}) => {
		started++;
		if (started <= covered) return;
		const microusd = requestHoldMicrousd({
			modelId: call.modelUsed,
			plane,
			inputChars: request.inputChars ?? shape.inputChars,
			outputTokens: request.outputTokens ?? outputTokens,
		});
		await port.extend(reservationId, microusd);
		covered++;
	};
	return {
		wrap: (model) =>
			isWrappableModel(model)
				? wrapLanguageModel({
						model,
						middleware: {
							specificationVersion: 'v3',
							wrapGenerate: async ({ doGenerate, params }) => {
								await beforeRequest({
									inputChars: requestChars(params),
									...(params.maxOutputTokens ? { outputTokens: params.maxOutputTokens } : {}),
								});
								return doGenerate();
							},
							wrapStream: async ({ doStream, params }) => {
								await beforeRequest({
									inputChars: requestChars(params),
									...(params.maxOutputTokens ? { outputTokens: params.maxOutputTokens } : {}),
								});
								return doStream();
							},
						},
					})
				: model,
		beforeRequest,
		end: async () => {
			const sent = meter.closeHold(reservationId);
			if (sent > 0) return;
			meter.markHoldSettled(reservationId);
			await port.release(reservationId).catch(() => undefined);
		},
	};
}
