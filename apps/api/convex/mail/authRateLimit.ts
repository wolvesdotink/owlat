/**
 * Shared Convex-side auth-failure rate limit.
 *
 * Every app-password login goes through `verify`, which consults this table:
 * SMTP submission (the MTA forwards the client's IP in the signed verify
 * request) and IMAP (which passes its peer's IP). The IMAP server also keeps a
 * Redis limiter in front of it for the hot LOGIN loop; both enforce the policy
 * in `@owlat/shared/mailAuthPolicy`.
 *
 * Sliding-window of failures per (address) and per (ip), looked up via
 * index range scans on `occurredAt`. The ip is stored as its rate-limit key
 * (an IPv6 client counts per /64). Entries are swept by a daily cron.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { normalizeEmail } from '@owlat/shared';
import { ipRateLimitKey } from '@owlat/shared/ipAddress';
import {
	MAIL_AUTH_FAILURE_WINDOW_MS,
	MAIL_AUTH_FAILURES_PER_ADDRESS,
	MAIL_AUTH_FAILURES_PER_IP,
} from '@owlat/shared/mailAuthPolicy';
import { mailAppPasswordScopeValidator } from '../lib/literalValidators';

const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The `mailAuthFailures.scope`s this limiter owns. Other modules share the
 * table but not the budget — `e2ee/memberKeys.ts` records `recovery-kit`
 * failures against the same address, and those must never count towards mail
 * submission, or a member fumbling a settings password prompt would lock their
 * own mail client out of SMTP/IMAP. The isolation has to hold in BOTH
 * directions, so this counts only its own scopes rather than everything the
 * address has ever failed.
 */
const OWNED_SCOPES = new Set<string>(['imap', 'smtp']);

export const recordFailure = internalMutation({
	args: {
		address: v.string(),
		ip: v.optional(v.string()),
		scope: mailAppPasswordScopeValidator,
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('mailAuthFailures', {
			address: normalizeEmail(args.address),
			ip: args.ip === undefined ? undefined : ipRateLimitKey(args.ip),
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
		const cutoff = Date.now() - MAIL_AUTH_FAILURE_WINDOW_MS;
		const lower = normalizeEmail(args.address);

		const byAddr = await ctx.db
			.query('mailAuthFailures')
			.withIndex('by_address_and_time', (q) => q.eq('address', lower).gte('occurredAt', cutoff))
			.collect(); // bounded: one address's auth failures in the time window
		if (byAddr.filter((f) => OWNED_SCOPES.has(f.scope)).length >= MAIL_AUTH_FAILURES_PER_ADDRESS) {
			return true;
		}

		if (args.ip) {
			const ipKey = ipRateLimitKey(args.ip);
			const byIp = await ctx.db
				.query('mailAuthFailures')
				.withIndex('by_ip_and_time', (q) => q.eq('ip', ipKey).gte('occurredAt', cutoff))
				.collect(); // bounded: one IP's auth failures in the time window
			// Recovery-kit rows carry no ip today, so filtering here is belt and
			// braces — it keeps the by-IP budget honest if one ever does.
			if (byIp.filter((f) => OWNED_SCOPES.has(f.scope)).length >= MAIL_AUTH_FAILURES_PER_IP) {
				return true;
			}
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
