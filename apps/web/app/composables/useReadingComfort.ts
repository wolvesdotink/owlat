import { computed, readonly, shallowRef } from 'vue';
import { setAppReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import {
	parseReadingComfort,
	READING_COMFORT_DEFAULTS,
	READING_COMFORT_STORAGE_KEY,
	readingComfortRootAttributes,
	type MailTypography,
	type ReadingComfort,
} from '~/utils/readingComfort';

/**
 * The one owner of the reading-comfort settings (utils/readingComfort): read
 * once from this device's localStorage, validated field by field, written back
 * on every change, and kept in step with other tabs through the `storage`
 * event. Module state, so every caller shares one value.
 *
 * Storage that throws (a privacy mode, a sandboxed webview, a full quota) is
 * not an error: the settings still apply for this page and fall back to the
 * defaults on the next load.
 */

const state = shallowRef<ReadingComfort>({ ...READING_COMFORT_DEFAULTS });
let loaded = false;

function storage(): Storage | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function readStored(): string | null {
	try {
		return storage()?.getItem(READING_COMFORT_STORAGE_KEY) ?? null;
	} catch {
		return null;
	}
}

function persist(value: ReadingComfort): void {
	try {
		storage()?.setItem(READING_COMFORT_STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Unavailable or full: the change still applies until the page reloads.
	}
}

function onStorage(event: StorageEvent): void {
	// `key === null` is a `localStorage.clear()` in another tab.
	if (event.key !== null && event.key !== READING_COMFORT_STORAGE_KEY) return;
	state.value = parseReadingComfort(event.newValue);
}

function ensureLoaded(): void {
	if (loaded || typeof window === 'undefined') return;
	loaded = true;
	state.value = parseReadingComfort(readStored());
	window.addEventListener('storage', onStorage);
}

/**
 * Write the settings onto `<html>`: the attributes the CSS keys off (contrast,
 * motion, list density) and the shared reduced-motion owner that JavaScript
 * callers read. Called by the reading-comfort plugin on load and on change.
 */
export function applyReadingComfort(root: HTMLElement, comfort: ReadingComfort): void {
	for (const [name, value] of Object.entries(readingComfortRootAttributes(comfort))) {
		if (value === null) root.removeAttribute(name);
		else root.setAttribute(name, value);
	}
	setAppReducedMotion(comfort.reduceMotion);
}

export function useReadingComfort() {
	ensureLoaded();

	function set<K extends keyof ReadingComfort>(key: K, value: ReadingComfort[K]): void {
		if (state.value[key] === value) return;
		const next = { ...state.value, [key]: value };
		state.value = next;
		persist(next);
	}

	return {
		comfort: readonly(state),
		/** The two settings that change a rendered mail body. */
		mailTypography: computed<MailTypography>(() => ({
			textSize: state.value.textSize,
			readingWidth: state.value.readingWidth,
		})),
		set,
		reset<K extends keyof ReadingComfort>(key: K): void {
			set(key, READING_COMFORT_DEFAULTS[key]);
		},
		isChanged(key: keyof ReadingComfort): boolean {
			return state.value[key] !== READING_COMFORT_DEFAULTS[key];
		},
	};
}

/** Test seam: forget the loaded state and the cross-tab listener. */
export function resetReadingComfortForTests(): void {
	if (loaded && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
	loaded = false;
	state.value = { ...READING_COMFORT_DEFAULTS };
	setAppReducedMotion(false);
}
