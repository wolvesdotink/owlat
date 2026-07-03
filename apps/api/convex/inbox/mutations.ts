/**
 * Inbound Email Mutations
 *
 * User-facing mutations for the verification queue:
 * approve, reject, edit drafts, assign threads, manage quarantine.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getMutationContext } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { transition as threadTransition } from './threads/module';
import type { CancelAutoSendOutcome } from './processingLifecycle';
import { getOrThrow, throwNotFound, throwInvalidState } from '../_utils/errors';
import { extractEmail } from '../lib/emailAddress';

/**
 * Feed a human verification-queue decision back into the graduated-autonomy
 * loop. The weekly `autonomy.adjustThresholds` cron consumes these rows to
 * tighten / loosen per-category auto-approve thresholds, and the agent-health
 * rollup uses them for the `rejection_spike` circuit breaker. Best-effort:
 * a message with no classification yet still records under `other` so the
 * signal isn't lost. Safe to call even when `ai.autonomy` is off — it only
 * appends a feedback row.
 */
async function recordAutonomyFeedback(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	action: 'approved' | 'rejected' | 'edited',
	userFeedback?: string,
): Promise<void> {
	await ctx.runMutation(internal.autonomy.recordFeedback, {
		category: message.classification?.category ?? 'other',
		action,
		agentConfidence: message.confidenceScore ?? message.classification?.confidence ?? 0,
		userFeedback,
		inboundMessageId: message._id,
	});
}

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

		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: {
				to: 'approved',
				at: Date.now(),
				source: 'human',
				userId,
			},
		});

		// Feed the approval into the graduated-autonomy learning loop.
		await recordAutonomyFeedback(ctx, message, 'approved');

		// Log audit
		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.draft_approved',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});

/**
 * Answer the open clarification questions parked on a message and resume the
 * draft.
 *
 * Backs the "Answer to continue" control on the review surface. The message was
 * parked in `awaiting_clarification` because the agent was missing a fact it
 * needed before it could safely draft; this folds the owner's answers back onto
 * `pendingClarification`, drives `awaiting_clarification → drafting` through the
 * single lifecycle writer, and schedules `walker.resumeDraft` to re-enter the
 * DRAFT step with the answers threaded in as a TRUSTED `[CONFIRMED BY OWNER]`
 * block. Mirrors `approveDraft`: authz is the `adminMutation` wrapper, the
 * status change is atomic inside the lifecycle, and the resume runs off the
 * scheduler so a slow draft never blocks the mutation.
 */
export const answerClarification = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		answers: v.array(
			v.object({
				questionId: v.string(),
				value: v.string(),
				// Origin of the value — the owner typed it ("user", default) or it
				// was auto-filled from stored memory ("memory").
				source: v.optional(v.union(v.literal('user'), v.literal('memory'))),
			}),
		),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);

		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'awaiting_clarification') {
			throwInvalidState('Message is not awaiting clarification');
		}
		const pending = message.pendingClarification;
		if (!pending) throwInvalidState('No clarification is pending');

		const now = Date.now();
		const answerByQuestion = new Map(
			args.answers.map((a) => [a.questionId, a] as const),
		);
		const questions = pending.questions.map((q) => {
			const provided = answerByQuestion.get(q.id);
			if (!provided) return q;
			return {
				...q,
				answer: {
					value: provided.value,
					source: provided.source ?? ('user' as const),
					at: now,
				},
			};
		});

		// Persist the answers (advisory field — direct patch, like editDraft). The
		// processingStatus change goes through the lifecycle below, not here.
		await ctx.db.patch(args.inboundMessageId, {
			pendingClarification: { ...pending, questions, answeredAt: now },
		});

		// Drive awaiting_clarification → drafting via the single lifecycle writer.
		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'drafting', at: now },
		});

		// Re-enter the DRAFT step with the confirmed answers folded in. Off the
		// scheduler so a slow draft can't block the mutation; the transition above
		// has already committed the message into `drafting`.
		await ctx.scheduler.runAfter(0, internal.agent.walker.resumeDraft, {
			inboundMessageId: args.inboundMessageId,
		});

		await recordAuditLog(ctx, {
			userId,
			action: 'inbound.clarification_answered',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
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
 * Undo an in-flight autonomous auto-send during its delay / undo window.
 *
 * Backs the "Sending in 0:59 — Undo" control on the review surface. The message
 * was auto-approved and its send scheduled behind `agentConfig.autoSendDelayMs`;
 * this aborts the scheduled send (if still pending) and routes the reply back to
 * the human review queue (`approved → draft_ready`) rather than dropping it —
 * the same fail-soft degrade as a landing thread reply. Idempotent: a message
 * whose send already fired (or was never delayed) returns `cancelled: false`.
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
 * Edit the draft text before approving
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

		const patches: Partial<Doc<'inboundMessages'>> = {
			draftResponse: args.draftResponse,
		};
		if (args.draftSubject) {
			patches.draftSubject = args.draftSubject;
		}

		await ctx.db.patch(args.inboundMessageId, patches);

		// An edit signals the draft wasn't quite right — a mild negative
		// signal for autonomy threshold tuning.
		await recordAutonomyFeedback(ctx, message, 'edited');

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
		// reset, mirroring the cron's per-message behaviour.
		const failedAction = (
			await ctx.db
				.query('agentActions')
				.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', args.inboundMessageId))
				.collect()
		)
			.filter((a) => a.status === 'failed')
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
