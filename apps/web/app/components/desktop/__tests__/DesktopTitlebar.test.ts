// @vitest-environment happy-dom
/**
 * DesktopTitlebar (UX piece d3) — the titlebar that earns its 38px:
 *   - the whole bar is a drag region; interactive controls (chip, search pill,
 *     unread pill) opt OUT so clicks land on them instead of dragging the window
 *   - the workspace chip opens the switcher menu; picking a row switches
 *   - the unread pill renders the active workspace's badge count and deep-links
 *     to the Postbox Today view's "For you" section
 *
 * The desktop composables are stubbed at the auto-import seam (same approach as
 * the Postbox component tests). Icon / NuxtLink are stubbed globals.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ref, computed } from 'vue';

import DesktopTitlebar from '../DesktopTitlebar.vue';
import { WORKSPACE_ACCENTS } from '~/lib/desktop/workspaceTypes';

enableAutoUnmount(afterEach);

type Ws = { id: string; label: string; accentColor: string };

const accent = WORKSPACE_ACCENTS[0] ?? '#c4785a';
const workspaces = ref<Ws[]>([
	{ id: 'w1', label: 'Acme', accentColor: accent },
	{ id: 'w2', label: 'Globex', accentColor: accent },
]);
const activeId = ref<string | null>('w1');
const switchTo = vi.fn();
const setWorkspaceAccent = vi.fn();
const navigateToMock = vi.fn().mockResolvedValue(undefined);
const badges: Record<string, number> = { w1: 3, w2: 0 };

beforeAll(() => {
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true), isMac: ref(true) }));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		workspaces,
		activeId,
		active: computed(() => workspaces.value.find((w) => w.id === activeId.value) ?? null),
		switchTo,
		setWorkspaceAccent,
	}));
	vi.stubGlobal('useWorkspaceBadges', () => ({ badgeFor: (id: string) => badges[id] ?? 0 }));
	// A palette is "mounted" so the search pill's palette-ready handshake passes.
	vi.stubGlobal('useCommandPalette', () => ({
		isMounted: ref(true),
		open: vi.fn(),
		registerMounted: () => () => {},
	}));
	vi.stubGlobal('navigateTo', navigateToMock);
});

beforeEach(() => {
	switchTo.mockClear();
	navigateToMock.mockClear();
	activeId.value = 'w1';
});

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const nuxtLinkStub = {
	props: ['to'],
	template: '<a class="nuxt-link" :href="to"><slot /></a>',
};

function mountBar() {
	return mount(DesktopTitlebar, {
		global: {
			components: {
				Icon: iconStub,
				NuxtLink: nuxtLinkStub,
				// Rendered inside the shared WorkspaceMenu rows; count display is
				// covered by that component's own concerns, not this bar's.
				DesktopWorkspaceUnreadBadge: {
					props: ['count'],
					template: '<span class="unread-badge" />',
				},
			},
			stubs: { transition: true },
		},
	});
}

describe('DesktopTitlebar', () => {
	it('marks the whole bar as a drag region and opts interactive controls out', () => {
		const w = mountBar();
		const bar = w.get('.desktop-titlebar');
		expect(bar.attributes('data-tauri-drag-region')).toBeDefined();

		// Interactive controls must NOT carry the drag attribute.
		expect(
			w.get('[aria-label="Switch workspace"]').attributes('data-tauri-drag-region')
		).toBeUndefined();
		expect(w.get('.tb-search').attributes('data-tauri-drag-region')).toBeUndefined();
	});

	it('opens the switcher menu from the chip and switches on selection', async () => {
		const w = mountBar();
		expect(w.find('[role="menu"]').exists()).toBe(false);

		await w.get('[aria-label="Switch workspace"]').trigger('click');
		expect(w.get('[aria-label="Switch workspace"]').attributes('aria-expanded')).toBe('true');
		const menu = w.get('[role="menu"]');
		expect(menu.exists()).toBe(true);

		const rows = menu.findAll('[role="menuitemradio"]');
		expect(rows).toHaveLength(2);
		// The active workspace row is marked.
		expect(rows[0]?.attributes('aria-checked')).toBe('true');

		await rows[1]?.trigger('click');
		expect(switchTo).toHaveBeenCalledWith('w2');
	});

	it('renders the unread pill with the active workspace count and the For-you deep link', () => {
		const w = mountBar();
		const pill = w.get('.tb-unread');
		expect(pill.text()).toContain('3');
		expect(pill.attributes('href')).toBe('/dashboard/postbox/inbox#postbox-for-you');
	});

	it('hides the unread pill when there is nothing awaiting', () => {
		activeId.value = 'w2';
		const w = mountBar();
		expect(w.find('.tb-unread').exists()).toBe(false);
	});

	it('falls back to a draggable brand strip with no chip/search/pill when no workspace is active', () => {
		activeId.value = null;
		const w = mountBar();

		// No workspace-scoped controls in the fallback branch.
		expect(w.find('[aria-label="Switch workspace"]').exists()).toBe(false);
		expect(w.find('.tb-search').exists()).toBe(false);
		expect(w.find('.tb-unread').exists()).toBe(false);

		// The fallback brand strip (img + label) must stay draggable: every
		// non-interactive element carries the drag-region attribute.
		const img = w.get('img');
		expect(img.attributes('data-tauri-drag-region')).toBeDefined();
		const strip = img.element.parentElement;
		expect(strip?.getAttribute('data-tauri-drag-region')).not.toBeNull();
		const label = w.get('.font-display');
		expect(label.attributes('data-tauri-drag-region')).toBeDefined();
	});
});
