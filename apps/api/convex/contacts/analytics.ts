import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { denseDailySeries, utcDayKey } from '../lib/clock';
import { getContactCount } from '../lib/contactCountHelpers';
import { redactContactCapabilityFields } from './listing';
import { readContactGrowth } from './growthCounters';

// Upper bound on the "recent contacts" dashboard read. Callers pass a small
// limit (default 5), but a hostile or buggy caller could ask for an unbounded
// page; clamp it so a single member-readable query can never scan the whole
// Contacts table.
const RECENT_LIMIT_CAP = 500;

// Upper bound on the reactive subscriber-growth scan. A live unbounded collect
// of every contact created in the last 30 days throws once the set exceeds the
// Convex per-query document-read limit (~32k rows); `.take(SCAN_CAP + 1)` keeps
// the read bounded and lets us flag truncation instead of crashing the whole
// audience dashboard.
const GROWTH_SCAN_CAP = 30000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Query to get audience stats for dashboard (for HTTP API)
// Uses cached contact count for O(1) performance.
export const getAudienceStats = authedQuery({
	args: {},
	handler: async (ctx) => {
		// Cached count, else a live count (soft-deleted contacts excluded).
		const totalContacts = await getContactCount(ctx);

		// Get topics count
		const topics = await ctx.db.query('topics').collect(); // bounded: org topics (org-scale config)

		// Get segments count
		const segments = await ctx.db.query('segments').collect(); // bounded: org segments (org-scale config)

		return {
			totalContacts,
			topicCount: topics.length,
			segmentCount: segments.length,
		};
	},
});

/** The 30 UTC days ending today, zero-filled, in the shape the growth chart reads. */
function growthDays(perDay: ReadonlyMap<string, number>, now: number) {
	return denseDailySeries(perDay, 30, now).map(({ date, count }) => ({
		date,
		count,
		// remove after release N+1: the web formats `date` in the reader's locale
		// now; `label` stays one release for older desktop/web clients
		// (CONVENTIONS.md → Old clients and workers).
		label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
	}));
}

// Query to get subscriber growth over time (last 30 days, for HTTP API)
export const getSubscriberGrowth = authedQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const thirtyDaysAgo = now - 30 * DAY_MS;

		// The per-day counter (contacts/growthCounters.ts, plan 3.1) answers with
		// 30 small rows. Until it is backfilled, fall back to the capped scan.
		const counted = await readContactGrowth(ctx.db, utcDayKey(now - 29 * DAY_MS), utcDayKey(now));
		if (counted) return { days: growthDays(counted, now), truncated: false };

		// Get contacts created in the last 30 days using index range. Read the
		// most-recent contacts first and cap the scan: this is a live, reactive
		// subscription and an unbounded collect throws once the 30-day
		// intake exceeds the Convex per-query read limit. Because we take newest
		// first, the recent days always stay complete; if the cap is hit the
		// oldest days in the window undercount and `truncated` flags it.
		//
		// Ride the soft-delete browse index pinned to `deletedAt === undefined`
		// so GDPR-erased contacts never inflate the growth series — the
		// composite index leads with `deletedAt`, then orders by `createdAt`.
		const scanned = await ctx.db
			.query('contacts')
			.withIndex('by_deleted_at_and_created_at', (q) =>
				q.eq('deletedAt', undefined).gte('createdAt', thirtyDaysAgo)
			)
			.order('desc')
			.take(GROWTH_SCAN_CAP + 1);
		const truncated = scanned.length > GROWTH_SCAN_CAP;
		const recentContacts = truncated ? scanned.slice(0, GROWTH_SCAN_CAP) : scanned;

		// Bucket by the shared UTC day key, then zero-fill the 30 UTC days
		// ending today.
		const perDay = new Map<string, number>();
		for (const contact of recentContacts) {
			const dateKey = utcDayKey(contact.createdAt);
			perDay.set(dateKey, (perDay.get(dateKey) ?? 0) + 1);
		}
		// `truncated` is true when the 30-day intake exceeded the scan cap, so
		// the oldest daily buckets undercount; callers can surface that.
		return { days: growthDays(perDay, now), truncated };
	},
});

// Query to get recent contacts (newly added, for HTTP API)
// Uses database-level ordering and limiting for efficiency
export const getRecent = authedQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Clamp the caller-supplied limit into [0, RECENT_LIMIT_CAP] so a single
		// member-readable read is always bounded.
		const limit = Math.min(Math.max(args.limit ?? 5, 0), RECENT_LIMIT_CAP);

		// Ride the soft-delete browse index pinned to `deletedAt === undefined`
		// (leading key) so GDPR-erased contacts never surface, then order by
		// createdAt desc within it. Redact the DOI capability fields
		// (doiConfirmationToken / doiTokenExpiresAt) — a member-readable read must
		// never leak the bearer token for the public /confirm/doi route.
		const recent = await ctx.db
			.query('contacts')
			.withIndex('by_deleted_at_and_created_at', (q) => q.eq('deletedAt', undefined))
			.order('desc')
			.take(limit);
		return recent.map(redactContactCapabilityFields);
	},
});
