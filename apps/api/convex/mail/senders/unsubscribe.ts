/**
 * Unsubscribe from a sender. Two separate things:
 *
 *   - LOCAL suppression: the sender's status becomes `unsubscribed`, so
 *     future mail is archived at delivery. Always happens, recorded as an
 *     undoable operation (`./status.ts`).
 *   - The EXTERNAL request, by the best method the sender's mail offers:
 *       one-click → the existing guarded RFC 8058 POST
 *                   (`mail/unsubscribe.ts postOneClickUnsubscribe`, run by
 *                   `./unsubscribeActions.ts`), result `confirmed` / `failed`;
 *       mailto / https → the client opens the compose or the page, result
 *                   `opened`.
 *
 * Nothing here reimplements the POST or the URL policy.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { internalQuery } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { subscriptionMethodOf } from '../subscriptions';

/** Sender messages read to find the best unsubscribe target. */
const TARGET_SCAN = 10;

/**
 * Gap between two senders' one-click POSTs in a bulk run: politeness toward
 * the ESPs (several senders often share one), as in `mail/subscriptions.ts`.
 */
export const ONE_CLICK_SPACING_MS = 400;

export type UnsubscribeMethod = NonNullable<Doc<'mailSenderProfiles'>['unsubscribe']>['method'];

export interface UnsubscribeTarget {
	method: UnsubscribeMethod;
	messageId: Id<'mailMessages'>;
	httpUrl?: string;
	mailtoUrl?: string;
}

const METHOD_OF = { 'one-click': 'one_click', http: 'https', mailto: 'mailto' } as const;
const RANK: Record<UnsubscribeMethod, number> = { one_click: 3, https: 2, mailto: 1 };

function targetOf(message: Doc<'mailMessages'>): UnsubscribeTarget | null {
	const method = subscriptionMethodOf(message.unsubscribe);
	if (!method || !message.unsubscribe) return null;
	return {
		method: METHOD_OF[method],
		messageId: message._id,
		...(message.unsubscribe.httpUrl ? { httpUrl: message.unsubscribe.httpUrl } : {}),
		...(message.unsubscribe.mailtoUrl ? { mailtoUrl: message.unsubscribe.mailtoUrl } : {}),
	};
}

/**
 * The best unsubscribe target among the sender's newest messages, best
 * method first (newest wins a tie). A message the person is looking at wins
 * when it carries a target at all.
 */
export async function findUnsubscribeTarget(
	ctx: Pick<QueryCtx, 'db'>,
	profile: Pick<Doc<'mailSenderProfiles'>, 'mailboxId' | 'address'>,
	preferred?: Doc<'mailMessages'>
): Promise<UnsubscribeTarget | null> {
	const own = preferred ? targetOf(preferred) : null;
	if (own) return own;
	const newest = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_from', (q) =>
			q.eq('mailboxId', profile.mailboxId).eq('fromAddress', profile.address)
		)
		.order('desc')
		.take(TARGET_SCAN);
	let best: UnsubscribeTarget | null = null;
	for (const message of newest) {
		const target = targetOf(message);
		if (target && (!best || RANK[target.method] > RANK[best.method])) best = target;
	}
	return best;
}

/** Whether the sender can be unsubscribed from without a person finishing it. */
export async function hasOneClickTarget(
	ctx: Pick<QueryCtx, 'db'>,
	profile: Pick<Doc<'mailSenderProfiles'>, 'mailboxId' | 'address'>
): Promise<boolean> {
	return (await findUnsubscribeTarget(ctx, profile))?.method === 'one_click';
}

/**
 * Start the external request for a target, after the local status is set.
 * One-click is scheduled (an action does the POST); mailto / https are
 * recorded as `opened` now, because the client opens them as this returns.
 */
export async function requestExternalUnsubscribe(
	ctx: MutationCtx,
	profile: Doc<'mailSenderProfiles'>,
	target: UnsubscribeTarget,
	opts: { now: number; delayMs?: number }
): Promise<void> {
	if (target.method === 'one_click') {
		await ctx.scheduler.runAfter(
			opts.delayMs ?? 0,
			internal.mail.senders.unsubscribeActions.requestOneClick,
			{ profileId: profile._id, messageId: target.messageId, requestedAt: opts.now }
		);
		return;
	}
	await ctx.db.patch(profile._id, {
		unsubscribe: { method: target.method, requestedAt: opts.now, result: 'opened' },
		updatedAt: opts.now,
	});
}

/** The one-click URL of a message, read fresh by the action. */
export const oneClickTarget = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<{ httpUrl: string } | null> => {
		const message = await ctx.db.get(args.messageId);
		const target = message?.unsubscribe;
		return target?.oneClick && target.httpUrl ? { httpUrl: target.httpUrl } : null;
	},
});

/** Record a one-click result; a newer request's result is never overwritten. */
export const recordOneClickResult = internalMutation({
	args: {
		profileId: v.id('mailSenderProfiles'),
		requestedAt: v.number(),
		isConfirmed: v.boolean(),
	},
	handler: async (ctx, args) => {
		const profile = await ctx.db.get(args.profileId);
		if (!profile) return;
		if ((profile.unsubscribe?.requestedAt ?? 0) > args.requestedAt) return;
		await ctx.db.patch(profile._id, {
			unsubscribe: {
				method: 'one_click',
				requestedAt: args.requestedAt,
				result: args.isConfirmed ? 'confirmed' : 'failed',
			},
			updatedAt: Date.now(),
		});
	},
});
