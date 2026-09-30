/**
 * "This member has been welcomed", remembered per user id in localStorage.
 *
 * `welcomedAt` only ever goes from unset to set, so once this browser knows a
 * member has seen `/welcome` it never needs to ask again. Two places learn it:
 * the `first-login` middleware, when `userOnboarding.get` returns a stamp, and
 * the welcome page, once its `markWelcomed` mutation has committed. Both read
 * and write through this module so the key cannot drift between them.
 *
 * The entry is a hint that saves one Convex round trip on the next session, not
 * a security boundary: it only decides whether a member is nudged to the
 * welcome screen.
 */

/** localStorage key prefix; the full key is `${prefix}${userId}`. */
export const WELCOMED_STORAGE_PREFIX = 'owlat:welcomed:';

export function welcomedCacheKey(userId: string): string {
	return `${WELCOMED_STORAGE_PREFIX}${userId}`;
}

export function readWelcomedCache(userId: string): boolean {
	try {
		return localStorage.getItem(welcomedCacheKey(userId)) === '1';
	} catch {
		// Storage blocked (private mode, sandboxed webview): fall back to the query.
		return false;
	}
}

export function writeWelcomedCache(userId: string): void {
	try {
		localStorage.setItem(welcomedCacheKey(userId), '1');
	} catch {
		// Storage blocked or full: the next session just asks the server again.
	}
}
