/**
 * Who wrote a device copy of an editor draft (`editorDraftStore.ts`), and
 * whether that editor is still open.
 *
 * Every open editor writes its own copy: two tabs editing the same draft
 * offline must not overwrite each other's, or one of them would claim edits
 * are kept on the device that are gone. A copy whose editor is still open
 * belongs to it (it deletes the copy once its save lands); only a copy left
 * behind, by an editor that closed before its save landed, is recovered.
 *
 * A writer id is `<tab>.<n>`. A tab holds a Web Lock named after it for as
 * long as it is open, so another tab can tell its copies are still in use.
 * Within one tab the open editors are known directly. A browser without Web
 * Locks cannot tell, and treats every other tab's copy as left behind.
 *
 * Pure data layer: no Vue, no network.
 */

const LOCK_PREFIX = 'owlat-editor-draft-tab:';

export interface EditorDraftWriter {
	readonly id: string;
	/** The editor closed: its copy, if any is left, may be recovered. */
	close(): void;
}

export interface EditorDraftWriters {
	open(): EditorDraftWriter;
	/** A snapshot of which writers still have an open editor. */
	liveness(): Promise<(writerId: string) => boolean>;
}

type Locks = Pick<LockManager, 'request' | 'query'>;

export function createEditorDraftWriters(tabId: string, locks: Locks | null): EditorDraftWriters {
	const openWriters = new Set<string>();
	let next = 0;
	let lockRequested = false;

	const holdTabLock = () => {
		if (lockRequested || !locks) return;
		lockRequested = true;
		// Never settles: the lock goes when the tab does.
		void locks
			.request(`${LOCK_PREFIX}${tabId}`, () => new Promise<never>(() => {}))
			.catch(() => {});
	};

	const openTabs = async (): Promise<Set<string> | null> => {
		if (!locks) return null;
		try {
			const snapshot = await locks.query();
			const names = [...(snapshot.held ?? []), ...(snapshot.pending ?? [])].map(
				(lock) => lock.name
			);
			return new Set(
				names
					.filter((name): name is string => name?.startsWith(LOCK_PREFIX) === true)
					.map((name) => name.slice(LOCK_PREFIX.length))
			);
		} catch {
			return null;
		}
	};

	return {
		open() {
			holdTabLock();
			next += 1;
			const id = `${tabId}.${next}`;
			openWriters.add(id);
			return { id, close: () => openWriters.delete(id) };
		},
		async liveness() {
			const tabs = await openTabs();
			return (writerId) => {
				const tab = writerId.split('.')[0] ?? '';
				if (tab === tabId) return openWriters.has(writerId);
				return tabs?.has(tab) === true;
			};
		},
	};
}

const randomTabId = () =>
	typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let shared: EditorDraftWriters | null = null;

/** This page's writers (one tab id per page load). */
export function getEditorDraftWriters(): EditorDraftWriters {
	shared ??= createEditorDraftWriters(
		randomTabId(),
		typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null
	);
	return shared;
}
