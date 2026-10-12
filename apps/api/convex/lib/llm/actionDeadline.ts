/**
 * The deadline every model call in one Convex action shares (ADR-0073).
 *
 * A Convex action is killed at 10 minutes, and a killed action writes no
 * ledger row for the requests it had in flight. So each action gets one model
 * budget, anchored when the action starts (or, for an action that never
 * anchors explicitly, at its first model call), ending well inside the limit
 * with time left to write the ledger. Every dispatch in the action enforces
 * the time that remains: a draft, its markup retry, its self-check and a
 * clarification sequence all spend from the same budget instead of each
 * starting a fresh one.
 *
 * The anchor is keyed by the action's ctx object: one invocation, one ctx.
 * A nested `ctx.runAction` gets its own ctx (and limit), but the parent waits
 * on it, so the caller passes its root, deadline included, and the child takes
 * the tighter of the two. Work SCHEDULED for later runs in a fresh action with
 * a fresh limit, so a scheduled root carries its id but not the deadline
 * ({@link scheduledRoot}).
 *
 * Pure and runtime-neutral.
 */

import { tighterDeadline, type LlmRootContext } from './requestMeter';

/**
 * Model time per action: the 600 s action limit less two minutes, for the
 * work an action does before its first call when it does not anchor at entry,
 * and for the ledger writes after its last.
 */
export const ACTION_MODEL_BUDGET_MS = 480_000;

const ANCHORS = new WeakMap<object, number>();

/**
 * The absolute deadline of the action `ctx` belongs to, anchoring it now on
 * first use. Call it at an action's entry to anchor at the start.
 */
export function anchorActionDeadline(ctx: object, now: number = Date.now()): number {
	const existing = ANCHORS.get(ctx);
	if (existing !== undefined) return existing;
	const deadlineAt = now + ACTION_MODEL_BUDGET_MS;
	ANCHORS.set(ctx, deadlineAt);
	return deadlineAt;
}

/** The deadline a call under `root` in this action must meet: the tighter of the two. */
export function callDeadlineAt(ctx: object, root: LlmRootContext | undefined): number {
	return tighterDeadline(root?.deadlineAt, anchorActionDeadline(ctx)) as number;
}

/**
 * `root` bounded by this action's deadline, for passing to a NESTED action
 * (`ctx.runAction`), which the caller waits on.
 */
export function boundedRoot(ctx: object, root: LlmRootContext): LlmRootContext {
	return { ...root, deadlineAt: callDeadlineAt(ctx, root) };
}

/** `root` for SCHEDULED work: the same root id, and no deadline (it runs in a fresh action). */
export function scheduledRoot(root: LlmRootContext): LlmRootContext {
	const { deadlineAt: _deadlineAt, ...rest } = root;
	return rest;
}
