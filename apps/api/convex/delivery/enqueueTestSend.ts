import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { transactionalEmailPool } from './workpool';
import { selectedSendProviderReady } from '../lib/sendProviders/capability';

/**
 * The member-only TEST PREVIEW send, split out of `delivery/enqueue.ts` (which
 * had grown past the ~500 LOC split guideline in CONVENTIONS.md).
 *
 * It is its own domain rather than an arbitrary slice: a preview is addressed to
 * a member of the instance, never to a contact, so it is the one enqueue path
 * with NO suppression gate, NO engagement score, NO experiment assignment row
 * and NO seed probe — and the only one that owns a RETENTION concern. Keeping it
 * beside the production producers made every one of those absences look like an
 * omission; here they are the point of the module.
 */

/** Test-preview Sends outlive the MTA's four-day queue ceiling, then self-delete. */
export const TEST_SEND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Queue a member-only test preview through the same durable governed path as
 * every other Send. The caller owns recipient/sender authorization; this
 * mutation owns the durable SendRef, workpool completion, and bounded cleanup.
 */
export const enqueueTestSend = internalMutation({
	args: {
		email: v.string(),
		organizationId: v.string(),
		from: v.string(),
		replyTo: v.optional(v.string()),
		subject: v.string(),
		html: v.string(),
	},
	handler: async (ctx, args) => {
		// A preview has ONE caller (`campaigns/testSend.ts`), reached from an
		// authed member action that surfaces a throw to the operator directly, so
		// it keeps the throw rather than adopting the intake outcome union: there
		// is no second call site to keep in agreement, and nothing here ever
		// string-matched the message (which is why the shared magic-string
		// constant this used to import could be deleted outright).
		if (!(await selectedSendProviderReady(ctx, undefined))) {
			throw new Error(
				'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) before sending a test preview.'
			);
		}
		const queuedAt = Date.now();
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: 'test' as const,
			email: args.email,
			subject: args.subject,
			status: 'queued',
			queuedAt,
		});

		await transactionalEmailPool.enqueueAction(
			ctx,
			internal.delivery.worker.sendSingleEmail,
			{
				envelopeInput: {
					kind: 'transactional' as const,
					deliveryDomain: 'member_test' as const,
					messageType: 'transactional' as const,
					emailPurpose: 'transactional' as const,
					to: args.email,
					from: args.from,
					replyTo: args.replyTo,
					organizationId: args.organizationId,
					sendId,
					template: { subject: args.subject, htmlContent: args.html },
				},
			},
			{
				onComplete: internal.delivery.sendCompletion.completeSend,
				context: { sendRef: { kind: 'transactional' as const, id: sendId } },
			}
		);
		await ctx.scheduler.runAfter(
			TEST_SEND_RETENTION_MS,
			internal.delivery.enqueueTestSend.deleteExpiredTestSend,
			{ sendId, queuedAt }
		);
		return { sendId };
	},
});

/** Idempotent per-row retention callback; seven days exceeds every MTA retry window. */
export const deleteExpiredTestSend = internalMutation({
	args: { sendId: v.id('transactionalSends'), queuedAt: v.number() },
	handler: async (ctx, args) => {
		const send = await ctx.db.get(args.sendId);
		if (!send || send.kind !== 'test' || send.queuedAt !== args.queuedAt) return false;
		const remainingMs = args.queuedAt + TEST_SEND_RETENTION_MS - Date.now();
		if (remainingMs > 0) {
			await ctx.scheduler.runAfter(
				remainingMs,
				internal.delivery.enqueueTestSend.deleteExpiredTestSend,
				args
			);
			return false;
		}
		await ctx.db.delete(args.sendId);
		return true;
	},
});
