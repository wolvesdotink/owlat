import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import {
	getUserIdFromSession,
	requireOrgPermission,
} from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { batchGet } from '../_utils/batchLoader';

// Status type for email sends
export type EmailSendStatus =
	| 'queued'
	| 'sent'
	| 'delivered'
	| 'opened'
	| 'clicked'
	| 'bounced'
	| 'complained'
	| 'failed';

// Get email sends for a campaign with pagination
export const listByCampaign = authedQuery({
	args: {
		campaignId: v.id('campaigns'),
		status: v.optional(
			v.union(
				v.literal('queued'),
				v.literal('sent'),
				v.literal('delivered'),
				v.literal('opened'),
				v.literal('clicked'),
				v.literal('bounced'),
				v.literal('complained'),
				v.literal('failed')
			)
		),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const offset = args.offset || 0;
		const limit = args.limit || 50;

		let query;
		if (args.status) {
			query = ctx.db
				.query('emailSends')
				.withIndex('by_campaign_and_status', (q) =>
					q.eq('campaignId', args.campaignId).eq('status', args.status!)
				);
		} else {
			query = ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId));
		}

		// Take only what we need: skip offset items + limit items + 1 to check hasMore
		const sends = await query.take(offset + limit + 1);
		const total = sends.length;
		const paginatedSends = sends.slice(offset, offset + limit);
		const hasMore = sends.length > offset + limit;

		// Use denormalized contact info (no N+1 queries)
		const sendsWithContacts = paginatedSends.map((send) => ({
			...send,
			contact: {
				email: send.contactEmail,
				firstName: send.contactFirstName,
				lastName: send.contactLastName,
			},
		}));

		return {
			sends: sendsWithContacts,
			total,
			hasMore,
		};
	},
});

// Get email sends for a contact
export const listByContact = authedQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.contactId, 'Contact');

		const limit = args.limit || 50;
		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.order('desc')
			.take(limit);

		// Batch-load all campaigns at once
		const campaignIds = sends.map((send) => send.campaignId);
		const campaignsMap = await batchGet<Doc<'campaigns'>>(ctx, campaignIds);

		const sendsWithCampaigns = sends.map((send) => {
			const campaign = campaignsMap.get(String(send.campaignId));
			return {
				...send,
				campaign: campaign
					? {
							name: campaign.name,
							subject: campaign.subject,
						}
					: null,
			};
		});

		return sendsWithCampaigns;
	},
});

// Get a single email send by ID
export const get = authedQuery({
	args: { id: v.id('emailSends') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		const send = await ctx.db.get(args.id);
		if (!send) return null;

		// Campaign still needs lookup (could be denormalized in future if needed)
		const campaign = await ctx.db.get(send.campaignId);

		return {
			...send,
			// Use denormalized contact info
			contact: {
				email: send.contactEmail,
				firstName: send.contactFirstName,
				lastName: send.contactLastName,
			},
			campaign: campaign
				? {
						name: campaign.name,
						subject: campaign.subject,
					}
				: null,
		};
	},
});

// Get statistics for a campaign
// Limits to first 10,000 sends; campaigns with more recipients should use denormalized stats on the campaign record
export const getStatsByCampaign = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.take(10_000);

		const stats = {
			total: sends.length,
			queued: 0,
			sent: 0,
			failed: 0,
			delivered: 0,
			opened: 0,
			clicked: 0,
			bounced: 0,
			complained: 0,
			uniqueOpens: 0,
			uniqueClicks: 0,
			totalOpens: 0,
			totalClicks: 0,
			hardBounced: 0,
			softBounced: 0,
		};

		for (const send of sends) {
			// Current-status buckets for the states a row LEAVES as it
			// progresses (queued → sent → … ). delivered/opened/clicked are
			// derived from monotonic timestamps below — NOT from `status` —
			// so a delivered→opened row still counts as delivered and an
			// opened-then-bounced row still counts as opened. Counting those
			// by `status` (the old behaviour) silently dropped any recipient
			// who progressed past the bucket, breaking every rate denominator.
			if (send.status === 'queued') stats.queued++;
			else if (send.status === 'sent') stats.sent++;
			else if (send.status === 'failed') stats.failed++;
			else if (send.status === 'complained') stats.complained++;

			// Count hard vs soft bounces from bounceType (canonical encoding;
			// see CONTEXT.md "Send status"). Sends written before the
			// sendLifecycle module may still encode the class in errorCode —
			// keep that fallback so old rows still classify.
			if (send.status === 'bounced') {
				stats.bounced++;
				const bounceClass =
					send.bounceType ??
					(send.errorCode === 'hard_bounce' ? 'hard' : 'soft');
				if (bounceClass === 'hard') {
					stats.hardBounced++;
				} else {
					stats.softBounced++;
				}
			}

			// "Ever reached delivered" — the deliverability denominator. A row
			// carrying any delivered/opened/clicked timestamp passed through
			// delivery, even if a later event moved its current status.
			if (send.deliveredAt || send.openedAt || send.clickedAt) {
				stats.delivered++;
			}

			// Count unique opens (any send that has been opened, regardless of current status)
			if (send.openedAt) {
				stats.opened++;
				stats.uniqueOpens++;
				stats.totalOpens += send.openCount || 1;
			}

			// Count unique clicks
			if (send.clickedAt || (send.clickedLinks && send.clickedLinks.length > 0)) {
				stats.clicked++;
				stats.uniqueClicks++;
				stats.totalClicks += send.clickedLinks?.length || 1;
			}
		}

		return stats;
	},
});

// Create a new email send record (when queuing for sending)
export const create = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		contactId: v.id('contacts'),
		personalizedSubject: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'campaigns:send', 'Only owners and admins can create email sends');
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const now = Date.now();

		// Fetch contact to denormalize fields
		const contact = await getOrThrow(ctx, args.contactId, 'Contact');
		// Email is optional on contacts (phone/SMS/WhatsApp/generic origin);
		// emailSends is the email send-path table, so an emailless contact
		// here is a caller bug — refuse rather than write an empty SNAPSHOT.
		if (!contact.email) {
			throwInvalidInput('Cannot create an email send for a contact without an email address');
		}

		const id = await ctx.db.insert('emailSends', {
			campaignId: args.campaignId,
			contactId: args.contactId,
			// Denormalize contact info to avoid N+1 queries on read
			contactEmail: contact.email,
			contactFirstName: contact.firstName,
			contactLastName: contact.lastName,
			status: 'queued',
			personalizedSubject: args.personalizedSubject,
			queuedAt: now,
		});

		return id;
	},
});

// Batch create email send records. Accepts an optional `abVariant` per
// row — set by the Campaign send orchestrator (module) when running an
// A/B test fanout; left undefined for non-A/B campaigns.
//
// IDEMPOTENT: any contact that already has an emailSends row for this campaign
// is skipped (one `by_campaign_and_contact` point-read per row). This makes a
// retried/resumed page of the checkpointed send walker exactly-once — a hop
// that committed its sends but crashed before advancing the cursor re-runs the
// SAME page on resume and writes zero new rows. Harmless for the A/B
// materialize path (it passes a single, already-deduped array). The returned
// `ids` carry only the rows actually inserted this call.
export const createBatch = internalMutation({
	args: {
		sends: v.array(
			v.object({
				campaignId: v.id('campaigns'),
				contactId: v.id('contacts'),
				personalizedSubject: v.optional(v.string()),
				// Allow passing denormalized contact info to avoid N+1 lookups during batch creation
				contactEmail: v.optional(v.string()),
				contactFirstName: v.optional(v.string()),
				contactLastName: v.optional(v.string()),
				abVariant: v.optional(v.union(v.literal('A'), v.literal('B'))),
			})
		),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ contactId: Id<'contacts'>; emailSendId: Id<'emailSends'> }[]> => {
		const now = Date.now();
		// (contactId → emailSendId) for the rows actually inserted THIS call.
		// Returning the join (not a positional id array) lets callers enqueue
		// exactly the newly-created rows even when the idempotent guard skipped
		// some inputs — a bare positional array would misalign on resume.
		const created: { contactId: Id<'contacts'>; emailSendId: Id<'emailSends'> }[] = [];

		for (const send of args.sends) {
			// Exactly-once guard: skip a contact that already has a send row for
			// this campaign. The walker may re-run a committed page on resume.
			const existing = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign_and_contact', (q) =>
					q.eq('campaignId', send.campaignId).eq('contactId', send.contactId),
				)
				.first();
			if (existing) continue;

			// Use provided contact info or fetch it
			let contactEmail = send.contactEmail;
			let contactFirstName = send.contactFirstName;
			let contactLastName = send.contactLastName;

			if (!contactEmail) {
				const contact = await ctx.db.get(send.contactId);
				if (!contact) {
					// Skip sends for deleted contacts
					continue;
				}
				contactEmail = contact.email;
				contactFirstName = contact.firstName;
				contactLastName = contact.lastName;
			}

			// Skip emailless contacts — emailSends is the email send-path
			// table; phone/SMS/WhatsApp/generic-only contacts can't receive
			// here and the SNAPSHOT field must be a real address.
			if (!contactEmail) continue;

			const id = await ctx.db.insert('emailSends', {
				campaignId: send.campaignId,
				contactId: send.contactId,
				// Denormalize contact info to avoid N+1 queries on read
				contactEmail,
				contactFirstName,
				contactLastName,
				status: 'queued',
				personalizedSubject: send.personalizedSubject,
				queuedAt: now,
				...(send.abVariant !== undefined ? { abVariant: send.abVariant } : {}),
			});
			created.push({ contactId: send.contactId, emailSendId: id });
		}

		return created;
	},
});

// Status writes (markAsSent / markAsDelivered / recordOpen / recordClick /
// markAsBounced / markAsComplained / markAsFailed) were consolidated into
// `delivery/sendLifecycle.ts` — the single writer of `emailSends.status`.
// Callers should invoke `internal.delivery.sendLifecycle.transition` with a
// SendRef `{ kind: 'campaign', id }` and a typed transition input. See
// CONTEXT.md "Send lifecycle".

// Delete email sends for a campaign (used when deleting a campaign)
export const deleteByCampaign = internalMutation({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.collect();

		for (const send of sends) {
			await ctx.db.delete(send._id);
		}

		return sends.length;
	},
});

// Get opens timeline data for a campaign (grouped by hour)
// Limits to first 10,000 sends to avoid unbounded reads
export const getOpensTimeline = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.take(10_000);

		// Filter to only opened emails and group by hour
		const opensByHour: Record<string, number> = {};

		for (const send of sends) {
			if (send.openedAt) {
				// Round to hour
				const hourTimestamp = Math.floor(send.openedAt / (1000 * 60 * 60)) * (1000 * 60 * 60);
				const hourKey = hourTimestamp.toString();
				opensByHour[hourKey] = (opensByHour[hourKey] || 0) + 1;
			}
		}

		// Convert to sorted array
		const timeline = Object.entries(opensByHour)
			.map(([timestamp, count]) => ({
				timestamp: parseInt(timestamp),
				count,
			}))
			.sort((a, b) => a.timestamp - b.timestamp);

		return timeline;
	},
});

// Get contacts who opened a campaign (with pagination)
export const getOpenedContacts = authedQuery({
	args: {
		campaignId: v.id('campaigns'),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.take(10_000);

		// Filter to only opened emails
		const openedSends = sends.filter((s) => s.openedAt);

		// Sort by openedAt descending (most recent first)
		openedSends.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));

		// Apply pagination
		const offset = args.offset || 0;
		const limit = args.limit || 10;
		const total = openedSends.length;
		const paginatedSends = openedSends.slice(offset, offset + limit);

		// Use denormalized contact info (no N+1 queries)
		const sendsWithContacts = paginatedSends.map((send) => ({
			_id: send._id,
			openedAt: send.openedAt,
			openCount: send.openCount || 1,
			contact: {
				_id: send.contactId,
				email: send.contactEmail,
				firstName: send.contactFirstName,
				lastName: send.contactLastName,
			},
		}));

		return {
			sends: sendsWithContacts,
			total,
			hasMore: offset + limit < total,
		};
	},
});

// Get contacts who clicked in a campaign (with pagination)
export const getClickedContacts = authedQuery({
	args: {
		campaignId: v.id('campaigns'),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.take(10_000);

		// Filter to only clicked emails
		const clickedSends = sends.filter(
			(s) => s.clickedAt || (s.clickedLinks && s.clickedLinks.length > 0)
		);

		// Sort by clickedAt descending (most recent first)
		clickedSends.sort((a, b) => (b.clickedAt || 0) - (a.clickedAt || 0));

		// Apply pagination
		const offset = args.offset || 0;
		const limit = args.limit || 10;
		const total = clickedSends.length;
		const paginatedSends = clickedSends.slice(offset, offset + limit);

		// Use denormalized contact info (no N+1 queries)
		const sendsWithContacts = paginatedSends.map((send) => ({
			_id: send._id,
			clickedAt: send.clickedAt,
			clickedLinks: send.clickedLinks || [],
			contact: {
				_id: send.contactId,
				email: send.contactEmail,
				firstName: send.contactFirstName,
				lastName: send.contactLastName,
			},
		}));

		return {
			sends: sendsWithContacts,
			total,
			hasMore: offset + limit < total,
		};
	},
});

// Get sends that need to be processed (queued status)
export const getQueuedSends = internalMutation({
	args: {
		campaignId: v.id('campaigns'),
		limit: v.number(),
	},
	handler: async (ctx, args) => {
		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign_and_status', (q) =>
				q.eq('campaignId', args.campaignId).eq('status', 'queued')
			)
			.take(args.limit);

		// Use denormalized contact info (no N+1 queries)
		const sendsWithContacts = sends.map((send) => ({
			id: send._id,
			contactId: send.contactId,
			personalizedSubject: send.personalizedSubject,
			contact: {
				email: send.contactEmail,
				firstName: send.contactFirstName,
				lastName: send.contactLastName,
			},
		}));

		return sendsWithContacts;
	},
});

// Get link click stats aggregated by URL for a campaign (for click heatmap)
export const getLinkClickStats = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);
		await getOrThrow(ctx, args.campaignId, 'Campaign');

		const sends = await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', args.campaignId))
			.take(10_000);

		// Aggregate clicks by URL
		const linkStats: Record<string, { url: string; clicks: number; uniqueClickers: number }> = {};

		for (const send of sends) {
			if (send.clickedLinks && send.clickedLinks.length > 0) {
				// Track which URLs this contact clicked (for unique clicker count)
				const clickedUrlsForThisContact = new Set<string>();

				for (const link of send.clickedLinks) {
					const url = link.url;

					// Initialize stats for this URL if needed
					if (!linkStats[url]) {
						linkStats[url] = { url, clicks: 0, uniqueClickers: 0 };
					}

					// Count total clicks
					linkStats[url].clicks++;

					// Track unique clickers (only count once per contact per URL)
					if (!clickedUrlsForThisContact.has(url)) {
						clickedUrlsForThisContact.add(url);
						linkStats[url].uniqueClickers++;
					}
				}
			}
		}

		// Convert to array and sort by clicks descending
		const sortedStats = Object.values(linkStats).sort((a, b) => b.clicks - a.clicks);

		// Calculate total unique clickers for rate calculation
		const totalDelivered = sends.filter(
			(s) => s.status === 'delivered' || s.status === 'opened' || s.status === 'clicked'
		).length;

		return {
			links: sortedStats,
			totalDelivered,
			totalUniqueClicks: sortedStats.reduce((sum, s) => sum + s.uniqueClickers, 0),
		};
	},
});
