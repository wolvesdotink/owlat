import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import { normalizeEmail } from './inputGuards';

/**
 * Whether `contact` exists and is not soft-deleted. A soft-deleted contact keeps
 * its email and names on the row (and its activities and automation runs keep
 * pointing at it) until the retention sweep, so every member-facing read that
 * resolves a contact by id, directly or as a join, treats a deleted one as
 * missing, the boundary `contacts.get` draws.
 */
export function isLiveContact(
	contact: Doc<'contacts'> | null | undefined
): contact is Doc<'contacts'> {
	return contact != null && contact.deletedAt === undefined;
}

/** The contact with this id if it is live (see {@link isLiveContact}), else null. */
export async function getLiveContact(
	ctx: { db: DatabaseReader },
	contactId: Id<'contacts'>
): Promise<Doc<'contacts'> | null> {
	const contact = await ctx.db.get(contactId);
	return isLiveContact(contact) ? contact : null;
}

/**
 * The live (not soft-deleted) contact with this email, or null.
 *
 * Every email lookup on `contacts` that acts for the current person goes
 * through here. Soft-deleting a contact keeps its email on the row until the
 * retention sweep erases it, and the address can be used again on day 1, so
 * `by_email` can return deleted rows ahead of the live one: rows sharing an
 * email come back in creation order, and an email edit moves an older row onto
 * an address without changing its creation time. An unfiltered `.first()`
 * can land on a deleted row.
 *
 * Read cost: one read on `by_email_and_deleted_at` that stops at the first
 * live row, no matter how many deleted rows share the email.
 *
 * Contact resolution and email edits refuse a second live contact for an
 * address, but a legacy live contact without an identity row can still share
 * its email with a newer one. In that case this returns the oldest live
 * contact (ascending creation order), and only that row is acted on.
 */
export async function findLiveContactByEmail(
	ctx: { db: DatabaseReader },
	email: string
): Promise<Doc<'contacts'> | null> {
	const normalized = normalizeEmail(email);
	if (!normalized) return null;
	return await ctx.db
		.query('contacts')
		.withIndex('by_email_and_deleted_at', (q) =>
			q.eq('email', normalized).eq('deletedAt', undefined)
		)
		.first();
}

/**
 * Deduplicate contacts by email within a batch (keeps first occurrence).
 * Used to prevent within-batch duplicates during imports.
 */
export function deduplicateContactsByEmail<T extends { email: string }>(
	contacts: T[]
): { unique: T[]; duplicateCount: number } {
	const seen = new Map<string, T>();
	let duplicateCount = 0;

	for (const contact of contacts) {
		const normalizedEmail = contact.email ? normalizeEmail(contact.email) : undefined;
		if (!normalizedEmail) continue;

		if (seen.has(normalizedEmail)) {
			duplicateCount++;
		} else {
			seen.set(normalizedEmail, contact);
		}
	}

	return {
		unique: Array.from(seen.values()),
		duplicateCount,
	};
}
