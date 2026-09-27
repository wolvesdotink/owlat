/**
 * Per-mailbox reads behind the Workbench and the Conversations sidebar.
 *
 * Both are soft-auth `publicQuery` reads that return `null` for a mailbox the
 * caller cannot open, exactly like the Postbox list reads they sit next to
 * (`mail/mailbox/queries.ts`). Each Workbench shows one mailbox, so the web
 * subscribes to one digest at a time; the sidebar reads one per inbox.
 *
 *   - `digest`: what happened in one mailbox since the viewer's watermark —
 *     a new-mail count, threads the viewer already knew that moved ("What
 *     changed"), new conversations sorted into important and routine
 *     (`triage.ts`), and the mail filed away (newsletters, notifications…)
 *     as counts plus the first few senders. Threads that need a reply are
 *     left to the Answer queue.
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
import { classifyMailCategory } from '../mail/category';
import { isFromMailboxOwner } from '../mail/needsReplyHeuristic';
import { loadTodaySummary } from './summaryCache';
import { type ImportantReason, isFiledBucket, triageThread } from './triage';
import {
	FILED_CATEGORIES,
	type FiledCategory,
	type ThreadStatus,
	deriveThreadStatus,
	mostUrgentStatus,
} from './threadStatus';

/** Newest threads scanned for the digest (bounded; a Workbench is about recent mail). */
const DIGEST_THREAD_SCAN = 150;
/** New-mail counts stop here and render as "150+". */
const NEW_MAIL_COUNT_CAP = 150;
const CHANGED_LIMIT = 10;
const ARRIVED_LIMIT = 20;
/** Source messages linked per changed thread. */
const SOURCE_LIMIT = 5;
const SIDEBAR_MAX = 10;
/** Senders named per filed category ("The Verge, Stratechery and 4 more"). */
const FILED_SENDER_LIMIT = 3;
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

/** "The Verge", else the sender's domain ("substack.com"), else the address. */
function senderLabel(message: Doc<'mailMessages'>): string {
	const name = message.fromName?.trim();
	if (name) return name;
	return message.fromAddress.split('@')[1] || message.fromAddress;
}

/**
 * The stored category, or — for a thread the classifier has not reached yet —
 * the same deterministic heuristic ingest runs on the latest message.
 */
async function categoryOf(
	ctx: QueryCtx,
	thread: Doc<'mailThreads'>,
	latest: Doc<'mailMessages'>
): Promise<{ stored: { label: string; source: string } | null; heuristic: string | null }> {
	if (thread.category) return { stored: thread.category, heuristic: null };
	// A reply from the mailbox itself says nothing about what kind of mail this is.
	if (latest.outbound !== undefined) return { stored: null, heuristic: null };
	const contact = await ctx.db
		.query('mailContacts')
		.withIndex('by_mailbox_and_email', (q) =>
			q.eq('mailboxId', thread.mailboxId).eq('email', latest.fromAddress.toLowerCase())
		)
		.first();
	return {
		stored: null,
		heuristic: classifyMailCategory({
			fromAddress: latest.fromAddress,
			subject: latest.subject,
			hasListUnsubscribe: latest.unsubscribe !== undefined,
			isKnownCorrespondent: contact !== null,
		}),
	};
}

/**
 * The mailbox has had the last word: the newest message went out from it, or
 * a teammate answered from their personal address (which only stamps
 * `latestReply` on the team thread). Either way nothing is waiting here.
 */
function isAnswered(
	thread: Doc<'mailThreads'>,
	latest: Doc<'mailMessages'>,
	mailboxAddress: string
): boolean {
	if (thread.latestReply && thread.latestReply.at >= latest.receivedAt) return true;
	return isFromMailboxOwner(latest, mailboxAddress);
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
	args: { mailboxId: v.id('mailboxes'), since: v.number(), locale: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const locale = args.locale ?? 'en';
		const access = await requireMailboxAccess(ctx, args.mailboxId);
		if (!access.ok) return null;
		const { userId, mailbox } = access;
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
		const filedSenders: Record<FiledCategory, string[]> = Object.fromEntries(
			FILED_CATEGORIES.map((c) => [c, []])
		) as unknown as Record<FiledCategory, string[]>;

		for (const thread of threads) {
			if (thread.isSelfDeliveredBrief || isThreadMuted(thread)) continue;
			// Needs a reply ⇒ it belongs to the Answer queue, not the digest.
			if (thread.needsReply || thread.followUp?.dueAt !== undefined) continue;
			if (!thread.latestMessageId) continue;
			const latest = await ctx.db.get(thread.latestMessageId);
			if (!latest || latest.flagDraft || isMessageSnoozed(latest, now)) continue;
			// The viewer's own send is not news to them.
			if (latest.sentByUserId === userId) continue;
			const answered = isAnswered(thread, latest, mailbox.address);
			if (answered && thread.latestReply?.byUserId === userId) continue;

			const visit = await loadThreadVisit(ctx, userId, thread._id);
			if (visit && visit.visitedAt >= thread.lastMessageAt) continue; // already seen

			const { stored, heuristic } = await categoryOf(ctx, thread, latest);
			const triage = triageThread({ category: stored, heuristic, subject: latest.subject });
			// Newsletters, notifications and the like are counted, never listed —
			// not even when the viewer once opened an earlier issue of the thread.
			if (isFiledBucket(triage.bucket)) {
				// The spam count includes what the classifier already moved to Spam.
				const roles = thread.folderRoles;
				if (!roles.includes('inbox') && !roles.includes('spam')) continue;
				filed[triage.bucket] += 1;
				const senders = filedSenders[triage.bucket];
				const name = senderLabel(latest);
				if (senders.length < FILED_SENDER_LIMIT && !senders.includes(name)) senders.push(name);
				continue;
			}

			const participated =
				thread.latestReply?.byUserId === userId && thread.latestReply.at <= args.since;

			if (visit || participated) {
				if (changed.length >= CHANGED_LIMIT) continue;
				const after = Math.max(visit?.visitedAt ?? 0, args.since);
				const sources = await messagesAfter(ctx, thread._id, after);
				const newMessages = visit ? visitDelta(thread, visit).newSinceVisit : sources.length;
				const sinceCount = Math.max(0, thread.messageCount - Math.max(newMessages, 1));
				changed.push({
					threadId: thread._id,
					mailboxId: thread.mailboxId,
					subject: thread.latestSubject,
					newMessages,
					lastMessageAt: thread.lastMessageAt,
					snippet: thread.latestSnippet,
					summary: await loadTodaySummary(ctx, {
						threadId: thread._id,
						locale,
						messageCount: thread.messageCount,
						sinceCount,
					}),
					summaryRequest: { messageId: thread.latestMessageId, sinceCount },
					sources: sources.map(toSource),
				});
				continue;
			}

			// A teammate already answered it: not a new arrival for anyone else.
			if (answered || !thread.folderRoles.includes('inbox')) continue;
			arrivedTotal += 1;
			if (arrived.length >= ARRIVED_LIMIT) continue;
			const important = triage.bucket === 'important';
			arrived.push({
				threadId: thread._id,
				mailboxId: thread.mailboxId,
				subject: thread.latestSubject,
				snippet: thread.latestSnippet,
				summary: await loadTodaySummary(ctx, {
					threadId: thread._id,
					locale,
					messageCount: thread.messageCount,
					sinceCount: 0,
				}),
				summaryRequest: { messageId: thread.latestMessageId, sinceCount: 0 },
				category: stored?.label ?? heuristic ?? null,
				bucket: important ? ('important' as const) : ('routine' as const),
				reason: triage.reason as ImportantReason | null,
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
			filedSenders,
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
