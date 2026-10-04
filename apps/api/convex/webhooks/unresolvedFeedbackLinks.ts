/**
 * Keeping `unresolvedFeedback` rows reachable by the contact erasure (#1194).
 *
 * A stored bounce or complaint names an address, and is linked to the contact
 * that owned it when it arrived. A row stored BEFORE the address belonged to
 * anyone has no link; the erasure can only find it by address while the
 * contact still has that address. These helpers run at the moments an address
 * stops being findable that way, while it is still known:
 *  - an email identity is removed (`linkUnresolvedFeedbackToContact`): the
 *    unlinked rows naming it are linked to the contact, so a later erasure
 *    finds them by id;
 *  - the erasure deletes an identity (`deleteUnresolvedFeedbackForAddress`):
 *    the rows naming it go first.
 *
 * A leaf module (data access only) so the contact modules can call it without
 * an import cycle through the webhook functions.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { normalizeEmail } from '../lib/inputGuards';

const BATCH = 100;

/** Link every unlinked row naming `address` to `contactId`. */
export async function linkUnresolvedFeedbackToContact(
	ctx: MutationCtx,
	contactId: Id<'contacts'>,
	address: string
): Promise<void> {
	const recipient = normalizeEmail(address);
	// Each patch moves the row out of the unlinked range, so this drains it.
	for (;;) {
		const rows = await ctx.db
			.query('unresolvedFeedback')
			.withIndex('by_recipient_and_contact', (q) =>
				q.eq('recipient', recipient).eq('contactId', undefined)
			)
			.take(BATCH);
		for (const row of rows) await ctx.db.patch(row._id, { contactId });
		if (rows.length < BATCH) return;
	}
}

/**
 * Delete up to `limit` rows naming `address`, linked or not. Returns the rows
 * deleted, so a budgeted caller can tell an emptied range (fewer than `limit`)
 * from one it has to come back to.
 */
export async function deleteUnresolvedFeedbackForAddress(
	ctx: MutationCtx,
	address: string,
	limit: number
): Promise<Array<{ _id: Id<'unresolvedFeedback'> }>> {
	const rows = await ctx.db
		.query('unresolvedFeedback')
		.withIndex('by_recipient_and_contact', (q) => q.eq('recipient', normalizeEmail(address)))
		.take(limit);
	for (const row of rows) await ctx.db.delete(row._id);
	return rows;
}
