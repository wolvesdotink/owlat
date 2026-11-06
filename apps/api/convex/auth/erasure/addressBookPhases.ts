/**
 * The personal mailbox's address book, erased with the mailbox
 * (`eraseMailboxRecords`): every row with the picture it owns, and the CardDAV
 * account syncing into it with its sealed password.
 */

import type { Id } from '../../_generated/dataModel';
import { drainEach } from '../../contacts/erasure/phaseKit';
import { deleteBlobQuietly } from '../../lib/storageBlobs';
import type { MemberPhaseContext } from './phaseKit';

/** Whether the book is gone; false when the budget ran out first. */
export async function eraseAddressBook(
	phase: MemberPhaseContext,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	const { ctx, budget } = phase;
	const isBookErased = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('mailContacts')
				.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		async (row) => {
			if (row.photoStorageId) {
				await deleteBlobQuietly(ctx.storage, row.photoStorageId, '[member erasure]', {
					contactId: row._id,
				});
			}
			await ctx.db.delete(row._id);
		}
	);
	if (!isBookErased) return false;
	return drainEach(
		budget,
		(n) =>
			ctx.db
				.query('mailCardDavAccounts')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.take(n),
		(account) => ctx.db.delete(account._id)
	);
}
