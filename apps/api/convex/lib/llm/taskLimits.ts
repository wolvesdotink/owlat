/**
 * The limits the dispatch enforces on one call (ADR-0073, Phase 1a): an output
 * ceiling that covers reasoning, and a deadline for the whole call. Every
 * dispatch mode (text, structured output, tool loop, stream, embedding) reads
 * them from here, so one table (`lib/llm/taskPolicy.ts`) sets them all.
 *
 * Output and reasoning share one wire field. OpenAI's reasoning models count
 * reasoning inside `max_output_tokens`, and Anthropic's `max_tokens` covers the
 * thinking budget, so the request carries `maxOutputTokens + maxReasoningTokens`
 * when both are set. A `null` limit sends nothing, which leaves the provider's
 * per-model default in force: that is today's effective value, and a fixed
 * number would be refused by any model whose own maximum is lower.
 *
 * The deadline covers every attempt and the backoff between them. A root
 * deadline (`LlmRootContext.deadlineAt`) caps every call under that root.
 *
 * Pure and runtime-neutral.
 */

import type { AiTaskName } from '@owlat/shared/aiRouting';
import type { LlmRootContext } from './requestMeter';
import { taskPolicy } from './taskPolicy';

/** The wire output ceiling of `task` (output plus reasoning), or undefined for none. */
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

/** The deadline a call under `task` and `root` must finish by, in ms from `now`. */
export function callDeadlineMs(
	task: AiTaskName | undefined,
	root: LlmRootContext | undefined,
	now: number = Date.now()
): number | undefined {
	const taskDeadline = task === undefined ? undefined : (taskPolicy(task).deadlineMs ?? undefined);
	const rootDeadline = root?.deadlineAt === undefined ? undefined : root.deadlineAt - now;
	const deadline = tighterLimit(taskDeadline, rootDeadline);
	return deadline === undefined ? undefined : Math.max(0, deadline);
}

/** The caller's signal joined with the call's deadline. Undefined when neither exists. */
export function callSignal(
	callerSignal: AbortSignal | undefined,
	deadlineMs: number | undefined
): AbortSignal | undefined {
	if (deadlineMs === undefined) return callerSignal;
	const deadline = AbortSignal.timeout(deadlineMs);
	return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}

/** Output ceiling and signal for one dispatch, from the caller's options and its task. */
export function dispatchLimits(opts: {
	readonly task?: AiTaskName;
	readonly root?: LlmRootContext;
	readonly maxOutputTokens?: number;
	readonly abortSignal?: AbortSignal;
}): { maxOutputTokens: number | undefined; abortSignal: AbortSignal | undefined } {
	return {
		maxOutputTokens: tighterLimit(opts.maxOutputTokens, taskOutputCeiling(opts.task)),
		abortSignal: callSignal(opts.abortSignal, callDeadlineMs(opts.task, opts.root)),
	};
}
