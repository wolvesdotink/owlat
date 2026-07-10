import { defineStep, DEFAULT_BATCH_SIZE, type OrganizationDeletionTable } from './_common';

/**
 * Generic full-table sweep step for tables that need no per-row side effects
 * (no storage blobs to purge, no delegated cascades) — just batched deletes.
 *
 * Most of the 41 tables this covers were silently MISSING from the wipe
 * before: 'Delete organization' left unifiedMessages, the whole Postbox
 * sidecar family (mailThreads/mailContacts/mailAuditLog/…), chat history,
 * agent state, and — worst — externalMailAccounts with encrypted IMAP/SMTP
 * credentials sitting in the database after the org was "deleted". The
 * compile-time guard in _common.ts now forces every TENANT_TABLES entry to
 * have a step, so a new table can't regrow that gap.
 */
export function makeSweepStep<T extends OrganizationDeletionTable>(table: T) {
	return defineStep({
		table,
		async deleteBatch(ctx) {
			const rows = await ctx.db.query(table).take(DEFAULT_BATCH_SIZE);
			for (const row of rows) await ctx.db.delete(row._id);
			return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
		},
	});
}
