// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ON THE APP-WIDE OVERLAYS.
 *
 * These three ride along on every dashboard page, and all three are the shape
 * screen readers fail hardest on: a dialog with no role and no name, a
 * filter-as-you-type list with no combobox wiring, a breadcrumb trail that is a
 * row of links with no "you are here" marker. They are audited in their OPEN
 * state — closed, they render nothing and the audit would be vacuous.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditA11y, installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { useCommandPaletteProviders } from '~/composables/useCommandPaletteProviders';
import { useCommandPaletteRegistry } from '~/composables/useCommandPaletteRegistry';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { COMMAND_PALETTE_OPEN_EVENT } from '~/composables/useCommandPalette';
import AppCommandPalette from '../AppCommandPalette.vue';
import KeyboardShortcutsHelp from '../KeyboardShortcutsHelp.vue';
import Breadcrumbs from '../Breadcrumbs.vue';

beforeEach(() => {
	installNuxtStubs({
		useRoute: () => ({
			path: '/dashboard/campaigns',
			fullPath: '/dashboard/campaigns',
			name: 'dashboard-campaigns',
			query: {},
			params: {},
			meta: {},
		}),
		useCommandPaletteProviders,
		useCommandPaletteRegistry,
		useDebouncedSearch,
		useSidebarContext: () => ({
			showToggle: ref(true),
			activeContext: ref('marketing'),
			sidebarSections: ref([]),
			firstSharedKey: ref(null),
			switchContext: vi.fn(),
		}),
		useBreadcrumbs: () => ({
			breadcrumbs: ref([
				{ label: 'Dashboard', to: '/dashboard' },
				{ label: 'Campaigns', to: '/dashboard/campaigns' },
				{ label: 'Spring launch' },
			]),
			setDynamicBreadcrumbs: vi.fn(),
			clearDynamicBreadcrumbs: vi.fn(),
		}),
		// The help dialog reads its open state straight off the shortcuts
		// composable, so this is what "the modal is on screen" looks like.
		useKeyboardShortcuts: () => ({
			isHelpModalOpen: ref(true),
			registerShortcut: vi.fn(),
			unregisterShortcut: vi.fn(),
			registerNavigationShortcuts: vi.fn(),
			registerNewShortcut: vi.fn(),
			registerSaveShortcut: vi.fn(),
			registerEscapeHandler: vi.fn(),
			openHelpModal: vi.fn(),
			closeHelpModal: vi.fn(),
			getRegisteredShortcuts: () => [],
		}),
		useModalFocus: vi.fn(),
		COMMAND_PALETTE_OPEN_EVENT,
		useDesktopContext: () => ({
			isDesktop: ref(false),
			isMac: ref(false),
			isWindows: ref(false),
			isLinux: ref(false),
		}),
		useDashboardNavigation: () => ({ navigationSections: ref([]) }),
		useOrganizationQuery: () => queryResult(undefined),
	});
});

describe('command palette — accessibility', () => {
	it('has no axe violations while open', async () => {
		const violations = await auditA11y(AppCommandPalette, {
			// Opened the way every affordance in the app opens it — the window
			// event `useCommandPalette().open()` dispatches. Like the other
			// dialogs it teleports to <body>, hence the document query.
			prepare: async () => {
				window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
				await nextTick();
				expect(document.body.querySelector('input')).not.toBeNull();
			},
		});
		expect(violations).toEqual([]);
	});
});

describe('keyboard shortcuts help — accessibility', () => {
	it('has no axe violations while open', async () => {
		const violations = await auditA11y(KeyboardShortcutsHelp, {
			// The dialog teleports to <body>, so the mount wrapper is empty by
			// design and the rendered copy has to be read off the document.
			prepare: () => expect(document.body.textContent).toContain('Go to Dashboard'),
		});
		expect(violations).toEqual([]);
	});
});

describe('breadcrumbs — accessibility', () => {
	it('has no axe violations for a nested trail', async () => {
		const violations = await auditA11y(Breadcrumbs, {
			prepare: (wrapper) => expect(wrapper.text()).toContain('Spring launch'),
		});
		expect(violations).toEqual([]);
	});
});
