import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import { normalizeEmail } from './inputGuards';

/**
 * Rows read per address by {@link findLiveContactByEmail}, newest first.
 *
 * Soft-deleting a contact keeps its email on the row until the retention
 * sweep erases it (30 days plus the erasure walker), and the address can be
 * used again on day 1, so several rows can share one email: at most one live
 * row (contact resolution refuses a second) plus the soft-deleted ones from
 * that window. The live row is the newest, so the normal read is one row.
 * The cap only matters for an address deleted and re-created more than this
 * many times inside the window; the lookup then reads as "no live contact".
 */
export const LIVE_CONTACT_EMAIL_SCAN_LIMIT = 25;

/**
 * The live (not soft-deleted) contact with this email, or null.
 *
 * Every email lookup on `contacts` that acts for the current person goes
 * through here. `by_email` returns rows that share an email in creation order,
 * so an unfiltered `.first()` lands on a soft-deleted original instead of the
 * contact that replaced it (#1242). Bounded by
 * {@link LIVE_CONTACT_EMAIL_SCAN_LIMIT}.
 */
export async function findLiveContactByEmail(
	ctx: { db: DatabaseReader },
	email: string
): Promise<Doc<'contacts'> | null> {
	const normalized = normalizeEmail(email);
	if (!normalized) return null;
	const rows = await ctx.db
		.query('contacts')
		.withIndex('by_email', (q) => q.eq('email', normalized))
		.order('desc')
		.take(LIVE_CONTACT_EMAIL_SCAN_LIMIT);
	return rows.find((row) => row.deletedAt === undefined) ?? null;
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
