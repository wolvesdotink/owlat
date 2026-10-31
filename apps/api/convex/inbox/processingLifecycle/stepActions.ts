/**
 * The lifecycle's writes as `MutationCtx` helpers: a status transition and the
 * `agentActions` row of a step that runs inside one processing status. The
 * internal mutations in `../processingLifecycle.ts` are thin wrappers over
 * these, and a commit mutation that has to land a step's result together with
 * its next hop (`agent/walkerCommit.ts`) calls them in its own transaction.
 */

import type { Infer } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import type { tokenUsageValidator } from '../../lib/convexValidators';
import { dispatch } from './effects';
import {
	failedActionStatus,
	type ActionType,
	type TransitionInput,
	type TransitionOutcome,
} from './types';

/** Apply a processing-status transition, legal-edge checked. */
export async function applyTransition(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	input: TransitionInput
): Promise<TransitionOutcome> {
	const message = await ctx.db.get(inboundMessageId);
	if (!message) return { ok: false, reason: 'message_not_found' };
	return await dispatch(ctx, message, input);
}

/** Open a `running` row for a step. */
export async function beginStepAction(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	actionType: ActionType
): Promise<Id<'agentActions'>> {
	// A scan belongs to the message's current `security_check` run.
	const run =
		actionType === 'security_scan'
			? (await ctx.db.get(inboundMessageId))?.securityCheckRun
			: undefined;
	return await ctx.db.insert('agentActions', {
		inboundMessageId,
		actionType,
		status: 'running',
		retryCount: 0,
		startedAt: Date.now(),
		createdAt: Date.now(),
		...(run !== undefined ? { securityCheckRun: run } : {}),
	});
}

export interface StepEnd {
	readonly actionId: Id<'agentActions'>;
	readonly output?: string;
	readonly durationMs?: number;
	readonly modelUsed?: string;
	readonly tokenUsage?: Infer<typeof tokenUsageValidator>;
}

/** Complete a step's row. */
export async function endStepAction(ctx: MutationCtx, end: StepEnd): Promise<void> {
	// A vanished row (deleted by a concurrent cleanup, or an id from a stale
	// closure after a retry) must not crash the step: patch on a missing id throws.
	const action = await ctx.db.get(end.actionId);
	if (!action) return;
	await ctx.db.patch(end.actionId, {
		status: 'completed',
		output: end.output,
		completedAt: Date.now(),
		durationMs: end.durationMs,
		modelUsed: end.modelUsed,
		tokenUsage: end.tokenUsage,
	});
}

/** Fail a step's row, or abandon it once its retries are spent. */
export async function failStepAction(
	ctx: MutationCtx,
	actionId: Id<'agentActions'>,
	errorMessage: string
): Promise<void> {
	const action = await ctx.db.get(actionId);
	// `abandoned` is final: retries are exhausted, or the lifecycle closed the
	// step because a person took the reply over. Don't reopen it as `failed`.
	if (!action || action.status === 'abandoned') return;
	const retryCount = action.retryCount + 1;
	await ctx.db.patch(actionId, {
		// Once retries are exhausted the row becomes terminally `abandoned`
		// so the retry cron's `by_status='failed'` scan is never starved by a
		// growing head of lifetime-exhausted failures.
		status: failedActionStatus(retryCount),
		errorMessage,
		completedAt: Date.now(),
		retryCount,
	});
}
