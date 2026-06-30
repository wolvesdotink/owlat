/**
 * Seed loader: topics.
 *
 * Inserts directly into the `topics` table. Public `api.topics.topics.create`
 * is skipped because it goes through `getMutationContext()` (org-member auth).
 * The seed runs from an HTTP action without a session, so direct insert is
 * the only path.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader } from './types';

interface TopicFixture {
	slug: string;
	name: string;
	description?: string;
	requireDoubleOptIn?: boolean;
	displayOrder?: number;
	isDefault?: boolean;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
): Promise<LoadResult> {
	const records = rawRecords as TopicFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'topics'>> = {};
	const now = Date.now();

	const existingTopics = await ctx.db.query('topics').collect(); // bounded: tiny seed table
	const byName = new Map(existingTopics.map((t) => [t.name, t]));

	for (const rec of records) {
		const existing = byName.get(rec.name);
		if (existing) {
			ids[rec.slug] = existing._id;
			skipped++;
			continue;
		}
		const id = await ctx.db.insert('topics', {
			name: rec.name,
			description: rec.description,
			requireDoubleOptIn: rec.requireDoubleOptIn,
			displayOrder: rec.displayOrder,
			isDefault: rec.isDefault,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		ids[rec.slug] = id;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const topicsLoader: Loader = {
	module: 'topics',
	dependencies: [],
	load,
};
