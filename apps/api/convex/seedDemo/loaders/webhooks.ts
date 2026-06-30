/**
 * Seed loader: webhooks.
 *
 * Direct insert — public mutation is session-gated. The deliveries pool would
 * not touch a freshly-created webhook anyway (it only fires when events
 * arrive), so no side effect to bypass.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { SEED_TAG, type LoadResult, type Loader } from './types';

type WebhookEvent =
	| 'email.sent'
	| 'email.delivered'
	| 'email.opened'
	| 'email.clicked'
	| 'email.bounced'
	| 'email.complained'
	| 'contact.created'
	| 'topic.unsubscribed';

interface WebhookFixture {
	slug: string;
	name: string;
	url: string;
	events: WebhookEvent[];
	isActive: boolean;
}

async function load(
	ctx: MutationCtx,
	rawRecords: unknown[],
): Promise<LoadResult> {
	const records = rawRecords as WebhookFixture[];
	let inserted = 0;
	let skipped = 0;
	const ids: Record<string, Id<'webhooks'>> = {};
	const now = Date.now();

	const existing = await ctx.db.query('webhooks').collect(); // bounded: tiny seed table
	const byName = new Map(existing.map((w) => [w.name, w]));

	for (const rec of records) {
		const found = byName.get(rec.name);
		if (found) {
			ids[rec.slug] = found._id;
			skipped++;
			continue;
		}
		// Use cryptographic randomness even for demo data — keeps the value
		// out of trivial brute-force range if the receiver URL is ever pointed
		// at a real endpoint during exploratory dev work.
		const secret = `whsec_seed_${crypto.randomUUID().replace(/-/g, '')}`;
		const id = await ctx.db.insert('webhooks', {
			name: rec.name,
			url: rec.url,
			events: rec.events,
			secret,
			isActive: rec.isActive,
			seedTag: SEED_TAG,
			createdAt: now,
			updatedAt: now,
		});
		ids[rec.slug] = id;
		inserted++;
	}

	return { inserted, skipped, ids };
}

export const webhooksLoader: Loader = {
	module: 'webhooks',
	dependencies: [],
	load,
};
