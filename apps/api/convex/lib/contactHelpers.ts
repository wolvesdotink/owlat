import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import { normalizeEmail } from './inputGuards';

/**
 * The live (not soft-deleted) contact with this email, or null.
 *
 * Every email lookup on `contacts` that acts for the current person goes
 * through here. Soft-deleting a contact keeps its email on the row until the
 * retention sweep erases it, and the address can be used again on day 1, so
 * `by_email` can return deleted rows ahead of the live one: rows sharing an
 * email come back in creation order, and an email edit moves an older row onto
 * an address without changing its creation time. An unfiltered `.first()`
 * landed on a deleted row (#1242).
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
