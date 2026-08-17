/**
 * Bulk review-queue decisions (adoption-gaps piece C2, decision D6).
 *
 * Batch counterparts to the single-message mutations in `./mutations.ts`,
 * backing the review queue's multi-select: `approveDrafts` / `rejectDrafts`
 * return one outcome PER id and never throw on a partially-failing batch, so
 * "8 approved, 2 held — someone is replying" stays honest in the UI. Each item
 * still takes exactly ONE lifecycle transition, records its own audit row
 * (approve feedback records later, at send-fire time — see
 * `decisionFeedback.recordApprovalSignalsAtSend`), and every approve in a
 * batch shares one undo window
 * (`agentConfig.humanApproveUndoDelayMs`, piece C1) — cancelled per id through
 * the companion `undoAutoSends`.
 *
 * A sibling of `mutations.ts` rather than more lines in it: that file already
 * sits at the ~500 LOC split threshold (CONVENTIONS.md).
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { recordAuditLog } from '../lib/auditLog';
import type { CancelAutoSendOutcome, TransitionOutcome } from './processingLifecycle';
import { resolveHumanApproveUndoDelayMs } from './processingLifecycle/effects';
import { throwInvalidState } from '../_utils/errors';
import { recordAutonomyFeedback, resolveReplyCollisionHold } from './decisionFeedback';

/**
 * Hard cap per batch. Matches the review queue's own page size (the
 * `getReviewQueue` default limit of 50), and keeps the whole batch — 50 ×
 * (transition + feedback + audit) — comfortably inside one transaction.
 * Mirrored client-side by `REVIEW_BULK_ACTION_LIMIT` (apps/web).
 */
const BULK_DECISION_LIMIT = 50;

/** Per-id outcome of a bulk approve — `approved` queued the send; the other
 * arms are the honest partial-failure vocabulary (decision D6). */
type ApproveOutcome =
	| { inboundMessageId: Id<'inboundMessages'>; outcome: 'approved' }
	| { inboundMessageId: Id<'inboundMessages'>; outcome: 'no_draft' }
	| { inboundMessageId: Id<'inboundMessages'>; outcome: 'reply_in_progress'; heldByName: string }
	| { inboundMessageId: Id<'inboundMessages'>; outcome: 'not_found' };

/** Dedupe (preserving order) and enforce the batch cap. An over-cap batch is a
 * malformed call — the UI caps selection — and throws BEFORE any item is
 * processed, so a refusal is never a partial application. */
function normalizeBatchIds(ids: Id<'inboundMessages'>[], label: string): Id<'inboundMessages'>[] {
	const unique = [...new Set(ids)];
	if (unique.length > BULK_DECISION_LIMIT) {
		throwInvalidState(`${label} is capped at ${BULK_DECISION_LIMIT} messages per batch`);
	}
	return unique;
}

/**
 * Approve a batch of agent drafts for sending — per D6, one outcome per id
 * (`approved | no_draft | reply_in_progress | not_found`), never throwing on a
 * partial failure. All approved items share ONE undo window (the C1
 * human-approve window resolved once for the batch), returned as
 * `undo.sendAt` exactly like the single `approveDraft`, so the shared
 * countdown toast can cancel any of them via `undoAutoSends` while it is open.
 *
 * `not_found` covers both a genuinely missing id and a row that left the queue
 * between selection and execution (a teammate approved/rejected it — from the
 * queue's perspective the item is gone).
 */
export const approveDrafts = adminMutation({
	args: {
		inboundMessageIds: v.array(v.id('inboundMessages')),
	},
	handler: async (ctx, args, session) => {
		const ids = normalizeBatchIds(args.inboundMessageIds, 'Bulk approve');

		// One shared undo window for the whole batch (piece C1 semantics).
		const configs = await ctx.db.query('agentConfig').take(1);
		const undoDelayMs = resolveHumanApproveUndoDelayMs(configs[0]?.humanApproveUndoDelayMs);
		const approvedAt = Date.now();

		const outcomes: ApproveOutcome[] = [];
		let approvedCount = 0;

		for (const inboundMessageId of ids) {
			const message = await ctx.db.get(inboundMessageId);
			// Only rows still sitting in the queue are approvable; anything else
			// (missing id, already approved/rejected/sent) reads as gone.
			if (!message || message.processingStatus !== 'draft_ready') {
				outcomes.push({ inboundMessageId, outcome: 'not_found' });
				continue;
			}
			if (!message.draftResponse) {
				outcomes.push({ inboundMessageId, outcome: 'no_draft' });
				continue;
			}

			// Per-id collision soft-hold — the same advisory guard as the single
			// approve: a held item is skipped, not a batch failure.
			const hold = await resolveReplyCollisionHold(ctx, message, session.userId);
			if (hold) {
				outcomes.push({
					inboundMessageId,
					outcome: 'reply_in_progress',
					heldByName: hold.heldByName,
				});
				continue;
			}

			// One lifecycle transition per item, threading the shared window so
			// each send is held behind the same cancellable pendingAutoSend marker.
			const transitioned: TransitionOutcome = await ctx.runMutation(
				internal.inbox.processingLifecycle.transition,
				{
					inboundMessageId,
					input: {
						to: 'approved',
						at: approvedAt,
						source: 'human',
						userId: session.userId,
						...(undoDelayMs > 0 ? { undoDelayMs } : {}),
					},
				}
			);
			// Unreachable after the draft_ready pre-check (same transaction), but
			// keep the outcome honest rather than claiming a send that never queued.
			if (!transitioned.ok) {
				outcomes.push({ inboundMessageId, outcome: 'not_found' });
				continue;
			}

			// The same audit tail as the single approve, per item. NO learning-loop
			// feedback here — like the single approve, the graduated-autonomy
			// signals record at SEND-FIRE time
			// (`decisionFeedback.recordApprovalSignalsAtSend`), so an approve
			// undone inside the shared window trains nothing.
			await recordAuditLog(ctx, {
				userId: session.userId,
				action: 'inbound.draft_approved',
				resource: 'inbound_message',
				resourceId: inboundMessageId,
			});

			approvedCount++;
			outcomes.push({ inboundMessageId, outcome: 'approved' });
		}

		// The batch's shared undo window — absent when the window is 0 (the sends
		// already left) or nothing was approved (nothing to undo).
		return {
			outcomes,
			...(undoDelayMs > 0 && approvedCount > 0
				? { undo: { sendAt: approvedAt + undoDelayMs } }
				: {}),
		};
	},
});

/**
 * Reject a batch of drafts — the same batch shape as `approveDrafts` (per-id
 * outcomes, never throwing on partial failure), server-side looping the single
 * `rejectDraft` semantics: one lifecycle transition, one autonomy-feedback row
 * and one audit row per rejected item. No undo — rejection keeps the message,
 * it just leaves the queue.
 */
export const rejectDrafts = adminMutation({
	args: {
		inboundMessageIds: v.array(v.id('inboundMessages')),
		reason: v.optional(v.string()),
	},
	handler: async (ctx, args, session) => {
		const ids = normalizeBatchIds(args.inboundMessageIds, 'Bulk reject');

		const outcomes: Array<{
			inboundMessageId: Id<'inboundMessages'>;
			outcome: 'rejected' | 'not_found';
		}> = [];

		for (const inboundMessageId of ids) {
			const message = await ctx.db.get(inboundMessageId);
			if (!message) {
				outcomes.push({ inboundMessageId, outcome: 'not_found' });
				continue;
			}

			const transitioned: TransitionOutcome = await ctx.runMutation(
				internal.inbox.processingLifecycle.transition,
				{
					inboundMessageId,
					input: {
						to: 'rejected',
						at: Date.now(),
						userId: session.userId,
						...(args.reason ? { reason: args.reason } : {}),
					},
				}
			);
			// A row no longer rejectable (already sent / archived / raced away)
			// reads as gone from the queue — same vocabulary as bulk approve.
			if (!transitioned.ok) {
				outcomes.push({ inboundMessageId, outcome: 'not_found' });
				continue;
			}

			await recordAutonomyFeedback(ctx, message, 'rejected', args.reason);
			await recordAuditLog(ctx, {
				userId: session.userId,
				action: 'inbound.draft_rejected',
				resource: 'inbound_message',
				resourceId: inboundMessageId,
				details: args.reason ? { reason: args.reason } : undefined,
			});

			outcomes.push({ inboundMessageId, outcome: 'rejected' });
		}

		return { outcomes };
	},
});

/**
 * Undo a batch of in-flight delayed sends during their shared undo window —
 * the bulk companion to `undoAutoSend`, backing the bulk toast's "Undo".
 * Per-id `CancelAutoSendOutcome`s, never throwing: an id whose send already
 * fired (or that never existed) reports `cancelled: false` while the rest of
 * the batch is still pulled back to `draft_ready`.
 */
export const undoAutoSends = adminMutation({
	args: {
		inboundMessageIds: v.array(v.id('inboundMessages')),
	},
	handler: async (ctx, args, session) => {
		const ids = normalizeBatchIds(args.inboundMessageIds, 'Bulk undo');

		const outcomes: Array<{ inboundMessageId: Id<'inboundMessages'> } & CancelAutoSendOutcome> = [];
		for (const inboundMessageId of ids) {
			const result: CancelAutoSendOutcome = await ctx.runMutation(
				internal.inbox.processingLifecycle.cancelAutoSend,
				{ inboundMessageId, reason: 'user_cancel', userId: session.userId }
			);
			outcomes.push({ inboundMessageId, ...result });
		}

		return { outcomes };
	},
});
