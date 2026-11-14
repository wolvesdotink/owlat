/**
 * Campaign send hold (module): what the walker does, and what the campaign
 * shows, while the deployment's sending is suspended or banned.
 *
 * Abuse status was read only when a campaign started, so a multi-day plan kept
 * sending its remaining days after a suspension. The walker now asks before
 * every page (`campaigns/send.ts:resolveCampaignPage`) and the worker asks again
 * before every marketing envelope leaves (`delivery/marketingDispatchGate.ts`).
 * Both hold rather than fail, so a lift resumes the send without a manual
 * re-send. The decision is `pageDecision.ts:decideWalkHold`; this module loads
 * and writes around it.
 */

import { v } from 'convex/values';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { DAY_MS } from '../lib/constants';
import { getLive } from '../lib/softDelete';
import { readSendingHold, type SendingHold } from '../workspaces/abuseGate';
import { campaignsQuery } from './_helpers';
import { decideHopStart, decideWalkHold } from './pageDecision';
import { readSendJob } from './sendJob';

/** The hop's cheap pre-check: is marketing mail held right now? */
export const getSendHold = internalQuery({
	args: {},
	handler: async (ctx): Promise<SendingHold | null> => await readSendingHold(ctx.db),
});

/** What `holdSendWalk` did, mapped onto the hop's result by the action. */
type WalkHoldOutcome = 'held' | 'expired' | 'resumed' | 'stale';

/**
 * Hold the walk, or end it once the hold has outlasted the delivery deadline.
 *
 * Authoritative: the hop decided from reads that may have moved, so this
 * re-reads the job and the status. A lift that landed meanwhile schedules the
 * next hop now. The hold writes `resumeAt`, so the stuck-walk watchdog leaves
 * the row alone, and only the hop that owns the pending re-check schedules the
 * next one: a second chain (a re-drive overlapping it) finds a re-check already
 * pending and stops, so a long hold cannot multiply its hops.
 */
export const holdSendWalk = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		/** The job the hop read. */
		read: v.object({ startedAt: v.number(), cursor: v.string() }),
	},
	handler: async (ctx, { campaignId, read }): Promise<WalkHoldOutcome> => {
		const start = decideHopStart(await readSendJob(ctx, campaignId), await ctx.db.get(campaignId));
		if (start.kind === 'stop') return 'stale';
		const { job } = start;
		if (job.startedAt !== read.startedAt || job.cursor !== read.cursor) return 'stale';

		const now = Date.now();
		const decision = decideWalkHold({ job, hold: await readSendingHold(ctx.db), now });
		if (decision.kind === 'walk') {
			await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, { campaignId });
			return 'resumed';
		}
		if (decision.kind === 'expire') {
			await ctx.db.patch(job._id, {
				phase: 'done',
				holdExpiredAt: now,
				resumeAt: undefined,
				updatedAt: now,
			});
			return 'expired';
		}
		if (job.resumeAt !== undefined && job.resumeAt > now) return 'held';
		await ctx.db.patch(job._id, {
			holdStartedAt: decision.holdStartedAt,
			resumeAt: decision.resumeAt,
			// Out of the watchdog's stale range until the re-check, as a park is.
			updatedAt: decision.resumeAt,
		});
		await ctx.scheduler.runAt(decision.resumeAt, internal.campaigns.send.resolveCampaignPage, {
			campaignId,
		});
		return 'held';
	},
});

/**
 * The campaign's hold as the report shows it:
 *   - `held`: the campaign is sending and marketing mail is held because the
 *     deployment is suspended or banned. `since` is when the walk was first
 *     held, absent when only already-enqueued mail is waiting in the worker.
 *   - `stopped`: the hold outlasted the delivery deadline and the walk ended;
 *     recipients it had not reached were not mailed.
 */
export type CampaignSendHold =
	| { kind: 'held'; status: SendingHold['status']; since?: number; holdDays: number }
	| { kind: 'stopped'; at: number; holdDays: number };

/** How long a hold lasts before held mail is given up, in whole days, for the copy. */
const HOLD_DAYS = Math.round(GOVERNED_MTA_MAX_MESSAGE_AGE_MS / DAY_MS);

export function campaignSendHold(input: {
	readonly campaign: Pick<Doc<'campaigns'>, 'status'>;
	readonly job: Pick<Doc<'campaignSendJobs'>, 'holdStartedAt' | 'holdExpiredAt'> | null;
	readonly hold: SendingHold | null;
}): CampaignSendHold | null {
	const { job } = input;
	if (job?.holdExpiredAt !== undefined) {
		return { kind: 'stopped', at: job.holdExpiredAt, holdDays: HOLD_DAYS };
	}
	if (input.campaign.status !== 'sending' || input.hold === null) return null;
	return {
		kind: 'held',
		status: input.hold.status,
		...(job?.holdStartedAt !== undefined ? { since: job.holdStartedAt } : {}),
		holdDays: HOLD_DAYS,
	};
}

// all-members: the hold notice on the campaign report, the same member-visible
// surface as the send plan line beside it (see sendPlanQueries.ts).
export const getCampaignSendHold = campaignsQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<CampaignSendHold | null> => {
		const campaign = await getLive(ctx, args.campaignId);
		if (!campaign) return null;
		return campaignSendHold({
			campaign,
			job: await readSendJob(ctx, args.campaignId),
			hold: await readSendingHold(ctx.db),
		});
	},
});
