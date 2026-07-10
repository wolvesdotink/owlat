// @vitest-environment happy-dom
/**
 * DesktopTitlebar (UX piece d3) — the titlebar that earns its 38px:
 *   - the whole bar is a drag region; interactive controls (chip, search pill,
 *     unread pill) opt OUT so clicks land on them instead of dragging the window
 *   - the workspace chip opens the switcher menu; picking a row switches
 *   - the unread pill renders the active workspace's badge count and deep-links
 *     to the Postbox Today view's "For you" section
 *   - the workspace label + app theme are mirrored into the native window
 *     (Mission Control / taskbar title, NSWindow appearance) via the window.ts
 *     bridge
 *
 * The desktop composables are stubbed at the auto-import seam (same approach as
 * the Postbox component tests). Icon / NuxtLink are stubbed globals. The
 * `@owlat/desktop/src/window` bridge is module-mocked with the REAL
 * `windowTitleFor` mapping kept, so the title assertions cover the production
 * label→title rule rather than a local re-derivation.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ref, computed } from 'vue';

import DesktopTitlebar from '../DesktopTitlebar.vue';
import { WORKSPACE_ACCENTS } from '~/lib/desktop/workspaceTypes';

const { setWindowTitleMock, setWindowThemeMock } = vi.hoisted(() => ({
	setWindowTitleMock: vi.fn().mockResolvedValue(undefined),
	setWindowThemeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@owlat/desktop/src/window', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@owlat/desktop/src/window')>();
	return {
		...actual,
		setWindowTitle: setWindowTitleMock,
		setWindowTheme: setWindowThemeMock,
	};
});

enableAutoUnmount(afterEach);

type Ws = { id: string; label: string; accentColor: string };

const accent = WORKSPACE_ACCENTS[0] ?? '#c4785a';
const workspaces = ref<Ws[]>([
	{ id: 'w1', label: 'Acme', accentColor: accent },
	{ id: 'w2', label: 'Globex', accentColor: accent },
]);
const activeId = ref<string | null>('w1');
// Default platform is win/linux; the macOS title-sync suite flips this.
const isMac = ref(false);
const themePreference = ref<'dark' | 'light' | 'system'>('system');
const switchTo = vi.fn();
const setWorkspaceAccent = vi.fn();
const navigateToMock = vi.fn().mockResolvedValue(undefined);
const badges: Record<string, number> = { w1: 3, w2: 0 };

beforeAll(async () => {
	// Warm the (mocked) bridge module. The component reaches it via dynamic
	// import inside its watcher; the FIRST resolution pays the transform cost and
	// can land a test or two late, leaking a stale setWindowTitle call across
	// test boundaries. Pre-importing makes every later import resolve within the
	// test that triggered it.
	await import('@owlat/desktop/src/window');
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true), isMac }));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		workspaces,
		activeId,
		active: computed(() => workspaces.value.find((w) => w.id === activeId.value) ?? null),
		switchTo,
		setWorkspaceAccent,
	}));
	vi.stubGlobal('useWorkspaceBadges', () => ({ badgeFor: (id: string) => badges[id] ?? 0 }));
	vi.stubGlobal('useCommandPalette', () => ({ open: vi.fn() }));
	vi.stubGlobal('useAppTheme', () => ({ themePreference }));
	vi.stubGlobal('navigateTo', navigateToMock);
});

beforeEach(() => {
	switchTo.mockClear();
	navigateToMock.mockClear();
	setWindowTitleMock.mockClear();
	setWindowThemeMock.mockClear();
	activeId.value = 'w1';
	isMac.value = false;
	themePreference.value = 'system';
});

const iconStub = { props: ['name'], template: '<span class="icon" :data-name="name" />' };
const nuxtLinkStub = {
	props: ['to'],
	template: '<a class="nuxt-link" :href="to"><slot /></a>',
};

function mountBar(props: { showSearch?: boolean } = { showSearch: true }) {
	return mount(DesktopTitlebar, {
		props,
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

	it('renders the notifications pill with the active workspace count and the For-you deep link', () => {
		const w = mountBar();
		const pill = w.get('.tb-unread');
		expect(pill.text()).toContain('3');
		expect(pill.classes()).not.toContain('tb-unread-idle');
		expect(pill.attributes('href')).toBe('/dashboard/postbox/inbox#postbox-for-you');
	});

	it('keeps a quiet notifications affordance (no count) when nothing awaits', () => {
		activeId.value = 'w2';
		const w = mountBar();
		const pill = w.get('.tb-unread');
		expect(pill.classes()).toContain('tb-unread-idle');
		expect(pill.text()).toBe('');
		expect(pill.attributes('href')).toBe('/dashboard/postbox/inbox#postbox-for-you');
	});

	it('renders no search pill on surfaces without a command palette (show-search omitted)', () => {
		const w = mountBar({});
		expect(w.find('.tb-search').exists()).toBe(false);
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

describe('DesktopTitlebar native window-title sync on macOS', () => {
	beforeEach(() => {
		isMac.value = true;
	});

	it('keeps the workspace chip — the in-frame native title stays hidden', () => {
		const w = mountBar();
		expect(w.find('[aria-label="Switch workspace"]').exists()).toBe(true);
	});

	it('mirrors the workspace label bare (Mission Control names windows, the menu bar names the app)', async () => {
		mountBar();
		await vi.waitFor(() => expect(setWindowTitleMock).toHaveBeenCalledWith('Acme'));
	});

	it('re-syncs the native title when the active workspace changes', async () => {
		mountBar();
		await vi.waitFor(() => expect(setWindowTitleMock).toHaveBeenCalledWith('Acme'));
		activeId.value = 'w2';
		await vi.waitFor(() => expect(setWindowTitleMock).toHaveBeenCalledWith('Globex'));
	});

	it('falls back to the plain app name when no workspace is connected', async () => {
		activeId.value = null;
		mountBar();
		await vi.waitFor(() => expect(setWindowTitleMock).toHaveBeenCalledWith('Owlat'));
	});
});

describe('DesktopTitlebar native-chrome sync (all platforms)', () => {
	it('qualifies the taskbar title with the app name on win/linux', async () => {
		mountBar();
		await vi.waitFor(() => expect(setWindowTitleMock).toHaveBeenCalledWith('Acme — Owlat'));
	});

	it('follows the OS theme when the app preference is system', async () => {
		mountBar();
		await vi.waitFor(() => expect(setWindowThemeMock).toHaveBeenCalledWith(null));
	});

	it('pins the native chrome when the app theme is forced', async () => {
		themePreference.value = 'dark';
		mountBar();
		await vi.waitFor(() => expect(setWindowThemeMock).toHaveBeenCalledWith('dark'));
	});
});
