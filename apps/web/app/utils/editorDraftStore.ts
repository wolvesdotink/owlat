/**
 * The device copy of an editor draft (email template, campaign) that has not
 * reached the server yet: written while the editor autosaves, deleted once a
 * save lands, read back when the editor opens.
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
	v: 1;
	/** When it was written; also what a conditional delete compares. */
	savedAt: number;
	/** The server state the draft was built on (a revision, an `updatedAt`). */
	base: number | null;
	data: T;
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

/** A copy found under a draft's scope. */
export interface FoundEditorDraft<T> {
	key: string;
	/** The editor that wrote it. */
	writerId: string;
	copy: EditorDraftCopy<T>;
}

function isCopy(value: unknown): value is EditorDraftCopy<unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const copy = value as Partial<EditorDraftCopy<unknown>>;
	return (
		copy.v === 1 &&
		typeof copy.savedAt === 'number' &&
		(copy.base === null || typeof copy.base === 'number') &&
		'data' in copy
	);
}

export interface EditorDraftStore {
	/** Whether writes are kept at all (false without IndexedDB). */
	readonly persistent: boolean;
	/** Resolves true once the write committed, false when it could not be kept. */
	write<T>(key: string, copy: EditorDraftCopy<T>): Promise<boolean>;
	/**
	 * The stored copy when it is well-formed, young enough and its `data`
	 * passes `accept`; anything else under the key is deleted.
	 */
	read<T>(
		key: string,
		accept: (data: unknown) => data is T,
		now?: number
	): Promise<EditorDraftCopy<T> | null>;
	/** Every copy of one draft (`read` applied to each), newest first. */
	list<T>(
		scope: string,
		accept: (data: unknown) => data is T,
		now?: number
	): Promise<FoundEditorDraft<T>[]>;
	/**
	 * Delete the copy only if it is still the one written at `savedAt`, so a
	 * newer copy (another tab, a later edit) written meanwhile stays.
	 */
	removeIf(key: string, savedAt: number): Promise<void>;
	/** Drop malformed and expired copies under every key (best effort). */
	prune(now?: number): Promise<void>;
}

export function createEditorDraftStore(driver: OfflineKvDriver): EditorDraftStore {
	const persistent = driver.persistent !== false;

	const removeIf = async (key: string, predicate: (current: unknown) => boolean) => {
		if (driver.deleteIf) {
			await driver.deleteIf(key, predicate);
			return;
		}
		if (predicate(await driver.get(key))) await driver.delete(key);
	};

	const expired = (copy: EditorDraftCopy<unknown>, now: number) =>
		now - copy.savedAt > EDITOR_DRAFT_MAX_AGE_MS;

	const read = async <T>(
		key: string,
		accept: (data: unknown) => data is T,
		now = Date.now()
	): Promise<EditorDraftCopy<T> | null> => {
		try {
			const stored = await driver.get<unknown>(key);
			if (stored === undefined) return null;
			if (isCopy(stored) && !expired(stored, now) && accept(stored.data)) {
				return stored as EditorDraftCopy<T>;
			}
			await removeIf(key, (current) => current === stored || sameCopy(current, stored));
			return null;
		} catch {
			return null;
		}
	};

	return {
		persistent,
		async write(key, copy) {
			if (!persistent) return false;
			try {
				// Through JSON: the editors' state is reactive, and IndexedDB's
				// structured clone refuses a Vue proxy.
				await driver.set(key, JSON.parse(JSON.stringify(copy)));
				return true;
			} catch {
				return false;
			}
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
				if (copy) found.push({ key, writerId: key.slice(scope.length), copy });
			}
			return found.sort((a, b) => b.copy.savedAt - a.copy.savedAt);
		},
		async removeIf(key, savedAt) {
			try {
				await removeIf(key, (current) => isCopy(current) && current.savedAt === savedAt);
			} catch {
				// A copy that could not be deleted is only offered again later,
				// where it is compared with the server before anything is applied.
			}
		},
		async prune(now = Date.now()) {
			try {
				const keys = (await driver.keys()).filter((key) => key.startsWith(PREFIX));
				for (const key of keys) {
					await removeIf(key, (current) => !isCopy(current) || expired(current, now));
				}
			} catch {
				// Best effort: expiry is also applied on every read.
			}
		},
	};
}

function sameCopy(a: unknown, b: unknown): boolean {
	return isCopy(a) && isCopy(b) ? a.savedAt === b.savedAt : JSON.stringify(a) === JSON.stringify(b);
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
