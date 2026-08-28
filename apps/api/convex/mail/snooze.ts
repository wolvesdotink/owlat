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
import type { Doc, Id } from '../_generated/dataModel';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { requireMailboxAccess, requireMessageAccess } from './permissions';
import { adjustFolderUnseen } from './folders';

export const snooze = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		until: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await requireMessageAccess(ctx, args.messageId);
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
 * `isSnoozeUntilReply` is set and `until` is the FALLBACK cap: any inbound reply
 * into the thread clears the snooze early (mail/delivery.ts → the awaited reply
 * arrived), otherwise the standard snooze sweep resurfaces it once at the cap.
 *
 * Reuses the resurface-on-no-reply idea from mail/followUps.ts, applied to
 * inbound deferral rather than sent-mail follow-ups.
 */
// authz: message → mailbox ownership via requireMessageAccess; org membership via
// authedMutation.
export const snoozeUntilReply = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		// Fallback cap — resurface by this time even if no reply arrives.
		capUntil: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await requireMessageAccess(ctx, args.messageId);
		if (!owned.ok) throwForbidden('Message not accessible');
		if (args.capUntil <= Date.now()) {
			throwInvalidInput('Snooze cap must be in the future');
		}
		const message = owned.message;
		const alreadySnoozed = isMessageSnoozed(message, Date.now());
		await ctx.db.patch(args.messageId, {
			snoozedUntil: args.capUntil,
			snoozedFromFolderId: message.snoozedFromFolderId ?? message.folderId,
			isSnoozeUntilReply: true,
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
	now: number
): Promise<void> {
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one thread's messages
	for (const m of messages) {
		if (m.isSnoozeUntilReply !== true) continue;
		if (!isMessageSnoozed(m, now)) continue;
		await ctx.db.patch(m._id, {
			snoozedUntil: undefined,
			snoozedFromFolderId: undefined,
			isSnoozeUntilReply: undefined,
			updatedAt: now,
		});
		// Returning to its folder re-enters the unread count (see unsnooze).
		if (!m.flagSeen) {
			await adjustFolderUnseen(ctx, m.folderId, 1);
		}
	}
}

/**
 * Return one message to its folder: drop the snooze columns and re-enter the
 * folder unread count. Shared by the manual unsnooze verbs and the wake sweep
 * so "coming back" means the same thing on all three paths.
 */
async function clearMessageSnooze(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	now: number
): Promise<void> {
	if (message.snoozedUntil == null) return;
	await ctx.db.patch(message._id, {
		snoozedUntil: undefined,
		snoozedFromFolderId: undefined,
		isSnoozeUntilReply: undefined,
		updatedAt: now,
	});
	// Returning to its folder re-enters the unread count. The decrement happened
	// when `snoozedUntil` was SET, and nothing re-adds it when the wake time
	// merely passes — so the presence of the column, not `isMessageSnoozed`, is
	// what says the message is currently out of the count.
	if (!message.flagSeen) {
		await adjustFolderUnseen(ctx, message.folderId, 1);
	}
}

/**
 * Snooze a whole CONVERSATION (idea 18) — the scope the `h` shortcut and the
 * snooze dialog now default to.
 *
 * Message-level snooze is still the primitive: this patches every INBOX-folder
 * message of the thread with the same wake timestamp, so the thread leaves the
 * inbox as one unit and the existing hide-from-folder filter, unread accounting
 * and Snoozed view all work unchanged. Only inbox mail is touched — a sent copy
 * or an already-archived sibling was never in the inbox and has nothing to
 * defer.
 *
 * Because every message shares one `until`, the sweep finds them all in the
 * same pass; `internalSweep` additionally finishes any thread it starts, so a
 * page boundary can never resurface half a conversation.
 */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const snoozeThread = authedMutation({
	args: { threadId: v.id('mailThreads'), until: v.number() },
	handler: async (ctx, args): Promise<{ ok: true; snoozed: number }> => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		if (args.until <= Date.now()) {
			throwInvalidInput('Snooze time must be in the future');
		}
		const now = Date.now();
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's messages
		let snoozed = 0;
		for (const m of messages) {
			const alreadySnoozed = isMessageSnoozed(m, now);
			if (!alreadySnoozed) {
				const folder = await ctx.db.get(m.folderId);
				if (folder?.role !== 'inbox') continue;
			}
			await ctx.db.patch(m._id, {
				snoozedUntil: args.until,
				snoozedFromFolderId: m.snoozedFromFolderId ?? m.folderId,
				updatedAt: now,
			});
			if (!m.flagSeen && !alreadySnoozed) {
				await adjustFolderUnseen(ctx, m.folderId, -1);
			}
			snoozed += 1;
		}
		// Deferring the conversation supersedes any "you came back from snooze"
		// marker still on it from a previous round trip.
		if (thread.snoozeReturnedAt !== undefined) {
			await ctx.db.patch(args.threadId, { snoozeReturnedAt: undefined, updatedAt: now });
		}
		return { ok: true, snoozed };
	},
});

/** Wake a whole conversation early — the inverse of {@link snoozeThread}. */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const unsnoozeThread = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args): Promise<{ ok: true; woken: number }> => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		const now = Date.now();
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's messages
		let woken = 0;
		for (const m of messages) {
			if (m.snoozedUntil == null) continue;
			await clearMessageSnooze(ctx, m, now);
			woken += 1;
		}
		return { ok: true, woken };
	},
});

/**
 * Dismiss the transient "back from snooze" marker (idea 19). Called the first
 * time the resurfaced thread is opened, so the chip is a one-shot recognition
 * cue rather than sticky state. Fail-soft: a thread without the marker is a
 * no-op, and the mutation is safe to fire on every open.
 */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const clearSnoozeReturned = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		if (thread.snoozeReturnedAt === undefined) return;
		await ctx.db.patch(args.threadId, { snoozeReturnedAt: undefined, updatedAt: Date.now() });
	},
});

export const unsnooze = authedMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const owned = await requireMessageAccess(ctx, args.messageId);
		if (!owned.ok) throwForbidden('Message not accessible');
		await clearMessageSnooze(ctx, owned.message, Date.now());
	},
});

// ── Internal cron sweep ────────────────────────────────────────────

/**
 * Cron entry: pulls due-snoozed message ids and wakes them.
 *
 * Thread-atomic (idea 18): every thread the page touches is FINISHED before the
 * sweep returns — any sibling message of that thread which is also due but fell
 * past the `take()` boundary is woken in the same transaction. A conversation
 * therefore resurfaces as one row, never as a trickle across sweep ticks.
 *
 * Each woken thread is stamped `snoozeReturnedAt` (idea 19, ported from the
 * Team Inbox's `inboxThreads.snoozeReturnedAt`) so the list row and the reader
 * header can say "back from snooze" until the thread is next opened.
 */
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
		const wokenIds = new Set<Id<'mailMessages'>>();
		for (const m of due) {
			await clearMessageSnooze(ctx, m, now);
			wokenIds.add(m._id);
			touchedThreads.add(m.threadId);
		}
		// Finish every thread the page started: a thread-level snooze writes one
		// `until` across all its inbox messages, and a take() boundary in the
		// middle of that set would otherwise resurface the conversation in pieces.
		for (const tid of touchedThreads) {
			const siblings = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', tid))
				.collect(); // bounded: one thread's messages
			for (const m of siblings) {
				if (wokenIds.has(m._id)) continue;
				if (m.snoozedUntil == null || m.snoozedUntil > now) continue;
				await clearMessageSnooze(ctx, m, now);
				wokenIds.add(m._id);
			}
		}
		for (const tid of touchedThreads) {
			const t = await ctx.db.get(tid);
			if (!t) continue;
			await ctx.db.patch(tid, {
				lastMessageAt: now,
				// Transient recognition cue; the reader clears it on open.
				snoozeReturnedAt: now,
				updatedAt: now,
			});
		}
		return { woken: wokenIds.size };
	},
});
