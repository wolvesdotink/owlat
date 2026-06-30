import { normalizeEmail } from './inputGuards';

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
