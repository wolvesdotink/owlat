/**
 * Internal read accessors for the AI assistant's data tools (getCampaignStats,
 * getEmailStats, draftEmailReply). The conversation runner is a scheduled
 * action with no user identity, so the tool layer reaches these `internalQuery`
 * functions rather than the authed UI queries. Single-org deployment, so there
 * is nothing to scope beyond the one tenant's data.
 *
 * All reads are bounded (search-index `.take` / status+time index `.take`) so a
 * tool call can never trigger an unbounded table scan.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';

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
			.withSearchIndex('search_campaigns', (s) => s.search('searchableText', q))
			.take(limit);
		return { campaigns: matches.map(campaignSnapshot) };
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
