/**
 * Campaign send job (module) — the checkpoint store + mutations for the
 * **checkpointed campaign-send walker**. Mirrors the integration-import
 * walker's `getImportById` / `commitIntegrationPage` / `completeImport`
 * internal mutations: the orchestrator action (`emails.resolveCampaignPage`)
 * stays in its `'use node'` file and reaches into these non-node mutations to
 * read and patch the `campaignSendJobs` row.
 *
 * One row per campaign send walk (`schema/campaigns.ts`). ALL send modes —
 * plain, A/B test cohort, and A/B winner remainder — flow through it:
 *   - PREP (`campaigns/send.ts:startCampaignSend`) opens it through
 *     `openSendJob` inside its one commit (`campaigns/sendCommit.ts`), with
 *     `phase: 'resolving'`, `cursor: ''` and a `variantMode`, and schedules the
 *     first hop in the same transaction.
 *   - Each hop reads it via `getSendJob` and plans one page (classified by
 *     the job's `variantMode` + deterministic per-contact hash); its one
 *     commit (`campaigns/walkerCommit.ts`) inserts and enqueues the page and
 *     calls `advanceJob` to patch `cursor`/counters and (on the last page)
 *     flip `phase: 'done'`.
 *   - For the second A/B phase, `sendCampaignWinnerToRemainder`'s commit calls
 *     `openSendJob` AGAIN to RESET the same row to a fresh `ab_winner` walk
 *     (`winningVariant` set, `phase: 'resolving'`, `cursor: ''`) and re-drives
 *     it over the audience, enqueuing only the held-back remainder.
 *   - The completion guard in `lifecycle.ts` refuses to flip the campaign to
 *     `sent` while the row is still `'resolving'`.
 *
 * These are `internalMutation`/`internalQuery` (server-only) — no auth floor;
 * the only callers are the orchestrator's own scheduled hops.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, readActiveWorkspaceDeletion } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { audienceValidator, type StoredAudience } from './audience';
import { abVariantValidator } from '../lib/literalValidators';
import { wasLatestSendPrepared } from './sendPlanning';

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
 * Nothing in this release calls it: PREP opens the first-phase job inside its
 * own commit and the winner phase resets it inside `commitWinnerRemainder`
 * (both through `openSendJob`). A call here comes from a preparation or
 * winner-phase action of the previous release still running during a deploy,
 * and it must not reset a walk this release already started for the same
 * send: a first-phase call returns the prepared job unchanged (see
 * `findPreparedSendJob`), and a winner-phase call returns an `ab_winner` walk
 * for the same winner unchanged. Remove after release N+1.
 */
export const createSendJob = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		audience: audienceValidator,
		// Defaults to `plain` so the non-A/B caller need not pass it.
		variantMode: v.optional(variantModeValidator),
		testFraction: v.optional(v.number()),
		splitPercentage: v.optional(v.number()),
		winningVariant: v.optional(abVariantValidator),
	},
	handler: async (ctx, args) => {
		if (args.variantMode !== 'ab_winner') {
			const prepared = await findPreparedSendJob(ctx, args.campaignId);
			if (prepared) return prepared._id;
		} else {
			const job = await readSendJob(ctx, args.campaignId);
			if (job?.variantMode === 'ab_winner' && job.winningVariant === args.winningVariant) {
				return job._id;
			}
		}
		return await openSendJob(ctx, { ...args, now: Date.now() });
	},
});

/** The campaign's send job row, or null. */
export async function readSendJob(
	ctx: QueryCtx,
	campaignId: Id<'campaigns'>
): Promise<Doc<'campaignSendJobs'> | null> {
	return await ctx.db
		.query('campaignSendJobs')
		.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
		.first();
}

/**
 * The job of the campaign's latest send when that send was prepared, also
 * once it finished (`wasLatestSendPrepared`), else null. The mutations a
 * preparation action of the previous release calls one by one check it, so
 * one that resumes after the new preparation committed the same send cannot
 * overwrite what that commit wrote, or reset the walk it started, even after
 * the walk completed.
 */
export async function findPreparedSendJob(
	ctx: QueryCtx,
	campaignId: Id<'campaigns'>
): Promise<Doc<'campaignSendJobs'> | null> {
	const campaign = await ctx.db.get(campaignId);
	if (!campaign) return null;
	const job = await readSendJob(ctx, campaignId);
	return wasLatestSendPrepared(campaign, job) ? job : null;
}

/** What one send walk starts from; `createSendJob`'s arguments plus the clock. */
export interface SendJobStart {
	readonly campaignId: Id<'campaigns'>;
	readonly audience: StoredAudience;
	readonly variantMode?: 'plain' | 'ab_test' | 'ab_winner';
	readonly testFraction?: number;
	readonly splitPercentage?: number;
	readonly winningVariant?: 'A' | 'B';
	/** Stamped on `startedAt`/`updatedAt`. */
	readonly now: number;
}

/**
 * `createSendJob` inside the caller's transaction: the send preparation commit
 * opens the job in the same mutation that moves the campaign to `sending`.
 */
export async function openSendJob(
	ctx: MutationCtx,
	args: SendJobStart
): Promise<Id<'campaignSendJobs'>> {
	const { now } = args;
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
		isPlanTruncated: undefined,
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
}

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
 * `advanceJob` for a page hop of the previous release still running during
 * the deploy; this release advances inside its page commit. That commit may
 * already have committed the same page (a re-driven hop), so a job that
 * already sits at the page's `nextCursor`, or is `done` on the last page, is
 * returned as it is instead of counting the page twice. Remove after release
 * N+1.
 */
export const advanceSendJob = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		nextCursor: v.union(v.string(), v.null()),
		pageEnqueued: v.number(),
		pageCandidates: v.number(),
	},
	handler: async (ctx, { campaignId, ...page }) => {
		const job = await readSendJob(ctx, campaignId);
		if (job && (page.nextCursor === null ? job.phase === 'done' : job.cursor === page.nextCursor)) {
			const { phase, enqueuedCount, totalCandidates } = job;
			return { phase, enqueuedCount, totalCandidates };
		}
		return await advanceJob(ctx, campaignId, page);
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
export async function advanceJob(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	page: { nextCursor: string | null; pageEnqueued: number; pageCandidates: number }
): Promise<{
	phase: 'resolving' | 'done';
	enqueuedCount: number;
	totalCandidates: number;
} | null> {
	const job = await readSendJob(ctx, campaignId);
	if (!job) return null;

	const enqueuedCount = job.enqueuedCount + page.pageEnqueued;
	const totalCandidates = job.totalCandidates + page.pageCandidates;
	const phase: 'resolving' | 'done' = page.nextCursor === null ? 'done' : 'resolving';

	await ctx.db.patch(job._id, {
		cursor: page.nextCursor ?? job.cursor,
		enqueuedCount,
		totalCandidates,
		phase,
		updatedAt: Date.now(),
	});

	return { phase, enqueuedCount, totalCandidates };
}

/**
 * Checkpoint the MULTI-DAY SEND PLAN's day state.
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
export const sendPlanStateValidator = v.object({
	planDayKey: v.string(),
	enqueuedToday: v.number(),
	planDayIndex: v.number(),
	planTotalDays: v.number(),
	// Required alongside the length, not optional: both come from the same
	// recomputed schedule, and a checkpoint carrying one without the other is a
	// plan whose honesty depends on which hop last wrote it.
	isPlanTruncated: v.boolean(),
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
	handler: async (ctx, args): Promise<{ isResumeAlreadyScheduled: boolean }> =>
		await writeSendPlanDay(ctx, args.campaignId, args.plan, args.resumeAt),
});

/** `recordSendPlanDay` inside the caller's transaction (the walker's page commit). */
export async function writeSendPlanDay(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	plan: Infer<typeof sendPlanStateValidator>,
	resumeAt: number | undefined
): Promise<{ isResumeAlreadyScheduled: boolean }> {
	const job = await readSendJob(ctx, campaignId);
	if (!job) return { isResumeAlreadyScheduled: false };
	// The row was ALREADY parked for exactly this window, so a hop for it is
	// already pending and a second one would double every counter it writes.
	const isResumeAlreadyScheduled = resumeAt !== undefined && job.resumeAt === resumeAt;
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
	const updatedAt =
		resumeAt !== undefined && Number.isFinite(resumeAt) && resumeAt > now ? resumeAt : now;
	await ctx.db.patch(job._id, {
		planDayKey: plan.planDayKey,
		enqueuedToday: plan.enqueuedToday,
		planDayIndex: plan.planDayIndex,
		planTotalDays: plan.planTotalDays,
		isPlanTruncated: plan.isPlanTruncated,
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
		resumeAt,
		updatedAt,
	});
	return { isResumeAlreadyScheduled };
}

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
 *
 * Not while a workspace deletion runs: it cancels the walk's hops, so every
 * resolving walk looks stranded, and a re-driven hop would only have its first
 * write refused by the fence. The deletion removes the job anyway.
 */
export const redriveStuckSendJobs = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ redriven: number }> => {
		if (await readActiveWorkspaceDeletion(ctx.db)) return { redriven: 0 };
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
