/**
 * Whether the knowledge detail page offers "Share with members": to an
 * owner or admin, on an entry members cannot see because it is restricted
 * (`memberAccess: 'restricted'`, migration 0069). The backend decides whether
 * the entry's source allows it (knowledge/sharing.ts); the review says so.
 */
export function offersShareWithMembers(
	entry: { memberAccess?: 'members' | 'restricted' } | null | undefined,
	isAdmin: boolean
): boolean {
	return isAdmin && entry?.memberAccess === 'restricted';
}
