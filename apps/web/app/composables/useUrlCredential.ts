import { computed, onMounted, ref } from 'vue';

/**
 * A credential that arrives in the page's query string (`?token=…`), read into
 * the page and then taken out of the URL.
 *
 * Left in the URL, the value sits in the tab's history (and in the `back`
 * state vue-router records for the next entry), in anything that copies the
 * address and in every URL-bearing report the page might produce. Once
 * mounted, the page keeps the value and replaces the route with the same one
 * minus that parameter, so the router's own location is clean too. Retries
 * keep working from the kept value.
 *
 * A reload, or coming back to the entry, finds a clean URL, so the value is
 * also kept in `sessionStorage` under the route's path: tab-scoped, gone when
 * the tab closes. That also means a later visit to the bare path in the same
 * tab (`/share` without a token) reuses the stored value. A page calls
 * `forget()` once the value is spent or known to be invalid, which clears the
 * stored copy (the page itself keeps what it has).
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

export function useUrlCredential(key = 'token') {
	const route = useRoute();
	const router = useRouter();
	const storageKey = `${STORAGE_PREFIX}${route.path}:${key}`;

	let stored: string | undefined;
	try {
		stored = single(storage()?.getItem(storageKey));
	} catch {
		stored = undefined;
	}
	const kept = ref<string | undefined>(single(route.query[key]) ?? stored);

	const token = computed(() => single(route.query[key]) ?? kept.value);

	onMounted(() => {
		const value = single(route.query[key]);
		if (!value) return;
		kept.value = value;
		try {
			storage()?.setItem(storageKey, value);
		} catch {
			// Without storage a reload shows the page's missing-link state; the
			// value still leaves the URL.
		}
		const { [key]: _dropped, ...query } = route.query;
		void router.replace({ query, hash: route.hash });
	});

	function forget(): void {
		try {
			storage()?.removeItem(storageKey);
		} catch {
			// Nothing to forget.
		}
	}

	return { token, forget };
}
