/**
 * Campaign send walker commits (module) — the ONE write of a page hop of
 * `resolveCampaignPage` (`campaigns/send.ts`).
 *
 * The hop reads the job, the audience page, the route and each bucket's
 * content, and decides who goes out when; this mutation then writes all of it
 * in a single transaction: the page's `emailSends` rows, the enqueue chunks
 * for exactly the rows it inserted, the daily send count, the cursor advance,
 * the day's plan line, and either the next hop or, on an empty audience, the
 * campaign's completion. A hop that dies before its commit leaves the page
 * unwritten and the cursor where it was, so the re-driven hop sends it whole;
 * one that dies after it left nothing half done.
 *
 * The commit re-checks the job the hop read: the same walk (`startedAt`, reset
 * by a re-fired send or the winner phase) at the same cursor, still
 * `resolving`, for a campaign still `sending`. A hop that lost that race (a
 * watchdog re-drive overlapping a slow hop, a cancelled send, a walk reset
 * under it) writes nothing and schedules nothing; the hop that won owns the
 * walk.
 */

import { v, type Infer } from 'convex/values';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { sendTimeGroupValidator } from '../lib/validators/sendTime';
import { campaignEnqueueEnvelopeFields, type CampaignEnqueueEmail } from '../delivery/enqueue';
import { insertCampaignSends } from '../delivery/sends';
import { transitionCampaign } from './lifecycle';
import { decideHopStart, decidePageEnd } from './pageDecision';
import { bumpDailySendCount } from './sendQueries';
import { advanceJob, readSendJob, sendPlanStateValidator, writeSendPlanDay } from './sendJob';
import { isEmptyAudienceComplete } from './sendPlanning';

const LIFECYCLE_USER_ORCHESTRATOR = 'system:orchestrator';

/**
 * Recipients handed to ONE `enqueueCampaignEmails` mutation.
 *
 * That mutation writes at least one workpool document AND one
 * `sendAssignments` row per recipient in a single transaction, so an
 * unchunked batch walks toward Convex's per-transaction write ceiling. Every
 * group (immediate, per timezone, per planned instant) is chunked to this
 * size; an unchunked timezone group is the whole campaign in one mutation for
 * a single-zone audience.
 */
const CAMPAIGN_ENQUEUE_CHUNK_SIZE = 50;

const pageRecipientValidator = v.object({
	contactId: v.id('contacts'),
	email: v.string(),
	firstName: v.optional(v.string()),
	lastName: v.optional(v.string()),
	engagementScore: v.optional(v.number()),
	personalizedSubject: v.string(),
	// Send-time optimization's arm, set only for an optimized campaign.
	sendTimeGroup: v.optional(sendTimeGroupValidator),
});

/**
 * One (language, variant) bucket of a page: the enqueue fields its chunks
 * share and its recipients, grouped by when they go out (`sendAt` absent:
 * now). The groups are the timezone or send-time instants the hop resolved.
 */
const pageBucketValidator = v.object({
	envelope: v.object(campaignEnqueueEnvelopeFields),
	groups: v.array(
		v.object({ sendAt: v.optional(v.number()), recipients: v.array(pageRecipientValidator) })
	),
});

export type PageBucket = Infer<typeof pageBucketValidator>;

/** Outcome of one page commit, mapped onto the hop's result by the action. */
export type CampaignPageCommit =
	| { kind: 'committed'; done: boolean; pageEnqueued: number }
	| { kind: 'stale'; reason: string };

export const commitCampaignPage = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		/** The job the hop read its page at. */
		read: v.object({ startedAt: v.number(), cursor: v.string() }),
		buckets: v.array(pageBucketValidator),
		page: v.object({ nextCursor: v.union(v.string(), v.null()), pageCandidates: v.number() }),
		/** Today's plan line as it stood before this page. */
		planDay: sendPlanStateValidator,
	},
	handler: async (ctx, args): Promise<CampaignPageCommit> => {
		const { campaignId, read } = args;
		const start = decideHopStart(await readSendJob(ctx, campaignId), await ctx.db.get(campaignId));
		if (start.kind === 'stop') {
			return { kind: 'stale', reason: 'The walk stopped during the hop' };
		}
		if (start.job.startedAt !== read.startedAt || start.job.cursor !== read.cursor) {
			return { kind: 'stale', reason: 'Another hop moved the walk during this one' };
		}

		let pageEnqueued = 0;
		for (const bucket of args.buckets) {
			pageEnqueued += await enqueueBucket(ctx, campaignId, bucket);
		}

		const end = decidePageEnd({
			page: args.page,
			pageEnqueued,
			slice: { enqueuedToday: args.planDay.enqueuedToday },
			planCheckpoint: args.planDay,
		});
		if (end.dailySendCount !== undefined) await bumpDailySendCount(ctx, end.dailySendCount);
		const advanced = await advanceJob(ctx, campaignId, end.advance);
		await writeSendPlanDay(ctx, campaignId, end.planDay, undefined);

		if (!end.isLastPage) {
			await ctx.scheduler.runAfter(0, internal.campaigns.send.resolveCampaignPage, { campaignId });
			return { kind: 'committed', done: false, pageEnqueued };
		}

		// Last page: complete NOW only on the empty-audience fast path; otherwise
		// the per-send completion callback / reconcile cron completes it once the
		// last queued send clears (the guard no longer blocks once phase is done).
		if (isEmptyAudienceComplete(start.job.variantMode ?? 'plain', advanced)) {
			await transitionCampaign(
				ctx,
				campaignId,
				{ to: 'sent', at: Date.now() },
				LIFECYCLE_USER_ORCHESTRATOR
			);
		}
		return { kind: 'committed', done: true, pageEnqueued };
	},
});

/**
 * Insert one bucket's send rows and schedule the enqueue of exactly the rows
 * inserted now. `insertCampaignSends` skips a contact that already has a row
 * for the campaign: that row was enqueued in the transaction that inserted it,
 * so enqueueing it again would send twice. Returns the rows inserted.
 */
async function enqueueBucket(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	{ envelope, groups }: PageBucket
): Promise<number> {
	const created = await insertCampaignSends(
		ctx,
		groups.flatMap((group) =>
			group.recipients.map((recipient) => ({
				campaignId,
				contactId: recipient.contactId,
				contactEmail: recipient.email,
				contactFirstName: recipient.firstName,
				contactLastName: recipient.lastName,
				personalizedSubject: recipient.personalizedSubject,
				...(envelope.abVariant !== undefined ? { abVariant: envelope.abVariant } : {}),
				...(recipient.sendTimeGroup !== undefined
					? { sendTimeGroup: recipient.sendTimeGroup }
					: {}),
			}))
		)
	);
	const sendIdByContact = new Map(created.map((row) => [row.contactId, row.emailSendId]));

	const now = Date.now();
	for (const group of groups) {
		const emails: CampaignEnqueueEmail[] = [];
		for (const recipient of group.recipients) {
			const emailSendId = sendIdByContact.get(recipient.contactId);
			if (!emailSendId) continue;
			emails.push({
				emailSendId,
				contactId: recipient.contactId,
				email: recipient.email,
				firstName: recipient.firstName,
				lastName: recipient.lastName,
				engagementScore: recipient.engagementScore,
			});
		}
		const delayMs = group.sendAt === undefined ? 0 : Math.max(0, group.sendAt - now);
		for (let i = 0; i < emails.length; i += CAMPAIGN_ENQUEUE_CHUNK_SIZE) {
			await ctx.scheduler.runAfter(delayMs, internal.delivery.enqueue.enqueueCampaignEmails, {
				...envelope,
				campaignId,
				emails: emails.slice(i, i + CAMPAIGN_ENQUEUE_CHUNK_SIZE),
			});
		}
	}
	return created.length;
}
