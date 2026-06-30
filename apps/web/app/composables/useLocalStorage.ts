/**
 * Composable for localStorage state management with SSR support
 *
 * Provides a reactive wrapper around localStorage that:
 * - Handles SSR (only accesses localStorage on client)
 * - Auto-serializes/deserializes JSON values
 * - Returns a reactive ref that syncs with localStorage
 */

export function useLocalStorage<T>(key: string, defaultValue: T) {
	const data = ref<T>(defaultValue) as Ref<T>;

	// Read from localStorage on client
	const readFromStorage = (): T => {
		if (!import.meta.client) {
			return defaultValue;
		}

		try {
			const stored = localStorage.getItem(key);
			if (stored === null) {
				return defaultValue;
			}
			return JSON.parse(stored) as T;
		} catch {
			// If JSON parsing fails, return default value
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
