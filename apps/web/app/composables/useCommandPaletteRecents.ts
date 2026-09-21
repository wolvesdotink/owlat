/**
 * The command palette's memory of recent search terms, per scope.
 *
 * Kept in `localStorage` so an idle palette can offer what you looked for last
 * time instead of a blank list. It is now the app's ONLY search history: the
 * Postbox search bar's private key folds in on first load (see
 * `~/lib/commandPaletteRecents`), so Mail history and object-search history are
 * two tags on one store rather than two stores that never met.
 *
 * Every storage access is guarded: `localStorage` is absent on the server and
 * throws in a private-mode/quota-exhausted browser, and neither case is worth
 * breaking the palette over — the list just stays empty.
 */

import {
	LEGACY_MAIL_RECENTS_KEY,
	PALETTE_RECENTS_KEY,
	type ScopedRecents,
	absorbLegacyMailRecents,
	emptyScopedRecents,
	parseScopedRecents,
	pushScopedRecent,
} from '~/lib/commandPaletteRecents';
import type { PaletteScope } from '~/lib/commandPaletteScope';

/**
 * `scope` is a getter rather than a value: the overlay's scope changes while it
 * is open (Tab, `?`, ⌘⇧K), and the offered history has to follow it.
 */
export function useCommandPaletteRecents(scope: () => PaletteScope = () => 'everything') {
	const store = ref<ScopedRecents>(emptyScopedRecents());

	/** Terms for the scope the palette is in right now, newest first. */
	const recentSearches = computed<string[]>(() => store.value[scope()] ?? []);

	function persist() {
		try {
			localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(store.value));
		} catch {
			// Ignore quota / disabled storage — history is a convenience, not state.
		}
	}

	/** Re-read the stored terms (the palette does this every time it opens). */
	function loadRecent() {
		if (import.meta.server) return;
		let stored: string | null = null;
		let legacy: string | null = null;
		try {
			stored = localStorage.getItem(PALETTE_RECENTS_KEY);
			legacy = localStorage.getItem(LEGACY_MAIL_RECENTS_KEY);
		} catch {
			store.value = emptyScopedRecents();
			return;
		}
		const parsed = parseScopedRecents(stored);
		if (legacy === null) {
			store.value = parsed;
			return;
		}
		// One-way migration: the search bar's history becomes Mail history and its
		// key goes, so the next load has nothing left to absorb.
		store.value = absorbLegacyMailRecents(parsed, legacy);
		persist();
		try {
			localStorage.removeItem(LEGACY_MAIL_RECENTS_KEY);
		} catch {
			// Ignore — a key that survives is re-absorbed idempotently next time.
		}
	}

	/** Record a term as the newest of the active scope, deduplicated and capped. */
	function saveRecent(term: string) {
		if (import.meta.server) return;
		const next = pushScopedRecent(store.value, scope(), term);
		if (next === store.value) return;
		store.value = next;
		persist();
	}

	/** Clears the ACTIVE scope only — the other scopes' history is not yours to drop. */
	function clearRecent() {
		store.value = { ...store.value, [scope()]: [] };
		if (import.meta.client) persist();
	}

	return { recentSearches, loadRecent, saveRecent, clearRecent };
}
