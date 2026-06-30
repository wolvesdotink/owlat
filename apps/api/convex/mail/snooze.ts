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
import { internalMutation } from '../_generated/server';
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
