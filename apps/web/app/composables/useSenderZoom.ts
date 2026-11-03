import { computed, readonly, shallowRef } from 'vue';
import { postboxSenderKey } from '~/utils/postboxImageAllowlist';
import { combineZoom, type MailTypography } from '~/utils/readingComfort';
import {
	nextSenderZoom,
	parseSenderZooms,
	SENDER_ZOOM_DEFAULT,
	SENDER_ZOOM_STORAGE_KEY,
	withSenderZoom,
	type SenderZoomAction,
	type SenderZooms,
} from '~/utils/senderZoom';
import { useReadingComfort } from './useReadingComfort';

/**
 * The one owner of the per-sender mail zoom (utils/senderZoom): read once from
 * this device's localStorage, written back on every change, and kept in step
 * with other tabs through the `storage` event. Module state, so the reader's
 * menu, its keys and the palette all move the same value.
 *
 * Storage that throws is not an error: the zoom still applies for this page.
 */

const zooms = shallowRef<SenderZooms>({});
let loaded = false;

function storage(): Storage | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function persist(value: SenderZooms): void {
	try {
		const store = storage();
		if (Object.keys(value).length === 0) store?.removeItem(SENDER_ZOOM_STORAGE_KEY);
		else store?.setItem(SENDER_ZOOM_STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Unavailable or full: the change still applies until the page reloads.
	}
}

function onStorage(event: StorageEvent): void {
	// `key === null` is a `localStorage.clear()` in another tab.
	if (event.key !== null && event.key !== SENDER_ZOOM_STORAGE_KEY) return;
	zooms.value = parseSenderZooms(event.newValue);
}

function ensureLoaded(): void {
	if (loaded || typeof window === 'undefined') return;
	loaded = true;
	let raw: string | null = null;
	try {
		raw = storage()?.getItem(SENDER_ZOOM_STORAGE_KEY) ?? null;
	} catch {
		raw = null;
	}
	zooms.value = parseSenderZooms(raw);
	window.addEventListener('storage', onStorage);
}

function commit(next: SenderZooms): void {
	zooms.value = next;
	persist(next);
}

export function useSenderZoom() {
	ensureLoaded();

	/** Percent for a From address; 100 when the sender has none or no address. */
	function zoomOf(fromAddress: string | null | undefined): number {
		const sender = postboxSenderKey(fromAddress);
		return (sender && zooms.value[sender]) || SENDER_ZOOM_DEFAULT;
	}

	return {
		zooms: readonly(zooms),
		zoomOf,
		/** Step the sender's zoom; false when the From header holds no address. */
		applyZoom(fromAddress: string | null | undefined, action: SenderZoomAction): boolean {
			const sender = postboxSenderKey(fromAddress);
			if (!sender) return false;
			const next = nextSenderZoom(zoomOf(sender), action);
			if (next !== zoomOf(sender)) commit(withSenderZoom(zooms.value, sender, next));
			return true;
		},
		/** Number of senders with a zoom of their own. */
		count: computed(() => Object.keys(zooms.value).length),
		/** Back to 100% for every sender. */
		clearAll(): void {
			commit({});
		},
	};
}

/**
 * The typography a body from `fromAddress` renders with: the reading-comfort
 * settings, with the sender's zoom multiplied into their zoom.
 */
export function useSenderMailTypography(fromAddress: () => string | null | undefined) {
	const { mailTypography } = useReadingComfort();
	const { zoomOf } = useSenderZoom();
	return computed<MailTypography>(() => ({
		...mailTypography.value,
		zoom: combineZoom(mailTypography.value.zoom, zoomOf(fromAddress()) / 100),
	}));
}

/** Test seam: forget the loaded state and the cross-tab listener. */
export function resetSenderZoomForTests(): void {
	if (loaded && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
	loaded = false;
	zooms.value = {};
}
