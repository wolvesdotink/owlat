/**
 * Seed loader: contacts.
 *
 * Inserts directly into `contacts` + `contactIdentities`. The public
 * `api.contacts.contacts.create` mutation is skipped because it requires an
 * authenticated session and emits PostHog telemetry + activity-timeline rows
 * we don't need in seed.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader } from './types';

type Source = 'api' | 'import' | 'form' | 'transactional' | 'inbound';
type DoiStatus = 'not_required' | 'pending' | 'confirmed';

interface ContactFixture {
	slug: string;
	email: string;
	firstName?: string;
	lastName?: string;
	source: Source;
	doiStatus: DoiStatus;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
): Promise<LoadResult> {
	const records = rawRecords as ContactFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'contacts'>> = {};
	const now = Date.now();

	for (const rec of records) {
		const existing = await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) => q.eq('email', rec.email))
			.first();
		if (existing) {
			ids[rec.slug] = existing._id;
			skipped++;
			continue;
		}

		const searchable = [rec.email, rec.firstName, rec.lastName].filter(Boolean).join(' ');

		const id = await ctx.db.insert('contacts', {
			email: rec.email,
			firstName: rec.firstName,
			lastName: rec.lastName,
			source: rec.source,
			doiStatus: rec.doiStatus,
			doiConfirmedAt: rec.doiStatus === 'confirmed' ? now : undefined,
			searchableText: searchable,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});

		await ctx.db.insert('contactIdentities', {
			contactId: id,
			channel: 'email',
			identifier: rec.email,
			isPrimary: true,
			verifiedAt: rec.doiStatus === 'confirmed' ? now : undefined,
			seedTag: SEED_TAG,
			createdAt: now,
		});

		ids[rec.slug] = id;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const contactsLoader: Loader = {
	module: 'contacts',
	dependencies: [],
	load,
};
