import { v } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { getLiveOrThrow } from '../lib/softDelete';
import { CAMPAIGN_REPORT_SEND_SCAN_LIMIT } from './sends';

/**
 * The campaign report's sends that did not arrive: the ones that `failed`
 * before or at the provider, and the ones the receiver `bounced`. Both read
 * one status of one campaign through `by_campaign_and_status`, so a report
 * never scans the campaign's delivered sends to find them.
 */

const undeliveredStatusValidator = v.union(v.literal('failed'), v.literal('bounced'));
type UndeliveredStatus = 'failed' | 'bounced';

/** The most rows one page of the Failed or Bounced list returns. */
export const UNDELIVERED_PAGE_LIMIT = 50;

// bounded: one status of one campaign, at most CAMPAIGN_REPORT_SEND_SCAN_LIMIT
// rows, the same cap the other report queries read under.
async function readCampaignSendsByStatus(
	ctx: QueryCtx,
	campaignId: Id<'campaigns'>,
	status: UndeliveredStatus
): Promise<Doc<'emailSends'>[]> {
	return await ctx.db
		.query('emailSends')
		.withIndex('by_campaign_and_status', (q) => q.eq('campaignId', campaignId).eq('status', status))
		.take(CAMPAIGN_REPORT_SEND_SCAN_LIMIT);
}

/**
 * Sends written before `bounceType` existed carry the class in `errorCode`
 * only; the same fallback `getStatsByCampaign` uses.
 */
function bounceClassOf(send: Doc<'emailSends'>): 'hard' | 'soft' {
	return send.bounceType ?? (send.errorCode === 'hard_bounce' ? 'hard' : 'soft');
}

interface ReasonGroup<K> {
	key: K;
	count: number;
	/** One send's raw provider text for the group, shown behind a disclosure. */
	exampleMessage: string | null;
}

function groupBy<K>(
	sends: readonly Doc<'emailSends'>[],
	keyOf: (send: Doc<'emailSends'>) => K
): ReasonGroup<K>[] {
	const groups = new Map<K, ReasonGroup<K>>();
	for (const send of sends) {
		const key = keyOf(send);
		const group = groups.get(key) ?? { key, count: 0, exampleMessage: null };
		group.count++;
		group.exampleMessage ??= send.errorMessage ?? null;
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Why a campaign's sends did not arrive, grouped by error code (failed) and
// bounce class (bounced). The web app turns each code into a sentence.
// all-members: campaign report data. Every role holds campaigns:manage, and
// the campaign report pages are open to editors.
export const getFailureSummary = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		await getLiveOrThrow(ctx, args.campaignId, 'Campaign');
		const failed = await readCampaignSendsByStatus(ctx, args.campaignId, 'failed');
		const bounced = await readCampaignSendsByStatus(ctx, args.campaignId, 'bounced');
		return {
			failed: {
				total: failed.length,
				reasons: groupBy(failed, (send) => send.errorCode ?? null).map((group) => ({
					errorCode: group.key,
					count: group.count,
					exampleMessage: group.exampleMessage,
				})),
			},
			bounced: {
				total: bounced.length,
				reasons: groupBy(bounced, bounceClassOf).map((group) => ({
					bounceType: group.key,
					count: group.count,
					exampleMessage: group.exampleMessage,
				})),
			},
		};
	},
});

// One page of a campaign's failed or bounced sends, newest first, with what
// each send recorded about why.
// all-members: campaign report data. Every role holds campaigns:manage, and
// the campaign report pages are open to editors.
export const getUndeliveredContacts = authedQuery({
	args: {
		campaignId: v.id('campaigns'),
		status: undeliveredStatusValidator,
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getLiveOrThrow(ctx, args.campaignId, 'Campaign');
		const sends = await readCampaignSendsByStatus(ctx, args.campaignId, args.status);

		const at = (send: Doc<'emailSends'>) =>
			(args.status === 'failed' ? send.failedAt : send.bouncedAt) ?? send.queuedAt;
		sends.sort((a, b) => at(b) - at(a));

		const offset = Math.max(0, Math.floor(args.offset ?? 0));
		const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 10)), UNDELIVERED_PAGE_LIMIT);
		const total = sends.length;

		return {
			sends: sends.slice(offset, offset + limit).map((send) => ({
				_id: send._id,
				at: at(send),
				errorCode: send.errorCode ?? null,
				errorMessage: send.errorMessage ?? null,
				bounceType: args.status === 'bounced' ? bounceClassOf(send) : null,
				contact: {
					_id: send.contactId,
					email: send.contactEmail,
					firstName: send.contactFirstName,
					lastName: send.contactLastName,
				},
			})),
			total,
			hasMore: offset + limit < total,
		};
	},
});
