/**
 * Team inbox follow-ups — a person writing to the customer again after the
 * thread's latest message was already answered.
 *
 * An inbound message carries one reply: its `draftResponse` rides the
 * processing lifecycle to `sent`, and `sent` is terminal. Reopening it would
 * overwrite the reply that went out, so a second message from the team gets
 * its own row (`inboxFollowUps`) and its own send path instead:
 *
 * - `sendFollowUp` answers the thread's newest message once it is `sent`,
 *   holding the same human-approve undo window an approved draft waits out
 *   (`agentConfig.humanApproveUndoDelayMs`), and the same collision soft-hold
 *   while a teammate is replying.
 * - `dispatch` runs when the window closes: it builds the reply envelope the
 *   approved reply uses (recipient, threading headers, sender identity) and
 *   hands a `team_reply` Send to the non-campaign intake.
 * - `completeSend` is driven by the Send lifecycle once the worker outcome
 *   lands (`delivery/sendLifecycle/sourceFinalization.ts`).
 * - `cancelFollowUp` is Undo, while the window is still open.
 *
 * This module is the only writer of `inboxFollowUps.status`.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { defineLifecycle } from '../lib/lifecycle';
import { getOptional } from '../lib/env';
import { isValidEmail, STRING_LIMITS, validateStringLength } from '../lib/inputGuards';
import { buildReplySubject } from '../lib/emailAddress';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { isOutboundChannel } from '../lib/convexValidators';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { mirrorEmailSendWrite } from '../unifiedMessages';
import { buildThreadingHeaders, extractRecipient, replyBodyToHtml } from '../agent/replyEnvelope';
import type {
	NonCampaignIntakeOutcome,
	NonCampaignIntakeRejectionReason,
} from '../delivery/nonCampaignIntake';
import { resolveHumanApproveUndoDelayMs } from './processingLifecycle/effects';
import { resolveReplyCollisionHold } from './decisionFeedback';
import { isSharedInboxReader } from './access';

type FollowUpStatus = Doc<'inboxFollowUps'>['status'];

/**
 * `scheduled → failed` is a refusal at dispatch (no sender identity, a
 * blocklisted recipient): no Send row was ever written.
 */
export const FOLLOW_UP_LIFECYCLE = defineLifecycle<FollowUpStatus>({
	scheduled: ['sending', 'cancelled', 'failed'],
	sending: ['sent', 'failed'],
	sent: [],
	failed: [],
	cancelled: [],
});

async function transitionFollowUp(
	ctx: MutationCtx,
	followUp: Doc<'inboxFollowUps'>,
	to: FollowUpStatus,
	patch: Partial<Doc<'inboxFollowUps'>> = {}
): Promise<boolean> {
	if (!FOLLOW_UP_LIFECYCLE.isLegalEdge(followUp.status, to)) return false;
	await ctx.db.patch(followUp._id, { ...patch, status: to });
	return true;
}

/**
 * Why the thread's newest message can't take a follow-up, or `null` when it
 * can. Anything short of `sent` still has its own reply to give, through the
 * review path. Pure + exported for tests.
 */
export function followUpRefusal(
	latest: Pick<Doc<'inboundMessages'>, 'processingStatus' | 'to'>
): string | null {
	if (latest.processingStatus !== 'sent') {
		return 'The latest message has not been answered yet. Reply to it instead.';
	}
	if (isOutboundChannel(latest.to)) return 'Follow-ups can only be sent on email threads';
	return null;
}

/** What each intake refusal tells the person, on the failed follow-up. */
const REFUSAL_MESSAGE: Record<
	NonCampaignIntakeRejectionReason,
	(detail: string | undefined) => string
> = {
	recipient_blocked: () => 'The recipient is on the blocklist',
	// Only marketing-scope kinds are gated on contact eligibility, and a
	// follow-up is a transactional `team_reply`, so this stays unreachable
	// unless that scope changes.
	recipient_ineligible: () => 'The recipient can no longer receive email from this workspace',
	no_delivery_provider: (detail) => detail ?? 'No delivery provider configured',
	abuse_blocked: () => 'Sending is disabled while this instance is suspended.',
};

type SendFollowUpResult =
	| { success: true; followUpId: Id<'inboxFollowUps'>; undo?: { sendAt: number } }
	| { success: false; reason: 'reply_in_progress'; heldByName: string };

export const sendFollowUp = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		body: v.string(),
		subject: v.string(),
	},
	handler: async (ctx, args, session): Promise<SendFollowUpResult> => {
		const body = args.body.trim();
		if (!body) throwInvalidInput('Write a message before sending');
		validateStringLength(args.subject, STRING_LIMITS.SUBJECT, 'Subject');
		await getOrThrow(ctx, args.threadId, 'Thread');

		const latest = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.first();
		if (!latest) throwInvalidState('This thread has no message to follow up on');
		const refusal = followUpRefusal(latest);
		if (refusal) throwInvalidState(refusal);

		// Collision soft-hold, the same shape `approveDraft` returns, so the
		// composer shows the same "… is replying" toast.
		const hold = await resolveReplyCollisionHold(ctx, latest, session.userId);
		if (hold) {
			return {
				success: false as const,
				reason: 'reply_in_progress' as const,
				heldByName: hold.heldByName,
			};
		}

		const configs = await ctx.db.query('agentConfig').take(1);
		const undoDelayMs = resolveHumanApproveUndoDelayMs(configs[0]?.humanApproveUndoDelayMs);
		const now = Date.now();
		const subject =
			args.subject.trim() ||
			latest.draftSubject ||
			(latest.subject ? buildReplySubject(latest.subject) : 'Re: your message');

		const followUpId = await ctx.db.insert('inboxFollowUps', {
			threadId: args.threadId,
			inReplyToMessageId: latest._id,
			subject,
			body,
			status: 'scheduled',
			createdBy: session.userId,
			createdAt: now,
			sendAt: now + undoDelayMs,
		});
		const scheduledFnId = await ctx.scheduler.runAfter(
			undoDelayMs,
			internal.inbox.followUps.dispatch,
			{ followUpId }
		);
		await ctx.db.patch(followUpId, { scheduledFnId });

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'inbound.follow_up_sent',
			resource: 'conversation_thread',
			resourceId: args.threadId,
			details: { followUpId, inReplyToMessageId: latest._id },
		});

		return {
			success: true as const,
			followUpId,
			...(undoDelayMs > 0 ? { undo: { sendAt: now + undoDelayMs } } : {}),
		};
	},
});

/**
 * Undo a follow-up while its window is open. Hands the text back so the
 * composer can reopen with it. `cancelled: false` once it has left.
 */
export const cancelFollowUp = adminMutation({
	args: { followUpId: v.id('inboxFollowUps') },
	handler: async (ctx, args, session) => {
		const followUp = await getOrThrow(ctx, args.followUpId, 'Follow-up');
		if (followUp.status !== 'scheduled') return { cancelled: false as const };
		if (followUp.scheduledFnId) await ctx.scheduler.cancel(followUp.scheduledFnId);
		await transitionFollowUp(ctx, followUp, 'cancelled', { scheduledFnId: undefined });

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'inbound.follow_up_cancelled',
			resource: 'conversation_thread',
			resourceId: followUp.threadId,
			details: { followUpId: followUp._id },
		});

		return { cancelled: true as const, body: followUp.body, subject: followUp.subject };
	},
});

/**
 * The undo window closed: send it. A mutation rather than an action so the
 * `scheduled → sending` edge and the Send row commit together — an Undo racing
 * this either lands first (and this returns) or finds it already `sending`.
 */
export const dispatch = internalMutation({
	args: { followUpId: v.id('inboxFollowUps') },
	handler: async (ctx, args): Promise<void> => {
		const followUp = await ctx.db.get(args.followUpId);
		if (!followUp || followUp.status !== 'scheduled') return;
		const fail = async (errorMessage: string): Promise<void> => {
			await transitionFollowUp(ctx, followUp, 'failed', { errorMessage, scheduledFnId: undefined });
		};

		const inbound = await ctx.db.get(followUp.inReplyToMessageId);
		if (!inbound) return await fail('The message this follow-up answers no longer exists');
		const recipient = extractRecipient(inbound.from);
		if (!recipient || !isValidEmail(recipient)) {
			return await fail('The sender of this thread has no address a reply can go to');
		}

		// The sending identity the approved reply uses (agentPipeline.sendApprovedReply).
		const settings = await ctx.db.query('instanceSettings').first();
		const fromEmail = settings?.defaultFromEmail ?? getOptional('DEFAULT_FROM_EMAIL');
		if (!fromEmail) {
			return await fail(
				'No sending identity configured — set a default sender email in organization settings.'
			);
		}
		const from = formatFromAddress(
			fromEmail,
			settings?.defaultFromName ?? getOptional('DEFAULT_FROM_NAME')
		);
		const headers = buildThreadingHeaders({
			messageId: inbound.messageId,
			references: inbound.references,
		});

		let outcome: NonCampaignIntakeOutcome;
		try {
			outcome = await ctx.runMutation(internal.delivery.nonCampaignIntake.intake, {
				kind: 'team_reply',
				email: recipient,
				...(inbound.contactId ? { contactId: inbound.contactId } : {}),
				followUpId: followUp._id,
				subject: followUp.subject,
				html: replyBodyToHtml(followUp.body),
				from,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			});
		} catch (err) {
			// Refusals are typed returns; a throw is an infrastructure fault.
			return await fail(err instanceof Error ? err.message : String(err));
		}
		if (!outcome.ok) return await fail(REFUSAL_MESSAGE[outcome.reason](outcome.detail));

		await transitionFollowUp(ctx, followUp, 'sending', {
			sendId: outcome.sendId,
			scheduledFnId: undefined,
		});
	},
});

/**
 * The Send carrying a follow-up reached a terminal state. A delivered one is
 * mirrored into the thread's unified timeline, like an approved reply.
 */
export const completeSend = internalMutation({
	args: {
		followUpId: v.id('inboxFollowUps'),
		outcome: v.union(
			v.object({
				kind: v.literal('sent'),
				at: v.number(),
				providerMessageId: v.optional(v.string()),
			}),
			v.object({ kind: v.literal('failed'), at: v.number(), errorMessage: v.string() })
		),
	},
	handler: async (ctx, args): Promise<void> => {
		const followUp = await ctx.db.get(args.followUpId);
		if (!followUp) return;
		if (args.outcome.kind === 'failed') {
			await transitionFollowUp(ctx, followUp, 'failed', {
				errorMessage: args.outcome.errorMessage,
			});
			return;
		}
		const moved = await transitionFollowUp(ctx, followUp, 'sent', { sentAt: args.outcome.at });
		if (!moved) return;
		try {
			const thread = await ctx.db.get(followUp.threadId);
			if (thread?.contactId) {
				await mirrorEmailSendWrite(ctx, {
					threadId: followUp.threadId,
					contactId: thread.contactId,
					subject: followUp.subject,
					textBody: followUp.body,
					externalMessageId: args.outcome.providerMessageId,
					status: 'sent',
				});
			}
		} catch {
			// The timeline is a denormalized read model; it never fails the send.
		}
	},
});

/** A thread's follow-ups, oldest first, for the thread view. Undone ones are left out. */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const listForThread = publicQuery({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return [];
		const rows = await ctx.db
			.query('inboxFollowUps')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('asc')
			.take(200); // bounded: one thread's follow-ups
		return rows.flatMap((row) =>
			row.status === 'cancelled'
				? []
				: [
						{
							_id: row._id,
							inReplyToMessageId: row.inReplyToMessageId,
							subject: row.subject,
							body: row.body,
							status: row.status,
							createdBy: row.createdBy,
							createdAt: row.createdAt,
							sendAt: row.sendAt,
							sentAt: row.sentAt,
							errorMessage: row.errorMessage,
						},
					]
		);
	},
});
