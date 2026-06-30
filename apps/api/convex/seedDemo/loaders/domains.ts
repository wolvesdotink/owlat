/**
 * Seed loader: domains + sendingDomainMtaIdentities.
 *
 * Direct insert in `verified` state — skips `verifyDnsRecords()` from
 * domains/dnsVerification.ts (real DNS lookups) and the provider-registration
 * effect from domains/lifecycle.ts that would call out to MTA/SES.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader } from './types';

interface DomainFixture {
	slug: string;
	domain: string;
	status: 'verified';
	providerType: 'mta';
	dkimSelector: string;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
): Promise<LoadResult> {
	const records = rawRecords as DomainFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'domains'>> = {};
	const now = Date.now();

	for (const rec of records) {
		const existing = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', rec.domain))
			.first();
		if (existing) {
			ids[rec.slug] = existing._id;
			skipped++;
			continue;
		}

		const domainId = await ctx.db.insert('domains', {
			domain: rec.domain,
			status: rec.status,
			providerType: rec.providerType,
			dnsRecords: {
				spf: { type: 'TXT', host: '@', value: 'v=spf1 include:mta.demo include:_spf.demo ~all' },
				dkim: [
					{ type: 'TXT', host: `${rec.dkimSelector}._domainkey`, value: 'v=DKIM1; k=rsa; p=DEMO' },
				],
				dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
			},
			verifiedAt: now,
			lastVerifiedAt: now,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});

		await ctx.db.insert('sendingDomainMtaIdentities', {
			domainId,
			dkimSelector: rec.dkimSelector,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});

		ids[rec.slug] = domainId;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const domainsLoader: Loader = {
	module: 'domains',
	dependencies: [],
	load,
};
