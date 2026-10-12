/**
 * The limits the dispatch enforces on one call (ADR-0073, Phase 1a): an output
 * ceiling that covers reasoning, and a deadline. Every dispatch mode (text,
 * structured output, tool loop, stream, embedding) reads them from here, so one
 * table (`lib/llm/taskPolicy.ts`) sets them all.
 *
 * OUTPUT. Output and reasoning share one wire field: OpenAI's reasoning models
 * count reasoning inside `max_output_tokens`, and Anthropic's `max_tokens`
 * covers the thinking budget. So the request carries the task's
 * `maxOutputTokens + maxReasoningTokens`, never above a lower ceiling the
 * caller set, and never above what the model accepts
 * (`./modelOutputLimits.ts`): a provider refuses a request over its model's
 * maximum, which would turn a bound into an outage.
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

/** The task's wire output ceiling (output plus reasoning), or undefined for none. */
export function taskOutputCeiling(task: AiTaskName | undefined): number | undefined {
	if (task === undefined) return undefined;
	const { maxOutputTokens, maxReasoningTokens } = taskPolicy(task);
	if (maxOutputTokens === null) return undefined;
	return maxOutputTokens + (maxReasoningTokens ?? 0);
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
 * The output ceiling sent for one request: the task's and the caller's,
 * clamped to the model's maximum. Undefined (nothing sent) only when neither
 * the task nor the caller sets one.
 */
export function wireOutputCeiling(opts: {
	readonly task?: AiTaskName;
	readonly maxOutputTokens?: number;
	readonly modelId?: string;
}): number | undefined {
	const wanted = tighterLimit(opts.maxOutputTokens, taskOutputCeiling(opts.task));
	if (wanted === undefined) return undefined;
	return Math.max(1, Math.min(wanted, modelMaxOutputTokens(opts.modelId)));
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
	readonly maxOutputTokens?: number;
	readonly abortSignal?: AbortSignal;
}): { maxOutputTokens: number | undefined; abortSignal: AbortSignal | undefined } {
	return {
		maxOutputTokens: wireOutputCeiling(opts),
		abortSignal: callSignal(opts.abortSignal, callDeadlineMs(opts.task, opts.deadlineAt)),
	};
}
