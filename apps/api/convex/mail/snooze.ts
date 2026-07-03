/**
 * Snooze a message — hide it from the inbox until a future timestamp.
 *
 * Implementation: store `snoozedUntil` and `snoozedFromFolderId` on the
 * message row, then move it to a holding "Snoozed" virtual concept. We
 * don't have a dedicated Snoozed system folder in P1's schema; instead
 * the wakeup cron returns the message to its origin folder and bumps
 * the thread `lastMessageAt` so the inbox sort floats it back to the
 * top. UI hides snoozed messages from the inbox view by filtering out
 * rows whose `snoozedUntil > Date.now()`.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import type { Id } from '../_generated/dataModel';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { loadOwnedMessage } from './permissions';
import { adjustFolderUnseen } from './folders';

export const snooze = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		until: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMessage(ctx, args.messageId);
		if (!owned.ok) throwForbidden('Message not accessible');
		if (args.until <= Date.now()) {
			throwInvalidInput('Snooze time must be in the future');
		}
		const message = owned.message;
		const alreadySnoozed = isMessageSnoozed(message, Date.now());
		await ctx.db.patch(args.messageId, {
			snoozedUntil: args.until,
			snoozedFromFolderId: message.snoozedFromFolderId ?? message.folderId,
			updatedAt: Date.now(),
		});
		// A snoozed message leaves the unread count (it's hidden from its folder).
		if (!message.flagSeen && !alreadySnoozed) {
			await adjustFolderUnseen(ctx, message.folderId, -1);
		}
	},
});

/**
 * Snooze a message until the other party replies (Boomerang "snooze until they
 * reply" parity). The message is hidden exactly like a normal snooze, but
 * `snoozeUntilReply` is set and `until` is the FALLBACK cap: any inbound reply
 * into the thread clears the snooze early (mail/delivery.ts → the awaited reply
 * arrived), otherwise the standard snooze sweep resurfaces it once at the cap.
 *
 * Reuses the resurface-on-no-reply idea from mail/followUps.ts, applied to
 * inbound deferral rather than sent-mail follow-ups.
 */
// authz: message → mailbox ownership via loadOwnedMessage; org membership via
// authedMutation.
export const snoozeUntilReply = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		// Fallback cap — resurface by this time even if no reply arrives.
		capUntil: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMessage(ctx, args.messageId);
		if (!owned.ok) throwForbidden('Message not accessible');
		if (args.capUntil <= Date.now()) {
			throwInvalidInput('Snooze cap must be in the future');
		}
		const message = owned.message;
		const alreadySnoozed = isMessageSnoozed(message, Date.now());
		await ctx.db.patch(args.messageId, {
			snoozedUntil: args.capUntil,
			snoozedFromFolderId: message.snoozedFromFolderId ?? message.folderId,
			snoozeUntilReply: true,
			updatedAt: Date.now(),
		});
		if (!message.flagSeen && !alreadySnoozed) {
			await adjustFolderUnseen(ctx, message.folderId, -1);
		}
	},
});

/**
 * Clear any "snooze until they reply" watch on a thread — the awaited reply
 * landed, so resurface the deferred message(s) immediately. Mirrors
 * followUps.clearThreadFollowUp and is called from the same inbound-delivery
 * hook. Fail-soft: a thread with no such watch is a no-op.
 */
export async function clearSnoozeUntilReplyForThread(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	now: number,
): Promise<void> {
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect();
	for (const m of messages) {
		if (m.snoozeUntilReply !== true) continue;
		if (!isMessageSnoozed(m, now)) continue;
		await ctx.db.patch(m._id, {
			snoozedUntil: undefined,
			snoozedFromFolderId: undefined,
			snoozeUntilReply: undefined,
			updatedAt: now,
		});
		// Returning to its folder re-enters the unread count (see unsnooze).
		if (!m.flagSeen) {
			await adjustFolderUnseen(ctx, m.folderId, 1);
		}
	}
}

export const unsnooze = authedMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMessage(ctx, args.messageId);
		if (!owned.ok) throwForbidden('Message not accessible');
		const message = owned.message;
		const wasSnoozed = isMessageSnoozed(message, Date.now());
		await ctx.db.patch(args.messageId, {
			snoozedUntil: undefined,
			snoozedFromFolderId: undefined,
			snoozeUntilReply: undefined,
			updatedAt: Date.now(),
		});
		// Returning to its folder re-enters the unread count.
		if (wasSnoozed && !message.flagSeen) {
			await adjustFolderUnseen(ctx, message.folderId, 1);
		}
	},
});

// ── Internal cron sweep ────────────────────────────────────────────

/** Cron entry: pulls due-snoozed message ids and wakes them. */
export const internalSweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		// `snoozedUntil` is optional, and on a single-field index Convex sorts
		// rows whose value is `undefined` BEFORE every number — so a bare
		// `lte('snoozedUntil', now)` would fill the page with never-snoozed rows
		// and wake nothing. Lower-bound the range with `gt(0)` to exclude them
		// (snooze() rejects any `until <= now`, so a real value is never <= 0).
		const dueRows = await ctx.db
			.query('mailMessages')
			.withIndex('by_snoozed_until', (q) => q.gt('snoozedUntil', 0).lte('snoozedUntil', now))
			.take(100);
		const due = dueRows.filter((m) => m.snoozedUntil != null);
		const touchedThreads = new Set<Id<'mailThreads'>>();
		for (const m of due) {
			await ctx.db.patch(m._id, {
				snoozedUntil: undefined,
				snoozedFromFolderId: undefined,
				snoozeUntilReply: undefined,
				updatedAt: now,
			});
			// Re-enter the unread count as the message floats back.
			if (!m.flagSeen) {
				await adjustFolderUnseen(ctx, m.folderId, 1);
			}
			touchedThreads.add(m.threadId);
		}
		for (const tid of touchedThreads) {
			const t = await ctx.db.get(tid);
			if (!t) continue;
			await ctx.db.patch(tid, { lastMessageAt: now, updatedAt: now });
		}
		return { woken: due.length };
	},
});
