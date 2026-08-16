/**
 * Shared helpers behind the human review-queue decisions (approve / reject /
 * edit), used by both the single-message mutations (`./mutations.ts`) and the
 * batch mutations (`./bulkMutations.ts`) so the two surfaces feed the SAME
 * learning-loop and collision signals rather than drifting copies.
 */

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { getActiveReplierOtherThan } from './presence';

/**
 * Feed a human verification-queue decision back into the graduated-autonomy
 * loop. The weekly `autonomy.adjustThresholds` cron consumes these rows to
 * tighten / loosen per-category auto-approve thresholds, and the agent-health
 * rollup uses them for the `rejection_spike` circuit breaker. Best-effort:
 * a message with no classification yet still records under `other` so the
 * signal isn't lost. Safe to call even when `ai.autonomy` is off — it only
 * appends a feedback row.
 */
export async function recordAutonomyFeedback(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	action: 'approved' | 'rejected' | 'edited',
	userFeedback?: string
): Promise<void> {
	await ctx.runMutation(internal.autonomyFeedback.recordFeedback, {
		category: message.classification?.category ?? 'other',
		action,
		agentConfidence: message.confidenceScore ?? message.classification?.confidence ?? 0,
		userFeedback,
		inboundMessageId: message._id,
	});

	// Reconcile any pending shadow ("would-have-sent") observation for this
	// message against the human's decision, feeding the graduation scorecard.
	// A no-op when the message was never observed in shadow mode. Best-effort:
	// scorecard bookkeeping must never affect the human action, so any failure
	// is swallowed — it runs in the same transaction and must not roll back the
	// human approve/reject/edit.
	try {
		await ctx.runMutation(internal.agent.shadowScorecard.reconcileShadowDecision, {
			inboundMessageId: message._id,
			action,
		});
	} catch {
		// swallowed: shadow scorecard bookkeeping is best-effort
	}
}

/**
 * Collision soft-hold (belt-and-braces): if ANOTHER teammate is actively
 * replying to this message's thread at execution time, don't quietly
 * double-answer — resolve their display name so the caller can surface an
 * honest "… is replying" hold instead of sending. Advisory only: last-writer
 * still wins if two callers race past the held button — this is not a
 * lock/transaction system, just a guard against the common collision.
 *
 * Returns `null` when the message has no thread or nobody else is replying.
 */
export async function resolveReplyCollisionHold(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	userId: string
): Promise<{ heldByName: string } | null> {
	if (!message.threadId) return null;
	const otherReplier = await getActiveReplierOtherThan(ctx, message.threadId, userId);
	if (!otherReplier) return null;
	const profile = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', otherReplier.userId))
		.first();
	return { heldByName: profile?.name || profile?.email || 'A teammate' };
}

/**
 * The learning-loop tail every human approve shares: an approve is a positive
 * autonomy-feedback row, and a draft the agent produced from an OWNER-answered
 * clarification, sent UNEDITED, additionally records the strong
 * `clarification_unedited_send` outcome signal — the owner supplied the missing
 * facts, the agent drafted, and the owner shipped it verbatim. Best-effort on
 * the outcome half: a learning-loop failure must never fail the human approve.
 */
export async function recordApprovalSignals(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>
): Promise<void> {
	await recordAutonomyFeedback(ctx, message, 'approved');

	if (message.pendingClarification?.answeredAt && !message.isDraftEdited) {
		try {
			await ctx.runMutation(internal.autonomyOutcome.recordOutcomeFeedback, {
				inboundMessageId: message._id,
				signal: 'clarification_unedited_send',
			});
		} catch {
			// swallowed: outcome bookkeeping is best-effort
		}
	}
}
