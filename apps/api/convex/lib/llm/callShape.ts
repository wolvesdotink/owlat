/**
 * What every dispatch mode derives from its options and meter before the first
 * request: the output ceiling and the deadline (`./taskLimits.ts`),
 * the attempt allowance, and the fields every request record of the call
 * shares. One function, so the text, object, tool-loop, stream and embedding
 * dispatches cannot drift apart. Pure and runtime-neutral.
 */

import type { LlmCallMeter } from './requestMeter';
import { dispatchLimits, tighterLimit } from './taskLimits';
import { taskPolicy } from './taskPolicy';
import { isLocalModel, modelEndpoint, modelTier } from './modelEndpoint';
import { isTierEligible, TaskTierNotEligibleError } from './taskRouting';

/** A model handle as the SDK takes it: an id, or an object carrying its `modelId`. */
type ModelHandle = string | { readonly modelId: string; readonly provider?: string };

export function requestedModelId(model: ModelHandle): string {
	return typeof model === 'string' ? model : model.modelId;
}

/** The attempt allowance: the caller's, never above the task's. */
export function attemptAllowance(
	meter: LlmCallMeter | undefined,
	maxAttempts: number | undefined
): number | undefined {
	return tighterLimit(maxAttempts, meter?.task ? taskPolicy(meter.task).maxAttempts : undefined);
}

export interface CallShape {
	readonly maxOutputTokens: number | undefined;
	readonly abortSignal: AbortSignal | undefined;
	readonly maxAttempts: number | undefined;
	readonly modelUsed: string;
	/** Fields every request record of the call carries. */
	readonly requestBase: {
		readonly modelUsed: string;
		readonly endpoint?: string;
		readonly isLocalEngine?: boolean;
	};
}

/** The limits one call runs under, plus what every request record of it shares. */
export function callShape(opts: {
	readonly model: ModelHandle;
	readonly meter?: LlmCallMeter;
	readonly maxOutputTokens?: number;
	readonly abortSignal?: AbortSignal;
	readonly maxAttempts?: number;
}): CallShape {
	// Model eligibility (the task-policy catalog): a model the
	// resolver resolved on a tier the call's task does not allow never reaches
	// the provider. Unstamped models (a test double, a plugin's string) pass.
	const tier = modelTier(opts.model);
	const task = opts.meter?.task;
	if (tier && task && !isTierEligible(task, tier)) throw new TaskTierNotEligibleError(task, tier);
	const modelUsed = requestedModelId(opts.model);
	const limits = dispatchLimits({
		task: opts.meter?.task,
		deadlineAt: opts.meter?.deadlineAt,
		modelId: modelUsed,
		...(typeof opts.model === 'string' ? {} : { provider: opts.model.provider }),
		maxOutputTokens: opts.maxOutputTokens,
		abortSignal: opts.abortSignal,
	});
	const endpoint = modelEndpoint(opts.model);
	return {
		...limits,
		maxAttempts: attemptAllowance(opts.meter, opts.maxAttempts),
		modelUsed,
		requestBase: {
			modelUsed,
			...(endpoint ? { endpoint } : {}),
			...(isLocalModel(opts.model) ? { isLocalEngine: true } : {}),
		},
	};
}

/** The SDK option spread for an output ceiling and a signal, each only when set. */
export function limitArgs(limits: {
	readonly maxOutputTokens: number | undefined;
	readonly abortSignal: AbortSignal | undefined;
}): { maxOutputTokens?: number; abortSignal?: AbortSignal } {
	return {
		...(limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: limits.maxOutputTokens }),
		...(limits.abortSignal ? { abortSignal: limits.abortSignal } : {}),
	};
}
