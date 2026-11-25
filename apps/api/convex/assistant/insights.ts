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
import { internalQuery, type DatabaseReader } from '../_generated/server';
import { campaignSendHold } from '../campaigns/sendHold';
import { readSendJob } from '../campaigns/sendJob';
import { loadDeliveryHealthReport, readSendingHoldRecord } from '../delivery/healthReport';
import { loadSendingDomainSetups } from '../domains/recordStates';
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
 * The live campaigns of one status, newest `sentAt` first. A campaign stamps
 * `sentAt` when its send starts, so this orders sending and sent alike.
 */
function latestWithStatus(db: DatabaseReader, status: 'sending' | 'sent', limit: number) {
	return db
		.query('campaigns')
		.withIndex('by_deleted_at_and_status_and_sent_at', (s) =>
			s.eq('deletedAt', undefined).eq('status', status)
		)
		.order('desc')
		.take(limit);
}

/**
 * Look up campaign performance by a name/subject query. Returns the top matches
 * (bounded) with delivery/open/click stats. Empty array when nothing matches.
 * Without a query it returns the latest campaigns instead: the ones still
 * sending first, then the most recently sent.
 */
export const campaignStats = internalQuery({
	args: { query: v.optional(v.string()), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const q = args.query?.trim() ?? '';
		const limit = Math.max(1, Math.min(args.limit ?? 3, 10));
		let matches;
		if (q.length === 0) {
			const sending = await latestWithStatus(ctx.db, 'sending', limit);
			const sent =
				sending.length < limit
					? await latestWithStatus(ctx.db, 'sent', limit - sending.length)
					: [];
			matches = [...sending, ...sent];
		} else if (q.length < 2) {
			return { campaigns: [] };
		} else {
			matches = await ctx.db
				.query('campaigns')
				.withSearchIndex('search_campaigns', (s) =>
					s.search('searchableText', q).eq('deletedAt', undefined)
				)
				.take(limit);
		}
		// The same hold the campaign report shows, so "why is it not sending"
		// has an answer: a suspended workspace holds every sending campaign, and
		// a held campaign carries the reason recorded for the suspension.
		const hold = await readSendingHold(ctx.db);
		const suspension = suspensionForModel(await readSendingHoldRecord(ctx.db));
		const campaigns = [];
		for (const campaign of matches) {
			const job = await readSendJob(ctx, campaign._id);
			const sendHold = campaignSendHold({ campaign, job, hold });
			campaigns.push({
				...campaignSnapshot(campaign),
				sendHold:
					sendHold?.kind === 'held'
						? { ...sendHold, reason: suspension?.reason ?? null, lift: suspension?.lift ?? null }
						: sendHold,
			});
		}
		return { campaigns };
	},
});

/** Longest stored suspension reason handed to the model. */
const MAX_SUSPENSION_REASON = 500;

/**
 * The suspension or ban in force, its stored reason clamped for the model and
 * its time as ISO 8601 and how it lifts, or `null` while sending is allowed.
 * The same facts `getSendingOverview` returns to every member.
 */
function suspensionForModel(hold: Awaited<ReturnType<typeof readSendingHoldRecord>>) {
	if (!hold) return null;
	return {
		status: hold.status,
		reason: hold.reason ? clampText(hold.reason, MAX_SUSPENSION_REASON) : null,
		since: hold.since !== null ? new Date(hold.since).toISOString() : null,
		lift: hold.lift,
	};
}

/**
 * Why delivery is or is not healthy, for the assistant: the shared report
 * (`delivery/healthReport.ts`), with the sending hold in the shape the model
 * reads, and on each domain the DNS records it still needs
 * (`domains/recordStates.ts`). A record goes to the model by name and state
 * only: a DKIM key is long, and the value a check found is text from DNS, so
 * the person reads both on the Domains page.
 */
export const deliveryHealth = internalQuery({
	args: {},
	handler: async (ctx) => {
		const { hold, domains: _domains, ...report } = await loadDeliveryHealthReport(ctx);
		const setups = await loadSendingDomainSetups(ctx.db);
		return {
			...report,
			domains: setups.map(({ domain, status, records }) => ({
				domain,
				status,
				// An optional record (the second DKIM key) is never something to fix.
				recordsToFix: records
					.filter((record) => record.state !== 'found' && !record.optional)
					.map(({ purpose, type, host, state }) => ({ purpose, type, host, state })),
			})),
			sendHold: suspensionForModel(hold),
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
