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
import { deferSource, markOutstanding, runOf, settleSource } from './outstanding';
import { sourceOrderKey } from './sourceOrder';
import { rootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import { loadInterpretSource } from './sources';
import { CLOSED_STATUSES, recentlyClosedItems, threadItemsWithStatus } from './load';
import type { InterpretDeferReason } from '@owlat/shared/aiRouting';
import type { Depth } from '@owlat/shared/arrival';
import { isReadOnArrivalOn } from './preferences';

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
 * Defer a captured Postbox source when its interpretation is display-only
 * and its owner turned read on arrival off (SPEC §2.1: with it on, the run
 * reads it now at the depth it chooses, `arrivalDecide.ts`). True when it was
 * deferred (the caller then runs nothing).
 */
export async function deferIfDisplayOnly(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>
): Promise<boolean> {
	if (!(await isDisplayOnlyInterpretation(ctx, message))) return false;
	const mailbox = await ctx.db.get(message.mailboxId);
	if (mailbox && (await isReadOnArrivalOn(ctx, mailbox.userId))) return false;
	return deferSource(ctx, interpretationSourceKey({ kind: 'mail', id: message._id }), DISPLAY_ONLY);
}

/**
 * The needs-reply classifier's question for a delivered message that is no
 * reply candidate (`mail/ai/needsReplyClassify.ts`): defer it, or run it now
 * (`mail/arrival/dispatch.ts`).
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
	const newest = await deferredInOrder(ctx, ref.id).order('desc').first();
	if (!newest) return 0;
	await markOutstanding(ctx, newest.sourceKey);
	// An open reads in full (read on arrival never lowers what an open reads).
	if (newest.source.kind === 'mail') {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: newest.source,
			depth: 'full',
		});
	} else {
		await ctx.scheduler.runAfter(0, runOf(newest.source), { source: newest.source });
	}
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
 * The root a predecessor read runs under: its own message's (`postbox:<id>`),
 * keeping the awaiting caller's deadline when there is one, so reading the
 * thread's earlier mail never outlasts the caller (ADR-0073).
 */
export function predecessorRoot(
	source: InterpretationSource,
	deadlineAt: number | undefined
): { root?: LlmRootContext } {
	if (deadlineAt === undefined) return {};
	return { root: { ...rootRequest('postbox', source.id), deadlineAt } };
}

/**
 * What a run returns when it rescheduled itself because earlier deferred
 * messages are still being read: nothing recorded, no projection (the Reply
 * Queue keeps its baseline), and the source stays outstanding.
 */
export function predecessorsPending(pending: { retryAt: number }) {
	return {
		status: 'skipped' as const,
		isReplayed: false,
		createdItemIds: [] as never[],
		errorCode: PREDECESSORS_PENDING,
		retryAt: pending.retryAt,
	};
}

/** The `errorCode` of {@link predecessorsPending}. */
export const PREDECESSORS_PENDING = 'predecessors_pending';

/**
 * How a run treats its thread's earlier deferred mail (`InterpretArgs.predecessors`):
 * absent reads them first and reschedules itself while some remain;
 * `caller_continues` reads them first but leaves the reschedule to the caller
 * (the Reply Queue classifier); `already_read` reads none (the loop selected
 * this source as the oldest left).
 */
export type PredecessorMode = 'caller_continues' | 'already_read';

/** A thread's deferred sources, in thread order (`sourceOrder.ts`; a legacy row without a key first). */
function deferredInOrder(ctx: ReadCtx, threadId: Doc<'mailThreads'>['_id']) {
	return ctx.db
		.query('interpretSources')
		.withIndex('by_mail_thread_deferred_order', (q) =>
			q.eq('mailThreadId', threadId).eq('isDeferred', true)
		);
}

/**
 * The OLDEST deferred source of the thread that arrived before `source`, or
 * null: one indexed read (Sol r4 F2), however long the backlog.
 */
export const oldestDeferredBefore = internalQuery({
	args: {
		source: interpretationSourceValidator,
		/** A full-read prerequisite's upgrade (`fullRead.ts`): upgradeable mail comes first too. */
		isUpgrade: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<InterpretationSource | null> => {
		if (args.source.kind !== 'mail' && args.source.kind !== 'outboundMail') return null;
		const message = await ctx.db.get(args.source.id);
		if (!message) return null;
		const ownKey = interpretationSourceKey(args.source);
		const key = sourceOrderKey(message);
		// The source itself is never its own predecessor, even as a keyless
		// (pre-key) deferred row, which sorts before every key: of the first
		// two rows below its key, the first that is not itself.
		const deferred = (
			await ctx.db
				.query('interpretSources')
				.withIndex('by_mail_thread_deferred_order', (q) =>
					q.eq('mailThreadId', message.threadId).eq('isDeferred', true).lt('sourceOrderKey', key)
				)
				.take(2)
		).find((row) => row.sourceKey !== ownKey);
		// Read on arrival (SPEC §2.3.4): a source that needs a full read (a sent
		// reply, mail that is not display-only, a full-read prerequisite's
		// upgrade) reads the thread's earlier gist-only or counted mail first,
		// the same way. Display-only mail never upgrades anything, and neither
		// does an open.
		const isUpgrading =
			args.isUpgrade === true ||
			args.source.kind === 'outboundMail' ||
			!(await isDisplayOnlyInterpretation(ctx, message));
		const upgradeable = isUpgrading
			? (
					await ctx.db
						.query('interpretSources')
						.withIndex('by_mail_thread_upgradeable_order', (q) =>
							q
								.eq('mailThreadId', message.threadId)
								.eq('isUpgradeable', true)
								.lt('sourceOrderKey', key)
						)
						.take(2)
				).find((row) => row.sourceKey !== ownKey)
			: undefined;
		const oldest =
			deferred && upgradeable
				? (deferred.sourceOrderKey ?? '') <= (upgradeable.sourceOrderKey ?? '')
					? deferred
					: upgradeable
				: (deferred ?? upgradeable);
		return oldest?.source ?? null;
	},
});

/**
 * A deferred predecessor whose message is gone can never be read, and would
 * hold every later source forever: its deferral is cleared (its snapshot is
 * left to the purge). True when it was released.
 */
export const releaseGoneDeferred = internalMutation({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args): Promise<boolean> => {
		if (args.source.kind !== 'mail' && args.source.kind !== 'outboundMail') return false;
		if (await ctx.db.get(args.source.id)) return false;
		await settleSource(ctx, interpretationSourceKey(args.source), 'recorded');
		return true;
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
 * Null when no earlier deferred source remains: the caller runs its source.
 * `{ retryAt }` when the budget ran out, or a predecessor's run did not
 * settle it (it waits for its category): the caller returns without running
 * its source, and the loop resumes at `retryAt`. By default this schedules
 * the source's own run; a caller that continues itself instead (the Reply
 * Queue classifier, which must apply the verdict) passes `caller_continues`.
 * `run` reads each selected predecessor in `already_read` mode, so it never
 * re-enters this selection (Sol r5). A predecessor whose message is gone is
 * released.
 * `run` is the interpretation run itself, passed in so this module never
 * imports the Node runtime.
 */
export async function runDeferredPredecessors(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'scheduler'>,
	source: InterpretationSource,
	run: (source: InterpretationSource) => Promise<unknown>,
	opts: {
		budget?: number;
		predecessors?: PredecessorMode;
		/** Carried into the source's own rescheduled run (a full read stays one). */
		depth?: Depth;
		isUpgrade?: boolean;
	} = {}
): Promise<{ retryAt: number } | null> {
	// Team Inbox threads never defer: no round trip for them. A predecessor the
	// loop selected is the oldest left: nothing older to read before it.
	if (source.kind !== 'mail' && source.kind !== 'outboundMail') return null;
	if (opts.predecessors === 'already_read') return null;
	const comeBack = async (delayMs: number) => {
		if (opts.predecessors !== 'caller_continues') {
			if (source.kind === 'mail') {
				await ctx.scheduler.runAfter(delayMs, internal.mail.interpret.run.interpretMessage, {
					source,
					...(opts.depth ? { depth: opts.depth } : {}),
					...(opts.isUpgrade ? { isUpgrade: true } : {}),
				});
			} else {
				await ctx.scheduler.runAfter(delayMs, runOf(source), { source });
			}
		}
		return { retryAt: Date.now() + delayMs };
	};
	const budget = opts.budget ?? PREDECESSOR_BUDGET;
	let previous: string | null = null;
	for (let reads = 0; ;) {
		let next: InterpretationSource | null;
		try {
			next = await ctx.runQuery(internal.mail.interpret.defer.oldestDeferredBefore, {
				source,
				...(opts.isUpgrade ? { isUpgrade: true } : {}),
			});
		} catch {
			return comeBack(PREDECESSOR_RETRY_MS);
		}
		if (!next) return null;
		const key = interpretationSourceKey(next);
		if (key === previous) {
			// Its run did not settle it. A message that is gone is released;
			// anything else (waiting for its category) is looked at again later.
			const isReleased = await ctx
				.runMutation(internal.mail.interpret.defer.releaseGoneDeferred, { source: next })
				.catch(() => false);
			if (!isReleased) return comeBack(PREDECESSOR_RETRY_MS);
			previous = null;
			continue;
		}
		if (reads >= budget) return comeBack(0);
		await run(next);
		reads++;
		previous = key;
	}
}
