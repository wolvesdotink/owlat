/**
 * The Reply Queue's pending marker (`mailThreads.needsReplyPendingAt`): how a
 * classification that never reached a verdict gets another run.
 *
 * Ingest stamps the marker. The classify action (mail/ai/needsReplyClassify.ts)
 * writes its heuristic baseline first, which re-stamps the marker instead of
 * clearing it, and only the model's verdict clears it. A run that ends without
 * one on purpose (AI off or rate-limited, a model error, a result that failed
 * to persist) settles the marker itself through `settlePending`, so it is not
 * retried. A run that simply stops — the backend OOM-killed mid-action, a
 * deploy restart, the action time limit — leaves it set, and `sweepPending`
 * schedules the classification again. Without that, a thread whose run died
 * after the baseline stayed `heuristic` for good: no verdict and, since
 * draft-on-arrival waits for the model's verdict, no draft.
 *
 * Split out of `mail/needsReply.ts`, which is at the domain-file size gate.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';

/**
 * Pending markers older than this are considered lost and re-scheduled. A
 * queued run has not stamped the marker yet, and on a busy self-hosted
 * deployment a scheduled action can wait several minutes for an action slot.
 * At five minutes the sweep read a queued run as lost and scheduled a second
 * one, which drafted twice and deepened the very backlog that delayed the
 * first. A run that started re-stamped the marker with its baseline and ends
 * within the ten-minute action limit. Past that limit plus headroom, a marker
 * this old really was lost (a restart, a dropped job, a killed run).
 */
export const SWEEP_MIN_AGE_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 20;

/**
 * How many times the sweep re-schedules one thread before it gives up and
 * leaves the heuristic flag for a human. A thread whose run is killed every
 * time (one that alone exhausts the backend's memory) would otherwise be
 * classified, and billed, every quarter hour for good.
 */
export const MAX_SWEEP_RETRIES = 3;

/**
 * Reconcile cron: re-schedule classification for threads whose run never
 * reached a verdict (lost scheduled action, killed or timed-out run). Bounded
 * per tick; bumping `needsReplyPendingAt` keeps a failing thread from being
 * re-picked every tick while it ages back into the window, and past
 * {@link MAX_SWEEP_RETRIES} the marker is dropped instead.
 */
export const sweepPending = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const cutoff = now - SWEEP_MIN_AGE_MS;
		// `needsReplyPendingAt` is optional: on the index, `undefined` rows sort
		// before every number, so lower-bound with gt(0) (same trick as the
		// snooze sweep) to skip the never-pending majority.
		const stale: Doc<'mailThreads'>[] = await ctx.db
			.query('mailThreads')
			.withIndex('by_needs_reply_pending', (q) =>
				q.gt('needsReplyPendingAt', 0).lte('needsReplyPendingAt', cutoff)
			)
			.take(SWEEP_BATCH);
		let rescheduled = 0;
		let abandoned = 0;
		for (const thread of stale) {
			const retries = (thread.needsReplyRetryCount ?? 0) + 1;
			if (retries > MAX_SWEEP_RETRIES) {
				await ctx.db.patch(thread._id, {
					needsReplyPendingAt: undefined,
					needsReplyRetryCount: undefined,
				});
				abandoned += 1;
				continue;
			}
			await ctx.db.patch(thread._id, { needsReplyPendingAt: now, needsReplyRetryCount: retries });
			await ctx.scheduler.runAfter(0, internal.mail.ai.needsReplyClassify.classifyThread, {
				threadId: thread._id,
			});
			rescheduled += 1;
		}
		return { rescheduled, abandoned };
	},
});

/**
 * End a classify run that finished without a verdict on purpose: the AI gate
 * refused (AI off, rate-limited), the model failed or answered badly, or the
 * result did not persist. Clears the pending marker the baseline left, so the
 * sweep does not retry an outcome that would only repeat. Stale-guarded like
 * `applyResult`: once a newer message arrived, the marker is that message's,
 * and its own run settles it.
 */
export const settlePending = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		/** thread.latestMessageId observed by getThreadContext. */
		expectedLatestMessageId: v.optional(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread || thread.needsReplyPendingAt === undefined) return;
		if (
			args.expectedLatestMessageId !== undefined &&
			thread.latestMessageId !== undefined &&
			thread.latestMessageId !== args.expectedLatestMessageId
		) {
			return;
		}
		await ctx.db.patch(args.threadId, {
			needsReplyPendingAt: undefined,
			needsReplyRetryCount: undefined,
		});
	},
});
