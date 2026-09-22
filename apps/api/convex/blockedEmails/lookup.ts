import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { normalizeEmail } from '../lib/inputGuards';

// Look up a blocklist row by email. Normalizes (lowercase + trim) so every
// caller hits the `by_email` index with the same key, then returns the first
// match or null. Single source of truth for the blocklist-by-email read.
//
// Exported for the suppression carry-over import, which needs to tell an address
// it just blocked from one that was already blocked in order to report an
// honest run summary. It reads through this rather than re-deriving the key,
// because a second normalization would eventually disagree with this one.
export async function findBlockedByEmail(
	ctx: QueryCtx | MutationCtx,
	email: string
): Promise<Doc<'blockedEmails'> | null> {
	const normalizedEmail = normalizeEmail(email);
	return await ctx.db
		.query('blockedEmails')
		.withIndex('by_email', (q) => q.eq('email', normalizedEmail))
		.first();
}
