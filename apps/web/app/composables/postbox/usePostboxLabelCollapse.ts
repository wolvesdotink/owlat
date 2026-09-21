/**
 * Which label branches are collapsed in the folder rail.
 *
 * A per-device UI preference like `usePostboxRailCollapsed`, so it lives in
 * localStorage rather than the Convex settings row: which branches you keep
 * folded is about this screen, not about the mailbox.
 *
 * Stored as an id array (a Set does not survive JSON), exposed as a Set so the
 * tree flattener can ask membership questions in O(1).
 */
const STORAGE_KEY = 'postbox-label-collapsed';

export function usePostboxLabelCollapse() {
	const { data, set } = useLocalStorage<string[]>(STORAGE_KEY, []);
	const collapsedIds = computed(() => new Set(data.value));

	function toggle(labelId: string) {
		const next = new Set(data.value);
		if (next.has(labelId)) next.delete(labelId);
		else next.add(labelId);
		set([...next]);
	}

	/** Un-collapse a run of ancestors — used to reveal the active label. */
	function expandAll(labelIds: readonly string[]) {
		if (labelIds.length === 0) return;
		const next = data.value.filter((id) => !labelIds.includes(id));
		if (next.length !== data.value.length) set(next);
	}

	return { collapsedIds, toggle, expandAll };
}
