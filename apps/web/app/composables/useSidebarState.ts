// Composable for managing sidebar state with localStorage persistence

export interface SectionState {
	inbox: boolean;
	postbox: boolean;
	chat: boolean;
	assistant: boolean;
	send: boolean;
	knowledge: boolean;
	audience: boolean;
	settings: boolean;
}

export type SectionKey = keyof SectionState;

const defaultSectionState: SectionState = {
	inbox: true,
	postbox: true,
	chat: true,
	assistant: true,
	send: true,
	knowledge: true,
	audience: true,
	settings: true,
};

// Use module-level storage to maintain singleton pattern across component instances
const collapsedStorage = useLocalStorage<boolean>('sidebar-collapsed', false);
const sectionsStorage = useLocalStorage<SectionState>('sidebar-sections', defaultSectionState);

export function useSidebarState() {
	// Sidebar collapsed state (icons only mode)
	const isCollapsed = collapsedStorage.data;

	// Section expand/collapse states
	const sectionStates = sectionsStorage.data;

	// Toggle sidebar collapsed state
	const toggleCollapsed = () => {
		collapsedStorage.set(!isCollapsed.value);
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

	// Set collapsed state directly
	const setCollapsed = (value: boolean) => {
		collapsedStorage.set(value);
	};

	// Initialize from localStorage on client side
	// Note: useLocalStorage already initializes from storage, this is kept for API compatibility
	const initFromStorage = () => {
		// No-op: useLocalStorage handles initialization automatically
	};

	return {
		isCollapsed,
		sectionStates,
		toggleCollapsed,
		toggleSection,
		isSectionExpanded,
		setCollapsed,
		initFromStorage,
	};
}
