/** Seed an explicit Gmail-proximity state for staging/demo acceptance. */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader } from './types';

interface ComplianceFixture {
	slug: string;
	primaryDomain: string;
	deliveredCount: number;
}

async function load(ctx: MutationCtx, rawRecords: unknown[]): Promise<LoadResult> {
	const records = rawRecords as ComplianceFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'gmailDomainVolumeRollups'>> = {};
	const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;

	for (const record of records) {
		const existing = await ctx.db
			.query('gmailDomainVolumeRollups')
			.withIndex('by_domain', (q) => q.eq('primaryDomain', record.primaryDomain))
			.unique();
		if (existing) {
			ids[record.slug] = existing._id;
			skipped++;
			continue;
		}
		const id = await ctx.db.insert('gmailDomainVolumeRollups', {
			primaryDomain: record.primaryDomain,
			hourlyCounts: [{ hourStart, deliveredCount: record.deliveredCount }],
			deliveredCount: record.deliveredCount,
			windowRefreshedAt: Date.now(),
			seedTag: SEED_TAG,
		});
		ids[record.slug] = id;
		inserted++;
	}
	return { inserted, skipped, ids };
}

export const complianceTelemetryLoader: Loader = {
	module: 'complianceTelemetry',
	dependencies: [],
	load,
};
