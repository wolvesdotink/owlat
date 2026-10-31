'use node';

/**
 * The external half of unsubscribing, both entry points running
 * the EXISTING guarded RFC 8058 POST (`mail/unsubscribe.ts`): the shared URL
 * policy, the DNS-rebinding guard, no redirects, a bounded timeout and the
 * fail-soft result. The URL is always re-read from the message at run time.
 *
 *   - `unsubscribe({target})`: THE unsubscribe path for a person (Senders
 *     page, Subscriptions panel, reader chip, ⇧O). Local suppression first
 *     (`./status.ts startUnsubscribe`), then the one-click POST inline with
 *     its result recorded on the sender, so the caller can say how it went.
 *     A team-inbox message gets the POST only; nothing is recorded.
 *   - `unsubscribeBatchSender`: the same, for one sender of a Subscriptions
 *     batch; on a team inbox its commit archives the sender's Inbox mail.
 *   - `requestOneClick`: the same POST scheduled by a bulk apply of
 *     suggestions (`./suggestions.ts`), spaced out.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { authedAction } from '../../lib/authedFunctions';
import { logError } from '../../lib/runtimeLog';
import { postOneClickUnsubscribe, type OneClickResult } from '../unsubscribe';
import type { UnsubscribeStart } from './status';
import { senderTargetValidator, type SenderTarget } from './targets';

/** POST to the target, if there is one. Pure (poster injected) for tests. */
export async function performOneClickRequest(
	target: { httpUrl: string } | null,
	post: (url: string) => Promise<OneClickResult> = postOneClickUnsubscribe
): Promise<OneClickResult> {
	if (!target) return { ok: false, error: 'not_one_click' };
	return await post(target.httpUrl);
}

/** What happened: the local half, plus the one-click result when there was a POST. */
export type UnsubscribeOutcome = UnsubscribeStart & {
	result: 'confirmed' | 'failed' | null;
	/** Why the POST failed (`http_404`, `network`, …), never the response body. */
	error?: string;
};

/**
 * One unsubscribe: the local half, the guarded POST, then its one commit —
 * the result on a personal sender, or for a team-inbox batch (`shared`) the
 * sender's Inbox mail archived once the sender agreed.
 */
async function runUnsubscribe(
	ctx: ActionCtx,
	target: SenderTarget,
	shared?: { mailboxId: Id<'mailboxes'>; senderEmail: string }
): Promise<{ outcome: UnsubscribeOutcome; sharedArchived: number }> {
	// checkpoint: the local suppression is the person's own decision and stands
	// whatever the one-click POST answers; the result recorded below only
	// annotates it. It claims nothing: running this again POSTs again.
	const start: UnsubscribeStart = await ctx.runMutation(
		internal.mail.senders.status.startUnsubscribe,
		{ target }
	);
	if (start.method !== 'one_click' || !start.messageId) {
		return { outcome: { ...start, result: null }, sharedArchived: 0 };
	}
	const oneClick = await ctx.runQuery(internal.mail.senders.unsubscribe.oneClickTarget, {
		messageId: start.messageId,
	});
	const posted = await performOneClickRequest(oneClick);
	// Fail-soft: the person is told; log for the operator.
	if (!posted.ok) logError('[Senders] one-click unsubscribe failed', posted.error);
	let sharedArchived = 0;
	if (start.scope === 'personal') {
		await ctx.runMutation(internal.mail.senders.unsubscribe.recordOneClickResult, {
			profileId: start.profileId,
			requestedAt: start.requestedAt,
			isConfirmed: posted.ok,
		});
	} else if (shared && posted.ok) {
		// A team inbox keeps no sender standing: archive once the sender agreed.
		({ archived: sharedArchived } = await ctx.runMutation(
			internal.mail.subscriptions.archiveSenderInInbox,
			shared
		));
	}
	const outcome: UnsubscribeOutcome = posted.ok
		? { ...start, result: 'confirmed' }
		: { ...start, result: 'failed', error: posted.error };
	return { outcome, sharedArchived };
}

// authz: org membership via authedAction; mailbox access in startUnsubscribe
// (requireMailboxAccess on the propagated session).
export const unsubscribe = authedAction({
	args: { target: senderTargetValidator },
	handler: async (ctx, args): Promise<UnsubscribeOutcome> =>
		(await runUnsubscribe(ctx, args.target)).outcome,
});

/**
 * One sender of `subscriptions.unsubscribeAndArchive`: the same unsubscribe,
 * and on a team inbox the sender's Inbox mail archived in that sender's own
 * commit. Runs with the batch's session, which every mutation re-checks.
 */
export const unsubscribeBatchSender = internalAction({
	args: {
		messageId: v.id('mailMessages'),
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(),
	},
	handler: async (ctx, args): Promise<{ outcome: UnsubscribeOutcome; sharedArchived: number }> =>
		await runUnsubscribe(
			ctx,
			{ messageId: args.messageId },
			{ mailboxId: args.mailboxId, senderEmail: args.senderEmail }
		),
});

export const requestOneClick = internalAction({
	args: {
		profileId: v.id('mailSenderProfiles'),
		messageId: v.id('mailMessages'),
		requestedAt: v.number(),
	},
	handler: async (ctx, args): Promise<void> => {
		const target = await ctx.runQuery(internal.mail.senders.unsubscribe.oneClickTarget, {
			messageId: args.messageId,
		});
		const result = await performOneClickRequest(target);
		if (!result.ok) logError('[Senders] one-click unsubscribe failed', result.error);
		await ctx.runMutation(internal.mail.senders.unsubscribe.recordOneClickResult, {
			profileId: args.profileId,
			requestedAt: args.requestedAt,
			isConfirmed: result.ok,
		});
	},
});
