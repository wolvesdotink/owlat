/**
 * Topic titles: the few words the People view names a conversation by.
 *
 *   - `renameTopic` sets the owner's own title, which the model never
 *     overwrites; an empty title, or `resetTopicTitle`, hands it back.
 *   - `requestTopicTitles` is called by the People view for the topics on
 *     screen. It schedules the model (`mail/ai/topicTitle.ts`) only for a
 *     thread of two or more messages whose title is missing or was written
 *     when the thread was much shorter, and only while the interpretation gate
 *     would admit the spend. So titles cost nothing for mail nobody looks at.
 *
 * A model title stays put until the thread has grown by
 * {@link RETITLE_GROWTH} messages: a title that changes on every reply is
 * harder to find again than the subject it replaced.
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { postboxMutation } from '../_helpers';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../../_utils/errors';
import { requireMailboxAccess } from '../permissions';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';
import { withStoredInlineBodies } from '../../lib/messageBodyStore';
import { validateStringLength } from '../../lib/inputGuards';
import { interpretGate } from '../interpret/gate';
import { modeOfMailbox } from '../interpret/briefTop';
import { isFencedThread } from '../interpret/staleFence';
import { buildThreadTranscript, CATEGORY } from '../ai/transcript';

/** Longest title kept; the model is asked for far less. */
export const TOPIC_TITLE_MAX_CHARS = 80;
/** A model title is written again once the thread grew by this many messages. */
export const RETITLE_GROWTH = 4;
/** Topics one request may name: one screen of the People view. */
const REQUEST_BATCH = 40;
/** A run still counts as in flight this long; a run that died is asked again after it. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** Messages the model reads, newest last. */
const TITLE_CONTEXT_MESSAGES = 8;

/** Whitespace collapsed, wrapping quotes and a trailing full stop dropped, capped. */
export function normalizeTopicTitle(raw: string): string {
	const collapsed = raw
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^["'„“”«»]+|["'„“”«»]+$/g, '')
		.replace(/[.。]+$/, '')
		.trim();
	return collapsed.slice(0, TOPIC_TITLE_MAX_CHARS).trim();
}

/** Whether a thread wants a model title now. Pure. */
/**
 * Whether a stored title may be shown: the owner's always; the model's only
 * while the thread's interpretation is not fenced (a failed signature
 * re-verification withdraws everything the model read from it).
 */
export function isTitleShown(
	thread: Pick<Doc<'mailThreads'>, 'topicTitle' | 'interpretationStaleSince'>
): boolean {
	if (!thread.topicTitle) return false;
	return thread.topicTitle.source === 'user' || !isFencedThread(thread);
}

export function wantsModelTitle(
	thread: Pick<
		Doc<'mailThreads'>,
		'messageCount' | 'topicTitle' | 'topicTitlePendingAt' | 'interpretationStaleSince'
	>,
	now: number
): boolean {
	if (thread.messageCount < 2) return false;
	if (thread.topicTitle?.source === 'user') return false;
	if (isFencedThread(thread)) return false;
	if (thread.topicTitlePendingAt !== undefined && now - thread.topicTitlePendingAt < PENDING_TTL_MS)
		return false;
	if (!thread.topicTitle) return true;
	return thread.messageCount >= thread.topicTitle.messageCount + RETITLE_GROWTH;
}

/** Name a conversation yourself. An empty title gives the naming back to Owlat. */
export const renameTopic = postboxMutation({
	args: { threadId: v.id('mailThreads'), title: v.string() },
	handler: async (ctx, args, session) => {
		validateStringLength(args.title, 500, 'Title');
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Thread not accessible');
		const title = normalizeTopicTitle(args.title);
		const now = Date.now();
		if (!title) {
			await ctx.db.patch(thread._id, { topicTitle: undefined, updatedAt: now });
			return null;
		}
		await ctx.db.patch(thread._id, {
			topicTitle: {
				text: await sealBodyAtWrite(title),
				source: 'user',
				messageCount: thread.messageCount,
				updatedAt: now,
			},
			topicTitlePendingAt: undefined,
			updatedAt: now,
		});
		return title;
	},
});

/** Drop the owner's title: the next look at the topic names it again. */
export const resetTopicTitle = postboxMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Thread not accessible');
		await ctx.db.patch(thread._id, {
			topicTitle: undefined,
			topicTitlePendingAt: undefined,
			updatedAt: Date.now(),
		});
		return null;
	},
});

/** Ask for model titles for the topics on screen; returns how many were scheduled. */
export const requestTopicTitles = postboxMutation({
	args: { mailboxId: v.id('mailboxes'), threadIds: v.array(v.id('mailThreads')) },
	handler: async (ctx, args, session) => {
		if (args.threadIds.length > REQUEST_BATCH) {
			throwInvalidInput(`At most ${REQUEST_BATCH} topics per request`);
		}
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Mailbox not accessible');
		const verdict = await interpretGate(ctx, modeOfMailbox(access.mailbox));
		if (!verdict.isAllowed) return 0;
		const now = Date.now();
		let scheduled = 0;
		for (const threadId of new Set(args.threadIds)) {
			const thread = await ctx.db.get(threadId);
			if (!thread || thread.mailboxId !== args.mailboxId) continue;
			if (!wantsModelTitle(thread, now)) continue;
			await ctx.db.patch(thread._id, { topicTitlePendingAt: now });
			await ctx.scheduler.runAfter(0, internal.mail.ai.topicTitle.writeTitle, {
				threadId: thread._id,
			});
			scheduled += 1;
		}
		return scheduled;
	},
});

/** What the model reads: the newest messages, the title it may keep, who pays. */
export const titleContext = internalQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread || thread.topicTitle?.source === 'user' || isFencedThread(thread)) return null;
		const mailbox = await ctx.db.get(thread.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
			.order('desc')
			.take(TITLE_CONTEXT_MESSAGES);
		if (messages.length === 0) return null;
		const ordered = messages.reverse();
		const transcript = await buildThreadTranscript(await withStoredInlineBodies(ctx.db, ordered), {
			...CATEGORY,
			ownerAddress: mailbox.address,
		});
		const previous =
			thread.topicTitle?.source === 'ai' ? await openMessageBody(thread.topicTitle.text) : null;
		return {
			transcript,
			previous,
			messageCount: thread.messageCount,
			latestMessageId: thread.latestMessageId,
			ownerUserId: mailbox.userId,
		};
	},
});

/** Store a model title, unless the owner named the topic while the model ran. */
export const applyTopicTitle = internalMutation({
	args: { threadId: v.id('mailThreads'), title: v.string(), messageCount: v.number() },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		const title = normalizeTopicTitle(args.title);
		// A fence that landed while the model ran keeps the model's name out too.
		if (thread.topicTitle?.source === 'user' || !title || isFencedThread(thread)) {
			await ctx.db.patch(thread._id, { topicTitlePendingAt: undefined });
			return;
		}
		await ctx.db.patch(thread._id, {
			topicTitle: {
				text: await sealBodyAtWrite(title),
				source: 'ai',
				messageCount: args.messageCount,
				updatedAt: Date.now(),
			},
			topicTitlePendingAt: undefined,
		});
	},
});
