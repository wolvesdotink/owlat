/**
 * Whether the folder rail's "More" group is expanded.
 *
 * A per-device UI preference like `usePostboxRailCollapsed` and
 * `usePostboxLabelCollapse`, so it lives in localStorage rather than the Convex
 * settings row: whether you keep Spam, Trash and the setup-time destinations
 * unfolded is about this screen, not about the mailbox. Collapsed by default —
 * the group exists precisely because none of its rows is a daily click.
 */
const STORAGE_KEY = 'postbox-rail-more-open';

export function usePostboxRailMore() {
	const { data: isOpen, set } = useLocalStorage(STORAGE_KEY, false);

	function toggle() {
		set(!isOpen.value);
	}

	return { isOpen, toggle, setOpen: set };
}
