/**
 * Seed loader: contactTopics (contact-topic memberships).
 *
 * Resolves contact + topic by slug via refs, then inserts directly. Skipped
 * the public subscription mutation because it triggers DOI lifecycle (token
 * generation, confirmation-email enqueue) we don't want in seed.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader, type SeedRefs } from './types';

interface MembershipFixture {
	contact: string;
	topic: string;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
	refs: SeedRefs,
): Promise<LoadResult> {
	const records = rawRecords as MembershipFixture[];
	let inserted = 0;
	let skipped = 0;
	const now = Date.now();

	for (const rec of records) {
		const contactId = refs['contacts']?.[rec.contact] as Id<'contacts'> | undefined;
		const topicId = refs['topics']?.[rec.topic] as Id<'topics'> | undefined;
		if (!contactId || !topicId) {
			skipped++;
			continue;
		}

		const existing = await ctx.db
			.query('contactTopics')
			.withIndex('by_contact_and_topic', (q) =>
				q.eq('contactId', contactId).eq('topicId', topicId),
			)
			.first();
		if (existing) {
			skipped++;
			continue;
		}

		await ctx.db.insert('contactTopics', {
			contactId,
			topicId,
			addedAt: now,
			seedTag: SEED_TAG,
		});
		inserted++;
	}

	return { inserted, skipped, ids: {} };
}

export const contactTopicsLoader: Loader = {
	module: 'contactTopics',
	dependencies: ['contacts', 'topics'],
	load,
};
