/**
 * Smart-inbox category on arrival — the in-mutation half of mail/category.ts.
 *
 * Runs inside the delivery mutation (`deliverToMailbox`, `ingestExternalMessage`
 * through `runPostInsertInboundEffects`), so it must not read the conversation:
 * a thread-wide read would grow the delivery's read set with the thread (and hit
 * the transaction read limit on a long notification thread) and make every
 * delivery conflict with any flag write on any message of the thread. The
 * heuristic only needs the newest inbound message, which on this path is almost
 * always the row just inserted, so it is found with a short newest-first walk.
 * Anything the walk cannot settle, and the one step that has to read the whole
 * thread (moving a long thread to Spam), goes to a scheduled job instead.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { isFromMailboxOwner } from './needsReplyHeuristic';
import {
	classifyMailCategory,
	loadCategorySignals,
	resolveCategory,
	writeCategory,
	type MailCategory,
} from './category';

/**
 * How many newest thread messages the arrival pass walks looking for the
 * latest inbound one. A delivery is almost always found on the first row; a
 * thread whose newest rows are all the owner's own defers to the LLM job, which
 * reads the whole thread outside the delivery transaction.
 */
export const ARRIVAL_INBOUND_SCAN = 20;

/**
 * Longest thread whose move to Spam still happens inside the delivery. The move
 * rebuilds the thread aggregates, which reads every message of the thread, so a
 * longer thread is filed by a scheduled `applyCategory` instead.
 */
export const ARRIVAL_SPAM_MOVE_MAX_MESSAGES = 25;

/**
 * Categorize a thread in the calling mutation and schedule the LLM only for
 * what the heuristic cannot decide. Called from the inbound webhook delivery
 * path and from forward external IMAP sync, for inbox deliveries only (a bulk
 * IMAP history import must not fan out background work), and from the one-shot
 * backfill (`enqueue` below).
 *
 * A remembered override or a concrete heuristic label is written in the same
 * transaction as the insert, so the thread never shows up as `other` first and
 * moves a second later. Ambiguous mail gets the fail-soft baseline (`other`, or
 * the thread's standing LLM label when it has one, so a follow-up does not
 * flicker) and the LLM refines it in the background.
 */
export async function enqueueCategoryCheck(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	opts: { precedence?: string } = {}
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const latestInbound = await newestInboundMessage(ctx, thread);
	if (latestInbound === null) return; // owner-only thread (or inactive mailbox)
	if (latestInbound === 'beyondScan') {
		// The whole-thread read belongs to the background job, not the delivery.
		await ctx.scheduler.runAfter(0, internal.mail.ai.categoryClassify.classifyThread, {
			threadId,
			precedence: opts.precedence,
		});
		return;
	}
	const signals = await loadCategorySignals(ctx, thread, latestInbound);

	if (signals.override) {
		if (movesLongThreadToSpam(thread, signals.override)) {
			await ctx.scheduler.runAfter(0, internal.mail.category.applyCategory, {
				threadId,
				label: signals.override,
				source: 'user',
			});
			return;
		}
		await writeCategory(ctx, thread, signals.override, 'user');
		return;
	}

	const deterministic = classifyMailCategory({
		...signals.deterministicInput,
		precedence: opts.precedence,
	});
	if (deterministic) {
		const resolved = resolveCategory({ deterministic });
		await writeCategory(ctx, thread, resolved.label, resolved.source);
		return;
	}

	if (!keepsStandingLabel(thread.category)) {
		await writeCategory(ctx, thread, 'other', 'heuristic');
	}
	await ctx.scheduler.runAfter(0, internal.mail.ai.categoryClassify.classifyThread, {
		threadId,
		precedence: opts.precedence,
		baselineApplied: true,
	});
}

/**
 * The newest message of the thread that the mailbox owner did not send, found
 * by walking `by_thread_and_received` newest-first and stopping at the first
 * hit, so the read set is one row in the usual case. Same pick as the
 * whole-thread `threadInboundView` in mail/category.ts: the index breaks
 * `receivedAt` ties by creation time, as its stable sort does.
 *
 * `null` when the mailbox is gone or inactive, or the thread holds only the
 * owner's own mail; `'beyondScan'` when the newest `ARRIVAL_INBOUND_SCAN` rows
 * are all the owner's and the answer lies further back.
 */
async function newestInboundMessage(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>
): Promise<Doc<'mailMessages'> | null | 'beyondScan'> {
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox || mailbox.status !== 'active') return null;
	let scanned = 0;
	for await (const message of ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
		.order('desc')) {
		if (!isFromMailboxOwner(message, mailbox.address)) return message;
		scanned += 1;
		if (scanned >= ARRIVAL_INBOUND_SCAN) return 'beyondScan';
	}
	return null;
}

/** Whether applying `label` would move a thread too long to move in the delivery. */
function movesLongThreadToSpam(thread: Doc<'mailThreads'>, label: MailCategory): boolean {
	return (
		label === 'spam' &&
		thread.category?.label !== 'spam' &&
		thread.messageCount > ARRIVAL_SPAM_MOVE_MAX_MESSAGES
	);
}

/**
 * Whether an ambiguous new message leaves the thread's current label in place
 * while the LLM runs. Only a model label does: a heuristic or user label came
 * from a signal the new message no longer carries, and `spam` has to be
 * re-applied so the move to Spam (which happens on the transition) covers the
 * newly delivered message too.
 */
function keepsStandingLabel(category: Doc<'mailThreads'>['category']): boolean {
	return category?.source === 'llm' && category.label !== 'spam';
}

/** Mutation wrapper so the backfill action can schedule via the shared helper. */
export const enqueue = internalMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		await enqueueCategoryCheck(ctx, args.threadId);
	},
});
