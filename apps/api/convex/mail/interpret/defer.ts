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
import {
	internalQuery,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../../_generated/server';
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
import { CLOSED_STATUSES, recentlyClosedItems, threadItemsWithStatus } from './load';
import type { InterpretDeferReason } from '@owlat/shared/aiRouting';

type ReadCtx = Pick<QueryCtx, 'db'>;

/** The one reason today: the reader display is the only consumer left. */
const DISPLAY_ONLY: InterpretDeferReason = 'display_only';

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
 * Opening a thread reads its deferred sources (`lazy.ts`), whatever its history
 * state. Only the NEWEST deferred source is scheduled, made outstanding (so the
 * stale sweep re-runs it if its run is lost); its run reads every older
 * deferred source first, oldest first ({@link runDeferredPredecessors}), and
 * then itself. Deferred sources are never scheduled side by side, so they are
 * always read in thread order. Returns how many runs were scheduled (0 or 1).
 */
export async function resumeDeferredSources(
	ctx: MutationCtx,
	ref: Extract<ThreadRef, { kind: 'mail' }>
): Promise<number> {
	let newest: { snapshot: Doc<'interpretSources'>; order: [number, number] } | null = null;
	for await (const snapshot of deferredOf(ctx, ref.id)) {
		const order = await orderOf(ctx, snapshot.source);
		if (order && (!newest || isBefore(newest.order, order))) newest = { snapshot, order };
	}
	if (!newest) return 0;
	await markOutstanding(ctx, newest.snapshot.sourceKey);
	await ctx.scheduler.runAfter(0, runOf(newest.snapshot.source), {
		source: newest.snapshot.source,
	});
	await markBriefPending(ctx, ref);
	return 1;
}

/** Whether a mail thread has deferred sources waiting for an open. */
export function hasDeferredSources(brief: Pick<Doc<'threadBriefs'>, 'deferredSources'> | null) {
	return (brief?.deferredSources ?? 0) > 0;
}

/**
 * Deferred predecessors one action reads before it hands the rest to a
 * rescheduled run of the same source (Sol r3 F1): the action's time limit
 * bounds what one run can do, not the thread.
 */
export const PREDECESSOR_BUDGET = 10;

/** How long a run waits before it looks again at a predecessor whose own run did not settle it. */
export const PREDECESSOR_RETRY_MS = 60_000;

/**
 * What a run returns when it rescheduled itself because earlier deferred
 * messages are still being read: nothing recorded, no projection (the Reply
 * Queue keeps its baseline), and the source stays outstanding.
 */
export function predecessorsPending() {
	return {
		status: 'skipped' as const,
		isReplayed: false,
		createdItemIds: [] as never[],
		errorCode: 'predecessors_pending',
	};
}

/** A Postbox message's place in its thread: arrival time, then creation. */
function isBefore(a: [number, number], b: [number, number]): boolean {
	return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function deferredOf(ctx: ReadCtx, threadId: Doc<'mailThreads'>['_id']) {
	return ctx.db
		.query('interpretSources')
		.withIndex('by_mail_thread_and_deferred', (q) =>
			q.eq('mailThreadId', threadId).eq('isDeferred', true)
		);
}

/** A Postbox source's thread order, or null when its message is gone (never blocks anything). */
async function orderOf(
	ctx: ReadCtx,
	source: InterpretationSource
): Promise<[number, number] | null> {
	if (source.kind !== 'mail' && source.kind !== 'outboundMail') return null;
	const row = await ctx.db.get(source.id);
	return row ? [row.receivedAt, row._creationTime] : null;
}

/**
 * The OLDEST deferred source of the thread that arrived before `source`, or
 * null. Reads every deferred source of the thread (the index has no time
 * order): a thread's deferred mail, never its whole history.
 */
export const oldestDeferredBefore = internalQuery({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args): Promise<InterpretationSource | null> => {
		if (args.source.kind !== 'mail' && args.source.kind !== 'outboundMail') return null;
		const message = await ctx.db.get(args.source.id);
		if (!message) return null;
		const own: [number, number] = [message.receivedAt, message._creationTime];
		let oldest: { source: InterpretationSource; order: [number, number] } | null = null;
		for await (const snapshot of deferredOf(ctx, message.threadId)) {
			const order = await orderOf(ctx, snapshot.source);
			if (!order || !isBefore(order, own)) continue;
			if (!oldest || isBefore(order, oldest.order)) oldest = { source: snapshot.source, order };
		}
		return oldest?.source ?? null;
	},
});

/**
 * D10 ordering (Sol r2 F1, r3): before a Postbox source is interpreted, every
 * EARLIER deferred source of its thread is read, oldest first. An earlier
 * message (an invoice) can hold the item a later one cancels or completes,
 * and a run reads only the items that exist.
 *
 * Crash-safe by construction, with no state of its own: each step takes the
 * oldest remaining deferred predecessor and runs it as it is; its deferred
 * state is cleared only when that run commits (`outstanding.settleSource`). A
 * run that dies leaves the rest deferred, in place, and the source's retry
 * (or the stale sweep, which re-runs the outstanding source and never a
 * deferred one) resumes at the next. A predecessor is never made
 * outstanding here, so nothing runs it out of order on its own.
 *
 * True when no earlier deferred source remains: the caller runs its source.
 * False when the budget ran out, or a predecessor's run did not settle it (it
 * waits for its category, or failed to commit): the source's run is
 * rescheduled to resume the loop, and the caller returns without running it.
 * `run` is the interpretation run itself, passed in so this module never
 * imports the Node runtime.
 */
export async function runDeferredPredecessors(
	ctx: Pick<ActionCtx, 'runQuery' | 'scheduler'>,
	source: InterpretationSource,
	run: (source: InterpretationSource) => Promise<unknown>,
	opts: { budget?: number } = {}
): Promise<boolean> {
	// Team Inbox threads never defer: no round trip for them.
	if (source.kind !== 'mail' && source.kind !== 'outboundMail') return true;
	const comeBack = async (delayMs: number) => {
		await ctx.scheduler.runAfter(delayMs, runOf(source), { source });
		return false;
	};
	let previous: string | null = null;
	for (let step = 0; ; step++) {
		let next: InterpretationSource | null;
		try {
			next = await ctx.runQuery(internal.mail.interpret.defer.oldestDeferredBefore, { source });
		} catch {
			return comeBack(PREDECESSOR_RETRY_MS);
		}
		if (!next) return true;
		const key = interpretationSourceKey(next);
		// Its run did not settle it: look again later rather than spin.
		if (key === previous) return comeBack(PREDECESSOR_RETRY_MS);
		if (step >= (opts.budget ?? PREDECESSOR_BUDGET)) return comeBack(0);
		await run(next);
		previous = key;
	}
}
