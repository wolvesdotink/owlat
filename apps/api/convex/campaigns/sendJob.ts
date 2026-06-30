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
import { audienceValidator } from './audience';

const variantModeValidator = v.union(
	v.literal('plain'),
	v.literal('ab_test'),
	v.literal('ab_winner'),
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
		args,
	): Promise<{ phase: 'resolving' | 'done'; enqueuedCount: number; totalCandidates: number } | null> => {
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
