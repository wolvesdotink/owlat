/**
 * Topic reads shared by the session-gated queries in `topics.ts` and their
 * API-key `*Internal` variants, and the body of `getContactInTopicDetails`.
 * The callers own the auth decision; these only load and shape rows.
 */

import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { topicListing } from './listing';
import { batchGet } from '../_utils/batchLoader';
import { getLiveContact } from '../lib/contactHelpers';

// Load a single topic by ID, enriched with the descriptor's `contactCount` so
// list and get can no longer drift. Shared by the session-gated `get` and the
// API-key `getInternal` variant.
export async function getTopicImpl(ctx: QueryCtx, topicId: Id<'topics'>) {
	const topic = await ctx.db.get(topicId);
	if (!topic) return null;

	const enriched = topicListing.enrich ? await topicListing.enrich(ctx.db, topic) : {};
	return { ...topic, ...enriched } as Doc<'topics'> & { contactCount: number };
}

// Query to get topics for a specific contact
export async function getTopicsForContactImpl(ctx: QueryCtx, contactId: Id<'contacts'>) {
	const memberships = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's topic memberships

	// Batch-load all topics at once
	const topicIds = memberships.map((membership) => membership.topicId);
	const topicsMap = await batchGet(ctx, topicIds);

	const topics = memberships.map((membership) => {
		const topic = topicsMap.get(membership.topicId);
		return topic
			? {
					...topic,
					addedAt: membership.addedAt,
				}
			: null;
	});

	// Filter out null values (topics that may have been deleted)
	return topics.filter((l): l is NonNullable<typeof l> => l !== null);
}

// The body of `getContactInTopicDetails`: the contact, its membership, its
// email history from campaigns targeting this topic, and engagement stats.
export async function loadContactInTopicDetails(
	ctx: QueryCtx,
	args: { topicId: Id<'topics'>; contactId: Id<'contacts'> }
) {
	// Fetch the topic
	const topic = await ctx.db.get(args.topicId);
	if (!topic) {
		return null;
	}

	// A soft-deleted contact keeps its email, names and membership until the
	// retention sweep; it reads as missing here as it does in contacts.get.
	const contact = await getLiveContact(ctx, args.contactId);
	if (!contact) {
		return null;
	}

	// Fetch the membership
	const membership = await ctx.db
		.query('contactTopics')
		.withIndex('by_contact_and_topic', (q) =>
			q.eq('contactId', args.contactId).eq('topicId', args.topicId)
		)
		.first();

	if (!membership) {
		return null;
	}

	// Fetch campaigns that target this specific topic. The audience is a
	// discriminated value whose topic id lives inside the union,
	// so filter in JS after a bounded scan. The scan rides the live-only
	// index, newest first, so campaigns in Recently deleted never show up
	// and never take up the scan limit.
	const scanned = await ctx.db
		.query('campaigns')
		.withIndex('by_deleted_at_and_updated_at', (q) => q.eq('deletedAt', undefined))
		.order('desc')
		.take(1000); // bounded: topic-detail lookup
	const campaigns = scanned.filter(
		(c) => c.audience?.kind === 'topic' && c.audience.topicId === args.topicId
	);

	// Limit to most recent campaigns for email history lookup
	const topicCampaigns = campaigns.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);

	// Get email sends for this contact from these campaigns
	const emailHistory = await Promise.all(
		topicCampaigns.map(async (campaign) => {
			const emailSend = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign_and_contact', (q) =>
					q.eq('campaignId', campaign._id).eq('contactId', args.contactId)
				)
				.first();

			if (!emailSend) return null;

			return {
				campaignId: campaign._id,
				campaignName: campaign.name,
				subject: campaign.subject || '',
				status: emailSend.status,
				sentAt: emailSend.sentAt,
				openedAt: emailSend.openedAt,
				clickedAt: emailSend.clickedAt,
				openCount: emailSend.openCount || 0,
				clickedLinks: emailSend.clickedLinks || [],
			};
		})
	);

	// Filter out null entries and sort by sentAt descending
	const validEmailHistory = emailHistory
		.filter((e): e is NonNullable<typeof e> => e !== null)
		.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));

	// Calculate aggregate stats
	const totalSent = validEmailHistory.length;
	const totalOpened = validEmailHistory.filter((e) => e.openedAt).length;
	const totalClicked = validEmailHistory.filter((e) => e.clickedAt).length;

	// Find last engagement date (most recent open or click)
	const engagementDates = validEmailHistory
		.flatMap((e) => [e.openedAt, e.clickedAt].filter((d): d is number => d !== undefined))
		.sort((a, b) => b - a);
	const lastEngagement = engagementDates[0] || null;

	return {
		topic: {
			_id: topic._id,
			name: topic.name,
			description: topic.description,
			requireDoubleOptIn: topic.requireDoubleOptIn,
			createdAt: topic.createdAt,
		},
		contact: {
			_id: contact._id,
			email: contact.email,
			firstName: contact.firstName,
			lastName: contact.lastName,
			createdAt: contact.createdAt,
		},
		membership: {
			addedAt: membership.addedAt,
		},
		emailHistory: validEmailHistory,
		emailStats: {
			totalSent,
			totalOpened,
			totalClicked,
			openRate: totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0,
			clickRate: totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0,
			lastEngagement,
		},
	};
}
