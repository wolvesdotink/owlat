/**
 * Persisted preference for the composer's formatting toolbar.
 *
 * Default is the Apple-minimal floating bar (shows only over a selection); the
 * footer "Aa" affordance flips back to the classic persistent toolbar and
 * persists the choice per user via `useLocalStorage`.
 */
const STORAGE_KEY = 'postbox-composer-persistent-toolbar';

export function usePostboxToolbarPreference() {
	const { data: persistentToolbar, set } = useLocalStorage(STORAGE_KEY, false);
	function toggleToolbar() {
		set(!persistentToolbar.value);
	}
	return { persistentToolbar, toggleToolbar };
}
