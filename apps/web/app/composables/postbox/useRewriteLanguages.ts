/**
 * Recent + default target languages for the selection-rewrite "Translate…"
 * submenu. The user's recently-picked targets are persisted to localStorage and
 * surfaced first, falling back to a small common set so the submenu is never
 * empty. Purely client-side chrome — no network, no server state.
 */

import { ref, computed } from 'vue';

const STORAGE_KEY = 'postbox.rewrite.recentLanguages';
const MAX_RECENT = 5;

/** A short common set so the submenu is useful before any history exists. */
export const DEFAULT_LANGUAGES = [
	'English',
	'Spanish',
	'French',
	'German',
	'Portuguese',
] as const;

function load(): string[] {
	if (!import.meta.client) return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT);
	} catch {
		return [];
	}
}

export function useRewriteLanguages() {
	const recent = ref<string[]>(load());

	/** Recent targets first, then defaults not already listed. */
	const languages = computed(() => {
		const seen = new Set(recent.value.map((l) => l.toLowerCase()));
		const merged = [...recent.value];
		for (const lang of DEFAULT_LANGUAGES) {
			if (!seen.has(lang.toLowerCase())) merged.push(lang);
		}
		return merged;
	});

	/** Record a freshly-used target at the front of the recents list. */
	function remember(language: string) {
		const name = language.trim();
		if (!name) return;
		const next = [name, ...recent.value.filter((l) => l.toLowerCase() !== name.toLowerCase())].slice(
			0,
			MAX_RECENT
		);
		recent.value = next;
		if (import.meta.client) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				/* storage full / disabled — recents are best-effort */
			}
		}
	}

	return { languages, recent, remember };
}
