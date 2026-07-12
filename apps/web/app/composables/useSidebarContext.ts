import type { NavigationSection } from '~/composables/useDashboardNavigation';
import {
	type SidebarContext,
	contextForPath,
	resolveSwitchTarget,
	splitSectionsByContext,
} from '~/lib/sidebarContext';

/**
 * Reactive wiring for the sidebar's Inbox ↔ Marketing context toggle (pure
 * model in `lib/sidebarContext.ts`).
 *
 * - Route-driven: navigating anywhere inside a context's subtree activates it
 *   (⌘K, deep links and dashboard cards all cross contexts without the toggle).
 * - Sticky on shared routes: Dashboard/Assistant/Knowledge/Settings keep the
 *   last context, persisted across sessions.
 * - Toggling navigates: to that context's last-visited route, falling back to
 *   its home. Never leaves the page and the sidebar disagreeing.
 * - Emergent: the toggle only exists while BOTH contexts survived the feature
 *   flags; otherwise the sidebar stays today's flat list.
 */

// Module-level storage (singleton across component instances, same pattern as
// useSidebarState). Fresh users default to Inbox.
const contextStorage = useLocalStorage<SidebarContext>('sidebar-context', 'inbox');
const lastVisitedStorage = useLocalStorage<Partial<Record<SidebarContext, string>>>(
	'sidebar-context-routes',
	{}
);

export function useSidebarContext() {
	const route = useRoute();
	const { navigationSections } = useDashboardNavigation();

	const split = computed(() => splitSectionsByContext(navigationSections.value));

	const showToggle = computed(
		() => split.value.inbox.length > 0 && split.value.marketing.length > 0
	);

	// Owned route → that context; shared route → whatever was last active.
	const activeContext = computed<SidebarContext>(
		() => contextForPath(route.path) ?? contextStorage.data.value
	);

	// Record owned-route visits so switching back returns where you left off.
	// Multiple callers (layout + palette) register duplicate watchers; the
	// writes are idempotent so that is harmless.
	watch(
		() => route.fullPath,
		() => {
			const owned = contextForPath(route.path);
			if (!owned) return;
			contextStorage.set(owned);
			lastVisitedStorage.set({ ...lastVisitedStorage.data.value, [owned]: route.fullPath });
		},
		{ immediate: true }
	);

	// What the sidebar renders: the active context's sections, then the shared
	// ones. With the toggle hidden the original flat order is preserved.
	const sidebarSections = computed<NavigationSection[]>(() => {
		if (!showToggle.value) return navigationSections.value;
		return [...split.value[activeContext.value], ...split.value.shared];
	});

	// Divider anchor between the context block and the shared block.
	const firstSharedKey = computed(() =>
		showToggle.value ? (split.value.shared[0]?.key ?? null) : null
	);

	// Toggle click / ⌘K command. No-op when the current route already belongs
	// to the target; from a shared route it acts as "take me to that context".
	const switchContext = async (target: SidebarContext) => {
		if (contextForPath(route.path) === target) return;
		contextStorage.set(target);
		await navigateTo(
			resolveSwitchTarget(target, lastVisitedStorage.data.value[target], navigationSections.value)
		);
	};

	return { showToggle, activeContext, sidebarSections, firstSharedKey, switchContext };
}
