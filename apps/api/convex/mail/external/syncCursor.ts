/**
 * The per-folder forward-sync cursor (`externalMailFolderSync`), advanced by
 * every ingest in `./delivery.ts`. Split out of that module for its size cap.
 *
 * Isolate-safe; not a Convex function.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';

/** Upsert the (account, remoteName) cursor, advancing lastSeenUid monotonically. */
export async function advanceCursor(
	ctx: MutationCtx,
	args: {
		accountId: Id<'externalMailAccounts'>;
		remoteName: string;
		remoteUid: number;
		remoteUidValidity: number;
	},
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	const now = Date.now();
	const existing = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account_and_remote', (q) =>
			q.eq('accountId', args.accountId).eq('remoteName', args.remoteName)
		)
		.first();
	if (existing) {
		await ctx.db.patch(existing._id, {
			lastSeenUid: Math.max(existing.lastSeenUid, args.remoteUid),
			remoteUidValidity: args.remoteUidValidity,
			lastSyncedAt: now,
			forwardIngestFailures: existing.forwardIngestFailures?.filter(
				(failure) => failure.uid !== args.remoteUid
			),
		});
		return;
	}
	// No mapping row yet (worker ingesting before discovery recorded it) — find
	// the local folder so the cursor row is complete.
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
	if (!folder) return;
	await ctx.db.insert('externalMailFolderSync', {
		accountId: args.accountId,
		mailboxId,
		folderId: folder._id,
		remoteName: args.remoteName,
		remoteUidValidity: args.remoteUidValidity,
		lastSeenUid: args.remoteUid,
		lastSyncedAt: now,
	});
}
