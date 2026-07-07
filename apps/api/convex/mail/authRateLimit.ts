/**
 * Shared Convex-side auth-failure rate limit.
 *
 * The IMAP server has its own Redis-backed limiter that's primary for
 * the hot LOGIN loop. This table is the SMTP submission path's
 * equivalent — the MTA's submission server calls Convex `verify`, which
 * doesn't have access to Redis, so we throttle here.
 *
 * Sliding-window of failures per (address) and per (ip), looked up via
 * index range scans on `occurredAt`. Entries are swept by a daily cron.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';

const WINDOW_MS = 60_000;
const PER_ADDRESS_LIMIT = 5;
const PER_IP_LIMIT = 50;
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

export const recordFailure = internalMutation({
	args: {
		address: v.string(),
		ip: v.optional(v.string()),
		scope: v.union(v.literal('imap'), v.literal('smtp')),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('mailAuthFailures', {
			address: args.address.trim().toLowerCase(),
			ip: args.ip,
			scope: args.scope,
			occurredAt: Date.now(),
		});
	},
});

export const isThrottled = internalQuery({
	args: {
		address: v.string(),
		ip: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<boolean> => {
		const cutoff = Date.now() - WINDOW_MS;
		const lower = args.address.trim().toLowerCase();

		const byAddr = await ctx.db
			.query('mailAuthFailures')
			.withIndex('by_address_and_time', (q) => q.eq('address', lower).gte('occurredAt', cutoff))
			.collect(); // bounded: one address's auth failures in the time window
		if (byAddr.length >= PER_ADDRESS_LIMIT) return true;

		if (args.ip) {
			const byIp = await ctx.db
				.query('mailAuthFailures')
				.withIndex('by_ip_and_time', (q) => q.eq('ip', args.ip).gte('occurredAt', cutoff))
				.collect(); // bounded: one IP's auth failures in the time window
			if (byIp.length >= PER_IP_LIMIT) return true;
		}

		return false;
	},
});

/** Cron-driven sweep — keep the table from growing unbounded. */
export const sweepOld = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - FAILURE_TTL_MS;
		const stale = await ctx.db
			.query('mailAuthFailures')
			.withIndex('by_time', (q) => q.lt('occurredAt', cutoff))
			.take(500);
		for (const row of stale) {
			await ctx.db.delete(row._id);
		}
		return { swept: stale.length };
	},
});
