import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import { getDailySendVolume } from '../lib/sendingLimits';
import {
	summarize,
	summarizeDomains,
	readDomainReputationBucketGroups,
	summarizeDomainReputationGroups,
	type ReputationSummary,
	type RiskLevel,
} from './sendingReputation';
import { summarizeDomainSpamRateGroups, type SpamRateSummary } from './spamRate';

/** The reputation card's UI shape, or `null` when there's no in-window activity. */
type ReputationDto = {
	bounceRate: number;
	complaintRate: number;
	riskLevel: string;
	totalSent: number;
	totalDelivered: number;
	totalBounced: number;
	totalComplaints: number;
} | null;

/**
 * Shape a rolling reputation summary for the overview card. Returns `null`
 * when the window has no sending activity yet, so the UI can render its empty
 * state instead of an all-zero "0% bounce" card that reads like a real signal.
 * Pure — no DB access — so the null-vs-populated decision is unit-testable.
 */
export function toReputationDto(summary: ReputationSummary): ReputationDto {
	const hasActivity =
		summary.totalSent > 0 ||
		summary.totalDelivered > 0 ||
		summary.totalBounced > 0 ||
		summary.totalComplaints > 0;

	if (!hasActivity) return null;

	return {
		bounceRate: summary.bounceRate,
		complaintRate: summary.complaintRate,
		riskLevel: summary.riskLevel,
		totalSent: summary.totalSent,
		totalDelivered: summary.totalDelivered,
		totalBounced: summary.totalBounced,
		totalComplaints: summary.totalComplaints,
	};
}

// ============ PUBLIC QUERIES ============

/**
 * Get sending overview: warming state, volume, reputation, abuse status.
 * Tier-based limits have been removed — IP warming is handled by the MTA.
 */
export const getSendingOverview = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);

		// Get instance settings
		const settings = await ctx.db.query('instanceSettings').first();

		if (!settings) {
			return null;
		}

		// Get warming state from MTA sync
		const warmingState = await ctx.db.query('warmingState').first();

		// Compute volume tracking
		const volume = getDailySendVolume(settings.dailySendCount ?? 0, settings.dailySendCountResetAt);

		// Rolling 30-day org reputation, derived on read through the single
		// summarizer, then shaped for the card (`null` on no in-window
		// activity, so the UI can show its empty state).
		const orgSummary = await summarize(ctx.db, { kind: 'org' });
		const reputation = toReputationDto(orgSummary);

		return {
			warming: warmingState
				? {
						phase: warmingState.phase,
						totalDailyCap: warmingState.totalDailyCap,
						totalSentToday: warmingState.totalSentToday,
						remainingToday: Math.max(0, warmingState.totalDailyCap - warmingState.totalSentToday),
						ipCount: warmingState.ipCount,
						ips: warmingState.ips,
						syncedAt: warmingState.syncedAt,
					}
				: null,
			volume,
			reputation,
			abuseStatus: settings.abuseStatus ?? null,
		};
	},
});

/**
 * Estimate how long a campaign will take to send based on IP warming state.
 */
export const getCampaignSendEstimate = authedQuery({
	args: {
		recipientCount: v.number(),
	},
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);

		const warmingState = await ctx.db.query('warmingState').first();

		if (!warmingState) {
			return {
				totalDailyCap: 0,
				remainingToday: 0,
				estimatedDays: 1,
				isFullyWarmed: false,
				message: 'Warming data not available yet. Your emails will be paced automatically.',
			};
		}

		const { totalDailyCap, totalSentToday } = warmingState;
		const remainingToday = Math.max(0, totalDailyCap - totalSentToday);

		// Check if all IPs are graduated
		const isFullyWarmed = warmingState.phase === 'graduated';

		if (isFullyWarmed) {
			return {
				totalDailyCap,
				remainingToday,
				estimatedDays: 1,
				isFullyWarmed: true,
				message: 'Your IPs are fully warmed. Campaign will send at full speed.',
			};
		}

		// Estimate days needed
		const { recipientCount } = args;
		if (recipientCount <= remainingToday) {
			return {
				totalDailyCap,
				remainingToday,
				estimatedDays: 1,
				isFullyWarmed: false,
				message: `Campaign fits within today's remaining capacity (${remainingToday.toLocaleString()} emails).`,
			};
		}

		// Project forward: assume daily cap roughly doubles each day (conservative estimate)
		let remaining = recipientCount - remainingToday;
		let days = 1;
		let projectedDailyCap = totalDailyCap;

		while (remaining > 0 && days < 30) {
			days++;
			// Conservative: cap increases ~1.5x per day during warmup
			projectedDailyCap = Math.min(projectedDailyCap * 1.5, 200000);
			remaining -= projectedDailyCap;
		}

		const message =
			days >= 30
				? 'Campaign will take approximately 30+ days based on current warmup progress.'
				: `Based on your IP warmup progress, this campaign will take approximately ${days} day${days === 1 ? '' : 's'} to complete.`;

		return {
			totalDailyCap,
			remainingToday,
			estimatedDays: days,
			isFullyWarmed: false,
			message,
		};
	},
});

/**
 * Get per-domain reputation summaries.
 */
export const getDomainReputations = authedQuery({
	args: {},
	handler: async (ctx) => {
		await getUserIdFromSession(ctx);

		// Per-domain rolling summaries, derived on read through the single
		// summarizer (grouped by domain).
		const summaries = await summarizeDomains(ctx.db);

		// Join verification status from the domains table.
		const domains = await ctx.db.query('domains').collect(); // bounded: org-curated sending domains, low-tens at most

		const domainStatusMap = new Map<string, string>();
		for (const d of domains) {
			domainStatusMap.set(d.domain, d.status);
		}

		const results = summaries.map((summary) => ({
			domain: summary.domain,
			riskLevel: summary.riskLevel as string,
			bounceRate: summary.bounceRate,
			complaintRate: summary.complaintRate,
			totalSent: summary.totalSent,
			totalBounced: summary.totalBounced,
			totalComplaints: summary.totalComplaints,
			domainStatus: domainStatusMap.get(summary.domain) ?? null,
		}));

		// Sort by totalSent descending (most active domains first)
		results.sort((a, b) => b.totalSent - a.totalSent);

		return results;
	},
});

/** Per-record email-auth verification state for a sending domain. */
export type DomainAuthState = { spf: boolean; dkim: boolean; dmarc: boolean };

/** One row of the Delivery health page's domain table. */
export interface DeliveryDomainRow {
	domain: string;
	status: 'registering' | 'pending' | 'verified' | 'failed';
	auth: DomainAuthState;
	/** Record names still failing/missing verification (e.g. ['DKIM','DMARC']). */
	missing: string[];
	sent30d: number;
	/**
	 * Rolling 30-day reputation risk for this domain, or `null` when it has no
	 * in-window sending activity (so the health dot can read neutral instead of a
	 * misleading green). This drives the row's health dot; verification drives the
	 * chip — two distinct signals, not the same status twice.
	 */
	riskLevel: RiskLevel | null;
	/** Rolling bounce rate (0–1), `null` when the domain has no in-window activity. */
	bounceRate: number | null;
	/** Rolling complaint rate (0–1), `null` when the domain has no in-window activity. */
	complaintRate: number | null;
	/** FBL complaints / delivered volume, the Gmail/Yahoo-facing rate. */
	spamRate: SpamRateSummary['spamRate'];
	spamRateStatus: SpamRateSummary['status'];
	delivered30d: number;
	complaints30d: number;
	cleanInternalDaysBelowHardThreshold: number;
	/** Latest provider-computed Google signal, distinct from Owlat's FBL rate. */
	googlePostmaster: {
		periodStart: number;
		userReportedSpamRatio: number;
	} | null;
}

/**
 * Whether a domain's SPF / DKIM / DMARC records are each verified, read from the
 * domain's `verificationResults`. DKIM is an array (one entry per selector); it
 * counts as verified only when every selector is present and verified. Pure —
 * unit-testable, and the single place the "is this record good?" rule lives.
 */
export function domainAuthState(
	results:
		| {
				spf?: { verified: boolean } | undefined;
				dkim?: Array<{ verified: boolean }> | undefined;
				dmarc?: { verified: boolean } | undefined;
		  }
		| undefined
): DomainAuthState {
	const spf = results?.spf?.verified === true;
	const dkimEntries = results?.dkim;
	const dkim = Array.isArray(dkimEntries)
		? dkimEntries.length > 0 && dkimEntries.every((r) => r.verified)
		: false;
	const dmarc = results?.dmarc?.verified === true;
	return { spf, dkim, dmarc };
}

/** The record names in `auth` that are not yet verified, in display order. */
export function missingAuthRecords(auth: DomainAuthState): string[] {
	const missing: string[] = [];
	if (!auth.spf) missing.push('SPF');
	if (!auth.dkim) missing.push('DKIM');
	if (!auth.dmarc) missing.push('DMARC');
	return missing;
}

/**
 * The Delivery health page's domain table: every configured sending domain (not
 * just the ones with in-window activity) joined with its email-auth
 * verification summary and its 30-day send volume. This is what lets the page
 * show "SPF · DKIM · DMARC ✓" or name the specific missing record with a fix
 * link, alongside health + volume — one table replacing the old split between
 * the domain reputation table and the separate verification view.
 */
// all-members: domain names, verification state and coarse 30d volumes/rates are org-wide operational status, member-visible — no credentials or per-recipient data.
export const getDeliveryDomainTable = authedQuery({
	args: {},
	handler: async (ctx): Promise<DeliveryDomainRow[]> => {
		await getUserIdFromSession(ctx);

		const domains = await ctx.db.query('domains').collect(); // bounded: org-curated sending domains, low-tens at most
		const bucketGroups = await readDomainReputationBucketGroups(ctx.db);
		const summaries = summarizeDomainReputationGroups(bucketGroups);
		const spamSummaries = summarizeDomainSpamRateGroups(bucketGroups);
		// Keep the whole per-domain reputation summary, not just the volume, so the
		// row can show a health dot from real risk plus bounce/complaint detail.
		const summaryByDomain = new Map<string, (typeof summaries)[number]>();
		for (const summary of summaries) summaryByDomain.set(summary.domain, summary);
		const spamByDomain = new Map(spamSummaries.map((summary) => [summary.domain, summary]));
		const latestGoogleStats = await Promise.all(
			domains.map(async (domainRecord) => {
				const latest = await ctx.db
					.query('googlePostmasterStats')
					.withIndex('by_domain_period', (q) => q.eq('domain', domainRecord.domain))
					.order('desc')
					.first();
				return [domainRecord.domain, latest] as const;
			})
		); // bounded: one indexed point lookup per org-curated sending domain
		const googleByDomain = new Map(latestGoogleStats);

		const rows: DeliveryDomainRow[] = domains.map((domainRecord) => {
			const auth = domainAuthState(domainRecord.verificationResults);
			const summary = summaryByDomain.get(domainRecord.domain);
			const spam = spamByDomain.get(domainRecord.domain);
			const google = googleByDomain.get(domainRecord.domain);
			return {
				domain: domainRecord.domain,
				status: domainRecord.status,
				auth,
				missing: missingAuthRecords(auth),
				sent30d: summary?.totalSent ?? 0,
				// `summarizeDomains` only returns domains with in-window activity, so a
				// missing entry means no reputation signal yet → null, not zero.
				riskLevel: summary?.riskLevel ?? null,
				bounceRate: summary?.bounceRate ?? null,
				complaintRate: summary?.complaintRate ?? null,
				spamRate: spam?.spamRate ?? null,
				spamRateStatus: spam?.status ?? 'no_data',
				delivered30d: spam?.totalDelivered ?? 0,
				complaints30d: spam?.totalComplaints ?? 0,
				cleanInternalDaysBelowHardThreshold: spam?.cleanInternalDaysBelowHardThreshold ?? 0,
				googlePostmaster: google
					? {
							periodStart: google.periodStart,
							userReportedSpamRatio: google.userReportedSpamRatio,
						}
					: null,
			};
		});

		// Most-active domains first, then alphabetically for a stable order.
		rows.sort((a, b) => b.sent30d - a.sent30d || a.domain.localeCompare(b.domain));
		return rows;
	},
});
