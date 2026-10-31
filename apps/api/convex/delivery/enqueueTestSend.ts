import { v, type Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { enqueueGovernedSend } from './governedEnqueue';
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

/** What a test Send carries; the caller owns recipient and sender authorization. */
const testSendArgs = {
	email: v.string(),
	organizationId: v.string(),
	from: v.string(),
	replyTo: v.optional(v.string()),
	subject: v.string(),
	html: v.string(),
};
const testSendValidator = v.object(testSendArgs);

export const NO_TEST_SEND_PROVIDER_MESSAGE =
	'No email delivery provider is configured. Set EMAIL_PROVIDER (+ credentials) before sending a test preview.';

/**
 * Queue a member-only test preview through the same durable governed path as
 * every other Send. The caller owns recipient/sender authorization; this
 * mutation owns the durable SendRef, workpool completion, and bounded cleanup.
 *
 * Kept for a test-send action of the previous release still running during
 * the deploy; this release queues inside `campaigns/testSendCommit.ts`. Each
 * call queues the one preview its caller asked for, so it never repeats one
 * that commit queued. Remove after release N+1.
 */
export const enqueueTestSend = internalMutation({
	args: testSendArgs,
	handler: async (ctx, args) => {
		if (!(await selectedSendProviderReady(ctx, undefined))) {
			throw new Error(NO_TEST_SEND_PROVIDER_MESSAGE);
		}
		return { sendId: await queueTestSend(ctx, args) };
	},
});

/**
 * `enqueueTestSend` inside the caller's transaction, once the caller has found
 * a delivery provider ready (`selectedSendProviderReady`): the test-send
 * commit checks that once for all of its recipients and answers a missing
 * provider with an outcome, so the rate-limit token it spent stays spent.
 */
export async function queueTestSend(
	ctx: MutationCtx,
	args: Infer<typeof testSendValidator>
): Promise<Id<'transactionalSends'>> {
	const queuedAt = Date.now();
	const sendId = await ctx.db.insert('transactionalSends', {
		kind: 'test' as const,
		email: args.email,
		subject: args.subject,
		status: 'queued',
		queuedAt,
	});

	await enqueueGovernedSend(
		ctx,
		{ kind: 'transactional', id: sendId },
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
		}
	);
	await ctx.scheduler.runAfter(
		TEST_SEND_RETENTION_MS,
		internal.delivery.enqueueTestSend.deleteExpiredTestSend,
		{ sendId, queuedAt }
	);
	return sendId;
}

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
