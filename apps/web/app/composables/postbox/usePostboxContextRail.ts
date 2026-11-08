/**
 * Persisted open/closed state of the Postbox reader's context rail (the
 * company and tasks beside an open conversation, PostboxContextRail). A
 * per-device layout preference, like the folder rail's collapse, so it lives
 * in localStorage rather than the Convex settings row. One choice for every
 * conversation: closing it once keeps the reader wide until it is opened again.
 */

import { readStoredBoolean } from '~/utils/storedValue';

const STORAGE_KEY = 'postbox-context-rail-collapsed';

export function usePostboxContextRail() {
	const { data: collapsed, set } = useLocalStorage(STORAGE_KEY, false, readStoredBoolean);

	function toggle() {
		set(!collapsed.value);
	}

	return { collapsed, toggle };
}
