// @vitest-environment happy-dom
/**
 * The shell's rarely used overlays stay off the boot path.
 *
 * The command palette and the "?" shortcut sheet used to be mounted with the
 * layout, which put the palette's providers and search composables into every
 * dashboard page's first load. They now mount the first time they are asked
 * for. What has to hold is that nobody can tell: the very first Cmd/Ctrl+K
 * opens the palette with the caret in its input, exactly as before, even though
 * the component did not exist when the key went down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineAsyncComponent, nextTick, reactive, ref } from 'vue';
import {
	dashboardShellStubs,
	installNuxtStubs,
	queryResult,
	shellComponents,
} from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useCommandPaletteProviders } from '~/composables/useCommandPaletteProviders';
import { useCommandPaletteRecents } from '~/composables/useCommandPaletteRecents';
import { useCommandPaletteScope } from '~/composables/useCommandPaletteScope';
import { useCommandPaletteMailScope } from '~/composables/useCommandPaletteMailScope';
import { useCommandPaletteInboxScope } from '~/composables/useCommandPaletteInboxScope';
import { useCommandPaletteObjectItems } from '~/composables/useCommandPaletteObjectItems';
import { useCommandPaletteAsk } from '~/composables/useCommandPaletteAsk';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { COMMAND_PALETTE_OPEN_EVENT } from '~/composables/useCommandPalette';
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';
import AppCommandPalette from '~/components/AppCommandPalette.vue';
import AppCommandPaletteResults from '~/components/AppCommandPaletteResults.vue';
import DashboardLayout from '../dashboard.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const route = reactive({
	path: '/dashboard/campaigns',
	fullPath: '/dashboard/campaigns',
	name: 'dashboard-campaigns',
	params: {},
	query: {},
	hash: '',
	meta: {},
});

const isHelpModalOpen = ref(false);
let paletteLoads = 0;

beforeEach(() => {
	paletteLoads = 0;
	isHelpModalOpen.value = false;
	localStorage.clear();
	document.body.innerHTML = '';
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		useRoute: () => route,
		useBreadcrumbs: () => ({ breadcrumbs: ref([]), setBreadcrumbs: vi.fn() }),
		useKeyboardShortcuts: () => ({
			isHelpModalOpen,
			registerNavigationShortcuts: vi.fn(),
			closeHelpModal: vi.fn(),
		}),
		// What the real palette needs once it is mounted.
		useCommandPaletteProviders,
		useCommandPaletteRegistry: () => ref([]),
		useCommandPaletteRecents,
		useCommandPaletteScope,
		useCommandPaletteMailScope,
		useCommandPaletteInboxScope,
		useCommandPaletteObjectItems,
		useCommandPaletteAsk,
		useDebouncedSearch,
		useModalFocus,
		usePostboxActiveMailbox: () => ({ activeMailboxId: ref(null), setActiveMailboxId: vi.fn() }),
		COMMAND_PALETTE_OPEN_EVENT,
		useOrganizationQuery: () => queryResult(undefined),
	});
});

let wrapper: VueWrapper | null = null;

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

function mountLayout(): VueWrapper {
	wrapper = mount(DashboardLayout, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: { resolveComponent: (name: string) => name },
			components: {
				...shellComponents,
				AppCommandPaletteResults,
				// Nuxt's `Lazy*` components are async components over the same module.
				LazyAppCommandPalette: defineAsyncComponent(async () => {
					paletteLoads += 1;
					return AppCommandPalette;
				}),
			},
			stubs: {
				DesktopTitlebar: true,
				DashboardShellHeader: true,
				ShellComposerOverlay: true,
				LazyKeyboardShortcutsHelp: { template: '<div data-testid="help" />' },
				AppLiveRegion: true,
				AppCommandPaletteFooter: true,
				QueryResult: true,
				Icon: true,
				UiBadge: true,
				UiSkeleton: true,
				UiSpinner: true,
				UiThemeToggle: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
	return wrapper;
}

const dialog = () => document.body.querySelector('[role="dialog"]');

async function settle() {
	await flushPromises();
	await nextTick();
	await flushPromises();
}

describe('dashboard layout — lazy command palette', () => {
	it('does not load the palette until it is asked for', async () => {
		mountLayout();
		await settle();
		expect(paletteLoads).toBe(0);
		expect(dialog()).toBeNull();
	});

	it('opens on the first Cmd/Ctrl+K with focus in the input', async () => {
		mountLayout();
		await settle();

		const chord = new KeyboardEvent('keydown', {
			key: 'k',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		window.dispatchEvent(chord);
		// The browser's own Ctrl+K must not fire while the chunk loads.
		expect(chord.defaultPrevented).toBe(true);
		await settle();

		expect(paletteLoads).toBe(1);
		expect(dialog()).not.toBeNull();
		const input = dialog()?.querySelector('input');
		expect(input).not.toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it('hands the keyboard over once mounted: the next Cmd/Ctrl+K closes it', async () => {
		mountLayout();
		await settle();
		const pressK = () =>
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
			);

		pressK();
		await settle();
		expect(dialog()).not.toBeNull();

		// Toggled by the palette alone: had the host still been listening, it would
		// re-request an open and the palette would never close.
		pressK();
		await settle();
		expect(dialog()).toBeNull();
		expect(paletteLoads).toBe(1);
	});

	it('opens on the shared open event (search buttons, titlebar pill)', async () => {
		mountLayout();
		await settle();

		window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, { detail: {} }));
		await settle();

		expect(dialog()).not.toBeNull();
		expect(document.activeElement).toBe(dialog()?.querySelector('input'));
	});
});

describe('dashboard layout — lazy shortcut sheet', () => {
	it('mounts the "?" sheet on first open and keeps it', async () => {
		mountLayout();
		await settle();
		expect(document.body.querySelector('[data-testid="help"]')).toBeNull();

		isHelpModalOpen.value = true;
		await settle();
		expect(document.body.querySelector('[data-testid="help"]')).not.toBeNull();

		isHelpModalOpen.value = false;
		await settle();
		expect(document.body.querySelector('[data-testid="help"]')).not.toBeNull();
	});
});
