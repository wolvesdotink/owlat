/**
 * Per-mailbox reads behind Today and the Conversations sidebar.
 *
 * Both are soft-auth `publicQuery` reads that return `null` for a mailbox the
 * caller cannot open, exactly like the Postbox list reads they sit next to
 * (`mail/mailbox/queries.ts`). The web subscribes once per accessible mailbox
 * and merges client-side, so every mailbox keeps its own permission check.
 *
 *   - `digest`: what happened in one mailbox since the viewer's watermark —
 *     a new-mail count, threads the viewer already knew that moved ("What
 *     changed"), new conversations ("Updates"), and the counts of low-signal
 *     mail filed away. Threads that need a reply are left to the Answer queue.
 *   - `sidebarThreads`: the latest inbox conversations with one status each,
 *     plus the most urgent status among the ones that did not fit.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { isThreadMuted } from '../lib/mailMute';
import { requireMailboxAccess } from '../mail/permissions';
import { loadThreadVisit, visitDelta } from '../mail/threadVisits';
import {
	FILED_CATEGORIES,
	type FiledCategory,
	type ThreadStatus,
	deriveThreadStatus,
	isFiledCategory,
	mostUrgentStatus,
} from './threadStatus';

/** Newest threads scanned for the digest (bounded; Today is about recent mail). */
const DIGEST_THREAD_SCAN = 150;
/** New-mail counts stop here and render as "150+". */
const NEW_MAIL_COUNT_CAP = 150;
const CHANGED_LIMIT = 10;
const ARRIVED_LIMIT = 20;
/** Source messages linked per changed thread. */
const SOURCE_LIMIT = 5;
const SIDEBAR_MAX = 10;
/** Needs-reply threads scanned to find urgency hidden behind "Show more". */
const HIDDEN_NEEDS_SCAN = 25;

interface SourceMessage {
	messageId: Id<'mailMessages'>;
	fromName: string | null;
	fromAddress: string;
	subject: string;
	snippet: string;
	receivedAt: number;
}

function toSource(message: Doc<'mailMessages'>): SourceMessage {
	return {
		messageId: message._id,
		fromName: message.fromName ?? null,
		fromAddress: message.fromAddress,
		subject: message.subject,
		snippet: message.snippet,
		receivedAt: message.receivedAt,
	};
}

/** A thread summary is only trusted while it still covers every message. */
function freshSummary(thread: Doc<'mailThreads'>): string | null {
	const cache = thread.summaryCache;
	return cache && cache.messageCount === thread.messageCount ? cache.summary : null;
}

/** Inbound messages of a thread newer than `after`, newest first. */
async function messagesAfter(
	ctx: QueryCtx,
	threadId: Id<'mailThreads'>,
	after: number
): Promise<Doc<'mailMessages'>[]> {
	const rows = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(20); // bounded: the tail of one thread
	return rows.filter((m) => m.receivedAt > after && !m.flagDraft).slice(0, SOURCE_LIMIT);
}

// public: soft-auth — returns null for anonymous/non-members; mailbox access is enforced in-handler
export const digest = publicQuery({
	args: { mailboxId: v.id('mailboxes'), since: v.number() },
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		if (!access.ok) return null;
		const { userId } = access;
		const now = Date.now();

		const inbox = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
			)
			.first();
		const newRows = inbox
			? await ctx.db
					.query('mailMessages')
					.withIndex('by_folder_and_received', (q) =>
						q.eq('folderId', inbox._id).gt('receivedAt', args.since)
					)
					.take(NEW_MAIL_COUNT_CAP + 1)
			: [];

		const threads = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) =>
				q.eq('mailboxId', args.mailboxId).gt('lastMessageAt', args.since)
			)
			.order('desc')
			.take(DIGEST_THREAD_SCAN);

		const changed = [];
		const arrived = [];
		let arrivedTotal = 0;
		const filed: Record<FiledCategory, number> = Object.fromEntries(
			FILED_CATEGORIES.map((c) => [c, 0])
		) as Record<FiledCategory, number>;

		for (const thread of threads) {
			if (thread.isSelfDeliveredBrief || isThreadMuted(thread)) continue;
			// Needs a reply ⇒ it belongs to the Answer queue, not the digest.
			if (thread.needsReply || thread.followUp?.dueAt !== undefined) continue;
			if (!thread.latestMessageId) continue;
			const latest = await ctx.db.get(thread.latestMessageId);
			if (!latest || latest.flagDraft || isMessageSnoozed(latest, now)) continue;
			// The viewer's own send is not news to them.
			if (latest.sentByUserId === userId) continue;

			const visit = await loadThreadVisit(ctx, userId, thread._id);
			if (visit && visit.visitedAt >= thread.lastMessageAt) continue; // already seen
			const participated =
				thread.latestReply?.byUserId === userId && thread.latestReply.at <= args.since;

			if (visit || participated) {
				if (changed.length >= CHANGED_LIMIT) continue;
				const after = Math.max(visit?.visitedAt ?? 0, args.since);
				const sources = await messagesAfter(ctx, thread._id, after);
				changed.push({
					threadId: thread._id,
					mailboxId: thread.mailboxId,
					subject: thread.latestSubject,
					newMessages: visit ? visitDelta(thread, visit).newSinceVisit : sources.length,
					lastMessageAt: thread.lastMessageAt,
					snippet: thread.latestSnippet,
					summary: freshSummary(thread),
					sources: sources.map(toSource),
				});
				continue;
			}

			if (!thread.folderRoles.includes('inbox')) continue;
			const category = thread.category?.label;
			if (isFiledCategory(category)) {
				filed[category] += 1;
				continue;
			}
			arrivedTotal += 1;
			if (arrived.length >= ARRIVED_LIMIT) continue;
			arrived.push({
				threadId: thread._id,
				mailboxId: thread.mailboxId,
				subject: thread.latestSubject,
				snippet: thread.latestSnippet,
				summary: freshSummary(thread),
				category: category ?? null,
				lastMessageAt: thread.lastMessageAt,
				hasAttachments: thread.hasAttachments,
				sources: [toSource(latest)],
			});
		}

		return {
			mailboxId: args.mailboxId,
			newMail: Math.min(newRows.length, NEW_MAIL_COUNT_CAP),
			isNewMailCapped: newRows.length > NEW_MAIL_COUNT_CAP,
			changed,
			arrived,
			arrivedTotal,
			filed,
		};
	},
});

// public: soft-auth — returns null for anonymous/non-members; mailbox access is enforced in-handler
export const sidebarThreads = publicQuery({
	args: { mailboxId: v.id('mailboxes'), limit: v.number() },
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		if (!access.ok) return null;
		const { userId } = access;
		const now = Date.now();
		const limit = Math.max(0, Math.min(Math.floor(args.limit), SIDEBAR_MAX));

		const inbox = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
			)
			.first();

		const statusOf = async (thread: Doc<'mailThreads'>): Promise<ThreadStatus | null> => {
			const visit = await loadThreadVisit(ctx, userId, thread._id);
			return deriveThreadStatus({
				needsReply: thread.needsReply,
				followUp: thread.followUp,
				newSinceVisit: visitDelta(thread, visit).newSinceVisit,
			});
		};

		const threads = [];
		if (limit > 0) {
			const candidates = await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
				.order('desc')
				.take(limit * 3 + 3);
			for (const thread of candidates) {
				if (threads.length >= limit) break;
				if (!thread.folderRoles.includes('inbox') || isThreadMuted(thread)) continue;
				const latest = thread.latestMessageId ? await ctx.db.get(thread.latestMessageId) : null;
				if (latest && isMessageSnoozed(latest, now)) continue;
				threads.push({
					threadId: thread._id,
					latestMessageId: thread.latestMessageId ?? null,
					subject: thread.latestSubject,
					fromName: latest?.fromName ?? null,
					fromAddress: thread.latestFromAddress,
					lastMessageAt: thread.lastMessageAt,
					isUnread: thread.unreadCount > 0,
					status: await statusOf(thread),
				});
			}
		}

		// Urgency that did not fit: needs-reply threads outside the visible rows.
		const visible = new Set(threads.map((t) => t.threadId));
		const waiting = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_needs_reply', (q) =>
				q.eq('mailboxId', args.mailboxId).gt('needsReply.detectedAt', 0)
			)
			.order('desc')
			.take(HIDDEN_NEEDS_SCAN);
		const hiddenStatuses = waiting
			.filter((t) => !visible.has(t._id) && !isThreadMuted(t))
			.map((t) =>
				deriveThreadStatus({ needsReply: t.needsReply, followUp: t.followUp, newSinceVisit: 0 })
			);

		return {
			mailboxId: args.mailboxId,
			unread: inbox?.unseenCount ?? 0,
			threads,
			hiddenStatus: mostUrgentStatus(hiddenStatuses),
			groupStatus: mostUrgentStatus([...threads.map((t) => t.status), ...hiddenStatuses]),
		};
	},
});
