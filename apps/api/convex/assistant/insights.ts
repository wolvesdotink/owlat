/**
 * Internal read accessors for the AI assistant's data tools (getCampaignStats,
 * getEmailStats, getDeliveryHealth, draftEmailReply). The conversation runner is a scheduled
 * action with no user identity, so the tool layer reaches these `internalQuery`
 * functions rather than the authed UI queries. Single-org deployment, so there
 * is nothing to scope beyond the one tenant's data.
 *
 * All reads are bounded (search-index `.take` / status+time index `.take`) so a
 * tool call can never trigger an unbounded table scan.
 */

import { v } from 'convex/values';
import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import { internalQuery, type DatabaseReader } from '../_generated/server';
import { readOrgReputation } from '../analytics/reputationQueries';
import { campaignSendHold } from '../campaigns/sendHold';
import { readSendJob } from '../campaigns/sendJob';
import { loadDeliveryHealth } from '../delivery/health';
import { DELIVERY_HEALTH_EXPLANATIONS } from '../delivery/healthCopy';
import { readSendingHold } from '../workspaces/abuseGate';
import { clampText } from './prompt';

/** Rate as a percentage to one decimal place, or null when the denominator is 0. */
function pct(num: number, den: number): number | null {
	return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}

/** Per-campaign performance snapshot returned to the model. */
function campaignSnapshot(c: {
	_id: unknown;
	name: string;
	status: string;
	subject?: string;
	sentAt?: number;
	statsSent?: number;
	statsDelivered?: number;
	statsOpened?: number;
	statsClicked?: number;
	statsBounced?: number;
	statsUnsubscribed?: number;
	statsFailed?: number;
}) {
	const sent = c.statsSent ?? 0;
	const delivered = c.statsDelivered ?? 0;
	const opened = c.statsOpened ?? 0;
	const clicked = c.statsClicked ?? 0;
	return {
		id: c._id as string,
		name: c.name,
		status: c.status,
		subject: c.subject ?? null,
		sentAt: c.sentAt ?? null,
		sent,
		delivered,
		opened,
		clicked,
		bounced: c.statsBounced ?? 0,
		unsubscribed: c.statsUnsubscribed ?? 0,
		failed: c.statsFailed ?? 0,
		openRatePct: pct(opened, delivered),
		clickRatePct: pct(clicked, delivered),
	};
}

/**
 * Look up campaign performance by a name/subject query. Returns the top matches
 * (bounded) with delivery/open/click stats. Empty array when nothing matches.
 */
export const campaignStats = internalQuery({
	args: { query: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const q = args.query.trim();
		const limit = Math.max(1, Math.min(args.limit ?? 3, 10));
		if (q.length < 2) return { campaigns: [] };
		const matches = await ctx.db
			.query('campaigns')
			.withSearchIndex('search_campaigns', (s) =>
				s.search('searchableText', q).eq('deletedAt', undefined)
			)
			.take(limit);
		// The same hold the campaign report shows, so "why is it not sending"
		// has an answer: a suspended workspace holds every sending campaign, and
		// a held campaign carries the reason recorded for the suspension.
		const hold = await readSendingHold(ctx.db);
		const suspension = await readSuspension(ctx.db);
		const campaigns = [];
		for (const campaign of matches) {
			const job = await readSendJob(ctx, campaign._id);
			const sendHold = campaignSendHold({ campaign, job, hold });
			campaigns.push({
				...campaignSnapshot(campaign),
				sendHold:
					sendHold?.kind === 'held'
						? { ...sendHold, reason: suspension?.reason ?? null }
						: sendHold,
			});
		}
		return { campaigns };
	},
});

/** Longest stored suspension reason handed to the model. */
const MAX_SUSPENSION_REASON = 500;

/** Most sending domains listed; a deployment curates low tens at most. */
const MAX_DOMAINS = 25;

/**
 * The suspension or ban in force, with the reason and time the status was
 * recorded, or `null` while sending is allowed. A lift keeps the old reason on
 * the row, so it is read only while the status still holds. The same fields
 * `getSendingOverview` returns to every member.
 */
async function readSuspension(db: DatabaseReader) {
	const settings = await db.query('instanceSettings').first();
	const status = settings?.abuseStatus;
	if (status !== 'suspended' && status !== 'banned') return null;
	return {
		status,
		reason: settings?.abuseStatusReason
			? clampText(settings.abuseStatusReason, MAX_SUSPENSION_REASON)
			: null,
		since:
			settings?.abuseStatusChangedAt !== undefined
				? new Date(settings.abuseStatusChangedAt).toISOString()
				: null,
	};
}

/** A rate (0–1) as a percentage to three decimals, next to its limit. */
function rateAgainstLimit(rate: number, limit: number) {
	const asPct = (value: number) => Math.round(value * 100_000) / 1000;
	return { ratePct: asPct(rate), limitPct: asPct(limit), isOver: rate >= limit };
}

/**
 * Why delivery is or is not healthy, for the assistant. The sidebar dot's
 * roll-up with its reason explained in English, plus the member-visible facts
 * behind it: each sending domain's verification status, the org's rolling
 * bounce and complaint rates against the limits the delivery hub shows, and the
 * sending hold. Nothing here is admin-only; the Deliverability Center's checks
 * (`delivery/checklist.ts`) stay out.
 */
export const deliveryHealth = internalQuery({
	args: {},
	handler: async (ctx) => {
		const verdict = await loadDeliveryHealth(ctx);
		const { sentence, fix } = DELIVERY_HEALTH_EXPLANATIONS[verdict.reasonCode];
		const explanation = Object.entries(verdict.reasonParams ?? {}).reduce(
			(text, [name, value]) => text.replaceAll(`{${name}}`, value),
			sentence as string
		);

		const domainRows = await ctx.db.query('domains').take(MAX_DOMAINS + 1);
		const reputation = await readOrgReputation(ctx.db);
		return {
			level: verdict.level,
			reasonCode: verdict.reasonCode,
			explanation,
			fix,
			domains: domainRows
				.slice(0, MAX_DOMAINS)
				.map((row) => ({ domain: row.domain, status: row.status })),
			isDomainListTruncated: domainRows.length > MAX_DOMAINS,
			// The limit is the one the delivery hub's tiles and the marketing
			// overview quote; past it the reputation verdict starts to warn.
			rates: reputation
				? {
						// The summarizer's rolling window (`analytics/sendingReputation.ts`).
						windowDays: 30,
						sent: reputation.totalSent,
						bounce: rateAgainstLimit(reputation.bounceRate, REPUTATION_THRESHOLDS.bounce.medium),
						complaint: rateAgainstLimit(
							reputation.complaintRate,
							REPUTATION_THRESHOLDS.complaint.medium
						),
					}
				: null,
			sendHold: await readSuspension(ctx.db),
		};
	},
});

/**
 * Aggregate campaign email performance over a recent window. Bounded: sums the
 * 'sent' campaigns whose sentAt falls in the window (capped), so the model gets
 * deployment-level marketing numbers without an unbounded emailSends scan.
 */
export const emailStats = internalQuery({
	args: { days: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const days = Math.max(1, Math.min(args.days ?? 30, 90));
		const since = Date.now() - days * 24 * 60 * 60 * 1000;
		const CAP = 500;
		const sent = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (s) => s.eq('status', 'sent').gte('sentAt', since))
			.take(CAP + 1);
		const truncated = sent.length > CAP;
		const rows = truncated ? sent.slice(0, CAP) : sent;
		const totals = rows.reduce(
			(acc, c) => {
				acc.sent += c.statsSent ?? 0;
				acc.delivered += c.statsDelivered ?? 0;
				acc.opened += c.statsOpened ?? 0;
				acc.clicked += c.statsClicked ?? 0;
				acc.bounced += c.statsBounced ?? 0;
				acc.unsubscribed += c.statsUnsubscribed ?? 0;
				return acc;
			},
			{ sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 }
		);
		return {
			windowDays: days,
			campaignsSent: rows.length,
			truncated,
			...totals,
			openRatePct: pct(totals.opened, totals.delivered),
			clickRatePct: pct(totals.clicked, totals.delivered),
		};
	},
});

/**
 * Resolve a contact by a name/email query for the draftEmailReply tool. Returns
 * the single best match (or null) — name + email only, no activity history.
 */
export const findContact = internalQuery({
	args: { query: v.string() },
	handler: async (ctx, args) => {
		const q = args.query.trim();
		if (q.length < 2) return null;
		const match = await ctx.db
			.query('contacts')
			.withSearchIndex('search_contacts', (s) =>
				s.search('searchableText', q).eq('deletedAt', undefined)
			)
			.first();
		if (!match) return null;
		const name = `${match.firstName ?? ''} ${match.lastName ?? ''}`.trim();
		return {
			id: match._id as string,
			name: name || null,
			email: match.email,
		};
	},
});
