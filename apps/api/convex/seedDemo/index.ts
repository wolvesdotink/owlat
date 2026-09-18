/**
 * Demo seed entry point — the mutation the `POST /seed/demo` route
 * (`seedDemo/indexHttp.ts`) drives.
 *
 * DEV ONLY, and it stays that way: this seed creates the dummy teammate
 * sign-ins whose passwords are published fixture hashes. A real install that
 * wants demo content uses the sample-data path instead (`sampleData/`,
 * `POST /sample-data/install`), which runs the same loaders minus the
 * accounts/mailboxes and needs no dev mode.
 *
 * Loaders run in topological order based on their declared `dependencies`
 * (see `./pipeline`). Each loader inserts rows tagged with `seedTag: 'demo'`
 * so reset can find them again. Exception: the `accounts` loader writes
 * BetterAuth component rows, which cannot carry the tag — it dedupes by email
 * instead and is only wiped by the full `POST /dev/reset`.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { applyLoaders, isRemovableSeedRow, SEEDED_TABLES, type SeedSummary } from './pipeline';

export type { SeedSummary } from './pipeline';

export const runSeedDemo = internalMutation({
	args: {
		reset: v.boolean(),
	},
	handler: async (ctx, { reset }): Promise<SeedSummary> => {
		const summary: SeedSummary = { inserted: {}, skipped: {} };

		if (reset) {
			summary.deleted = {};
			for (const table of SEEDED_TABLES) {
				const rows = await ctx.db.query(table).collect(); // bounded: dev-only seed table
				let removed = 0;
				for (const row of rows) {
					if (isRemovableSeedRow(row)) {
						await ctx.db.delete(row._id);
						removed++;
					}
				}
				if (removed > 0) summary.deleted[table] = removed;
			}
		}

		const { inserted, skipped } = await applyLoaders(ctx);
		summary.inserted = inserted;
		summary.skipped = skipped;
		return summary;
	},
});
