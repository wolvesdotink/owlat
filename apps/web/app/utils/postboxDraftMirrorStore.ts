/**
 * Persistence for the composer's local draft mirror (plan idea 7).
 *
 * Shares the object store and the driver with {@link PostboxOfflineStore} (one
 * IndexedDB connection per page) but is its own module because it is its own
 * failure contract: FAIL-SOFT. The mirror is a second copy of text the server is
 * also being told about, so a device that cannot store it degrades to
 * server-only autosave, and a composer never refuses a keystroke over a storage
 * failure. Every write reports whether it committed, so a caller that is about
 * to drop another copy can tell.
 *
 * OWNERSHIP, NOT COORDINATION. Each composer session writes only its own keys:
 *
 *   draft-mirror:v2:<ns>:<draftKey>:<sessionId>:<slot>
 *
 * `draftKey` is the draft id, or `new-<sessionId>` before the composition has a
 * row; `slot` is `live` or `pre-restore.<backupId>`. Other sessions only read
 * them, and delete them only through {@link removeIf} (one IndexedDB
 * transaction re-checks the stored value), so a newer copy written in between
 * is never deleted on the strength of an older read. There are no shared
 * records, no claims, no generation tokens and no heartbeats to race on.
 *
 * Legacy (v1) entries `draft-mirror:<ns>:<id>` are read, never written; their
 * old one-shot tombstones `draft-mirror-dead:<ns>:<id>` are honoured.
 *
 * Namespaced by mailboxId, so one account's unsent text is never offered inside
 * another on a shared device. Pure data layer: no Vue, no DOM, no network.
 */

import {
	MIRROR_CAP_PER_MAILBOX,
	isMirrorCopyExpired,
	sameStoredValue,
	type LegacyMirrorEntry,
	type MirrorCopy,
} from './postboxDraftMirror';
import { getOfflineKvDriver, type OfflineKvDriver } from './postboxOfflineStore';

const V2_PREFIX = 'draft-mirror:v2:';

/** One stored copy, located. */
export interface MirrorCopyRecord {
	key: string;
	draftKey: string;
	sessionId: string;
	slot: string;
	copy: MirrorCopy;
}

/** A legacy v1 entry, located. */
export interface LegacyMirrorRecord {
	key: string;
	id: string;
	entry: LegacyMirrorEntry;
}

/** The key of one session's slot. Every segment is colon-free. */
export function mirrorCopyKey(
	ns: string,
	draftKey: string,
	sessionId: string,
	slot: string
): string {
	return `${V2_PREFIX}${ns}:${draftKey}:${sessionId}:${slot}`;
}

/** The provisional draft key of a composition that has no row yet. */
export function provisionalDraftKey(sessionId: string): string {
	return `new-${sessionId}`;
}

const legacyKey = (ns: string, id: string) => `draft-mirror:${ns}:${id}`;
const legacyTombKey = (ns: string, id: string) => `draft-mirror-dead:${ns}:${id}`;
const legacyIndexKey = (ns: string) => `draft-mirror-index:${ns}`;

function parseCopyKey(key: string): Omit<MirrorCopyRecord, 'copy'> | null {
	if (!key.startsWith(V2_PREFIX)) return null;
	const parts = key.slice(V2_PREFIX.length).split(':');
	if (parts.length !== 4) return null;
	const [, draftKey, sessionId, slot] = parts as [string, string, string, string];
	return { key, draftKey, sessionId, slot };
}

function isMirrorCopy(value: unknown): value is MirrorCopy {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { v?: unknown }).v === 2 &&
		typeof (value as { savedAt?: unknown }).savedAt === 'number'
	);
}

export class PostboxDraftMirrorStore {
	private readonly driver: OfflineKvDriver;

	constructor(driver: OfflineKvDriver) {
		this.driver = driver;
	}

	/** False when nothing written here is actually stored (no IndexedDB). */
	get persistent(): boolean {
		return this.driver.persistent !== false;
	}

	/** Write one copy. True only when its transaction committed on a real store. */
	async write(key: string, copy: MirrorCopy): Promise<boolean> {
		if (!this.persistent) return false;
		try {
			await this.driver.set(key, copy);
			return true;
		} catch {
			return false;
		}
	}

	/** Delete one of the caller's OWN keys. */
	async remove(key: string): Promise<boolean> {
		try {
			await this.driver.delete(key);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Delete `key` only if, inside one transaction, the stored value still
	 * passes `predicate`. Used for every key the caller does not own. Without a
	 * transactional driver it falls back to a read then a delete (tests only).
	 */
	async removeIf(key: string, predicate: (current: unknown) => boolean): Promise<boolean> {
		try {
			if (this.driver.deleteIf) return await this.driver.deleteIf(key, predicate);
			const current = await this.driver.get<unknown>(key);
			if (!predicate(current)) return false;
			await this.driver.delete(key);
			return true;
		} catch {
			return false;
		}
	}

	/** Delete `key` only if it still holds exactly `expected`. */
	removeIfUnchanged(
		key: string,
		expected: unknown,
		alsoRequire: () => boolean = () => true
	): Promise<boolean> {
		return this.removeIf(key, (current) => alsoRequire() && sameStoredValue(current, expected));
	}

	private async keys(): Promise<string[]> {
		try {
			return await this.driver.keys();
		} catch {
			return [];
		}
	}

	private async read(key: string): Promise<unknown> {
		try {
			return await this.driver.get<unknown>(key);
		} catch {
			return undefined;
		}
	}

	/** Every v2 copy in a mailbox, optionally only one draft key's. */
	async list(ns: string, draftKey?: string): Promise<MirrorCopyRecord[]> {
		const prefix = draftKey ? `${V2_PREFIX}${ns}:${draftKey}:` : `${V2_PREFIX}${ns}:`;
		const records: MirrorCopyRecord[] = [];
		for (const key of await this.keys()) {
			if (!key.startsWith(prefix)) continue;
			const located = parseCopyKey(key);
			if (!located) continue;
			const value = await this.read(key);
			if (isMirrorCopy(value)) records.push({ ...located, copy: value });
		}
		return records;
	}

	/**
	 * A legacy v1 entry, or null. One retired by its old tombstone is dropped
	 * together with the tombstone (that composition was discarded).
	 */
	async readLegacy(ns: string, id: string): Promise<LegacyMirrorRecord | null> {
		const key = legacyKey(ns, id);
		const tomb = await this.read(legacyTombKey(ns, id));
		if (tomb) {
			await this.remove(legacyTombKey(ns, id));
			await this.remove(key);
			return null;
		}
		const entry = await this.read(key);
		if (
			typeof entry !== 'object' ||
			entry === null ||
			typeof (entry as { savedAt?: unknown }).savedAt !== 'number' ||
			typeof (entry as { fields?: unknown }).fields !== 'object'
		) {
			return null;
		}
		return { key, id, entry: entry as LegacyMirrorEntry };
	}

	/** Remove a resolved legacy entry and drop it from its old index. */
	async removeLegacy(
		record: LegacyMirrorRecord,
		alsoRequire: () => boolean = () => true
	): Promise<boolean> {
		const removed = await this.removeIfUnchanged(record.key, record.entry, alsoRequire);
		if (removed) {
			const ns = record.key.slice('draft-mirror:'.length, record.key.lastIndexOf(`:${record.id}`));
			const index = await this.read(legacyIndexKey(ns));
			if (Array.isArray(index) && index.includes(record.id)) {
				try {
					await this.driver.set(
						legacyIndexKey(ns),
						index.filter((id) => id !== record.id)
					);
				} catch {
					// The index only ever narrowed a scan; a stale entry is harmless.
				}
			}
		}
		return removed;
	}

	/**
	 * Move one session's copies from `fromDraftKey` (its provisional key) to the
	 * draft that now exists, each source deleted only after its destination
	 * committed. A slot already written under the draft is newer (a session's
	 * writes are ordered), so the provisional one is only dropped. True once
	 * every slot reached the draft.
	 */
	async migrateSession(
		ns: string,
		sessionId: string,
		fromDraftKey: string,
		draftId: string
	): Promise<boolean> {
		let complete = true;
		const landed = new Set(
			(await this.list(ns, draftId))
				.filter((record) => record.sessionId === sessionId)
				.map((record) => record.slot)
		);
		for (const record of await this.list(ns, fromDraftKey)) {
			if (record.sessionId !== sessionId) continue;
			if (landed.has(record.slot)) {
				await this.removeIfUnchanged(record.key, record.copy);
				continue;
			}
			const moved: MirrorCopy = { ...record.copy, draftId };
			if (await this.write(mirrorCopyKey(ns, draftId, sessionId, record.slot), moved)) {
				await this.removeIfUnchanged(record.key, record.copy);
			} else complete = false;
		}
		return complete;
	}

	/**
	 * Retention, confined to the mirror prefix: copies older than the retention
	 * window, and the oldest beyond the per-mailbox cap. `skip` names copies that
	 * must not be expired now (an open offer, a live session's own keys).
	 */
	async sweep(ns: string, now: number, skip: (record: MirrorCopyRecord) => boolean): Promise<void> {
		const records = (await this.list(ns)).filter((record) => !skip(record));
		const sorted = [...records].sort((a, b) => b.copy.savedAt - a.copy.savedAt);
		for (const [index, record] of sorted.entries()) {
			if (isMirrorCopyExpired(record.copy.savedAt, now) || index >= MIRROR_CAP_PER_MAILBOX) {
				await this.removeIfUnchanged(record.key, record.copy);
			}
		}
	}
}

let singleton: PostboxDraftMirrorStore | null = null;

/** The shared draft-mirror store for this session. */
export function getPostboxDraftMirrorStore(): PostboxDraftMirrorStore {
	if (!singleton) singleton = new PostboxDraftMirrorStore(getOfflineKvDriver());
	return singleton;
}
