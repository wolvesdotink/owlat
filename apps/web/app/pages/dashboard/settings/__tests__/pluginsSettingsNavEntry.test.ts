// @vitest-environment happy-dom
/**
 * Settings landing page — the "Plugins" nav entry must stay reachable when a
 * removed plugin left residual settings behind, even though this deployment now
 * bundles zero plugins. Otherwise the orphan-purge UX is undiscoverable exactly
 * when it is needed.
 *
 * The bundled composition is mocked empty so the entry depends solely on the
 * orphaned-settings signal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([]),
}));

// Avoid pulling the email-builder → email-renderer chain (and its transitive
// module resolution) into this page test; the page only needs the dialog shell.
vi.mock('@owlat/email-builder', () => ({ UnsavedChangesDialog: { template: '<div />' } }));

import SettingsIndexPage from '../index.vue';

const overview = ref<{ plugins: unknown[]; orphaned: unknown[] }>({ plugins: [], orphaned: [] });
let queryCall = 0;

beforeEach(() => {
	overview.value = { plugins: [], orphaned: [] };
	queryCall = 0;

	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useOrganizationContext', () => ({
		hasActiveOrganization: ref(true),
		isLoading: ref(false),
		role: ref('owner'),
	}));
	vi.stubGlobal('useOrganization', () => ({
		organization: ref({ name: 'Acme' }),
		update: vi.fn(),
	}));
	vi.stubGlobal('useAppTheme', () => ({ themePreference: ref('system'), setTheme: vi.fn() }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref([]),
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ flags: ref({}), isEnabled: () => false }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(true) }));
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: vi.fn(),
	}));
	// Query order in the page: isPlatformAdmin, then getPluginSettingsOverview.
	vi.stubGlobal('useConvexQuery', () => {
		const call = queryCall++ % 2;
		if (call === 0) {
			return { data: ref(false), isLoading: ref(false), error: ref(null), refetch: vi.fn() };
		}
		return { data: overview, isLoading: ref(false), error: ref(null), refetch: vi.fn() };
	});
});

const passthroughStub = { template: '<div><slot name="loading"/><slot/></div>' };
const nuxtLinkStub = {
	props: ['to'],
	template: '<a :href="to"><slot/></a>',
};

function mountPage() {
	return mount(SettingsIndexPage, {
		global: {
			stubs: {
				UiQueryBoundary: passthroughStub,
				UiCard: passthroughStub,
				NuxtLink: nuxtLinkStub,
				UiEmptyState: true,
				UiSpinner: true,
				UiToggle: true,
				UiInput: true,
				UiButton: true,
				UiBadge: true,
				UiIconBox: true,
				Icon: true,
				UnsavedChangesDialog: true,
			},
		},
	});
}

const PLUGINS_HREF = 'a[href="/dashboard/settings/plugins"]';

describe('Settings index — Plugins nav entry', () => {
	it('hides the entry when no plugins are bundled and nothing is orphaned', () => {
		const wrapper = mountPage();
		expect(wrapper.find(PLUGINS_HREF).exists()).toBe(false);
	});

	it('shows the entry when a removed plugin left residual settings behind', () => {
		overview.value = {
			plugins: [],
			orphaned: [{ flagKey: 'plugin.removed-pack', pluginId: 'removed-pack' }],
		};
		const wrapper = mountPage();
		const link = wrapper.find(PLUGINS_HREF);
		expect(link.exists()).toBe(true);
		expect(link.text()).toContain('Plugins');
	});
});
