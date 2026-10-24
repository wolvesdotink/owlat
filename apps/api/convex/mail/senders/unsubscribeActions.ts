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
 *   - `requestOneClick`: the same POST scheduled by a bulk apply of
 *     suggestions (`./suggestions.ts`), spaced out.
 */

import { v } from 'convex/values';
import { internalAction } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { authedAction } from '../../lib/authedFunctions';
import { logError } from '../../lib/runtimeLog';
import { postOneClickUnsubscribe, type OneClickResult } from '../unsubscribe';
import type { UnsubscribeStart } from './status';
import { senderTargetValidator } from './targets';

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

// authz: org membership via authedAction; mailbox access in startUnsubscribe
// (requireMailboxAccess on the propagated session).
export const unsubscribe = authedAction({
	args: { target: senderTargetValidator },
	handler: async (ctx, args): Promise<UnsubscribeOutcome> => {
		const start: UnsubscribeStart = await ctx.runMutation(
			internal.mail.senders.status.startUnsubscribe,
			{ target: args.target }
		);
		if (start.method !== 'one_click' || !start.messageId) return { ...start, result: null };
		const target = await ctx.runQuery(internal.mail.senders.unsubscribe.oneClickTarget, {
			messageId: start.messageId,
		});
		const outcome = await performOneClickRequest(target);
		// Fail-soft: the person is told; log for the operator.
		if (!outcome.ok) logError('[Senders] one-click unsubscribe failed', outcome.error);
		if (start.scope === 'personal') {
			await ctx.runMutation(internal.mail.senders.unsubscribe.recordOneClickResult, {
				profileId: start.profileId,
				requestedAt: start.requestedAt,
				isConfirmed: outcome.ok,
			});
		}
		return outcome.ok
			? { ...start, result: 'confirmed' }
			: { ...start, result: 'failed', error: outcome.error };
	},
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
