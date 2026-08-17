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
import { auditA11y, dashboardShellStubs, installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useCommandPaletteProviders } from '~/composables/useCommandPaletteProviders';
import { useCommandPaletteRegistry } from '~/composables/useCommandPaletteRegistry';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { COMMAND_PALETTE_OPEN_EVENT } from '~/composables/useCommandPalette';
import type { SearchResults } from '~/lib/commandPaletteCore';
import AppCommandPalette from '../AppCommandPalette.vue';
import KeyboardShortcutsHelp from '../KeyboardShortcutsHelp.vue';
import Breadcrumbs from '../Breadcrumbs.vue';

/** One hit per list, so every object-search group in the palette has markup. */
const searchResults: SearchResults = {
	contacts: [
		{
			id: 'contact1',
			type: 'contact',
			title: 'Ada Lovelace',
			subtitle: 'ada@example.com',
			url: '/dashboard/audience/contacts/contact1',
		},
	],
	emails: [
		{
			id: 'template1',
			type: 'email',
			title: 'Spring welcome',
			subtitle: 'Template',
			url: '/dashboard/send/templates/template1',
		},
	],
	campaigns: [
		{
			id: 'campaign1',
			type: 'campaign',
			title: 'Spring launch',
			subtitle: 'Draft',
			url: '/dashboard/campaigns/campaign1',
		},
	],
};

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		// The palette reads the same navigation the sidebar does, so it gets the
		// same shell stubs: seeded with real sections its list renders real
		// `role="option"` rows under real group headings, which is the wiring
		// (`aria-activedescendant`, `aria-selected`) this audit exists for.
		...dashboardShellStubs(),
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
		useOrganizationQuery: () => queryResult(searchResults),
	});
});

/** Open the palette the way every affordance in the app opens it. */
async function openPalette(): Promise<void> {
	window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
	await nextTick();
	expect(document.body.querySelector('input')).not.toBeNull();
}

/** The palette teleports to <body>, so its rows are read off the document. */
function paletteOptions(): NodeListOf<Element> {
	return document.body.querySelectorAll('[role="option"]');
}

describe('command palette — accessibility', () => {
	it('has no axe violations listing its idle destinations', async () => {
		const violations = await auditA11y(AppCommandPalette, {
			global: { plugins: [createTestI18n()] },
			prepare: async () => {
				await openPalette();
				// Without rows there is no listbox to audit — no `role="option"`,
				// no `aria-activedescendant` target, no group headings — and the
				// scan would be passing on the "No matches" placeholder.
				expect(paletteOptions().length).toBeGreaterThan(0);
				// The seeded sidebar sections, under their group heading.
				expect(document.body.textContent).toContain('Go to');
				const input = document.body.querySelector('input');
				expect(input?.getAttribute('aria-activedescendant')).toBeTruthy();
			},
		});
		expect(violations).toEqual([]);
	});

	it('has no axe violations showing results for a typed query', async () => {
		const violations = await auditA11y(AppCommandPalette, {
			global: { plugins: [createTestI18n()] },
			// The results branch is different markup: object-search groups with
			// subtitled rows, rendered only once the query passes the minimum.
			prepare: async () => {
				await openPalette();
				const input = document.body.querySelector('input');
				if (!input) throw new Error('palette input missing');
				input.value = 'spring';
				input.dispatchEvent(new Event('input'));
				await nextTick();
				expect(document.body.textContent).toContain('Spring launch');
				expect(paletteOptions().length).toBeGreaterThan(0);
			},
		});
		expect(violations).toEqual([]);
	});
});

describe('keyboard shortcuts help — accessibility', () => {
	it('has no axe violations while open', async () => {
		const violations = await auditA11y(KeyboardShortcutsHelp, {
			global: { plugins: [createTestI18n()] },
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
			global: { plugins: [createTestI18n()] },
			prepare: (wrapper) => expect(wrapper.text()).toContain('Spring launch'),
		});
		expect(violations).toEqual([]);
	});
});
