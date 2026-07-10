import { permanentlyDeleteContactWithRelations } from '../../../lib/contactMutations';
import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Delegating step: routes through the single canonical contact cascade
 * writer (`permanentlyDeleteContactWithRelations` in
 * `lib/contactMutations.ts`). Closes drift #1 — pre-deepening the
 * org-wipe path open-coded a divergent cascade that skipped
 * `contactRelationships` and hard-deleted sends instead of soft-marking
 * them. Now both the 30-day soft-delete cron and the org-wipe path
 * route through one helper.
 *
 * By the time this step runs, `emailSends` and `transactionalSends`
 * are already empty (their steps ran earlier in `STEPS`), so the
 * helper's soft-mark-sends loop is a no-op index lookup — no waste, no
 * special flag needed. `decrementCount: false` because the
 * `instanceSettings.contactCount` cache is going away with the
 * terminal step.
 */
export const contactsStep = defineStep({
	table: 'contacts',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('contacts').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await permanentlyDeleteContactWithRelations(ctx, row._id, {
				decrementCount: false,
			});
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
