/**
 * Edits that live only in a mounted component (a form, a wizard, an editor of
 * something already saved) register here while they are unsaved, so an app
 * update never reloads the page over them (`reloadSafety.ts` reads this).
 *
 * Kept apart from `reloadSafety.ts` so the composer-draft book can register
 * its component-local drafts without importing the module that reads the book.
 */

const blockers = new Set<() => boolean>();

/**
 * Keep the page from reloading while `probe` answers true. Returns the
 * unregister.
 */
export function registerReloadBlocker(probe: () => boolean): () => void {
	blockers.add(probe);
	return () => blockers.delete(probe);
}

/** A registered probe reports edits a reload would lose. */
export function hasReloadBlocker(): boolean {
	for (const probe of blockers) if (probe()) return true;
	return false;
}
