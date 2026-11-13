/**
 * `mailThreads.inboxLastMessageAt`: the thread's `lastMessageAt` while one of
 * its messages sits in the Inbox, `null` while none does.
 *
 * `folderRoles` is an array and Convex cannot index one, so without this the
 * conversation list could only walk a mailbox's threads by recency and drop
 * the ones outside the Inbox: a mailbox whose recent mail is archived read
 * hundreds of threads to show a handful, and stopped before older Inbox
 * threads. `by_mailbox_inbox_recency` holds exactly the Inbox threads.
 *
 * Every write of `folderRoles` or `lastMessageAt` sets it in the same patch,
 * from the values that patch leaves on the row. A thread written before the
 * field has none until `migrations/0072_backfill_thread_inbox_recency`
 * reaches it, so the list reads the index only once that migration completed
 * ({@link isInboxRecencyIndexReady}) and scans by recency before.
 *
 * Not a Convex function; shared by the thread writers and the list read.
 */

import type { QueryCtx } from '../_generated/server';
import { readMigrationRun } from '../lib/migrationLedger';

/** The ledger row whose completion makes the index safe to read. */
export const INBOX_RECENCY_MIGRATION = '0072_backfill_thread_inbox_recency';

/** The value `inboxLastMessageAt` holds for these folder roles and recency. */
export function inboxLastMessageAt(thread: {
	folderRoles: readonly string[];
	lastMessageAt: number;
}): number | null {
	return thread.folderRoles.includes('inbox') ? thread.lastMessageAt : null;
}

/** Every thread carries the field, so the index holds every Inbox thread. */
export async function isInboxRecencyIndexReady(ctx: { db: QueryCtx['db'] }): Promise<boolean> {
	const run = await readMigrationRun(ctx, INBOX_RECENCY_MIGRATION);
	return run?.status === 'completed';
}
