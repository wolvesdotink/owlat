/**
 * Persisted collapse state for the Postbox folder rail (PostboxLayout pane 1).
 *
 * Collapsed, the rail shrinks to a ~48px icon strip: folder glyphs + unread
 * badges with tooltips, a search icon that opens the search page, and a chevron
 * to re-expand. Folder CRUD, label management and the search box are
 * expanded-only. The choice is a per-device UI preference (like the toolbar
 * preference), so it persists via localStorage rather than the Convex settings
 * row.
 */
const STORAGE_KEY = 'postbox-rail-collapsed';

export function usePostboxRailCollapsed() {
	const { data: collapsed, set } = useLocalStorage(STORAGE_KEY, false);

	function toggle() {
		set(!collapsed.value);
	}

	function setCollapsed(value: boolean) {
		set(value);
	}

	return { collapsed, toggle, setCollapsed };
}
