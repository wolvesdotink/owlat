/**
 * Re-run a finished mailbox import's knowledge sweep.
 *
 * An import that completed without knowledge — the team-inbox opt-in left
 * unticked, or a sweep that ran while the default local embedder could store
 * nothing (768-dim vectors rejected by the 1536-wide index, no model pulled) —
 * otherwise only gets its mail into the knowledge graph by re-importing the
 * whole mailbox. An operator runs
 * `convex run migrations/0050_reindex_mailbox_knowledge:run '{"migrationId":"..."}'`
 * with the id of the import's `mailboxMigrations` row.
 *
 * Safe to re-run: messages that already produced entries are counted, not
 * re-extracted.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';

export const run = internalAction({
	args: { migrationId: v.id('mailboxMigrations') },
	handler: async (ctx, args): Promise<{ started: boolean; reason?: string }> =>
		await ctx.runMutation(internal.mail.migrationIndexing.reindexMigration, {
			migrationId: args.migrationId,
		}),
});
