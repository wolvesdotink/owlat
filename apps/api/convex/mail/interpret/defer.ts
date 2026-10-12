/**
 * Lazy interpretation for display-only mail (ADR-0073 D10, AI routing plan gap
 * L12).
 *
 * Postbox interprets every eligible delivered message, including mail the
 * needs-reply screen already ruled out (notifications, receipts, a known
 * sender's newsletter), because the thread brief shows its facts. When the
 * reader display is the ONLY consumer left, the model call waits until
 * someone opens the thread:
 *
 *   - a personal mailbox (brief mode; a shared mailbox runs in actions mode);
 *   - not a reply candidate: the thread carries no needs-reply flag and no
 *     pending classification;
 *   - no item a new message could move: none open (unclear and proposed
 *     included) and none closed within the lookback, since interpretation
 *     may reopen, complete or supersede those;
 *   - nothing else in flight in the thread: no other outstanding source (an
 *     earlier run may be creating the item this message updates), no
 *     history walk still admitting pages, no wording matches scanning;
 *   - no response plan (a draft self-check reads the items);
 *   - eligible on its snapshot. An ineligible source is still run now: its
 *     run records a skip without a model call.
 *
 * Deferred sources are stored distinctly (`outstanding.deferSource`): not
 * outstanding, so the stale sweep and the history backfill leave them alone,
 * and counted in `threadBriefs.deferredSources`, which keeps the brief
 * `pending` (or partial) and tells the reader to ask `lazy.ensure`. Opening
 * the thread runs them ({@link resumeDeferredSources}).
 *
 * A deferred source never stays behind an eager one: when any later source of
 * the thread is interpreted eagerly (a reply candidate, a sent reply), its
 * earlier deferred sources are promoted and read first, oldest first
 * ({@link runDeferredPredecessors}, called by `run.ts#runInterpretation`).
 * So an eager run always reads the items its thread's earlier mail holds.
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { ActionCtx, MutationCtx, QueryCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import {
	interpretationSourceKey,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { mailboxScope } from '../mailbox/shared';
import { isInterpretationEligible } from './eligibility';
import { loadBriefRow, markBriefPending } from './briefRow';
import { deferSource, markOutstanding, runOf } from './outstanding';
import { loadInterpretSource } from './sources';
import { RUN_SPACING_MS } from './backfillSources';
import { CLOSED_STATUSES, recentlyClosedItems, threadItemsWithStatus } from './load';
import type { InterpretDeferReason } from '@owlat/shared/aiRouting';

type ReadCtx = Pick<QueryCtx, 'db'>;

/** The one reason today: the reader display is the only consumer left. */
const DISPLAY_ONLY: InterpretDeferReason = 'display_only';

/** Deferred sources one thread open starts at most; the rest wait for the next ask. */
export const RESUME_BATCH = 25;

/**
 * Whether the thread holds an item this message could move (D10 keeps
 * transitions eager): any open item (unclear and proposed ones included) or
 * one closed within the lookback, which is exactly the set interpretation
 * reads and may reopen, complete or supersede (`load.ts`
 * `loadPromptItemCandidates`). Bounded: one row per status.
 */
async function hasTransitionTargets(ctx: ReadCtx, ref: ThreadRef, now: number): Promise<boolean> {
	if ((await threadItemsWithStatus(ctx, ref, 'open', 1)).length > 0) return true;
	return (await recentlyClosedItems(ctx, ref, CLOSED_STATUSES, now, 1)).rows.length > 0;
}

/**
 * Whether a delivered Postbox message's interpretation has the reader
 * display as its only consumer (see the module doc). Reads only; the caller
 * defers.
 */
export async function isDisplayOnlyInterpretation(
	ctx: ReadCtx,
	message: Doc<'mailMessages'>
): Promise<boolean> {
	if (message.outbound !== undefined) return false;
	const thread = await ctx.db.get(message.threadId);
	if (!thread) return false;
	if (thread.needsReply !== undefined || thread.needsReplyPendingAt !== undefined) return false;
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox || mailboxScope(mailbox) === 'shared') return false;
	const ref: ThreadRef = { kind: 'mail', id: thread._id };
	const snapshot = await loadInterpretSource(ctx, { kind: 'mail', id: message._id });
	if (!snapshot) return false;
	if (!isInterpretationEligible(snapshot.eligibility, { direction: 'inbound' }).isEligible) {
		return false;
	}
	const brief = await loadBriefRow(ctx, ref);
	// Work still in flight in this thread: another source's run (it may be
	// creating the item this message updates; nothing would resume this one
	// when that item appears), a history walk still admitting pages, or
	// wording matches still scanning. The source itself is outstanding when
	// delivery captured it, so it is not counted.
	const otherOutstanding = (brief?.pendingSources ?? 0) - (snapshot.isOutstanding ? 1 : 0);
	if (otherOutstanding > 0 || brief?.historyState === 'pending') return false;
	if ((brief?.pendingMatchRuns ?? 0) > 0) return false;
	if (await hasTransitionTargets(ctx, ref, Date.now())) return false;
	const plan = await ctx.db
		.query('draftResponsePlans')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', thread._id))
		.first();
	return plan === null;
}

/**
 * Defer a captured Postbox source when its interpretation is display-only.
 * True when it was deferred (the caller then runs nothing).
 */
export async function deferIfDisplayOnly(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>
): Promise<boolean> {
	if (!(await isDisplayOnlyInterpretation(ctx, message))) return false;
	await deferSource(ctx, interpretationSourceKey({ kind: 'mail', id: message._id }), DISPLAY_ONLY);
	return true;
}

/**
 * The needs-reply classifier's question for a delivered message that is no
 * reply candidate (`mail/ai/needsReplyClassify.ts`): defer it, or run it now.
 */
export const deferDeliveredIfDisplayOnly = internalMutation({
	args: { mailMessageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<boolean> => {
		const message = await ctx.db.get(args.mailMessageId);
		return message ? deferIfDisplayOnly(ctx, message) : false;
	},
});

/**
 * Opening a thread runs its deferred sources (`lazy.ts`), whatever its history
 * state: each becomes outstanding again (`markOutstanding`) and is scheduled,
 * {@link RUN_SPACING_MS} apart. Returns how many were scheduled.
 */
export async function resumeDeferredSources(
	ctx: MutationCtx,
	ref: Extract<ThreadRef, { kind: 'mail' }>
): Promise<number> {
	const deferred = await ctx.db
		.query('interpretSources')
		.withIndex('by_mail_thread_and_deferred', (q) =>
			q.eq('mailThreadId', ref.id).eq('isDeferred', true)
		)
		.take(RESUME_BATCH);
	let scheduled = 0;
	for (const snapshot of deferred) {
		await markOutstanding(ctx, snapshot.sourceKey);
		await ctx.scheduler.runAfter(scheduled * RUN_SPACING_MS, runOf(snapshot.source), {
			source: snapshot.source,
		});
		scheduled++;
	}
	if (scheduled > 0) await markBriefPending(ctx, ref);
	return scheduled;
}

/** Whether a mail thread has deferred sources waiting for an open. */
export function hasDeferredSources(brief: Pick<Doc<'threadBriefs'>, 'deferredSources'> | null) {
	return (brief?.deferredSources ?? 0) > 0;
}

/** Deferred predecessors one eager run reads first, at most. */
export const PREDECESSOR_BATCH = 50;

/** A Postbox message's place in its thread: arrival time, then creation. */
function threadOrder(message: Doc<'mailMessages'>): [number, number] {
	return [message.receivedAt, message._creationTime];
}

function isBefore(a: [number, number], b: [number, number]): boolean {
	return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/**
 * Sol r2 F1: a source turning eager promotes every EARLIER deferred source of
 * its thread. An earlier message (an invoice) can hold the item a later one
 * cancels or completes; the later run reads only items that exist, so the
 * earlier message must be folded first. Each promoted source becomes
 * outstanding again (so a run that dies is re-run by the sweep) and is
 * returned oldest first, for the caller to interpret in that order before
 * its own source. Inbound and outbound (sent) Postbox sources alike; Team
 * Inbox threads never defer.
 */
export const promoteDeferredPredecessors = internalMutation({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args): Promise<InterpretationSource[]> => {
		if (args.source.kind !== 'mail' && args.source.kind !== 'outboundMail') return [];
		const message = await ctx.db.get(args.source.id);
		if (!message) return [];
		const deferred = await ctx.db
			.query('interpretSources')
			.withIndex('by_mail_thread_and_deferred', (q) =>
				q.eq('mailThreadId', message.threadId).eq('isDeferred', true)
			)
			.take(PREDECESSOR_BATCH);
		const ownKey = interpretationSourceKey(args.source);
		const earlier: { source: InterpretationSource; order: [number, number] }[] = [];
		for (const snapshot of deferred) {
			if (snapshot.sourceKey === ownKey) continue;
			if (snapshot.source.kind !== 'mail' && snapshot.source.kind !== 'outboundMail') continue;
			const row = await ctx.db.get(snapshot.source.id);
			if (!row || !isBefore(threadOrder(row), threadOrder(message))) continue;
			await markOutstanding(ctx, snapshot.sourceKey);
			earlier.push({ source: snapshot.source, order: threadOrder(row) });
		}
		if (earlier.length > 0) await markBriefPending(ctx, { kind: 'mail', id: message.threadId });
		return earlier
			.sort((a, b) => (isBefore(a.order, b.order) ? -1 : isBefore(b.order, a.order) ? 1 : 0))
			.map((e) => e.source);
	},
});

/**
 * Before an eager interpretation of `source`: promote its thread's earlier
 * deferred sources and interpret them, oldest first, with `run` (the run
 * itself; passed in so this module never imports the Node runtime). Fail-soft:
 * a failed promotion interprets the source as before, and a promoted source
 * whose run fails stays outstanding for the sweep.
 */
export async function runDeferredPredecessors(
	ctx: Pick<ActionCtx, 'runMutation'>,
	source: InterpretationSource,
	run: (source: InterpretationSource) => Promise<unknown>
): Promise<void> {
	// Team Inbox threads never defer: no round trip for them.
	if (source.kind !== 'mail' && source.kind !== 'outboundMail') return;
	let earlier: InterpretationSource[] = [];
	try {
		earlier = await ctx.runMutation(internal.mail.interpret.defer.promoteDeferredPredecessors, {
			source,
		});
	} catch {
		return;
	}
	for (const predecessor of earlier) await run(predecessor);
}
