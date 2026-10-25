/**
 * The device copy of an editor draft (email template, campaign) that has not
 * reached the server yet: written while the editor autosaves, deleted once a
 * save covers it, offered back when the editor opens.
 *
 * Its own IndexedDB database rather than the Postbox store: the Postbox cache
 * controls in settings empty their store wholesale, and this copy may be the
 * only one of an edit made offline.
 *
 * Keys are namespaced by the signed-in person and workspace, so one person's
 * unsaved edits are never offered to another on a shared browser, and end in
 * the editor that wrote the copy (`editorDraftWriters.ts`), so two tabs never
 * overwrite each other's:
 *
 *   editor-draft:v1:<userId>:<organizationId>:<kind>:<entityId>:<writerId>
 *
 * Every write carries a unique `token` and a `seq` that grows with each write
 * of one editor. A conditional delete names the tokens it may delete and
 * compares inside one transaction, so cleaning up one copy can never take a
 * newer one with it; `savedAt` is only the copy's age. Operations on one key
 * run one after another in the order they were asked for, so an older write
 * never lands over a newer one. Copies from before tokens existed (`v: 1`)
 * are still read; their token is derived from their content.
 *
 * Pure data layer: no Vue, no network.
 */

import {
	createIndexedDbDriver,
	createNoopDriver,
	type OfflineKvDriver,
} from './postboxOfflineKvDriver';

const PREFIX = 'editor-draft:v1:';
const DB_NAME = 'owlat-editor-drafts';
const STORE_NAME = 'kv';

/** A copy nobody came back for in this long is dropped. */
export const EDITOR_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type EditorDraftKind = 'emailTemplate' | 'campaign';

/** One stored draft. */
export interface EditorDraftCopy<T> {
	v: 2;
	/** Unique per write; what a conditional delete compares. */
	token: string;
	/** Grows with every write of the editor that wrote it. */
	seq: number;
	/** When it was written: its age, nothing else. */
	savedAt: number;
	/** The server state the draft was built on (a revision, an `updatedAt`). */
	base: number | null;
	data: T;
}

/** A copy found under a draft's scope. */
export interface FoundEditorDraft<T> {
	key: string;
	/** The editor that wrote it. */
	writerId: string;
	token: string;
	savedAt: number;
	base: number | null;
	data: T;
	/** Written before copies had tokens; its base is not trusted for anything. */
	legacy: boolean;
}

/** The prefix every copy of one draft shares, whichever editor wrote it. */
export function editorDraftScope(parts: {
	userId: string;
	organizationId: string;
	kind: EditorDraftKind;
	id: string;
}): string {
	return `${PREFIX}${parts.userId}:${parts.organizationId}:${parts.kind}:${parts.id}:`;
}

/** One editor's copy of the draft `scope` names. */
export function editorDraftKey(scope: string, writerId: string): string {
	return `${scope}${writerId}`;
}

interface StoredCopy {
	v: 1 | 2;
	token?: string;
	seq?: number;
	savedAt: number;
	base: number | null;
	data: unknown;
}

function isStored(value: unknown): value is StoredCopy {
	if (typeof value !== 'object' || value === null) return false;
	const copy = value as Partial<StoredCopy>;
	const shaped =
		typeof copy.savedAt === 'number' &&
		(copy.base === null || typeof copy.base === 'number') &&
		'data' in copy;
	if (copy.v === 2) return shaped && typeof copy.token === 'string' && typeof copy.seq === 'number';
	return copy.v === 1 && shaped;
}

/** FNV-1a: a short, stable name for a legacy copy's content. */
function contentHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

/** The token a stored value answers to; null when it is no copy at all. */
export function editorDraftToken(stored: unknown): string | null {
	if (!isStored(stored)) return null;
	return stored.v === 2 ? stored.token! : `v1:${contentHash(JSON.stringify(stored))}`;
}

export interface EditorDraftStore {
	/** Whether writes are kept at all (false without IndexedDB). */
	readonly persistent: boolean;
	/** Resolves true once the write committed, false when it could not be kept. */
	write<T>(key: string, copy: EditorDraftCopy<T>): Promise<boolean>;
	/**
	 * The copy under `key` when it is well-formed, young enough and its data
	 * passes `accept`; anything else under the key is deleted.
	 */
	read<T>(
		key: string,
		accept: (data: unknown) => data is T,
		now?: number
	): Promise<FoundEditorDraft<T> | null>;
	/** Every copy of one draft (`read` applied to each), newest first. */
	list<T>(
		scope: string,
		accept: (data: unknown) => data is T,
		now?: number
	): Promise<FoundEditorDraft<T>[]>;
	/**
	 * Delete the copy under `key` only while it is one of `tokens`, in one
	 * transaction: a newer copy (a later write, another tab's) stays.
	 * Resolves whether it deleted.
	 */
	removeIf(key: string, tokens: readonly string[]): Promise<boolean>;
	/** Drop malformed and expired copies under every key (best effort). */
	prune(now?: number): Promise<void>;
}

export function createEditorDraftStore(driver: OfflineKvDriver): EditorDraftStore {
	const persistent = driver.persistent !== false;

	// One queue per key: an operation starts once the previous one settled.
	const queues = new Map<string, Promise<unknown>>();
	const serial = <R>(key: string, op: () => Promise<R>): Promise<R> => {
		const run = (queues.get(key) ?? Promise.resolve()).then(op, op);
		const tail = run.catch(() => undefined);
		queues.set(key, tail);
		void tail.then(() => {
			if (queues.get(key) === tail) queues.delete(key);
		});
		return run;
	};

	const deleteWhere = async (key: string, predicate: (current: unknown) => boolean) => {
		if (driver.deleteIf) return driver.deleteIf(key, predicate);
		if (!predicate(await driver.get(key))) return false;
		await driver.delete(key);
		return true;
	};

	const expired = (copy: StoredCopy, now: number) => now - copy.savedAt > EDITOR_DRAFT_MAX_AGE_MS;

	const readNow = async <T>(
		key: string,
		accept: (data: unknown) => data is T,
		now: number
	): Promise<FoundEditorDraft<T> | null> => {
		const stored = await driver.get<unknown>(key);
		if (stored === undefined) return null;
		if (isStored(stored) && !expired(stored, now) && accept(stored.data)) {
			return {
				key,
				writerId: '',
				token: editorDraftToken(stored)!,
				savedAt: stored.savedAt,
				base: stored.base,
				data: stored.data,
				legacy: stored.v === 1,
			};
		}
		// Unusable: delete exactly what was read, nothing written since.
		const seen = JSON.stringify(stored);
		await deleteWhere(key, (current) => JSON.stringify(current) === seen);
		return null;
	};

	const read = <T>(key: string, accept: (data: unknown) => data is T, now = Date.now()) =>
		serial(key, () => readNow(key, accept, now)).catch(() => null);

	return {
		persistent,
		write(key, copy) {
			if (!persistent) return Promise.resolve(false);
			// Serialized now, not when its turn in the queue comes: the data is
			// the editor's live state, which keeps changing, and the write must
			// store what its token names. Through JSON, also because IndexedDB's
			// structured clone refuses a Vue proxy.
			let frozen: EditorDraftCopy<unknown>;
			try {
				frozen = JSON.parse(JSON.stringify(copy)) as EditorDraftCopy<unknown>;
			} catch {
				return Promise.resolve(false);
			}
			return serial(key, () => driver.set(key, frozen)).then(
				() => true,
				() => false
			);
		},
		read,
		async list(scope, accept, now = Date.now()) {
			let keys: string[];
			try {
				keys = (await driver.keys()).filter((key) => key.startsWith(scope));
			} catch {
				return [];
			}
			const found = [];
			for (const key of keys) {
				const copy = await read(key, accept, now);
				if (copy) found.push({ ...copy, writerId: key.slice(scope.length) });
			}
			return found.sort((a, b) => b.savedAt - a.savedAt);
		},
		removeIf(key, tokens) {
			return serial(key, () =>
				deleteWhere(key, (current) => {
					const token = editorDraftToken(current);
					return token !== null && tokens.includes(token);
				})
			).catch(() => false);
		},
		async prune(now = Date.now()) {
			try {
				const keys = (await driver.keys()).filter((key) => key.startsWith(PREFIX));
				for (const key of keys) {
					await serial(key, () =>
						deleteWhere(key, (current) => !isStored(current) || expired(current, now))
					);
				}
			} catch {
				// Best effort: expiry is also applied on every read.
			}
		},
	};
}

let shared: EditorDraftStore | null = null;
let pruned = false;

/** The page's one store; prunes stale copies the first time it is asked for. */
export function getEditorDraftStore(): EditorDraftStore {
	if (!shared) {
		shared = createEditorDraftStore(
			createIndexedDbDriver(DB_NAME, STORE_NAME) ?? createNoopDriver()
		);
	}
	if (!pruned) {
		pruned = true;
		void shared.prune();
	}
	return shared;
}
