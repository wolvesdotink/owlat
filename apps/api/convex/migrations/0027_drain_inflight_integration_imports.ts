/**
 * ADR-0027 — Drain in-flight integration imports during the cutover from the
 * per-provider `processMailchimpPage` / `processStripePage` actions to the
 * unified `processIntegrationPage` walker.
 *
 * Any `integrationImports` row at `'running'` when this deploys would have
 * its next scheduled `processMailchimpPage` / `processStripePage`
 * invocation arrive at a deleted action. Mitigation: patch every
 * `'running'` row to `'failed'` with an explanatory `errorMessage`. The
 * frontend already surfaces per-row error messages, so the operator sees
 * the message and re-starts the import under the new
 * `startIntegrationImport` surface.
 *
 * Idempotent: re-running is a no-op once every running row has been
 * patched (the `by_status` lookup returns nothing).
 */

import { internalMutation } from '../_generated/server';

const DRAIN_MESSAGE =
	'Migration to integration-import walker (ADR-0027); please retry.';

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		const running = await ctx.db
			.query('integrationImports')
			.withIndex('by_status', (q) => q.eq('status', 'running'))
			.collect(); // bounded: one-shot pre-prod migration

		const now = Date.now();
		for (const row of running) {
			await ctx.db.patch(row._id, {
				status: 'failed',
				errors: [...row.errors, DRAIN_MESSAGE].slice(0, 20),
				completedAt: now,
			});
		}

		return { drained: running.length };
	},
});
