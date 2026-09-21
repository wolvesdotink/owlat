/**
 * Per-thread "notify me when they reply" — the opt-IN twin of conversation mute.
 *
 * An armed thread carries `mailThreads.notifyOnReplyAt`. It is read in exactly
 * one place: the unread peek (`mail/mailbox/queries.ts:newestUnreadInbox`)
 * marks the message `alerted`, and the pure desktop rules
 * (`lib/desktop/notificationRules`) then let it through even when the global
 * scope is people-only and even inside the user's quiet hours. Nothing else
 * routes off it — arming an alert never moves mail, never touches the Reply
 * Queue and never changes the badge.
 *
 * Alert and mute are the two ends of one axis, so they are mutually exclusive:
 * arming the alert drops any mute marker, and `mail/mute.ts` clears the alert
 * when the same thread is muted. Absent ⇒ exactly today's behaviour.
 *
 * Lives beside `mail/mute.ts` rather than inside it: that module is documented
 * end-to-end as the mute verb (with its archive side effect), and this one has
 * no side effect at all.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { authedMutation } from '../lib/authedFunctions';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';

/**
 * Arm / disarm the reply alert for the conversation the given message belongs
 * to. Keyed off the MESSAGE the UI has in hand for the same reason
 * `mute.setMutedForMessage` is: the reader and the list row both address mail
 * by message id.
 */
// authz: message → thread → mailbox access via requireMailboxAccess; org
// membership via authedMutation.
export const setNotifyOnReplyForMessage = authedMutation({
	args: { messageId: v.id('mailMessages'), enabled: v.boolean() },
	handler: async (ctx, args): Promise<{ ok: true; threadId: Id<'mailThreads'> }> => {
		const message = await getOrThrow(ctx, args.messageId, 'Message');
		const owned = await requireMailboxAccess(ctx, message.mailboxId);
		if (!owned.ok) throwForbidden('Message not accessible');
		const thread = await getOrThrow(ctx, message.threadId, 'Thread');
		const now = Date.now();
		if (args.enabled) {
			// Arming the alert on a muted thread would be a contradiction the user
			// could not see, so the opt-in wins and the mute marker goes.
			await ctx.db.patch(thread._id, {
				notifyOnReplyAt: now,
				...(thread.mutedAt !== undefined ? { mutedAt: undefined } : {}),
				updatedAt: now,
			});
		} else if (thread.notifyOnReplyAt !== undefined) {
			await ctx.db.patch(thread._id, { notifyOnReplyAt: undefined, updatedAt: now });
		}
		return { ok: true, threadId: message.threadId };
	},
});
