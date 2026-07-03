/**
 * Delayed auto-send cancellation (undo window) — the side-effect-free-ish core
 * shared by the two public cancel mutations in the parent
 * `inbox/processingLifecycle.ts` (`cancelAutoSend` and
 * `cancelPendingAutoSendsForKillSwitch`).
 *
 * Split out of `processingLifecycle.ts` to keep that dispatcher file under the
 * size cap, mirroring the sibling `reducers.ts` / `effects.ts` / `types.ts`
 * split. The public mutations still live in the parent (their generated
 * `internal.inbox.processingLifecycle.*` paths are unchanged); only these
 * private helpers and their types moved here.
 *
 * Aborts an in-flight DELAYED autonomous auto-send before its undo window
 * (`agentConfig.autoSendDelayMs`) elapses. Three callers:
 *   - a landing inbound reply in the same thread (the queued reply is now
 *     stale — the customer said more; see inbox/threads/module.ts),
 *   - the autonomy kill switch (stop everything in flight),
 *   - an explicit user "Undo" from the review surface.
 *
 * Cancelling the scheduled send routes the reply back to the human review
 * queue (`approved → draft_ready`) rather than dropping it — the fail-soft
 * degrade. Idempotent: a message with no `pendingAutoSend` marker (already
 * sent, never delayed, or already cancelled) is a no-op.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { recordAuditLog } from '../../lib/auditLog';
import { dispatch } from './effects';

export type CancelAutoSendReason = 'thread_reply' | 'kill_switch' | 'user_cancel';

export const cancelAutoSendReasonValidator = v.union(
	v.literal('thread_reply'),
	v.literal('kill_switch'),
	v.literal('user_cancel'),
);

export type CancelAutoSendOutcome = {
	cancelled: boolean;
	reason: 'no_pending_send' | 'not_approved' | 'already_sent' | 'cancelled';
};

// Audit the abort so the `reason` discriminator (thread reply / kill switch /
// explicit user Undo) is a durable signal, not dead surface. `userId` is the
// operator for an explicit Undo; system-initiated cancels (a landing reply, the
// kill switch) record under the synthetic `system` actor.
async function recordAutoSendCancellation(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	reason: CancelAutoSendReason,
	userId: string | undefined,
): Promise<void> {
	await recordAuditLog(ctx, {
		userId: userId ?? 'system',
		action: 'inbound.auto_send_cancelled',
		resource: 'inbound_message',
		resourceId: message._id,
		details: { reason },
	});
}

// Shared core for both the single-message cancel and the kill-switch bulk
// cancel. Aborts the delayed send on one message and routes it back to human
// review, fail-soft: any message that has no live pending send is a no-op.
export async function cancelPendingAutoSend(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	reason: CancelAutoSendReason,
	userId?: string,
): Promise<CancelAutoSendOutcome> {
	const pending = message.pendingAutoSend;
	if (!pending) return { cancelled: false, reason: 'no_pending_send' };

	// A marker only ever lives on an `approved` message; if the status has
	// already moved on (e.g. the send fired and completed), there is nothing
	// to cancel — leave the state alone.
	if (message.processingStatus !== 'approved') {
		return { cancelled: false, reason: 'not_approved' };
	}

	// Guard the enqueue→completion race. When the delayed `sendApprovedReply`
	// fires it enqueues the send but the message stays `approved` (marker still
	// present) until `sendCompletion` drives it to `sent`. In that window the
	// scheduled function has left `pending`. Cancelling here would route an
	// ALREADY-DISPATCHED reply back to review (a confusing status flip, and a
	// duplicate if a human re-approves). Only cancel while the job is still
	// pending in the queue.
	const scheduled = await ctx.db.system.get(pending.scheduledFnId);
	if (!scheduled || scheduled.state.kind !== 'pending') {
		return { cancelled: false, reason: 'already_sent' };
	}

	// Abort the delayed send. `scheduler.cancel` is a no-op if the job has
	// already run or been cancelled, so this is safe against a race with the
	// send firing at its deadline.
	await ctx.scheduler.cancel(pending.scheduledFnId);

	// Record WHY the queued send was pulled back (thread reply / kill switch /
	// explicit user Undo) as an audit trail before routing to review, so the
	// `reason` discriminator is a real signal rather than dead surface.
	await recordAutoSendCancellation(ctx, message, reason, userId);

	// Route back to human review. The `→ draft_ready` reducer clears the
	// pendingAutoSend marker (any transition out of `approved` does) and
	// projects the thread's draft status back to `pending`.
	await dispatch(ctx, message, { to: 'draft_ready', at: Date.now() });

	return { cancelled: true, reason: 'cancelled' };
}
