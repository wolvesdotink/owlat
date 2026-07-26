/** Google Postmaster Tools ingestion and retention. */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { authedQuery } from '../lib/authedFunctions';
import { getUserIdFromSession } from '../lib/sessionOrganization';
import {
	derivePostmasterCards,
	type PostmasterCard,
	type PostmasterDomainSignals,
} from './postmasterCards';

const DAY_MS = 24 * 60 * 60 * 1_000;
const INGEST_MAX_AGE_MS = 14 * DAY_MS;
const RETENTION_MS = 90 * DAY_MS;
export const POSTMASTER_CLEANUP_BATCH_SIZE = 128;
/** Hard bounds on collector-supplied lists, so a hostile payload stays small. */
export const MAX_DELIVERY_ERROR_CATEGORIES = 24;
export const MAX_COMPLIANCE_CHECKS = 32;
const FETCHED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export function parseGoogleStatsDate(date: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date
		? parsed
		: null;
}

function isRatio(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCanonicalDomain(domain: string): boolean {
	return (
		domain === domain.toLowerCase() &&
		domain.length <= 253 &&
		/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain)
	);
}

async function findVerifiedDomain(ctx: Pick<MutationCtx, 'db'>, domain: string) {
	if (!isCanonicalDomain(domain)) return null;
	const row = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.unique();
	return row?.status === 'verified' ? row : null;
}

/** Fail-closed preflight before the collector retains any per-domain state. */
export const authorizeDomain = internalMutation({
	args: { domain: v.string() },
	handler: async (ctx, args) => ({
		authorized: (await findVerifiedDomain(ctx, args.domain)) !== null,
	}),
});

/** Bounded, sanitized delivery-error breakdown; anything unusable is dropped. */
function sanitizeDeliveryErrors(
	raw: Array<{ category: string; ratio: number }> | undefined
): Array<{ category: string; ratio: number }> | undefined {
	if (raw === undefined) return undefined;
	const byCategory = new Map<string, number>();
	for (const entry of raw) {
		if (byCategory.size >= MAX_DELIVERY_ERROR_CATEGORIES) break;
		// The category is rendered, so only an opaque enum-shaped token is kept.
		if (!/^[A-Z0-9_]{1,64}$/.test(entry.category) || !isRatio(entry.ratio)) continue;
		if (!byCategory.has(entry.category)) byCategory.set(entry.category, entry.ratio);
	}
	return byCategory.size === 0
		? undefined
		: [...byCategory].map(([category, ratio]) => ({ category, ratio }));
}

/**
 * De-duplicated, bounded Compliance Status checks. A check name that is not an
 * opaque enum-shaped token is dropped rather than escaped: the name is stored
 * and rendered, and nothing but `[A-Z0-9_]` ever needs to be.
 */
function sanitizeComplianceChecks(
	raw: Array<{ name: string; state: 'passing' | 'failing' | 'unknown' }>
): Array<{ name: string; state: 'passing' | 'failing' | 'unknown' }> {
	const byName = new Map<string, 'passing' | 'failing' | 'unknown'>();
	for (const check of raw) {
		if (byName.size >= MAX_COMPLIANCE_CHECKS) break;
		if (!/^[A-Z0-9_]{1,64}$/.test(check.name) || byName.has(check.name)) continue;
		byName.set(check.name, check.state);
	}
	return [...byName].map(([name, state]) => ({ name, state }));
}

/** An optional ratio that is dropped rather than stored when out of range. */
function optionalRatio(value: number | undefined): number | undefined {
	return value !== undefined && isRatio(value) ? value : undefined;
}

export const ingest = internalMutation({
	args: {
		domain: v.string(),
		date: v.string(),
		userReportedSpamRatio: v.number(),
		spfSuccessRatio: v.optional(v.number()),
		dkimSuccessRatio: v.optional(v.number()),
		dmarcSuccessRatio: v.optional(v.number()),
		deliveryErrorRatio: v.optional(v.number()),
		deliveryErrors: v.optional(v.array(v.object({ category: v.string(), ratio: v.number() }))),
		fetchedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const periodStart = parseGoogleStatsDate(args.date);
		const domain = await findVerifiedDomain(ctx, args.domain);
		if (!domain) {
			return { ingested: false, authorized: false, reason: 'domain_not_verified' as const };
		}
		if (
			periodStart === null ||
			periodStart > now ||
			periodStart < now - INGEST_MAX_AGE_MS ||
			!Number.isFinite(args.fetchedAt) ||
			args.fetchedAt < periodStart ||
			args.fetchedAt > now + FETCHED_AT_FUTURE_TOLERANCE_MS ||
			!isCanonicalDomain(args.domain) ||
			!isRatio(args.userReportedSpamRatio)
		) {
			return { ingested: false, authorized: true, reason: 'invalid_observation' as const };
		}

		// A metric Google withheld for the day, or one that arrives out of range,
		// is simply absent from the row — never a rejected observation, because
		// the spam ratio it travels with is still worth keeping.
		const spfSuccessRatio = optionalRatio(args.spfSuccessRatio);
		const dkimSuccessRatio = optionalRatio(args.dkimSuccessRatio);
		const dmarcSuccessRatio = optionalRatio(args.dmarcSuccessRatio);
		const deliveryErrorRatio = optionalRatio(args.deliveryErrorRatio);
		const deliveryErrors = sanitizeDeliveryErrors(args.deliveryErrors);
		const values = {
			domainId: domain._id,
			domain: args.domain,
			periodStart,
			userReportedSpamRatio: args.userReportedSpamRatio,
			...(spfSuccessRatio !== undefined ? { spfSuccessRatio } : {}),
			...(dkimSuccessRatio !== undefined ? { dkimSuccessRatio } : {}),
			...(dmarcSuccessRatio !== undefined ? { dmarcSuccessRatio } : {}),
			...(deliveryErrorRatio !== undefined ? { deliveryErrorRatio } : {}),
			...(deliveryErrors !== undefined ? { deliveryErrors } : {}),
			fetchedAt: args.fetchedAt,
			ingestedAt: now,
		};
		const existing = await ctx.db
			.query('googlePostmasterStats')
			.withIndex('by_domain_period', (q) =>
				q.eq('domain', args.domain).eq('periodStart', periodStart)
			)
			.unique();
		if (existing && existing.fetchedAt > args.fetchedAt) {
			return { ingested: false, authorized: true, reason: 'stale_observation' as const };
		}
		if (existing && existing.fetchedAt === args.fetchedAt) {
			return { ingested: true, authorized: true, updated: false, replayed: true };
		}
		// `replace`, not `patch`: a metric Google stops reporting for the day must
		// disappear from the row rather than linger from the previous fetch.
		if (existing) await ctx.db.replace(existing._id, values);
		else await ctx.db.insert('googlePostmasterStats', values);
		return { ingested: true, authorized: true, updated: existing !== null };
	},
});

/**
 * The v2 Compliance Status verdict for one domain/day.
 *
 * Shares the statistics path's authorization and freshness rules so a forged
 * or replayed verdict cannot land, and stores at most
 * `MAX_COMPLIANCE_CHECKS` de-duplicated, enum-shaped check names.
 */
export const ingestCompliance = internalMutation({
	args: {
		domain: v.string(),
		date: v.string(),
		checks: v.array(
			v.object({
				name: v.string(),
				state: v.union(v.literal('passing'), v.literal('failing'), v.literal('unknown')),
			})
		),
		fetchedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const periodStart = parseGoogleStatsDate(args.date);
		const domain = await findVerifiedDomain(ctx, args.domain);
		if (!domain) {
			return { ingested: false, authorized: false, reason: 'domain_not_verified' as const };
		}
		const checks = sanitizeComplianceChecks(args.checks);
		if (
			periodStart === null ||
			periodStart > now ||
			periodStart < now - INGEST_MAX_AGE_MS ||
			!Number.isFinite(args.fetchedAt) ||
			args.fetchedAt < periodStart ||
			args.fetchedAt > now + FETCHED_AT_FUTURE_TOLERANCE_MS ||
			!isCanonicalDomain(args.domain) ||
			checks.length === 0
		) {
			return { ingested: false, authorized: true, reason: 'invalid_observation' as const };
		}

		const values = {
			domainId: domain._id,
			domain: args.domain,
			periodStart,
			checks,
			fetchedAt: args.fetchedAt,
			ingestedAt: now,
		};
		const existing = await ctx.db
			.query('googlePostmasterCompliance')
			.withIndex('by_domain_period', (q) =>
				q.eq('domain', args.domain).eq('periodStart', periodStart)
			)
			.unique();
		if (existing && existing.fetchedAt > args.fetchedAt) {
			return { ingested: false, authorized: true, reason: 'stale_observation' as const };
		}
		if (existing && existing.fetchedAt === args.fetchedAt) {
			return { ingested: true, authorized: true, updated: false, replayed: true };
		}
		if (existing) await ctx.db.replace(existing._id, values);
		else await ctx.db.insert('googlePostmasterCompliance', values);
		return { ingested: true, authorized: true, updated: existing !== null };
	},
});

export const cleanup = internalMutation({
	args: {},
	handler: async (ctx) => {
		const horizon = Date.now() - RETENTION_MS;
		const expired = await ctx.db
			.query('googlePostmasterStats')
			.withIndex('by_period', (q) => q.lt('periodStart', horizon))
			.take(POSTMASTER_CLEANUP_BATCH_SIZE);
		for (const row of expired) await ctx.db.delete(row._id);
		const expiredCompliance = await ctx.db
			.query('googlePostmasterCompliance')
			.withIndex('by_period', (q) => q.lt('periodStart', horizon))
			.take(POSTMASTER_CLEANUP_BATCH_SIZE);
		for (const row of expiredCompliance) await ctx.db.delete(row._id);
		const hasMore =
			expired.length === POSTMASTER_CLEANUP_BATCH_SIZE ||
			expiredCompliance.length === POSTMASTER_CLEANUP_BATCH_SIZE;
		if (hasMore) await ctx.scheduler.runAfter(0, internal.delivery.postmaster.cleanup, {});
		return { deleted: expired.length, continuationScheduled: hasMore };
	},
});

/** One sending domain's latest Postmaster observation, plus its action cards. */
export interface PostmasterDomainStatus extends PostmasterDomainSignals {
	/** Start of the UTC day the statistics describe, or `null` when there are none. */
	periodStart: number | null;
	/** Start of the UTC day the Compliance Status verdict describes. */
	compliancePeriodStart: number | null;
	cards: PostmasterCard[];
}

export interface PostmasterStatus {
	/**
	 * Whether ANY Postmaster data has ever arrived. `false` is a supported
	 * configuration — the operator simply has not connected a Google account —
	 * and the UI renders it as an invitation, never as an error.
	 */
	connected: boolean;
	domains: PostmasterDomainStatus[];
}

// all-members: Postmaster verdicts and provider-measured rates for the org's own
// sending domains are operational status, member-visible — no credentials, no
// per-recipient data.
export const getPostmasterStatus = authedQuery({
	args: {},
	handler: async (ctx): Promise<PostmasterStatus> => {
		await getUserIdFromSession(ctx);

		const domains = await ctx.db.query('domains').collect(); // bounded: org-curated sending domains, low-tens at most
		const statuses = await Promise.all(
			domains.map(async (domainRecord): Promise<PostmasterDomainStatus> => {
				const [stats, compliance] = await Promise.all([
					ctx.db
						.query('googlePostmasterStats')
						.withIndex('by_domain_period', (q) => q.eq('domain', domainRecord.domain))
						.order('desc')
						.first(),
					ctx.db
						.query('googlePostmasterCompliance')
						.withIndex('by_domain_period', (q) => q.eq('domain', domainRecord.domain))
						.order('desc')
						.first(),
				]); // bounded: two indexed point lookups per sending domain
				const signals: PostmasterDomainSignals = {
					domain: domainRecord.domain,
					userReportedSpamRatio: stats?.userReportedSpamRatio ?? null,
					spfSuccessRatio: stats?.spfSuccessRatio ?? null,
					dkimSuccessRatio: stats?.dkimSuccessRatio ?? null,
					dmarcSuccessRatio: stats?.dmarcSuccessRatio ?? null,
					deliveryErrorRatio: stats?.deliveryErrorRatio ?? null,
					deliveryErrors: stats?.deliveryErrors ?? [],
					checks: compliance?.checks ?? [],
				};
				return {
					...signals,
					periodStart: stats?.periodStart ?? null,
					compliancePeriodStart: compliance?.periodStart ?? null,
					cards: derivePostmasterCards(signals),
				};
			})
		);

		return {
			connected: statuses.some(
				(status) => status.periodStart !== null || status.compliancePeriodStart !== null
			),
			// Domains with something to say first, then alphabetically for stability.
			domains: statuses.sort(
				(a, b) => b.cards.length - a.cards.length || a.domain.localeCompare(b.domain)
			),
		};
	},
});
