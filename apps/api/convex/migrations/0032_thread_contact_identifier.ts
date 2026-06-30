/**
 * ADR-0032 phase 1 — Backfill `contactEmail → contactIdentifier` on every
 * `conversationThreads` row, dropping the stale misnomer field so the row
 * matches the renamed schema.
 *
 * Idempotent: a row that already carries `contactIdentifier` is skipped, so
 * re-running is a no-op. Pre-prod, single org per deployment — the row set
 * is bounded, so this runs synchronously against `.collect()`.
 */

import { internalMutation } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		let updated = 0;
		// `contactEmail` is gone from the schema type post-rename; read it off
		// the on-disk row via a legacy-shape cast.
		const threads = await ctx.db.query('conversationThreads').collect(); // bounded: one-shot pre-prod migration (single org per deployment)
		for (const thread of threads) {
			const legacy = thread as unknown as {
				contactEmail?: string;
				contactIdentifier?: string;
			};
			if (legacy.contactIdentifier !== undefined) continue;
			if (legacy.contactEmail === undefined) continue;
			await ctx.db.patch(thread._id, {
				contactIdentifier: legacy.contactEmail,
				// Remove the stale misnomer field from the row.
				contactEmail: undefined,
			} as unknown as Partial<Doc<'conversationThreads'>>);
			updated++;
		}
		return { updated };
	},
});
