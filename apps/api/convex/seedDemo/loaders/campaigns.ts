/**
 * Seed loader: campaigns + emailSends.
 *
 * Direct insert — skips `sendProviderDispatch()` from delivery/sendLifecycle.ts
 * so seeded "sent" campaigns never reach Resend / MTA / SES. Stats are written
 * inline rather than via the send-lifecycle effect aggregator: the aggregator
 * is the canonical writer in normal flow, but the seed wants deterministic
 * pre-baked numbers without invoking the lifecycle at all.
 *
 * A failed or bounced send takes its row fields from the lifecycle's own pure
 * reducers (`reduceFailed`, `reduceBounced`), so it carries exactly the error
 * code, bounce class and receiver reply the report groups by. Their effects are
 * not run: they would fire `email.failed` / `email.bounced` at the seeded
 * webhook, write reputation events and schedule campaign completion. The
 * campaign counters they would bump are written with the rest of the stats.
 * The contact's soft-bounce count is left alone: on a real install the
 * sample campaign can reach the operator's own contacts through a topic of
 * the same name, and removing the sample data would not take it back.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { recordListingCounter } from '../../lib/listingCounters';
import { reduceBounced, reduceFailed } from '../../delivery/sendLifecycle/reducers';
import { SEED_TAG, type LoadResult, type Loader, type SeedRefs } from './types';

type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'pending_review';

interface CampaignFixture {
	slug: string;
	name: string;
	template: string;
	topic: string;
	status: CampaignStatus;
	subject: string;
	fromName: string;
	fromEmail: string;
	sentDaysAgo?: number;
	stats?: {
		sent: number;
		delivered: number;
		opened: number;
		clicked: number;
		/** Sent, then soft-bounced by the receiver; never delivered. */
		bounced: number;
		/** Recipients the send failed for before it went out; not in `sent`. */
		failed?: number;
	};
	/** The provider's refusal recorded on each failed send. */
	failure?: { errorCode: string; errorMessage: string };
	/** The receiving server's reply recorded on each bounced send. */
	bounceMessage?: string;
}

async function load(ctx: MutationCtx, rawRecords: unknown[], refs: SeedRefs): Promise<LoadResult> {
	const records = rawRecords as CampaignFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'campaigns'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('campaigns').collect(); // bounded: tiny seed table
	const byName = new Map(existing.map((c) => [c.name, c]));

	for (const rec of records) {
		const found = byName.get(rec.name);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}

		const templateId = refs['emailTemplates']?.[rec.template] as Id<'emailTemplates'> | undefined;
		const topicId = refs['topics']?.[rec.topic] as Id<'topics'> | undefined;
		if (!templateId || !topicId) {
			skipped++;
			continue;
		}

		const sentAt =
			rec.sentDaysAgo !== undefined ? now - rec.sentDaysAgo * 24 * 60 * 60 * 1000 : undefined;

		// Every seeded bounce is soft (see seedEmailSends).
		const counters = rec.stats
			? {
					statsSent: rec.stats.sent,
					statsDelivered: rec.stats.delivered,
					statsOpened: rec.stats.opened,
					statsClicked: rec.stats.clicked,
					statsBounced: rec.stats.bounced,
					statsSoftBounced: rec.stats.bounced,
					statsHardBounced: 0,
					statsFailed: rec.stats.failed ?? 0,
				}
			: {};

		const campaignId = await ctx.db.insert('campaigns', {
			name: rec.name,
			emailTemplateId: templateId,
			status: rec.status,
			subject: rec.subject,
			fromName: rec.fromName,
			fromEmail: rec.fromEmail,
			audience: { kind: 'topic', topicId },
			sentAt,
			...counters,
			// Demo opens and clicks are generated, not fetched: label them as
			// filtered so the report does not warn about pre-cutover automated ones.
			...(rec.stats
				? {
						statsAutomatedOpened: 0,
						isAutomatedOpenFiltered: true,
						statsAutomatedClicked: 0,
						isAutomatedClickFiltered: true,
					}
				: {}),
			statsUpdatedAt: rec.stats ? now : undefined,
			searchableText: `${rec.name} ${rec.subject}`,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		await recordListingCounter(ctx, 'campaignStatus', null, { status: rec.status });
		// The campaign's stats columns are a cache the rollup cron rewrites from
		// the shards (`campaigns/statShards.ts`), so the counts live in a shard
		// too, or the first rollup would zero them.
		if (rec.stats) {
			await ctx.db.insert('campaignStatShards', { campaignId, shardKey: 0, ...counters });
		}
		ids[rec.slug] = campaignId;
		inserted++;

		if (rec.status === 'sent' && rec.stats && sentAt) {
			await seedEmailSends(ctx, campaignId, topicId, rec, rec.stats, sentAt);
		}
	}

	return { inserted, skipped, ids };
}

async function seedEmailSends(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	topicId: Id<'topics'>,
	rec: CampaignFixture,
	stats: NonNullable<CampaignFixture['stats']>,
	sentAt: number
): Promise<void> {
	const failed = stats.failed ?? 0;
	// The status assignment below relies on `clicked ⊆ opened ⊆ delivered` and
	// on delivered and bounced sends being disjoint parts of `sent` — surface
	// fixture mistakes loudly rather than silently producing rows where
	// `status='clicked'` but `openedAt` is undefined.
	if (
		stats.clicked > stats.opened ||
		stats.opened > stats.delivered ||
		stats.delivered + stats.bounced > stats.sent ||
		(failed > 0 && !rec.failure) ||
		(stats.bounced > 0 && !rec.bounceMessage)
	) {
		throw new Error(
			`Invalid campaign fixture stats (campaign=${campaignId}): expected clicked ≤ opened ≤ delivered, delivered + bounced ≤ sent, and a failure / bounceMessage for failed / bounced sends; got ${JSON.stringify(stats)}`
		);
	}

	// Recipients in topic order: the sent ones first, then the ones the send
	// failed for.
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_topic', (q) => q.eq('topicId', topicId))
		.take(stats.sent + failed);

	for (let i = 0; i < memberships.length; i++) {
		const m = memberships[i]!;
		const contact = await ctx.db.get(m.contactId);
		if (!contact) continue;

		const isFailed = i >= stats.sent;
		const isBounced = !isFailed && i >= stats.delivered && i < stats.delivered + stats.bounced;
		const isOpened = i < stats.opened;
		const isClicked = i < stats.clicked;
		const isDelivered = i < stats.delivered;

		const status: 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' = isFailed
			? 'queued'
			: isClicked
				? 'clicked'
				: isOpened
					? 'opened'
					: isDelivered
						? 'delivered'
						: 'sent';

		const sendId = await ctx.db.insert('emailSends', {
			campaignId,
			contactId: m.contactId,
			contactEmail: contact.email ?? '',
			contactFirstName: contact.firstName,
			contactLastName: contact.lastName,
			status,
			queuedAt: sentAt - 60_000,
			sentAt: isFailed ? undefined : sentAt,
			deliveredAt: isDelivered ? sentAt + 1_000 : undefined,
			openedAt: isOpened ? sentAt + 60_000 : undefined,
			clickedAt: isClicked ? sentAt + 120_000 : undefined,
			openCount: isOpened ? 1 : undefined,
			seedTag: SEED_TAG,
		});

		if (!isFailed && !isBounced) continue;
		const send = (await ctx.db.get(sendId))!;
		const ref = { kind: 'campaign' as const, id: sendId };
		const { patch } =
			isFailed && rec.failure
				? reduceFailed(send, { to: 'failed', at: sentAt, ...rec.failure }, ref)
				: reduceBounced(
						send,
						{
							to: 'bounced',
							at: sentAt + 5 * 60_000,
							bounceType: 'soft',
							bounceCause: 'recipient',
							bounceMessage: rec.bounceMessage,
						},
						ref,
						send.contactEmail,
						undefined,
						contact
					);
		await ctx.db.patch(sendId, patch);
	}
}

export const campaignsLoader: Loader = {
	module: 'campaigns',
	dependencies: ['emailTemplates', 'topics', 'contactTopics'],
	load,
};
