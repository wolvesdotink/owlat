import { decodeJsonText, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import type { StoredValueReader } from '~/utils/storedValue';

/**
 * `key`'s value in `storage` as `read` accepts it. Anything else (no entry,
 * text that is not JSON, a value `read` does not accept, a storage that
 * throws) reads as `defaultValue`.
 */
export function readStoredValue<T>(
	storage: Pick<Storage, 'getItem'>,
	key: string,
	defaultValue: T,
	read: StoredValueReader<T>
): T {
	let stored: string | null;
	try {
		stored = storage.getItem(key);
	} catch {
		// Storage itself is unavailable (blocked, sandboxed).
		return defaultValue;
	}
	if (stored === null) return defaultValue;
	const decoded = decodeJsonText(stored, parserDecoder(read, `${key}: not a stored value`));
	return decoded.ok ? decoded.value : defaultValue;
}

/**
 * Composable for localStorage state management with SSR support
 *
 * Provides a reactive wrapper around localStorage that:
 * - Handles SSR (only accesses localStorage on client)
 * - Auto-serializes/deserializes JSON values, checking what it reads with
 *   `read` (see `readStoredValue`)
 * - Returns a reactive ref that syncs with localStorage
 */

export function useLocalStorage<T>(key: string, defaultValue: T, read: StoredValueReader<T>) {
	const data = ref<T>(defaultValue) as Ref<T>;

	// Read from localStorage on client
	const readFromStorage = (): T => {
		if (!import.meta.client) {
			return defaultValue;
		}
		try {
			return readStoredValue(localStorage, key, defaultValue, read);
		} catch {
			// Reaching `localStorage` itself throws in a sandboxed frame.
			return defaultValue;
		}
	};

	// Write to localStorage
	const writeToStorage = (value: T): void => {
		if (!import.meta.client) {
			return;
		}

		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {
			// Silently fail if localStorage is unavailable or quota exceeded
		}
	};

	// Set value and sync to localStorage
	const set = (value: T): void => {
		data.value = value;
		writeToStorage(value);
	};

	// Initialize from localStorage on client
	if (import.meta.client) {
		data.value = readFromStorage();
	}

	return {
		data,
		set,
	};
}
