// Composable for managing sidebar state with localStorage persistence

export interface SectionState {
	inbox: boolean;
	postbox: boolean;
	chat: boolean;
	assistant: boolean;
	send: boolean;
	knowledge: boolean;
	audience: boolean;
	administration: boolean;
	preferences: boolean;
}

export type SectionKey = keyof SectionState;

// The three persistent display modes of the desktop sidebar.
//  - visible:   full-width rail with labels
//  - collapsed: icon-only rail (existing "Collapse" button)
//  - hidden:    off the layout entirely; content goes full-bleed and the rail
//               floats back in as a transient peek overlay (see `isPeeking`).
// `hidden` is orthogonal to `collapsed`: a hidden sidebar peeks at whatever
// width it last had (collapsed → w-16, otherwise → w-64).
export type SidebarMode = 'visible' | 'collapsed' | 'hidden';

const defaultSectionState: SectionState = {
	inbox: true,
	postbox: true,
	chat: true,
	assistant: true,
	send: true,
	knowledge: true,
	audience: true,
	administration: true,
	preferences: true,
};

/**
 * Reconcile a persisted section map with the current set of sections.
 *
 * `useLocalStorage` returns stored JSON verbatim, and the stored object predates
 * the current keys for anyone who used the sidebar before them ('settings' was
 * renamed to 'administration', 'preferences' was added, 'delivery' was removed).
 * A verbatim read therefore leaves the new keys `undefined`, and the sidebar's
 * plain truthy check renders `undefined` as collapsed — so an upgrade would
 * silently collapse the new sections once. Merging over the defaults fixes that;
 * only known keys are copied, so keys for sections that no longer exist are
 * dropped on the next write.
 */
function normalizeSectionState(stored: unknown): SectionState {
	const merged = { ...defaultSectionState };
	if (!stored || typeof stored !== 'object') return merged;
	const source = stored as Partial<Record<SectionKey, unknown>>;
	for (const key of Object.keys(defaultSectionState) as SectionKey[]) {
		const value = source[key];
		if (typeof value === 'boolean') merged[key] = value;
	}
	return merged;
}

// Use module-level storage to maintain singleton pattern across component instances
const collapsedStorage = useLocalStorage<boolean>('sidebar-collapsed', false);
const hiddenStorage = useLocalStorage<boolean>('sidebar-hidden', false);
const sectionsStorage = useLocalStorage<SectionState>('sidebar-sections', defaultSectionState);

// Section expand/collapse states, always reconciled against the current sections.
const normalizedSectionStates = computed<SectionState>(() =>
	normalizeSectionState(sectionsStorage.data.value)
);

// Transient peek overlay state — NOT persisted. True only while a hidden
// sidebar is floating over the content (hover hot-zone or focus).
const isPeeking = ref(false);

// Whether the viewport is wide enough (>= lg) for the hidden mode to apply.
// Mobile keeps its own off-canvas drawer, so `hidden` is a desktop-only concept.
// The dashboard layout keeps this in sync via matchMedia; defaults to true so
// SSR/tests behave as desktop.
const isDesktopViewport = ref(true);

export function useSidebarState() {
	// Sidebar collapsed state (icons only mode)
	const isCollapsed = collapsedStorage.data;

	// Sidebar hidden state (off the layout flow — desktop only)
	const isHidden = hiddenStorage.data;

	// Section expand/collapse states (read-only: mutate through toggleSection so
	// the persisted map is normalized on write)
	const sectionStates = normalizedSectionStates;

	// Hidden only takes effect on a desktop-width viewport; on mobile the raw
	// persisted value is ignored so the off-canvas drawer keeps working.
	const effectiveHidden = computed(() => isHidden.value && isDesktopViewport.value);

	// The resolved display mode consumers should render against.
	const sidebarMode = computed<SidebarMode>(() => {
		if (effectiveHidden.value) return 'hidden';
		return isCollapsed.value ? 'collapsed' : 'visible';
	});

	// Toggle sidebar collapsed state (icons ↔ labels). Orthogonal to hidden.
	const toggleCollapsed = () => {
		collapsedStorage.set(!isCollapsed.value);
	};

	// Set collapsed state directly
	const setCollapsed = (value: boolean) => {
		collapsedStorage.set(value);
	};

	// Toggle sidebar hidden state (Cmd/Ctrl-\). No-op below the desktop
	// breakpoint. Any active peek is dismissed so the transition is clean and
	// re-showing the rail always lands in a settled state.
	const toggleHidden = () => {
		if (!isDesktopViewport.value) return;
		hiddenStorage.set(!isHidden.value);
		isPeeking.value = false;
	};

	// Set hidden state directly (guarded like the toggle).
	const setHidden = (value: boolean) => {
		if (!isDesktopViewport.value) return;
		hiddenStorage.set(value);
		isPeeking.value = false;
	};

	// Open the transient peek overlay — only meaningful while hidden.
	const openPeek = () => {
		if (effectiveHidden.value) {
			isPeeking.value = true;
		}
	};

	// Close the peek overlay (mouseleave debounce / Esc / focus loss).
	const closePeek = () => {
		isPeeking.value = false;
	};

	// Keep the desktop-viewport flag in sync. Called by the layout's matchMedia
	// listener; leaving the desktop breakpoint also dismisses any peek.
	const setDesktopViewport = (value: boolean) => {
		isDesktopViewport.value = value;
		if (!value) {
			isPeeking.value = false;
		}
	};

	// Toggle a specific section
	const toggleSection = (section: keyof SectionState) => {
		sectionsStorage.set({
			...sectionStates.value,
			[section]: !sectionStates.value[section],
		});
	};

	// Check if a section is expanded
	const isSectionExpanded = (section: keyof SectionState) => {
		return sectionStates.value[section];
	};

	// Initialize from localStorage on client side
	// Note: useLocalStorage already initializes from storage, this is kept for API compatibility
	const initFromStorage = () => {
		// No-op: useLocalStorage handles initialization automatically
	};

	return {
		isCollapsed,
		isHidden,
		effectiveHidden,
		sidebarMode,
		isPeeking,
		sectionStates,
		toggleCollapsed,
		setCollapsed,
		toggleHidden,
		setHidden,
		openPeek,
		closePeek,
		setDesktopViewport,
		toggleSection,
		isSectionExpanded,
		initFromStorage,
	};
}
