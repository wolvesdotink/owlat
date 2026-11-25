/**
 * What `POST /api/v1/domains/{domain}/verify` does (`./domainCheckHttp.ts`):
 * find the sending domain, spend its allowance and queue the check
 * (`domains/requestedVerification.ts`), in one transaction, so a refused
 * request queues nothing and an accepted one is always charged.
 */

import { v } from 'convex/values';
import { MINUTE, type RateLimitConfig } from '@convex-dev/rate-limiter';
import type { DomainCheckRequest } from '@owlat/public-contract';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import { rateLimiter } from '../lib/rateLimiter';
import { internalMutation, readActiveWorkspaceDeletion, refuseWrite } from '../lib/writeFence';

/**
 * One check per domain per minute, whichever key asks: each check is a burst
 * of live DNS lookups against the customer's nameservers, and DNS changes
 * take longer than that to show anyway.
 */
export const DOMAIN_CHECK_BUCKET = 'publicApiDomainCheck';
export const DOMAIN_CHECK_CONFIG: RateLimitConfig = {
	kind: 'token bucket',
	rate: 1,
	period: MINUTE,
	capacity: 1,
};

/** The sending domain a path names: its ID, or its name in any letter case. */
async function findDomain(db: DatabaseReader, ref: string): Promise<Doc<'domains'> | null> {
	const id = db.normalizeId('domains', ref);
	if (id) return await db.get(id);
	const name = ref.trim().toLowerCase().replace(/\.$/, '');
	return await db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', name))
		.first();
}

export type DomainCheckOutcome =
	| { kind: 'queued'; request: DomainCheckRequest }
	| { kind: 'not_found' }
	| { kind: 'registering' }
	| { kind: 'rate_limited'; retryAfterMs: number };

export const requestForApi = internalMutation({
	args: { domain: v.string() },
	handler: async (ctx, args): Promise<DomainCheckOutcome> => {
		const domain = await findDomain(ctx.db, args.domain);
		if (!domain) return { kind: 'not_found' };
		// Its records are not generated yet, so there is nothing to look up.
		if (domain.status === 'registering') return { kind: 'registering' };
		// The check's verdict is a write the fence refuses, so the request is
		// refused up front rather than queued to fail.
		const deletion = await readActiveWorkspaceDeletion(ctx.db);
		if (deletion) refuseWrite(deletion);
		const allowance = await rateLimiter.limit(ctx, DOMAIN_CHECK_BUCKET, {
			key: domain._id,
			config: DOMAIN_CHECK_CONFIG,
		});
		if (!allowance.ok) return { kind: 'rate_limited', retryAfterMs: allowance.retryAfter };
		await ctx.scheduler.runAfter(0, internal.domains.requestedVerification.verifyRequested, {
			domainId: domain._id,
		});
		return {
			kind: 'queued',
			request: {
				id: domain._id,
				domain: domain.domain,
				status: domain.status,
				lastCheckedAt:
					domain.lastVerifiedAt === undefined
						? null
						: new Date(domain.lastVerifiedAt).toISOString(),
				requestedAt: new Date(Date.now()).toISOString(),
			},
		};
	},
});
