/**
 * Seed loader: emailBlocks (saved blocks per ADR-0023).
 *
 * Direct insert. The public mutation lives in the saved-block module but is
 * session-gated; we skip it and the rerender-pool dispatch the public path
 * fires after insert (the pool only runs when a block is *edited*, not on
 * fresh creation, so this is a no-op skip).
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader } from './types';

interface SavedBlockFixture {
	slug: string;
	name: string;
	description?: string;
	content: string;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
): Promise<LoadResult> {
	const records = rawRecords as SavedBlockFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'emailBlocks'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('emailBlocks').collect(); // bounded: tiny seed table
	const byName = new Map(existing.map((b) => [b.name, b]));

	for (const rec of records) {
		const found = byName.get(rec.name);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}
		const id = await ctx.db.insert('emailBlocks', {
			name: rec.name,
			description: rec.description,
			content: rec.content,
			usageCount: 0,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		ids[rec.slug] = id;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const savedBlocksLoader: Loader = {
	module: 'savedBlocks',
	dependencies: [],
	load,
};
