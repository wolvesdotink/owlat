/** Google Postmaster Tools ingestion and retention. */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';

const DAY_MS = 24 * 60 * 60 * 1_000;
const INGEST_MAX_AGE_MS = 14 * DAY_MS;
const RETENTION_MS = 90 * DAY_MS;
export const POSTMASTER_CLEANUP_BATCH_SIZE = 128;
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

export const ingest = internalMutation({
	args: {
		domain: v.string(),
		date: v.string(),
		userReportedSpamRatio: v.number(),
		fetchedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const periodStart = parseGoogleStatsDate(args.date);
		if (
			periodStart === null ||
			periodStart > now ||
			periodStart < now - INGEST_MAX_AGE_MS ||
			!Number.isFinite(args.fetchedAt) ||
			args.fetchedAt < periodStart ||
			args.fetchedAt > now + FETCHED_AT_FUTURE_TOLERANCE_MS ||
			args.domain !== args.domain.toLowerCase() ||
			args.domain.length > 253 ||
			!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(args.domain) ||
			!isRatio(args.userReportedSpamRatio)
		) {
			return { ingested: false, reason: 'invalid_observation' as const };
		}

		// Exact verified-domain join is the tenant boundary: a Google account may
		// expose unrelated domains, but the signed collector cannot create rows for
		// domains this Owlat deployment does not own and currently verify.
		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', args.domain))
			.unique();
		if (!domain || domain.status !== 'verified') {
			return { ingested: false, reason: 'domain_not_verified' as const };
		}

		const values = {
			domainId: domain._id,
			domain: args.domain,
			periodStart,
			userReportedSpamRatio: args.userReportedSpamRatio,
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
			return { ingested: false, reason: 'stale_observation' as const };
		}
		if (existing && existing.fetchedAt === args.fetchedAt) {
			return { ingested: true, updated: false, replayed: true };
		}
		if (existing) await ctx.db.patch(existing._id, values);
		else await ctx.db.insert('googlePostmasterStats', values);
		return { ingested: true, updated: existing !== null };
	},
});

export const cleanup = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('googlePostmasterStats')
			.withIndex('by_period', (q) => q.lt('periodStart', Date.now() - RETENTION_MS))
			.take(POSTMASTER_CLEANUP_BATCH_SIZE);
		for (const row of expired) await ctx.db.delete(row._id);
		const hasMore = expired.length === POSTMASTER_CLEANUP_BATCH_SIZE;
		if (hasMore) await ctx.scheduler.runAfter(0, internal.delivery.postmaster.cleanup, {});
		return { deleted: expired.length, continuationScheduled: hasMore };
	},
});
