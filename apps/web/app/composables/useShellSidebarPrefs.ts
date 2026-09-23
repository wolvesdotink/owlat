/**
 * The Conversations sidebar's own preferences (the "Sidebar options" menu):
 * how many conversations each inbox shows, how rows are ordered, and which
 * groups are collapsed. Persisted per device, like the other sidebar state.
 */

export type SidebarThreadSort = 'recent' | 'priority';

export const SIDEBAR_THREADS_MIN = 0;
export const SIDEBAR_THREADS_MAX = 10;
export const SIDEBAR_THREADS_DEFAULT = 3;

const threadsPerInbox = useLocalStorage<number>(
	'sidebar-threads-per-inbox',
	SIDEBAR_THREADS_DEFAULT
);
const threadSort = useLocalStorage<SidebarThreadSort>('sidebar-thread-sort', 'recent');
const collapsedGroups = useLocalStorage<string[]>('sidebar-collapsed-groups', []);

export function clampThreadsPerInbox(value: number): number {
	if (!Number.isFinite(value)) return SIDEBAR_THREADS_DEFAULT;
	return Math.min(SIDEBAR_THREADS_MAX, Math.max(SIDEBAR_THREADS_MIN, Math.round(value)));
}

export function useShellSidebarPrefs() {
	const perInbox = computed({
		get: () => clampThreadsPerInbox(threadsPerInbox.data.value),
		set: (value: number) => threadsPerInbox.set(clampThreadsPerInbox(value)),
	});
	const sort = computed({
		get: () => threadSort.data.value,
		set: (value: SidebarThreadSort) => threadSort.set(value),
	});
	const isCollapsed = (key: string) => collapsedGroups.data.value.includes(key);
	const toggleGroup = (key: string) => {
		const current = collapsedGroups.data.value;
		collapsedGroups.set(
			current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
		);
	};
	return { perInbox, sort, isCollapsed, toggleGroup };
}
