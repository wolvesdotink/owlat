/**
 * Campaign send job (module) — the checkpoint store + mutations for the
 * **checkpointed campaign-send walker**. Mirrors the integration-import
 * walker's `getImportById` / `updateImportProgress` / `completeImport`
 * internal mutations: the orchestrator action (`emails.resolveCampaignPage`)
 * stays in its `'use node'` file and reaches into these non-node mutations to
 * read and patch the `campaignSendJobs` row.
 *
 * One row per campaign send walk (`schema/campaigns.ts`). ALL send modes —
 * plain, A/B test cohort, and A/B winner remainder — flow through it:
 *   - PREP (`emails.startCampaignSend`) inserts it via `createSendJob`
 *     (`phase: 'resolving'`, `cursor: ''`, a `variantMode`) and schedules the
 *     first hop.
 *   - Each hop reads it via `getSendJob`, enqueues one page (classified by the
 *     job's `variantMode` + deterministic per-contact hash), then calls
 *     `advanceSendJob` to patch `cursor`/counters and (on the last page) flip
 *     `phase: 'done'`.
 *   - For the second A/B phase, `sendCampaignWinnerToRemainder` calls
 *     `createSendJob` AGAIN to RESET the same row to a fresh `ab_winner` walk
 *     (`winningVariant` set, `phase: 'resolving'`, `cursor: ''`) and re-drives
 *     it over the audience, enqueuing only the held-back remainder.
 *   - The completion guard in `lifecycle.ts` refuses to flip the campaign to
 *     `sent` while the row is still `'resolving'`.
 *
 * These are `internalMutation`/`internalQuery` (server-only) — no auth floor;
 * the only callers are the orchestrator's own scheduled hops.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import { audienceValidator } from './audience';

const variantModeValidator = v.union(
	v.literal('plain'),
	v.literal('ab_test'),
	v.literal('ab_winner')
);

/**
 * Open (or RESET) the checkpoint row for one send walk. At most one row per
 * campaign (`by_campaign`): a re-fire (a later `→ sending` transition, or the
 * second A/B phase) RESETS the existing row to a fresh walk (`phase:
 * 'resolving'`, `cursor: ''`, counters 0, supplied mode + Audience snapshot)
 * rather than resuming the prior, already-`done` walk.
 *
 * PREP fires this once per first-phase send (the lifecycle dedupes same-state
 * `sending → sending`); the winner-remainder action fires it once after winner
 * declaration. Both are single-fire per phase, so the reset cannot clobber an
 * in-flight walk of the SAME phase.
 */
export const createSendJob = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		audience: audienceValidator,
		// Defaults to `plain` so the non-A/B caller need not pass it.
		variantMode: v.optional(variantModeValidator),
		testFraction: v.optional(v.number()),
		splitPercentage: v.optional(v.number()),
		winningVariant: v.optional(v.union(v.literal('A'), v.literal('B'))),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const fields = {
			phase: 'resolving' as const,
			variantMode: args.variantMode ?? ('plain' as const),
			testFraction: args.testFraction,
			splitPercentage: args.splitPercentage,
			winningVariant: args.winningVariant,
			cursor: '',
			audience: args.audience,
			enqueuedCount: 0,
			totalCandidates: 0,
			// A RESET WIPES THE MULTI-DAY PLAN TOO. The row is reused for the second
			// A/B phase and for a re-fired send, and a plan carried over from the
			// previous walk would charge the new one for a day it never sent on — and,
			// worse, could report it as "day 3 of 4" before it had enqueued anybody.
			planDayKey: undefined,
			enqueuedToday: undefined,
			planDayIndex: undefined,
			planTotalDays: undefined,
			plannedTotal: undefined,
			isPlannedTotalLowerBound: undefined,
			isPlannedTotalCountAttempted: undefined,
			resumeAt: undefined,
			updatedAt: now,
		};
		const existing = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { ...fields, startedAt: now });
			return existing._id;
		}

		return await ctx.db.insert('campaignSendJobs', {
			campaignId: args.campaignId,
			...fields,
			startedAt: now,
		});
	},
});

/** Read the checkpoint row for a campaign (or null). Used at every hop entry
 *  to short-circuit a re-fired/stale walk. */
export const getSendJob = internalQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		return await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
	},
});

/**
 * Advance the checkpoint after one page was enqueued. Patches the cursor to
 * the page's `nextCursor` and sums the page counters. When `nextCursor` is
 * `null` the walk is done — flip `phase: 'done'`; the next reconcile then
 * completes the campaign (the completion guard stops blocking).
 *
 * Returns the new phase so the caller knows whether to reschedule.
 */
export const advanceSendJob = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		nextCursor: v.union(v.string(), v.null()),
		pageEnqueued: v.number(),
		pageCandidates: v.number(),
	},
	handler: async (
		ctx,
		args
	): Promise<{
		phase: 'resolving' | 'done';
		enqueuedCount: number;
		totalCandidates: number;
	} | null> => {
		const job = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (!job) return null;

		const enqueuedCount = job.enqueuedCount + args.pageEnqueued;
		const totalCandidates = job.totalCandidates + args.pageCandidates;
		const phase: 'resolving' | 'done' = args.nextCursor === null ? 'done' : 'resolving';

		await ctx.db.patch(job._id, {
			cursor: args.nextCursor ?? job.cursor,
			enqueuedCount,
			totalCandidates,
			phase,
			updatedAt: Date.now(),
		});

		return { phase, enqueuedCount, totalCandidates };
	},
});

/**
 * Checkpoint the MULTI-DAY SEND PLAN's day state (deliverability plan P3-7).
 *
 * Separate from `advanceSendJob` on purpose: the cursor advance is the walk's
 * CORRECTNESS checkpoint — a crash between the enqueue and that patch re-runs
 * the same page, and `createBatch`'s idempotency makes the re-run free — while
 * this is the day BUDGET, which the exhausted-day path has to write on a hop
 * that advanced no cursor at all. Folding the two together would mean either
 * writing a cursor that did not move or leaving the day's counter behind.
 *
 * Unlike `touchSendJob` it does NOT skip a `done` walk: the LAST hop of a plan
 * is the one that finishes it, and refusing to record its day would leave the
 * operator-facing progress line permanently one page short of the truth. The
 * `updatedAt` bump it carries is safe on a finished walk: the stuck-walk
 * watchdog matches on `phase === 'resolving'`, so a `done` row is not something
 * a fresh timestamp can drag back into the re-drive queue.
 *
 * IT ALSO OWNS THE `updatedAt` TOUCH for the hop that calls it, which is why the
 * exhausted-day path does not call `touchSendJob` as well: two mutations
 * patching the same field on the same row, two lines apart, is one write too
 * many on a path that already runs a query, a mutation and a scheduler call.
 *
 * AND IT OWNS THE PARK. `resumeAt` is what makes a deliberately parked walk —
 * one waiting up to ~24h for the next cap window — invisible to the stuck-walk
 * watchdog, which would otherwise re-drive it every five minutes and schedule a
 * duplicate resume hop each time. The returned `isResumeAlreadyScheduled` makes
 * the scheduling idempotent as well, so at most one hop is ever pending even if
 * the row is re-driven by something else.
 */
const sendPlanStateValidator = v.object({
	planDayKey: v.string(),
	enqueuedToday: v.number(),
	planDayIndex: v.number(),
	planTotalDays: v.number(),
	plannedTotal: v.optional(v.number()),
	isPlannedTotalLowerBound: v.optional(v.boolean()),
	isPlannedTotalCountAttempted: v.optional(v.boolean()),
});

export const recordSendPlanDay = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		plan: sendPlanStateValidator,
		/**
		 * Set when the walk is PARKED until this instant; omitted on a hop that
		 * made progress, which clears any previous park.
		 */
		resumeAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<{ isResumeAlreadyScheduled: boolean }> => {
		const job = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (!job) return { isResumeAlreadyScheduled: false };
		const { plan } = args;
		// The row was ALREADY parked for exactly this window, so a hop for it is
		// already pending and a second one would double every counter it writes.
		const isResumeAlreadyScheduled = args.resumeAt !== undefined && job.resumeAt === args.resumeAt;
		// A PARKED ROW LEAVES THE WATCHDOG'S STALE RANGE INSTEAD OF FILLING IT.
		// `redriveStuckSendJobs` pages `by_phase_updatedAt` and only then skips
		// parked rows, so a park stamped at park time sits inside `updatedAt <
		// cutoff` for the whole ~24h it waits — and enough concurrent parked walks
		// fill the page entirely, starving a genuinely stranded walk of its
		// re-drive. Stamping the RESUME INSTANT keeps the row out of the range
		// until its window opens, which is exactly when it becomes re-drivable
		// again. A resume instant that is not in the future cannot do that job, so
		// it falls back to the clock rather than back-dating the row.
		const now = Date.now();
		const parkedUntil = args.resumeAt;
		const updatedAt =
			parkedUntil !== undefined && Number.isFinite(parkedUntil) && parkedUntil > now
				? parkedUntil
				: now;
		await ctx.db.patch(job._id, {
			planDayKey: plan.planDayKey,
			enqueuedToday: plan.enqueuedToday,
			planDayIndex: plan.planDayIndex,
			planTotalDays: plan.planTotalDays,
			// Only ever SET, never cleared: the denominator is counted once per walk
			// and a later hop that skipped the count must not erase it. The
			// lower-bound flag travels with it so the two can never describe
			// different counts.
			...(plan.plannedTotal === undefined
				? {}
				: {
						plannedTotal: plan.plannedTotal,
						isPlannedTotalLowerBound: plan.isPlannedTotalLowerBound === true,
					}),
			// Also SET-ONLY: a walk that already attempted the count must never be
			// told to attempt it again by a later hop that simply skipped it.
			...(plan.isPlannedTotalCountAttempted === true ? { isPlannedTotalCountAttempted: true } : {}),
			resumeAt: args.resumeAt,
			updatedAt,
		});
		return { isResumeAlreadyScheduled };
	},
});

/**
 * Bump `updatedAt` on a send job WITHOUT advancing the cursor. Called by a hop
 * that intentionally defers itself with its own backoff reschedule (the
 * fail-closed no-provider path) rather than making forward progress: touching
 * `updatedAt` marks the row as "a live self-reschedule chain still owns this
 * walk" so the `redriveStuckSendJobs` watchdog does NOT pile a second re-drive
 * on top of the chain on every tick. The watchdog only re-drives once the row
 * goes stale again — i.e. once that self-reschedule chain has actually died.
 * No-ops if the row is gone or no longer `resolving` (a completed/cancelled
 * walk must not be dragged back to a live timestamp).
 */
export const touchSendJob = internalMutation({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<void> => {
		const job = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.first();
		if (!job || job.phase !== 'resolving') return;
		await ctx.db.patch(job._id, { updatedAt: Date.now() });
	},
});

// A send walk that has not advanced in this long while still `resolving` is
// treated as stranded and re-driven. `resolveCampaignPage` self-reschedules
// only at the END of a successful hop, so ANY throw before that (a transient
// runQuery/OCC error, or the fail-closed no-provider route check) stops the
// walk forever: the job stays `resolving`, the lifecycle completion guard
// refuses to flip the campaign to `sent`, and every recipient past the last
// committed cursor is silently dropped. A healthy hop bumps `updatedAt` within
// seconds per page, so a walk stale past this threshold has genuinely stopped.
const STUCK_SEND_JOB_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes without progress

/**
 * Watchdog: re-drive send walks that stalled mid-flight. Finds `campaignSendJobs`
 * rows still in `phase: 'resolving'` whose `updatedAt` is older than the
 * staleness threshold and re-schedules `resolveCampaignPage` for each, resuming
 * the walk from its committed cursor. Safe to fire against a walk that is not
 * actually stuck: `resolveCampaignPage` re-reads the checkpoint and short-circuits
 * a `done`/cancelled walk, and `createBatch` is idempotent (a re-run of the same
 * page inserts zero duplicate rows), so a resume can neither drop nor duplicate
 * recipients. Called by the `reconcile stuck campaign sends` cron.
 *
 * A DELIBERATELY PARKED WALK IS NOT A STUCK ONE. The multi-day send plan parks a
 * walk whose day budget is spent until the next cap window — up to ~24h, far
 * past this threshold — with its own resume hop already scheduled. Re-driving it
 * would not just be pointless: each re-drive would park it again and schedule
 * ANOTHER hop at the same instant, so a day of parking would accumulate a
 * scheduler storm of duplicate hops that all fire together at the UTC boundary
 * and apply the same page's counters over and over.
 *
 * TWO THINGS KEEP A PARKED ROW OUT OF THE WAY, and the order matters. The park
 * stamps `updatedAt` AT THE RESUME INSTANT (`recordSendPlanDay`), so the row
 * leaves the `updatedAt < cutoff` range entirely rather than sitting in it for a
 * day — which is what stops a crowd of parked walks filling this page and
 * starving a genuinely stranded one of its re-drive. The `resumeAt` test below
 * is the belt to that braces: it also covers rows parked before that rule
 * existed. Both are cleared by the first hop that makes progress, so a park that
 * never wakes up is still re-driven once its instant has passed.
 */
export const redriveStuckSendJobs = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ redriven: number }> => {
		const now = Date.now();
		const cutoff = now - STUCK_SEND_JOB_THRESHOLD_MS;

		const stuck = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_phase_updatedAt', (q) => q.eq('phase', 'resolving').lt('updatedAt', cutoff))
			.take(50);

		let redriven = 0;
		for (const job of stuck) {
			if (job.resumeAt !== undefined && job.resumeAt > now) continue;
			redriven += 1;
			await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, {
				campaignId: job.campaignId,
			});
		}

		return { redriven };
	},
});
