/**
 * Persistence for the composer's local draft mirror (plan idea 7).
 *
 * Shares the object store and the driver with {@link PostboxOfflineStore} (one
 * IndexedDB connection per page) but is its own module because it is its own
 * failure contract:
 *
 *   - FAIL-SOFT, like the cache. The mirror is a SECOND copy of text the server
 *     is also being told about, so a device that cannot store it degrades to
 *     exactly today's server-only autosave. A composer must never refuse a
 *     keystroke over a storage failure. (The outbox is the opposite: queued
 *     mail has no other copy, so those writes throw.)
 *   - TOMBSTONED, BUT ONE-SHOT. A deliberately thrown-away draft leaves a
 *     `draft-mirror-dead:` marker so a write that was already debounced when
 *     Discard was pressed cannot resurrect it — including from the next page
 *     load, since that write may only land after a reload. The marker is
 *     CONSUMED by the read that honours it, because mirror keys are reused: a
 *     fresh compose keys off `new`, a reply off the message it answers, and a
 *     draft id outlives the composer that discarded it. A permanent tombstone
 *     would therefore trade one Discard for crash recovery on every later
 *     composition sharing that key, forever.
 *
 * Namespaced by mailboxId like every other key family here, so one account's
 * unsent text is never offered inside another on a shared device.
 *
 * Pure data layer: no Vue, no DOM, no network. The reconcile decision lives in
 * `postboxDraftMirror.ts` and the wiring in `usePostboxComposeMirror.ts`.
 */

import type { DraftMirrorEntry } from './postboxDraftMirror';
import { getOfflineKvDriver, type OfflineKvDriver } from './postboxOfflineStore';

/**
 * Mirrors retained per mailbox. The compositions open at once are a handful
 * (the composer stack caps well below this); the cap exists so a device that
 * crashes repeatedly cannot accumulate mirrors without bound.
 */
export const DRAFT_MIRRORS_CAP = 20;

const mirrorKey = (ns: string, id: string) => `draft-mirror:${ns}:${id}`;
const mirrorIndexKey = (ns: string) => `draft-mirror-index:${ns}`;
const mirrorTombKey = (ns: string, id: string) => `draft-mirror-dead:${ns}:${id}`;

export class PostboxDraftMirrorStore {
	private readonly driver: OfflineKvDriver;
	/**
	 * Keys retired this session. Held in memory as well as on disk so the
	 * refusal costs no extra read on the hot (debounced, per-burst-of-typing)
	 * write path — the race it closes is same-tab, between Discard and a mirror
	 * write that was already scheduled when Discard fired. Consumed by
	 * {@link load}, which is the moment a new composition claims the key.
	 */
	private readonly discarded = new Set<string>();

	constructor(driver: OfflineKvDriver) {
		this.driver = driver;
	}

	/** Best-effort write; a failure is swallowed (see the module header). */
	private async safeSet(key: string, value: unknown): Promise<boolean> {
		try {
			await this.driver.set(key, value);
			return true;
		} catch {
			return false;
		}
	}

	private async safeGet<T>(key: string, fallback: T): Promise<T> {
		try {
			const value = await this.driver.get<T>(key);
			return value === undefined ? fallback : value;
		} catch {
			return fallback;
		}
	}

	/**
	 * Mirror one composition's live fields. Refuses a key retired this session,
	 * so a write debounced before a Discard lands as a no-op. Returns whether
	 * anything was actually stored.
	 */
	async save(ns: string, id: string, entry: DraftMirrorEntry): Promise<boolean> {
		if (this.discarded.has(mirrorKey(ns, id))) return false;
		if (!(await this.safeSet(mirrorKey(ns, id), entry))) return false;

		const index = await this.safeGet<string[]>(mirrorIndexKey(ns), []);
		const next = index.filter((existing) => existing !== id);
		next.push(id);
		while (next.length > DRAFT_MIRRORS_CAP) {
			const evicted = next.shift();
			if (evicted === undefined) break;
			try {
				await this.driver.delete(mirrorKey(ns, evicted));
			} catch {
				// A failed eviction just leaves an orphan mirror; harmless.
			}
		}
		await this.safeSet(mirrorIndexKey(ns), next);
		return true;
	}

	/**
	 * The mirror for one composition, or null when there is none — including
	 * when it was deliberately retired. The tombstone is read back here, so a
	 * LATER SESSION (not only the tab that discarded) refuses it too.
	 *
	 * REFUSE AND CONSUME. Honouring a tombstone also retires it: a `load` is a
	 * new composer claiming the key, and by then every write the retired one had
	 * in flight has either landed (and is refused here) or been cancelled. Left
	 * standing, the marker would refuse that new composition's writes as well —
	 * one Discard of a blank compose would disable crash recovery for every
	 * later compose on `new`, in this session and all the ones after it.
	 */
	async load(ns: string, id: string): Promise<DraftMirrorEntry | null> {
		const key = mirrorKey(ns, id);
		const tomb = await this.safeGet<{ at: number } | null>(mirrorTombKey(ns, id), null);
		if (tomb || this.discarded.has(key)) {
			this.discarded.delete(key);
			if (tomb) {
				try {
					await this.driver.delete(mirrorTombKey(ns, id));
				} catch {
					// A surviving tombstone only costs one more refused open.
				}
			}
			return null;
		}
		return this.safeGet<DraftMirrorEntry | null>(key, null);
	}

	/**
	 * Drop a mirror whose content is now safely on the server (a confirmed save,
	 * an applied restore). No tombstone: this composition may carry on being
	 * edited, and the next change mirrors it again.
	 */
	async clear(ns: string, id: string): Promise<void> {
		try {
			await this.driver.delete(mirrorKey(ns, id));
		} catch {
			// Best-effort: a surviving mirror is reconciled away on the next open.
		}
		const index = await this.safeGet<string[]>(mirrorIndexKey(ns), []);
		if (index.includes(id)) {
			await this.safeSet(
				mirrorIndexKey(ns),
				index.filter((existing) => existing !== id)
			);
		}
	}

	/**
	 * Retire a composition (Discard, a queued or completed send): clear the
	 * mirror AND tombstone the key, so a write this composition still had in
	 * flight cannot put it back. The tombstone lasts exactly until the next
	 * {@link load} — see there for why it must not outlive that.
	 *
	 * Superseding a single stale entry under a key that stays live — dismissing
	 * a restore offer on a draft the user goes on editing — is {@link clear},
	 * not this.
	 */
	async discard(ns: string, id: string): Promise<void> {
		this.discarded.add(mirrorKey(ns, id));
		await this.clear(ns, id);
		await this.safeSet(mirrorTombKey(ns, id), { at: Date.now() });
	}
}

let singleton: PostboxDraftMirrorStore | null = null;

/** The shared draft-mirror store for this session. */
export function getPostboxDraftMirrorStore(): PostboxDraftMirrorStore {
	if (!singleton) singleton = new PostboxDraftMirrorStore(getOfflineKvDriver());
	return singleton;
}
