/**
 * Local folders that mirror a provider's own (user) folders.
 *
 * With full sync (`externalMailAccounts.syncMode`), the worker maps every
 * selectable folder on the provider, not only the six system roles: Gmail
 * labels and IMAP folders appear in Postbox as user folders, mail filed into
 * them there lands in them here, and a move between them in either place is
 * mirrored. The mapping is the account's `externalMailFolderSync` row, keyed by
 * the remote name; this module creates the local side of it.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { startFolderMembership } from '../folderMembership';

/** Numbered variants tried for a name another folder already holds. */
const MAX_NAME_VARIANTS = 50;

/**
 * Find or create the local folder for a remote user folder, given its path of
 * names outermost first (namespace prefix already stripped). Local folder names
 * are unique per mailbox (`mail/folders.ts`), so a name held by a system folder
 * or by a folder elsewhere in the tree gets a numbered variant — "Archive (2)"
 * for a Gmail label called Archive. Returns null for an unusable path.
 */
export async function ensureMirroredFolder(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	path: ReadonlyArray<string>
): Promise<Id<'mailFolders'> | null> {
	let parentId: Id<'mailFolders'> | undefined;
	for (const segment of path) {
		const name = segment.trim();
		if (!name) return null;
		const id = await findOrCreateChild(ctx, mailboxId, name, parentId);
		if (!id) return null;
		parentId = id;
	}
	return parentId ?? null;
}

async function findOrCreateChild(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	name: string,
	parentId: Id<'mailFolders'> | undefined
): Promise<Id<'mailFolders'> | null> {
	for (let n = 1; n <= MAX_NAME_VARIANTS; n++) {
		const candidate = n === 1 ? name : `${name} (${n})`;
		const existing = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_name', (q) => q.eq('mailboxId', mailboxId).eq('name', candidate))
			.first();
		if (!existing) {
			const now = Date.now();
			const folderId = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: candidate,
				parentId,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			await startFolderMembership(ctx, folderId, { isEmpty: true });
			return folderId;
		}
		if (!existing.role && existing.parentId === parentId) return existing._id;
	}
	return null;
}

/**
 * The local folder an ingest lands in: the system folder for `folderRole`, or
 * — for a mirrored user folder, which the worker names by remote name only —
 * the folder its mapping row points at.
 */
export async function resolveIngestFolder(
	ctx: QueryCtx,
	args: {
		accountId: Id<'externalMailAccounts'>;
		mailboxId: Id<'mailboxes'>;
		folderRole?: Doc<'mailFolders'>['role'];
		remoteName: string;
	}
): Promise<Doc<'mailFolders'> | null> {
	if (args.folderRole) {
		const role = args.folderRole;
		return await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', args.mailboxId).eq('role', role))
			.first();
	}
	const mapping = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account_and_remote', (q) =>
			q.eq('accountId', args.accountId).eq('remoteName', args.remoteName)
		)
		.first();
	if (!mapping) return null;
	const folder = await ctx.db.get(mapping.folderId);
	return folder && folder.mailboxId === args.mailboxId ? folder : null;
}

/**
 * Forget the provider mapping of a local folder that is being deleted, so the
 * worker stops ingesting into a folder that no longer exists. The provider's
 * folder is left alone — it may hold mail Owlat never imported.
 */
export async function dropFolderMappings(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<void> {
	const rows = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_folder', (q) => q.eq('folderId', folderId))
		.collect(); // bounded: a folder maps to one remote folder per account
	for (const row of rows) await ctx.db.delete(row._id);
}
