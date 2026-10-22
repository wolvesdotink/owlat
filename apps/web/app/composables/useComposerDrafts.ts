/**
 * Unsent text in the conversation composers, kept per thread or room so a
 * reload, a crash or a closed tab loses nothing (`utils/composerDraftStore.ts`
 * is the device copy).
 *
 * One book per page, held in memory and written through to the device:
 *
 *  - Reads are synchronous and reactive, so a composer binds its text to the
 *    book and a list row can show that a thread or room holds a draft.
 *  - Every change is stored as it is made, not on unmount: a reload never
 *    gives the page a chance to say goodbye. Writes for one draft run in
 *    order and coalesce to the newest value, so a late write can never bring
 *    back text that was already sent or cleared.
 *  - The device copy loads once per signed-in person, after the page has
 *    started. Anything typed (or cleared) before it arrives wins over it.
 *  - Signing out, or another person signing in, empties the book; their
 *    drafts stay on the device under their own key.
 */
import { shallowRef, watch, effectScope, computed, type WritableComputedRef } from 'vue';
import {
	composerDraftHasContent,
	composerDraftKey,
	getComposerDraftStore,
	isComposerDraftEmpty,
	type ComposerDraftFields,
	type ComposerDraftKind,
	type ComposerDraftStore,
	type StoredComposerDraft,
} from '~/utils/composerDraftStore';

const bookKey = (kind: ComposerDraftKind, target: string) => `${kind}\u0000${target}`;

type DraftUpdate<K extends ComposerDraftKind> = (
	current: ComposerDraftFields<K> | null
) => ComposerDraftFields<K> | null;

/** One pending change to one stored draft. */
type DeviceOp =
	/** The book's value for its signed-in person. `blind`: set before their device copy loaded. */
	| { put: ComposerDraftFields | null; blind: boolean }
	/** A settle for a person no longer on the page, applied to their device copy. */
	| { offBook: () => Promise<void> };

export function createComposerDraftBook(
	store: () => ComposerDraftStore,
	now: () => number = Date.now
) {
	const drafts = shallowRef<Readonly<Record<string, ComposerDraftFields>>>({});
	// Nobody signed in: nothing to load.
	const ready = shallowRef(true);
	let userId: string | null = null;
	let generation = 0;
	/** Drafts changed since this person's device copy started loading. */
	let changed = new Set<string>();
	let hydration: Promise<void> = Promise.resolve();
	/** By storage key: the value this page last read or wrote there. */
	let known = new Map<string, StoredComposerDraft>();
	const queued = new Map<string, DeviceOp[]>();
	const writing = new Map<string, Promise<void>>();

	async function apply(key: string, op: DeviceOp): Promise<void> {
		if ('offBook' in op) {
			await op.offBook();
		} else if (op.put) {
			const stored = await store().write(key, op.put, now());
			if (stored) known.set(key, stored);
		} else {
			// Only what this page saw there goes. A device copy it never read
			// was saved by another tab (or after this one loaded) and stays;
			// before the load, the person's clear wins over a copy not yet shown.
			const expected = known.get(key);
			if (expected === undefined && !op.blind) return;
			if (await store().remove(key, expected)) known.delete(key);
		}
	}

	async function drain(key: string): Promise<void> {
		// Yield first, so `writing` holds this run before anything is awaited.
		await Promise.resolve();
		try {
			for (let op = queued.get(key)?.shift(); op; op = queued.get(key)?.shift()) {
				try {
					await apply(key, op);
				} catch {
					// The store reports failures; a throwing one must not stall the queue.
				}
			}
		} finally {
			queued.delete(key);
			writing.delete(key);
		}
	}

	function enqueue(key: string, op: DeviceOp) {
		// The book's value supersedes everything still pending for the key; a
		// settle for an absent person is applied in turn.
		if ('put' in op) queued.set(key, [op]);
		else queued.set(key, [...(queued.get(key) ?? []), op]);
		if (!writing.has(key)) writing.set(key, drain(key));
	}

	function persist(kind: ComposerDraftKind, target: string, fields: ComposerDraftFields | null) {
		if (!userId) return;
		enqueue(composerDraftKey(userId, kind, target), { put: fields, blind: !ready.value });
	}

	async function hydrate(forUser: string, forGeneration: number): Promise<void> {
		const loaded = await store().load(forUser, now(), (kind, target) =>
			changed.has(bookKey(kind, target))
		);
		if (forGeneration !== generation) return;
		const fromDevice: Record<string, ComposerDraftFields> = {};
		for (const draft of loaded) {
			const key = bookKey(draft.kind, draft.target);
			if (changed.has(key)) continue;
			fromDevice[key] = draft.fields;
			known.set(composerDraftKey(forUser, draft.kind, draft.target), draft.stored);
		}
		drafts.value = { ...fromDevice, ...drafts.value };
		ready.value = true;
	}

	function get<K extends ComposerDraftKind>(
		kind: K,
		target: string
	): ComposerDraftFields<K> | null {
		return (drafts.value[bookKey(kind, target)] as ComposerDraftFields<K> | undefined) ?? null;
	}

	function set<K extends ComposerDraftKind>(
		kind: K,
		target: string,
		fields: ComposerDraftFields<K> | null
	): void {
		const key = bookKey(kind, target);
		const next = fields && !isComposerDraftEmpty(kind, fields) ? fields : null;
		const current = drafts.value[key] ?? null;
		// Until the device copy has loaded, memory is not the whole truth: a
		// clear must still reach the device and win over what loads.
		const unchanged =
			next === null ? current === null : JSON.stringify(next) === JSON.stringify(current);
		if (unchanged && ready.value) return;
		const copy = { ...drafts.value };
		if (next) copy[key] = next;
		else delete copy[key];
		drafts.value = copy;
		changed.add(key);
		persist(kind, target, next);
	}

	/**
	 * An updater for this draft as it belongs to the person signed in now. A
	 * send or upload that resolves later settles THEIR draft: if someone else
	 * has signed in meanwhile, it goes to the first person's device copy and
	 * never touches the new person's book; with nobody signed in when it
	 * started, there is nothing left to settle.
	 */
	function pin<K extends ComposerDraftKind>(kind: K, target: string) {
		const owner = userId;
		const ownGeneration = generation;
		const settle = (update: DraftUpdate<K>): void => {
			if (ownGeneration === generation || (owner !== null && owner === userId && ready.value)) {
				set(kind, target, update(get(kind, target)));
			} else if (owner !== null && owner === userId) {
				// The same person signed in again: settle once their copy is back.
				void hydration.then(() => settle(update));
			} else if (owner !== null) {
				const key = composerDraftKey(owner, kind, target);
				enqueue(key, { offBook: () => store().update(key, kind, update, now()) });
			}
		};
		return settle;
	}

	return {
		/** The device copy for the signed-in person has loaded (or there is none). */
		ready,
		get,
		set,
		pin,
		/** A draft a person would call one is kept for this target. */
		has(kind: ComposerDraftKind, target: string): boolean {
			const fields = get(kind, target);
			return !!fields && composerDraftHasContent(kind, fields);
		},
		/**
		 * Switch to `next` (null: signed out). The book empties and that
		 * person's device copy loads. The same person again is a no-op.
		 */
		bindUser(next: string | null): void {
			if (next !== null && next === userId) return;
			generation++;
			userId = next;
			drafts.value = {};
			changed = new Set();
			known = new Map();
			ready.value = next === null;
			if (next) hydration = hydrate(next, generation);
		},
		/** Resolves once the device copy has loaded and every write has settled. */
		async idle(): Promise<void> {
			await hydration;
			while (writing.size > 0) await Promise.all(writing.values());
		},
	};
}

export type ComposerDraftBook = ReturnType<typeof createComposerDraftBook>;

let book: ComposerDraftBook | null = null;

/** The page's composer-draft book. */
export function useComposerDrafts(): ComposerDraftBook {
	book ??= createComposerDraftBook(getComposerDraftStore);
	return book;
}

let following = false;

/**
 * Keep the book on the signed-in person (the auth middleware calls this on
 * every protected route; only the first call starts the watch).
 */
export function followComposerDraftsUser(userId: () => string | null | undefined): void {
	if (following) return;
	following = true;
	const drafts = useComposerDrafts();
	effectScope(true).run(() => {
		watch(
			() => userId() ?? null,
			(next) => drafts.bindUser(next),
			{ immediate: true }
		);
	});
}

/**
 * One composer's draft as a ref. `target` names the thread or room; while it
 * is null (no target known, or a box that must not be kept, such as an edit
 * of something already saved) the value lives in the component alone.
 *
 * `pin()` remembers the target, and who is signed in, as they are now and
 * returns an updater for that draft, so a send or upload that resolves after
 * the person moved on (another thread, another account) settles the draft it
 * started from, not the one now on screen. Anything that writes after an
 * await must go through it.
 */
export function useComposerDraft<K extends ComposerDraftKind>(
	kind: K,
	target: () => string | null | undefined,
	blank: ComposerDraftFields<K>
): {
	draft: WritableComputedRef<ComposerDraftFields<K>>;
	pin: () => (update: (current: ComposerDraftFields<K>) => ComposerDraftFields<K>) => void;
} {
	const drafts = useComposerDrafts();
	const local = shallowRef<ComposerDraftFields<K>>(blank);
	const read = (at: string | null) => (at === null ? local.value : (drafts.get(kind, at) ?? blank));
	const write = (at: string | null, fields: ComposerDraftFields<K>) => {
		if (at === null) local.value = fields;
		else drafts.set(kind, at, fields);
	};
	const draft = computed<ComposerDraftFields<K>>({
		get: () => read(target() ?? null),
		set: (fields) => write(target() ?? null, fields),
	});
	return {
		draft,
		pin() {
			const at = target() ?? null;
			if (at === null) return (update) => (local.value = update(local.value));
			const settle = drafts.pin(kind, at);
			return (update) => settle((current) => update(current ?? blank));
		},
	};
}

/** The team composer's note draft key for a Team inbox thread. */
export function teamNoteDraftKey(threadId: string): string {
	return `team:${threadId}`;
}

/** Any of the viewer's unsent text on a Team inbox thread (the row's pencil). */
export function teamThreadHasDraft(drafts: ComposerDraftBook, threadId: string): boolean {
	return (
		drafts.has('team-reply', threadId) ||
		drafts.has('team-note', teamNoteDraftKey(threadId)) ||
		drafts.has('answer-note', threadId) ||
		drafts.has('channel-reply', threadId)
	);
}
