/**
 * Spend admission inside the dispatch (ADR-0073, Phase 1b): a call reserves
 * before EVERY provider request it makes, sized from that request's own
 * provider parameters (`./admissionPort.ts`), so the ceiling bounds what is
 * sent and a hold never has to cover a worst case that rarely happens.
 *
 * A wrapped language model's middleware sees each provider request (each
 * attempt, tool round, stream step, and the SDK's own re-send of a stream's
 * opening request) with its real prompt, tools, schema and output ceiling.
 * The first request opens the hold (`admit`), every later one grows it
 * (`extend`), and each records its own bound under the meter's request id and
 * the attempt number the request will be recorded with, so unknown usage is
 * charged at that request's bound (`aiRouting/settlement.ts`). A refusal stops
 * the call before the request leaves. The embedding dispatch, which makes its
 * requests itself, calls {@link DispatchHold.beforeRequest} once per attempt.
 * A model the middleware cannot wrap (not a v3 model object) is held at the
 * call's worst case before its first request instead.
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
import type { AdmissionPort, LlmCallMeter } from './requestMeter';
import type { CallShape } from './callShape';
import type { LlmUsagePlane } from '../llmUsageTags';
import { MAX_LLM_ATTEMPTS } from './retryPolicy';
import { modelMaxOutputTokens } from './modelOutputLimits';
import { taskPolicy } from './taskPolicy';
import {
	dispatchHoldMicrousd,
	FALLBACK_OUTPUT_TOKENS,
	requestHoldMicrousd,
	serializedBytes,
} from './admissionPort';

/** The shape of one dispatch, as {@link admitDispatch} prices it. */
export interface DispatchShape {
	/** Absent: the meter task's plane, else language. */
	readonly plane?: LlmUsagePlane;
	/**
	 * Whether every request will pass through {@link DispatchHold.beforeRequest}
	 * with its own size (a wrapped v3 model, or the embedding dispatch). False:
	 * hold the worst case, from {@link DispatchShape.size}, before the first request.
	 */
	readonly isIncremental: boolean;
	/** The request's size as the dispatch sees it, for a worst-case hold. */
	readonly size?: { readonly bytes: number; readonly messages: number };
	/** Steps a worst-case hold covers. */
	readonly steps?: number;
	readonly retries?: 'every_step' | 'opening_only';
	/** Embeddings have no output. */
	readonly hasOutput?: boolean;
}

/** One provider request about to be sent, as admission sizes it. */
export interface RequestSize {
	readonly bytes: number;
	readonly messages: number;
	readonly outputTokens?: number;
}

/** A dispatch's hold, while the call runs. */
export interface DispatchHold {
	/** Wrap a language model so each of its provider requests is reserved first. */
	wrap(model: LanguageModel): LanguageModel;
	/** Reserve the request about to be sent, or throw `AdmissionRefusedError`. */
	beforeRequest(size: RequestSize): Promise<void>;
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

/** A provider request's size from its call options (everything that is sent). */
function providerRequestSize(params: {
	readonly prompt?: readonly unknown[];
	readonly maxOutputTokens?: number;
}): RequestSize {
	const { prompt, ...rest } = params;
	return {
		bytes: serializedBytes(prompt ?? []) + serializedBytes(rest),
		messages: prompt?.length ?? 1,
		...(params.maxOutputTokens ? { outputTokens: params.maxOutputTokens } : {}),
	};
}

/**
 * Prepare admission for one dispatch. For a worst-case shape it reserves now,
 * or throws `AdmissionRefusedError`; for an incremental one the first request
 * reserves. Returns the hold the dispatch threads through the call and ends
 * when the call is over.
 */
export async function admitDispatch(
	meter: LlmCallMeter | undefined,
	call: CallShape,
	shape: DispatchShape
): Promise<DispatchHold> {
	const port = meter?.admission;
	if (!meter || !port || meter.hasOuterHold || call.requestBase.isLocalEngine) return NO_HOLD;
	const plane = shape.plane ?? (meter.task ? taskPolicy(meter.task).plane : 'language');
	const endpoint = call.requestBase.endpoint;
	const ceiling =
		shape.hasOutput === false
			? 0
			: (call.maxOutputTokens ?? modelMaxOutputTokens(call.modelUsed) ?? FALLBACK_OUTPUT_TOKENS);
	const estimate = {
		task: meter.task,
		plane,
		modelId: call.modelUsed,
		...(endpoint ? { endpoint } : {}),
	};
	const priced = (size: RequestSize) =>
		requestHoldMicrousd({
			modelId: call.modelUsed,
			plane,
			...(endpoint ? { endpoint } : {}),
			bytes: size.bytes,
			messages: size.messages,
			outputTokens: shape.hasOutput === false ? 0 : (size.outputTokens ?? ceiling),
		});

	if (!shape.isIncremental) {
		const worst = dispatchHoldMicrousd({
			modelId: call.modelUsed,
			plane,
			...(endpoint ? { endpoint } : {}),
			bytes: shape.size?.bytes ?? 0,
			messages: shape.size?.messages ?? 1,
			outputTokens: ceiling,
			steps: shape.steps ?? 1,
			attempts: call.maxAttempts ?? MAX_LLM_ATTEMPTS,
			retries: shape.retries ?? 'every_step',
		});
		const admitted = await port.admit({
			...estimate,
			microusd: worst.microusd,
			maxRequests: worst.maxRequests,
			requestBound: { microusd: worst.maxRequestMicrousd },
		});
		if (!admitted) return NO_HOLD;
		meter.openHold(admitted.reservationId, worst.maxRequests);
		return heldUntilEnd(meter, port, admitted.reservationId, async () => {});
	}

	// Incremental: the first request opens the hold, every later one grows it.
	let reservationId: string | undefined;
	let isUnbounded = false;
	const beforeRequest = async (size: RequestSize) => {
		if (isUnbounded) return;
		const bound = {
			requestId: meter.requestId,
			attempt: meter.nextAttempt,
			microusd: priced(size),
		};
		if (reservationId !== undefined) {
			await port.extend(reservationId, bound);
			return;
		}
		const admitted = await port.admit({
			...estimate,
			microusd: bound.microusd,
			maxRequests: 1,
			requestBound: bound,
		});
		if (!admitted) {
			// Nothing bounds this call (no ceiling configured): nothing to hold.
			isUnbounded = true;
			return;
		}
		reservationId = admitted.reservationId;
		meter.openHold(reservationId, 1);
	};
	const held = heldUntilEnd(meter, port, () => reservationId, beforeRequest);
	return held;
}

/** The hold's `wrap` and `end` around a `beforeRequest`. */
function heldUntilEnd(
	meter: LlmCallMeter,
	port: AdmissionPort,
	reservation: string | (() => string | undefined),
	beforeRequest: (size: RequestSize) => Promise<void>
): DispatchHold {
	const idOf = () => (typeof reservation === 'string' ? reservation : reservation());
	return {
		wrap: (model) =>
			isWrappableModel(model)
				? wrapLanguageModel({
						model,
						middleware: {
							specificationVersion: 'v3',
							wrapGenerate: async ({ doGenerate, params }) => {
								await beforeRequest(providerRequestSize(params));
								return doGenerate();
							},
							wrapStream: async ({ doStream, params }) => {
								await beforeRequest(providerRequestSize(params));
								return doStream();
							},
						},
					})
				: model,
		beforeRequest,
		end: async () => {
			const id = idOf();
			if (id === undefined) return;
			const sent = meter.closeHold(id);
			if (sent > 0) return;
			meter.markHoldSettled(id);
			await port.release(id).catch(() => undefined);
		},
	};
}
