/**
 * Inbound Email Mutations
 *
 * User-facing mutations for the verification queue:
 * approve, reject, edit drafts, assign threads, manage quarantine.
 */

import { v } from 'convex/values';
import { adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getMutationContext } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { transition as threadTransition } from './threads/module';
import type { CancelAutoSendOutcome } from './processingLifecycle';
import { resolveHumanApproveUndoDelayMs } from './processingLifecycle/effects';
import { getOrThrow, throwNotFound, throwInvalidState } from '../_utils/errors';
import { extractEmail } from '../lib/emailAddress';
import {
	recordApprovalSignals,
	recordAutonomyFeedback,
	resolveReplyCollisionHold,
} from './decisionFeedback';
import { appendDraftRevision } from './draftRevisions';

/**
 * Approve an agent-generated draft for sending.
 *
 * Per ADR-0010, status + thread latestDraftStatus + send scheduling all
 * happen atomically inside `processingLifecycle.transition`.
 */
export const approveDraft = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (!message.draftResponse) throwInvalidState('No draft to approve');

		// Collision soft-hold: return a soft error the UI turns into a toast
		// ("… just sent a reply — review the thread") rather than sending.
		const hold = await resolveReplyCollisionHold(ctx, message, userId);
		if (hold) {
			return {
				success: false as const,
				reason: 'reply_in_progress' as const,
				heldByName: hold.heldByName,
			};
		}

		// Resolve the human-approve undo window from the singleton agentConfig
		// (default 15s, clamped 0–120s; 0 = the legacy immediate send) and thread
		// it into the lifecycle, which schedules the delayed send with the same
		// cancellable `pendingAutoSend` marker autonomous sends use.
		const configs = await ctx.db.query('agentConfig').take(1);
		const undoDelayMs = resolveHumanApproveUndoDelayMs(configs[0]?.humanApproveUndoDelayMs);

		const approvedAt = Date.now();
		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: {
				to: 'approved',
				at: approvedAt,
				source: 'human',
				userId,
				...(undoDelayMs > 0 ? { undoDelayMs } : {}),
			},
		});

		// Feed the approval into the graduated-autonomy learning loop (positive
		// feedback row + the strong `clarification_unedited_send` outcome signal
		// when an owner-answered clarification draft ships verbatim).
		await recordApprovalSignals(ctx, message);

		// Log audit
		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.draft_approved',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		// Hand the undo window back to the caller so the UI can arm its countdown
		// toast ("Approved — Undo (14s)") without re-querying the marker. Absent
		// when the window is 0 — the send already left, nothing to undo.
		return {
			success: true as const,
			...(undoDelayMs > 0 ? { undo: { sendAt: approvedAt + undoDelayMs } } : {}),
		};
	},
});

/**
 * Reject an agent-generated draft.
 *
 * Per ADR-0010, status + thread latestDraftStatus update atomically
 * inside `processingLifecycle.transition`.
 */
export const rejectDraft = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		reason: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');

		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: {
				to: 'rejected',
				at: Date.now(),
				userId,
				...(args.reason ? { reason: args.reason } : {}),
			},
		});

		// Feed the rejection into the graduated-autonomy learning loop.
		await recordAutonomyFeedback(ctx, message, 'rejected', args.reason);

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.draft_rejected',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
			details: args.reason ? { reason: args.reason } : undefined,
		});

		return { success: true };
	},
});

/**
 * Undo an in-flight delayed send during its delay / undo window.
 *
 * Backs the "Sending in 0:59 — Undo" control on the review surface for both
 * origins of a pending delayed send: an AUTONOMOUS auto-approve (window from
 * `agentConfig.autoSendDelayMs`) and a HUMAN approve (window from
 * `agentConfig.humanApproveUndoDelayMs` — the countdown undo toast). Aborts the
 * scheduled send (if still pending) and routes the reply back to the human
 * review queue (`approved → draft_ready`) rather than dropping it — the same
 * fail-soft degrade as a landing thread reply. Idempotent: a message whose send
 * already fired (or was never delayed) returns `cancelled: false`.
 */
export const undoAutoSend = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args): Promise<CancelAutoSendOutcome> => {
		const { userId } = await getMutationContext(ctx);

		// Existence check, mirroring the sibling approve/reject mutations. Authz
		// is the `adminMutation` wrapper (owner/admin of this single-org
		// deployment); there is exactly one org's inbox here.
		await getOrThrow(ctx, args.inboundMessageId, 'Message');

		const result = await ctx.runMutation(internal.inbox.processingLifecycle.cancelAutoSend, {
			inboundMessageId: args.inboundMessageId,
			reason: 'user_cancel',
			userId,
		});

		return result;
	},
});

/**
 * Edit the draft text before approving.
 *
 * Revision-appending per D7: the agent original is preserved as revision 0 and
 * the edit becomes the working draft via `appendDraftRevision` — never an
 * in-place overwrite. Records NO autonomy feedback here; the `'edited'` signal
 * fires once at approve time iff the sent text differs from the agent original
 * (see `decisionFeedback.recordApprovalSignals`).
 */
export const editDraft = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		draftResponse: v.string(),
		draftSubject: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');

		await appendDraftRevision(ctx, message, {
			text: args.draftResponse,
			...(args.draftSubject ? { subject: args.draftSubject } : {}),
			savedBy: userId,
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.draft_edited',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});

/**
 * Assign a thread to a team member (or unassign with no `assignedTo`).
 *
 * Routes through the Conversation thread module so the write is audited
 * (`thread.assigned` / `thread.unassigned`) — see ADR-0032 §3.
 */
export const assignThread = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		assignedTo: v.optional(v.string()), // omit to unassign
	},
	handler: async (ctx, args) => {
		const { userId: actorId } = await getMutationContext(ctx);

		// Validate the assignee is a real instance user — assignedTo is a
		// free-form string, so without this an admin could assign a thread to a
		// bogus or foreign id that no member-facing UI could ever surface or
		// clear. Resolve against userProfiles.by_auth_user_id.
		if (args.assignedTo !== undefined) {
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.assignedTo!))
				.first();
			if (!profile) {
				throwInvalidState('Cannot assign a thread to a non-member');
			}
		}

		const outcome = await threadTransition(ctx, {
			threadId: args.threadId,
			input: { kind: 'assignment_change', assignedTo: args.assignedTo, source: 'user' },
		});
		if (!outcome.ok) throwNotFound('Thread');

		// Notify the new assignee, but never on self-assign (claiming a thread for
		// yourself). One append-only notice row per cross-user assignment; the
		// assignee's session surfaces it via `queries.pendingAssignments` (in-app
		// toast + desktop notification, coalesced client-side). Best-effort: a
		// missing thread/profile just skips the notice, it never fails the assign.
		if (args.assignedTo !== undefined && args.assignedTo !== actorId) {
			const thread = await ctx.db.get(args.threadId);
			const actorProfile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', actorId))
				.first();
			const assignedByName = actorProfile?.name?.trim() || actorProfile?.email || 'A teammate';
			await ctx.db.insert('inboxAssignmentNotices', {
				userId: args.assignedTo,
				threadId: args.threadId,
				subject: thread?.subject ?? 'No subject',
				assignedByName,
				createdAt: Date.now(),
			});
		}

		return { success: true };
	},
});

/**
 * Close or resolve a thread.
 *
 * Routes through the Conversation thread module so the write is audited
 * (`thread.status_changed`, carrying `from`/`to`) — see ADR-0032 §3.
 */
export const updateThreadStatus = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		status: v.union(
			v.literal('open'),
			v.literal('waiting'),
			v.literal('resolved'),
			v.literal('closed')
		),
	},
	handler: async (ctx, args) => {
		const outcome = await threadTransition(ctx, {
			threadId: args.threadId,
			input: { kind: 'status_change', to: args.status, source: 'user' },
		});
		if (!outcome.ok) throwNotFound('Thread');

		return { success: true };
	},
});

/**
 * Release a quarantined message for agent processing.
 *
 * Per ADR-0010, status reset (and clearing of securityFlags) happens via
 * the lifecycle; the re-schedule of the next pipeline step stays here
 * because it's release-specific (jumps straight to context retrieval
 * rather than re-running the security scan).
 */
export const releaseFromQuarantine = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'quarantined') {
			throwInvalidState('Message is not quarantined');
		}

		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: {
				to: 'received',
				at: Date.now(),
				source: 'release_quarantine',
				userId,
			},
		});

		// The lifecycle's `schedule_pipeline_start` effect (fired on
		// `to: 'received'` from `release_quarantine`) re-kicks the Agent
		// walker from `security_scan`. No explicit reschedule here — see
		// ADR-0014 for why the pre-deepening direct schedule to
		// `agentContext.retrieveContext` was broken (illegal-edge:
		// `received → classifying` was never legal).

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.released',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});

/**
 * Manually re-enqueue a permanently-failed message for reprocessing.
 *
 * `processingStatus === 'failed'` is terminal once the cron auto-retries
 * (`processingLifecycle.retryFailedActions`, max 3) are exhausted — at which
 * point the message is invisible to the workflow. This is the operator-facing
 * counterpart to that cron: it routes the `failed → received` edge through the
 * lifecycle with the existing `cron_retry` source (clearing `errorMessage`,
 * re-kicking the pipeline from `security_scan`), and resets the most recent
 * failed `agentAction` to pending so the retried step has a clean row — exactly
 * what `retryFailedActions` does per message.
 */
export const retryFailedMessage = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'failed') {
			throwInvalidState('Message has not failed');
		}

		// Reset the most recent failed agentAction (if any) alongside the status
		// reset, mirroring the cron's per-message behaviour. A message only
		// reaches terminal `processingStatus === 'failed'` once its step retries
		// are exhausted, at which point the step row is `abandoned` (the terminal
		// twin of `failed`) — so match either so the operator retry still resets
		// the offending step to a clean `pending`.
		const failedAction = (
			await ctx.db
				.query('agentActions')
				.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', args.inboundMessageId))
				.collect()
		) // bounded: one message's pipeline actions (~1 per step)
			.filter((a) => a.status === 'failed' || a.status === 'abandoned')
			.sort((a, b) => b.createdAt - a.createdAt)[0];

		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: {
				to: 'received',
				at: Date.now(),
				source: 'cron_retry',
				userId,
				...(failedAction ? { resetActionId: failedAction._id } : {}),
			},
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.retried',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});

/**
 * Block a sender (add to blocklist) and archive the message.
 *
 * Per ADR-0010, archive transition routes through the lifecycle so the
 * star-source `* → archived` legal edge is enforced uniformly.
 */
export const blockSender = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');

		// Extract email from the from field
		const email = extractEmail(message.from);

		// Add to blocked emails
		const existing = await ctx.db
			.query('blockedEmails')
			.withIndex('by_email', (q) => q.eq('email', email))
			.first();

		if (!existing) {
			await ctx.db.insert('blockedEmails', {
				email,
				reason: 'manual',
				notes: 'Blocked from inbound quarantine',
				createdAt: Date.now(),
			});
		}

		// Archive the message via the lifecycle.
		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: {
				to: 'archived',
				at: Date.now(),
				reason: 'sender_blocked',
				userId,
			},
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.sender_blocked',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
			details: { email },
		});

		return { success: true };
	},
});
