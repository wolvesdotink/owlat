import { computed, onMounted } from 'vue';

/**
 * A credential that arrives in the page's query string (`?token=…`), read into
 * the page and then taken out of the address bar.
 *
 * Left in the URL, the value sits in the tab's history entry, in anything that
 * copies the address and in every URL-bearing report the page might produce.
 * Once mounted, the parameter is replaced out of the current history entry; the
 * value stays available to the page (retries included), because the router's
 * own copy of the query is untouched.
 *
 * A reload, or coming back to the entry, finds a clean URL, so the value is
 * also kept in `sessionStorage` under the page's path: tab-scoped, gone when
 * the tab closes. A page whose credential is spent calls `forget()`.
 */

const STORAGE_PREFIX = 'owlat.urlCredential:';

function single(raw: unknown): string | undefined {
	return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function storage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage;
	} catch {
		// Storage can throw on access when the browser blocks it.
		return null;
	}
}

function withoutParam(path: string, key: string): string {
	const url = new URL(path, 'http://owlat.invalid');
	url.searchParams.delete(key);
	return url.pathname + url.search + url.hash;
}

function dropFromAddressBar(key: string): void {
	const url = new URL(window.location.href);
	if (!url.searchParams.has(key)) return;
	const state: unknown = window.history.state;
	// vue-router writes `state.current` back into this entry on the next push,
	// which would put the parameter back into the history it was removed from.
	const next =
		state &&
		typeof state === 'object' &&
		typeof (state as { current?: unknown }).current === 'string'
			? { ...state, current: withoutParam((state as { current: string }).current, key) }
			: state;
	window.history.replaceState(next, '', withoutParam(url.pathname + url.search + url.hash, key));
}

export function useUrlCredential(key = 'token') {
	const route = useRoute();
	const storageKey =
		typeof window === 'undefined' ? null : `${STORAGE_PREFIX}${window.location.pathname}:${key}`;

	let stored: string | undefined;
	if (storageKey) {
		try {
			stored = single(storage()?.getItem(storageKey));
		} catch {
			stored = undefined;
		}
	}

	const token = computed(() => single(route.query[key]) ?? stored);

	onMounted(() => {
		const value = single(route.query[key]);
		if (!value || !storageKey) return;
		try {
			storage()?.setItem(storageKey, value);
		} catch {
			// Without storage a reload shows the page's missing-link state; the
			// value still leaves the address bar.
		}
		dropFromAddressBar(key);
	});

	function forget(): void {
		stored = undefined;
		if (!storageKey) return;
		try {
			storage()?.removeItem(storageKey);
		} catch {
			// Nothing to forget.
		}
	}

	return { token, forget };
}
