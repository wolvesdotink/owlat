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
	const ids: Record<string, Id<'gmailVolumeBuckets'>> = {};
	const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;

	for (const record of records) {
		const existing = await ctx.db
			.query('gmailVolumeBuckets')
			.withIndex('by_domain_hour_shard', (q) =>
				q.eq('primaryDomain', record.primaryDomain).eq('hourStart', hourStart).eq('shardKey', 0)
			)
			.unique();
		if (existing) {
			ids[record.slug] = existing._id;
			skipped++;
			continue;
		}
		const id = await ctx.db.insert('gmailVolumeBuckets', {
			primaryDomain: record.primaryDomain,
			hourStart,
			shardKey: 0,
			deliveredCount: record.deliveredCount,
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
