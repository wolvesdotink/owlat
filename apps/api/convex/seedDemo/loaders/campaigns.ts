/**
 * Seed loader: campaigns + emailSends.
 *
 * Direct insert — skips `sendProviderDispatch()` from delivery/sendLifecycle.ts
 * so seeded "sent" campaigns never reach Resend / MTA / SES. Stats are written
 * inline rather than via the send-lifecycle effect aggregator: the aggregator
 * is the canonical writer in normal flow, but the seed wants deterministic
 * pre-baked numbers without invoking the lifecycle at all.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
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
		bounced: number;
	};
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
	refs: SeedRefs,
): Promise<LoadResult> {
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

		const sentAt = rec.sentDaysAgo !== undefined
			? now - rec.sentDaysAgo * 24 * 60 * 60 * 1000
			: undefined;

		const campaignId = await ctx.db.insert('campaigns', {
			name: rec.name,
			emailTemplateId: templateId,
			status: rec.status,
			subject: rec.subject,
			fromName: rec.fromName,
			fromEmail: rec.fromEmail,
			audience: { kind: 'topic', topicId },
			sentAt,
			statsSent: rec.stats?.sent,
			statsDelivered: rec.stats?.delivered,
			statsOpened: rec.stats?.opened,
			statsClicked: rec.stats?.clicked,
			statsBounced: rec.stats?.bounced,
			statsUpdatedAt: rec.stats ? now : undefined,
			searchableText: `${rec.name} ${rec.subject}`,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		ids[rec.slug] = campaignId;
		inserted++;

		if (rec.status === 'sent' && rec.stats && sentAt) {
			await seedEmailSends(ctx, campaignId, topicId, rec.stats, sentAt);
		}
	}

	return { inserted, skipped, ids };
}

async function seedEmailSends(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	topicId: Id<'topics'>,
	stats: NonNullable<CampaignFixture['stats']>,
	sentAt: number,
): Promise<void> {
	// The status assignment below relies on `clicked ⊆ opened ⊆ delivered ⊆ sent`
	// — surface fixture mistakes loudly rather than silently producing rows
	// where `status='clicked'` but `openedAt` is undefined.
	if (
		stats.clicked > stats.opened ||
		stats.opened > stats.delivered ||
		stats.delivered > stats.sent
	) {
		throw new Error(
			`Invalid campaign fixture stats (campaign=${campaignId}): expected clicked ≤ opened ≤ delivered ≤ sent; got ${JSON.stringify(stats)}`,
		);
	}

	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_topic', (q) => q.eq('topicId', topicId))
		.take(stats.sent);

	for (let i = 0; i < memberships.length; i++) {
		const m = memberships[i]!;
		const contact = await ctx.db.get(m.contactId);
		if (!contact) continue;

		const isOpened = i < stats.opened;
		const isClicked = i < stats.clicked;
		const isDelivered = i < stats.delivered;

		const status: 'sent' | 'delivered' | 'opened' | 'clicked' = isClicked
			? 'clicked'
			: isOpened
				? 'opened'
				: isDelivered
					? 'delivered'
					: 'sent';

		await ctx.db.insert('emailSends', {
			campaignId,
			contactId: m.contactId,
			contactEmail: contact.email ?? '',
			contactFirstName: contact.firstName,
			contactLastName: contact.lastName,
			status,
			queuedAt: sentAt - 60_000,
			sentAt,
			deliveredAt: isDelivered ? sentAt + 1_000 : undefined,
			openedAt: isOpened ? sentAt + 60_000 : undefined,
			clickedAt: isClicked ? sentAt + 120_000 : undefined,
			openCount: isOpened ? 1 : undefined,
			seedTag: SEED_TAG,
		});
	}
}

export const campaignsLoader: Loader = {
	module: 'campaigns',
	dependencies: ['emailTemplates', 'topics', 'contactTopics'],
	load,
};
