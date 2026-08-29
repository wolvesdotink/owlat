/**
 * Offline cache for the Postbox FOLDER LIST (plan idea 49).
 *
 * The thread rows and bodies were cached long before the folders were, which
 * made a cold offline start half-useful: the message list came back but the
 * rail it hangs off — inbox, archive, the user's own folders, the unread
 * counts — rendered empty, so there was nothing to navigate with. This module
 * closes that gap.
 *
 * Shares the object store and the driver with {@link PostboxOfflineStore} (one
 * IndexedDB connection per page) and repeats its contract exactly:
 *   - FAIL-SOFT. A missing/blocked IndexedDB or a quota rejection degrades to
 *     the live-only rail; nothing here is ever the only copy of anything.
 *   - NAMESPACED by the active mailboxId, so one account's folder names and
 *     unread counts are never shown inside another on a shared device.
 *   - PURE DATA LAYER. No Vue, no DOM, no network — the reactive bridge is
 *     `usePostboxOfflineFolders.ts`.
 *
 * Its own module rather than more methods on the store: that file sits one
 * line under the 500-LOC ratchet, and the outbox split (postboxOfflineOutbox
 * Item.ts) and the draft mirror (postboxDraftMirrorStore.ts) set the pattern.
 */

import { getOfflineKvDriver, type OfflineKvDriver } from './postboxOfflineStore';

/**
 * Folders retained per mailbox. Generous on purpose — an IMAP account migrated
 * from a decade of manual filing can carry hundreds — and each row is a name
 * plus a couple of counters, so the whole rail is a few KB.
 */
export const OFFLINE_FOLDERS_CAP = 300;

const foldersKey = (ns: string) => `folders:${ns}`;
const foldersMetaKey = (ns: string) => `folders-meta:${ns}`;

/** When a mailbox's folder rows were last persisted. */
export interface OfflineFoldersMeta {
	savedAt: number;
}

/** Typed façade over an {@link OfflineKvDriver} for the folder rail. */
export class PostboxOfflineFolderStore {
	private readonly driver: OfflineKvDriver;

	constructor(driver: OfflineKvDriver) {
		this.driver = driver;
	}

	/** Persist the folder rail for `ns`, capped at {@link OFFLINE_FOLDERS_CAP}. */
	async saveFolders<T>(ns: string, rows: readonly T[]): Promise<void> {
		try {
			await this.driver.set(foldersKey(ns), rows.slice(0, OFFLINE_FOLDERS_CAP));
		} catch {
			// Fail-soft: the rail just renders from the live query instead.
			return;
		}
		try {
			const meta: OfflineFoldersMeta = { savedAt: Date.now() };
			await this.driver.set(foldersMetaKey(ns), meta);
		} catch {
			// The rows landed; only their freshness stamp is missing.
		}
	}

	/** The cached folder rail for `ns`; empty when there is none. */
	async loadFolders<T>(ns: string): Promise<T[]> {
		try {
			return (await this.driver.get<T[]>(foldersKey(ns))) ?? [];
		} catch {
			return [];
		}
	}

	/** When {@link loadFolders}' rows were persisted; null if never. */
	async loadFoldersMeta(ns: string): Promise<OfflineFoldersMeta | null> {
		try {
			return (await this.driver.get<OfflineFoldersMeta>(foldersMetaKey(ns))) ?? null;
		} catch {
			return null;
		}
	}
}

let singleton: PostboxOfflineFolderStore | null = null;

/**
 * The shared folder-rail cache for this session. Backed by the same driver as
 * {@link PostboxOfflineStore}, so `PostboxOfflineStore.clear()` (the "Clear
 * local cache" action) wipes these rows too.
 */
export function getPostboxOfflineFolderStore(): PostboxOfflineFolderStore {
	singleton ??= new PostboxOfflineFolderStore(getOfflineKvDriver());
	return singleton;
}
