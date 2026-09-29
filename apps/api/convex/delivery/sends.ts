import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';
import { abVariantValidator } from '../lib/convexValidators';
import { hasClicked, hasOpened, hasReachedDelivered } from './sendEngagement';

// bounded: the campaign report queries below read a campaign's `emailSends`
// through the `by_campaign` index and stop at this many rows, so a large
// campaign can't exceed the per-query document read limit. Campaigns with more
// recipients should use the denormalized stats on the campaign record.
const CAMPAIGN_REPORT_SEND_SCAN_LIMIT = 10_000;

/**
 * Shared prologue of the campaign report queries: require the campaign to
 * exist, then load its first CAMPAIGN_REPORT_SEND_SCAN_LIMIT `emailSends` rows.
 * The caller's session is already checked by the `authedQuery` floor
 * (`requireOrgMember`), so it is not resolved a second time here.
 */
async function loadCampaignSendsForReport(
	ctx: QueryCtx,
	campaignId: Id<'campaigns'>
): Promise<Doc<'emailSends'>[]> {
	await getOrThrow(ctx, campaignId, 'Campaign');

	return await ctx.db
		.query('emailSends')
		.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
		.take(CAMPAIGN_REPORT_SEND_SCAN_LIMIT);
}

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

// Get statistics for a campaign (bounded by CAMPAIGN_REPORT_SEND_SCAN_LIMIT)
export const getStatsByCampaign = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const sends = await loadCampaignSendsForReport(ctx, args.campaignId);

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
			// Sends whose pixel an automated client fetched (Apple MPP, a
			// scanner). The fetch is not an open, but a reader may still have
			// opened the same send, so it can also be in `opened`.
			automatedOpens: 0,
			// Sends whose tracked links an automated client followed (a
			// security gateway, a link scanner). Like `automatedOpens`, the
			// same send may also be in `clicked` from a reader click.
			automatedClicks: 0,
			totalClicks: 0,
			hardBounced: 0,
			softBounced: 0,
		};

		for (const send of sends) {
			// Current-status buckets for the states a row LEAVES as it
			// progresses (queued → sent → … ). delivered/opened/clicked come
			// from the sendEngagement predicates below, which read monotonic
			// timestamps rather than `status` (see that module for why).
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
				const bounceClass = send.bounceType ?? (send.errorCode === 'hard_bounce' ? 'hard' : 'soft');
				if (bounceClass === 'hard') {
					stats.hardBounced++;
				} else {
					stats.softBounced++;
				}
			}

			// "Ever reached delivered" — the deliverability denominator.
			if (hasReachedDelivered(send)) {
				stats.delivered++;
			}

			// Count unique opens (any send that has been opened, regardless of current status)
			if (hasOpened(send)) {
				stats.opened++;
				stats.uniqueOpens++;
				stats.totalOpens += send.openCount || 1;
			}

			if (send.automatedOpenedAt) stats.automatedOpens++;
			if (send.automatedClickedAt) stats.automatedClicks++;

			// Count unique clicks
			if (hasClicked(send)) {
				stats.clicked++;
				stats.uniqueClicks++;
				stats.totalClicks += send.clickedLinks?.length || 1;
			}
		}

		return stats;
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
				abVariant: v.optional(abVariantValidator),
			})
		),
	},
	handler: async (
		ctx,
		args
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
					q.eq('campaignId', send.campaignId).eq('contactId', send.contactId)
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

// Get opens timeline data for a campaign (grouped by hour, bounded by
// CAMPAIGN_REPORT_SEND_SCAN_LIMIT)
export const getOpensTimeline = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const sends = await loadCampaignSendsForReport(ctx, args.campaignId);

		// Filter to only opened emails and group by hour
		const opensByHour: Record<string, number> = {};

		for (const send of sends) {
			if (hasOpened(send)) {
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
		const sends = await loadCampaignSendsForReport(ctx, args.campaignId);

		// Filter to only opened emails
		const openedSends = sends.filter(hasOpened);

		// Sort by openedAt descending (most recent first)
		openedSends.sort((a, b) => b.openedAt - a.openedAt);

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
		const sends = await loadCampaignSendsForReport(ctx, args.campaignId);

		// Filter to only clicked emails
		const clickedSends = sends.filter(hasClicked);

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

// Get link click stats aggregated by URL for a campaign (for click heatmap)
export const getLinkClickStats = authedQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args) => {
		const sends = await loadCampaignSendsForReport(ctx, args.campaignId);

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

		// Rate denominator for the heatmap: the same "ever reached delivered"
		// rule as getStatsByCampaign, so the per-link click rate and the
		// campaign click rate on the report page share one denominator.
		const totalDelivered = sends.filter(hasReachedDelivered).length;

		return {
			links: sortedStats,
			totalDelivered,
			totalUniqueClicks: sortedStats.reduce((sum, s) => sum + s.uniqueClickers, 0),
		};
	},
});
