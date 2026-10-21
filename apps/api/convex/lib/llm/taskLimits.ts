/**
 * The limits the dispatch enforces on one call: an output
 * ceiling that covers reasoning, and a deadline. Every dispatch mode (text,
 * structured output, tool loop, stream, embedding) reads them from here, so one
 * table (`lib/llm/taskPolicy.ts`) sets them all.
 *
 * OUTPUT AND REASONING, per provider family ({@link outputControlFamily}):
 *   - `anthropic`: `max_tokens` is the OUTPUT ceiling alone. Extended thinking
 *     is never enabled on these requests, so no reasoning is spent; were it
 *     enabled, the SDK adds the thinking budget on top. Both enforced.
 *   - `openai`: a non-reasoning OpenAI model spends no reasoning, so
 *     `max_output_tokens` is the output ceiling alone. Both enforced.
 *   - `openai-reasoning` (gpt-5, gpt-6, the o-series): `max_output_tokens`
 *     covers reasoning AND output, and the reasoning effort
 *     (`./requestPolicy.ts`) is the reasoning control. The request carries
 *     output + reasoning; the split between them is ADVISORY.
 *   - `combined` (Google, Azure deployments, OpenRouter, OpenAI-compatible and
 *     local servers, anything unrecognised): one field, output + reasoning;
 *     the split is ADVISORY.
 * The value never exceeds a lower ceiling the caller set, and is clamped to the
 * model's maximum when the model is known (`./modelOutputLimits.ts`): a
 * provider refuses a request over its model's maximum. An unknown model gets
 * the task's ceiling unclamped.
 *
 * DEADLINE. The tighter of the task's own deadline (covering every attempt and
 * the backoff between them) and the call's absolute deadline: the root's, and
 * the running action's model budget (`./actionDeadline.ts`). Every dispatch in
 * an action therefore spends from one clock.
 *
 * Pure and runtime-neutral.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import { taskPolicy } from './taskPolicy';
import { modelMaxOutputTokens } from './modelOutputLimits';

/**
 * How a provider family takes output and reasoning limits. `separate`: the
 * output ceiling is enforced on its own (no reasoning is spent); `combined`:
 * one field bounds both, and the task's split between them is advisory.
 */
export type OutputControlFamily = 'anthropic' | 'openai' | 'openai-reasoning' | 'combined';

export const OUTPUT_SPLIT_BY_FAMILY: Readonly<
	Record<OutputControlFamily, 'separate' | 'combined'>
> = {
	anthropic: 'separate',
	openai: 'separate',
	'openai-reasoning': 'combined',
	combined: 'combined',
};

const OPENAI_REASONING_MODEL = /^(?:gpt-5|gpt-6|o\d)/;

/** The family of a model, from its SDK provider id (`anthropic.messages`, `openai.responses`). */
export function outputControlFamily(
	provider: string | undefined,
	modelId: string | undefined
): OutputControlFamily {
	if (provider?.startsWith('anthropic.')) return 'anthropic';
	if (provider?.startsWith('openai.')) {
		const id = (modelId ?? '').toLowerCase().replace(/^[^/]+\//, '');
		return OPENAI_REASONING_MODEL.test(id) ? 'openai-reasoning' : 'openai';
	}
	return 'combined';
}

/** The task's ceiling for a family: output alone where it is separate, else output + reasoning. */
export function taskOutputCeiling(
	task: AiTaskName | undefined,
	family: OutputControlFamily = 'combined'
): number | undefined {
	if (task === undefined) return undefined;
	const { maxOutputTokens, maxReasoningTokens } = taskPolicy(task);
	if (maxOutputTokens === null) return undefined;
	return OUTPUT_SPLIT_BY_FAMILY[family] === 'separate'
		? maxOutputTokens
		: maxOutputTokens + (maxReasoningTokens ?? 0);
}

/** The smaller of two optional ceilings. */
export function tighterLimit(
	left: number | undefined,
	right: number | undefined
): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
}

/**
 * The output ceiling sent for one request: the task's for the model's family
 * and the caller's, clamped to the model's maximum when it is known. Undefined
 * (nothing sent) only when neither the task nor the caller sets one.
 */
export function wireOutputCeiling(opts: {
	readonly task?: AiTaskName;
	readonly maxOutputTokens?: number;
	readonly modelId?: string;
	readonly provider?: string;
}): number | undefined {
	const family = outputControlFamily(opts.provider, opts.modelId);
	const wanted = tighterLimit(opts.maxOutputTokens, taskOutputCeiling(opts.task, family));
	if (wanted === undefined) return undefined;
	const clamped = tighterLimit(wanted, modelMaxOutputTokens(opts.modelId)) as number;
	return Math.max(1, clamped);
}

/** The time a call under `task` may take, in ms from `now`, given its absolute deadline. */
export function callDeadlineMs(
	task: AiTaskName | undefined,
	deadlineAt: number | undefined,
	now: number = Date.now()
): number | undefined {
	const taskDeadline = task === undefined ? undefined : (taskPolicy(task).deadlineMs ?? undefined);
	const remaining = deadlineAt === undefined ? undefined : deadlineAt - now;
	const deadline = tighterLimit(taskDeadline, remaining);
	return deadline === undefined ? undefined : Math.max(0, deadline);
}

/** The caller's signal joined with the call's deadline. Undefined when neither exists. */
export function callSignal(
	callerSignal: AbortSignal | undefined,
	deadlineMs: number | undefined
): AbortSignal | undefined {
	if (deadlineMs === undefined) return callerSignal;
	// A deadline already past aborts now: a timer of 0 would only fire after the
	// first request had gone out.
	const deadline =
		deadlineMs <= 0
			? AbortSignal.abort(new DOMException('The call deadline has passed.', 'TimeoutError'))
			: AbortSignal.timeout(deadlineMs);
	return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

/** Output ceiling and signal for one dispatch, from the caller's options and its meter. */
export function dispatchLimits(opts: {
	readonly task?: AiTaskName;
	readonly deadlineAt?: number;
	readonly modelId?: string;
	readonly provider?: string;
	readonly maxOutputTokens?: number;
	readonly abortSignal?: AbortSignal;
}): { maxOutputTokens: number | undefined; abortSignal: AbortSignal | undefined } {
	return {
		maxOutputTokens: wireOutputCeiling(opts),
		abortSignal: callSignal(opts.abortSignal, callDeadlineMs(opts.task, opts.deadlineAt)),
	};
}

/**
 * The step limit of a tool loop or a tool-calling stream:
 * the caller's, never past the task's `maxToolRounds`. A task without one
 * keeps the caller's limit, as today.
 */
export function toolRoundLimit(task: AiTaskName | undefined, requested: number): number {
	const cap = task === undefined ? null : taskPolicy(task).maxToolRounds;
	return cap === null ? requested : Math.max(1, Math.min(requested, cap));
}
