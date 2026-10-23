/**
 * Whether the page may reload without losing anything the person did.
 *
 * A reload keeps only what reached the server or the device. Three owners
 * answer for the rest, and a reload waits on all of them:
 *
 *  - `pendingOperations`: writes the server has not acknowledged yet, the
 *    holds of uploads and debounced saves, and its unsaved-work probes (a
 *    failed autosave, the offline outbox);
 *  - the blockers registered here: a page whose edits are not saved
 *    (`useUnsavedChanges` registers its dirty flag for as long as it is
 *    mounted);
 *  - the composer-draft book: unsent text whose device copy has not committed.
 *
 * The book is the only owner that settles by itself, so it is the only one a
 * reload waits for; anything else that blocks stays the person's to finish.
 */
import { useComposerDrafts } from '~/composables/useComposerDrafts';
import { hasPendingWork } from '~/lib/pendingOperations';

/** How long a reload waits for composer drafts to reach the device before giving up. */
export const DRAFT_SETTLE_TIMEOUT_MS = 3_000;

const blockers = new Set<() => boolean>();

/**
 * Keep the page from reloading while `probe` answers true. Returns the
 * unregister.
 */
export function registerReloadBlocker(probe: () => boolean): () => void {
	blockers.add(probe);
	return () => blockers.delete(probe);
}

/** Something other than composer drafts would be lost by a reload. */
function blockedOutsideDrafts(): boolean {
	return hasPendingWork() || [...blockers].some((probe) => probe());
}

/** A reload now would lose something. */
function reloadBlocked(): boolean {
	return blockedOutsideDrafts() || useComposerDrafts().hasUnstoredDrafts();
}

/**
 * Let composer drafts finish reaching the device, then answer whether the page
 * may reload. False when anything else blocks it, when the drafts did not
 * settle within {@link DRAFT_SETTLE_TIMEOUT_MS} or did not commit, and when an
 * edit made while waiting is not saved yet. A true answer holds until the
 * caller's next await: reload in the same task.
 */
export async function settleForReload(): Promise<boolean> {
	if (blockedOutsideDrafts()) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		useComposerDrafts()
			.idle()
			.then(() => true),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), DRAFT_SETTLE_TIMEOUT_MS);
		}),
	]);
	clearTimeout(timer);
	return settled && !reloadBlocked();
}
