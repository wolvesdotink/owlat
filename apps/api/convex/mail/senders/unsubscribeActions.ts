'use node';

/**
 * The scheduled one-click request behind a sender unsubscribe (SPEC §5).
 * Runs the EXISTING guarded RFC 8058 POST (`mail/unsubscribe.ts`): the shared
 * URL policy, the DNS-rebinding guard, no redirects, a bounded timeout and the
 * fail-soft result. The URL is re-read from the message at run time.
 */

import { v } from 'convex/values';
import { internalAction } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { logError } from '../../lib/runtimeLog';
import { postOneClickUnsubscribe, type OneClickResult } from '../unsubscribe';

/** POST to the target, if there is one. Pure (poster injected) for tests. */
export async function performOneClickRequest(
	target: { httpUrl: string } | null,
	post: (url: string) => Promise<OneClickResult> = postOneClickUnsubscribe
): Promise<OneClickResult> {
	if (!target) return { ok: false, error: 'not_one_click' };
	return await post(target.httpUrl);
}

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
		// Fail-soft: the person sees "couldn't unsubscribe"; log for the operator.
		if (!result.ok) logError('[Senders] one-click unsubscribe failed', result.error);
		await ctx.runMutation(internal.mail.senders.unsubscribe.recordOneClickResult, {
			profileId: args.profileId,
			requestedAt: args.requestedAt,
			isConfirmed: result.ok,
		});
	},
});
