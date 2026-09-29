/**
 * Who a cached Postbox row belongs to, and how to forget it.
 *
 * The offline READ cache (thread rows, bodies, the folder rail) is on by
 * default in the browser too, so a shared browser profile is the normal case,
 * not the edge. Two rules keep one identity's mail away from another:
 *
 *   - Every read-cache key is namespaced by the signed-in user AND the mailbox
 *     ({@link offlineCacheNamespace}). A team mailbox is shared by several
 *     members, so the mailbox id alone would hand one member's cached rows to
 *     the next one to sign in on the same device.
 *   - Signing out wipes the read cache for every identity
 *     ({@link wipeOfflineReadCache}), so nothing cached survives the session
 *     that was allowed to see it.
 *
 * Only the read-cache key families are touched here. Queued offline sends
 * (`outbox:`) and composer draft mirrors (`draft-mirror*:`) are the user's own
 * unsent text with no other copy; they keep their own lifecycle.
 *
 * Pure data layer over the shared {@link OfflineKvDriver}: no Vue, no DOM.
 */

import type { OfflineKvDriver } from './postboxOfflineStore';

/**
 * Separates the user from the mailbox inside a namespace. Neither id contains
 * it (Convex and better-auth ids are alphanumeric), and it is not the `:` the
 * key helpers use between a namespace and the rest of the key.
 */
const NAMESPACE_SEPARATOR = '~';

/** The key prefixes of the read cache; see postboxOfflineStore/FolderStore. */
const READ_CACHE_FAMILIES = new Set([
	'threads',
	'threads-meta',
	'body',
	'body-index',
	'folders',
	'folders-meta',
]);

/**
 * The read-cache namespace for one user in one mailbox, or null while either
 * is unknown (nothing is read or written then).
 */
export function offlineCacheNamespace(
	userId: string | null | undefined,
	mailboxId: string | null | undefined
): string | null {
	if (!userId || !mailboxId) return null;
	return `${userId}${NAMESPACE_SEPARATOR}${mailboxId}`;
}

/** The namespace of a read-cache key, or null for any other key family. */
export function readCacheNamespaceOf(key: string): string | null {
	const familyEnd = key.indexOf(':');
	if (familyEnd < 0 || !READ_CACHE_FAMILIES.has(key.slice(0, familyEnd))) return null;
	const rest = key.slice(familyEnd + 1);
	const nsEnd = rest.indexOf(':');
	return nsEnd < 0 ? rest : rest.slice(0, nsEnd);
}

/**
 * A namespace written before the cache was keyed per user (the bare mailbox
 * id). Nothing reads those keys any more; they are only worth deleting.
 */
export function isLegacyOfflineCacheNamespace(ns: string): boolean {
	return !ns.includes(NAMESPACE_SEPARATOR);
}

/**
 * Delete every read-cache key whose namespace passes `match` (all of them by
 * default). Outbox and draft-mirror keys are never touched. Best-effort per
 * key: one failed delete does not stop the rest. Returns how many keys went.
 */
export async function wipeOfflineReadCache(
	driver: OfflineKvDriver,
	match: (ns: string) => boolean = () => true
): Promise<number> {
	const doomed = (await driver.keys()).filter((key) => {
		const ns = readCacheNamespaceOf(key);
		return ns !== null && match(ns);
	});
	const results = await Promise.allSettled(doomed.map((key) => driver.delete(key)));
	return results.filter((r) => r.status === 'fulfilled').length;
}
