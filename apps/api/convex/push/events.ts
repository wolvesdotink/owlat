/**
 * The producer side of Web Push: what mail delivery, inbox assignment and chat
 * call from inside their own mutations to say "this person may want to know".
 *
 * Deliberately cheap, because it sits on hot write paths: with push not
 * configured, or no device on file for the person, it is one env read or one
 * indexed `.first()` and nothing is scheduled. Everything else — the person's
 * rules, quiet hours, privacy, the copy — is decided later by the scheduled
 * sender (`push/dispatch.ts`), outside the producer's transaction, so a push
 * problem can never fail a delivery or a chat post.
 *
 * Not a Convex function module; imported by the producers only.
 */

import type { Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { pushEventValidator } from '../lib/validators/push';
import { isWebPushConfigured } from './config';

type PushEvent = Infer<typeof pushEventValidator>;

/** Schedule a push for `userId` when Web Push is on and they have at least one device. */
export async function enqueuePush(
	ctx: MutationCtx,
	userId: string,
	event: PushEvent
): Promise<void> {
	if (!isWebPushConfigured()) return;
	const device = await ctx.db
		.query('pushSubscriptions')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	if (!device) return;
	await ctx.scheduler.runAfter(0, internal.push.send.deliver, { userId, event });
}
