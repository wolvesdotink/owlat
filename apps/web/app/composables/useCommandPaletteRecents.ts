/**
 * The command palette's memory of recent search terms.
 *
 * Carried over from the old GlobalSearch modal and kept in `localStorage`, so
 * an idle palette can offer what you looked for last time instead of a blank
 * list. Extracted from `AppCommandPalette.vue` to keep that component under the
 * file-size cap; it is also the only part of the palette that touches storage,
 * which makes it the one part worth isolating behind a seam.
 *
 * Every storage access is guarded: `localStorage` is absent on the server and
 * throws in a private-mode/quota-exhausted browser, and neither case is worth
 * breaking the palette over — the list just stays empty.
 */

import { MAX_RECENT_SEARCHES } from '~/lib/commandPaletteCore';

const RECENT_KEY = 'owlat_recent_searches';

export function useCommandPaletteRecents() {
	const recentSearches = ref<string[]>([]);

	/** Re-read the stored terms (the palette does this every time it opens). */
	function loadRecent() {
		if (import.meta.server) return;
		try {
			const stored = localStorage.getItem(RECENT_KEY);
			recentSearches.value = stored ? (JSON.parse(stored) as string[]) : [];
		} catch {
			recentSearches.value = [];
		}
	}

	/** Record a term as the newest, de-duplicated and capped. */
	function saveRecent(term: string) {
		const trimmed = term.trim();
		if (!trimmed || import.meta.server) return;
		recentSearches.value = [trimmed, ...recentSearches.value.filter((s) => s !== trimmed)].slice(
			0,
			MAX_RECENT_SEARCHES
		);
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches.value));
		} catch {
			// Ignore quota / disabled storage.
		}
	}

	function clearRecent() {
		recentSearches.value = [];
		if (import.meta.client) {
			try {
				localStorage.removeItem(RECENT_KEY);
			} catch {
				// Ignore.
			}
		}
	}

	return { recentSearches, loadRecent, saveRecent, clearRecent };
}
