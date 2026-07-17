// @vitest-environment happy-dom
/**
 * Plugin settings index page (index.vue) — the overview is an adminQuery, so an
 * editor-role member must see the established "Admins only" gate rather than the
 * gated query's `forbidden` throw rendered as a "Failed to load" error, and the
 * query must be skipped for them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';

const role = ref<'owner' | 'editor'>('owner');

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['mail:read']),
				flag: Object.freeze({ default: false }),
				settingsSchema: Object.freeze([]),
			}),
		}),
	]),
}));

import PluginsIndexPage from '../index.vue';

const overview = ref<{
	plugins: Array<Record<string, unknown>>;
	orphaned: Array<{ flagKey: string; pluginId: string }>;
}>({ plugins: [], orphaned: [] });

// The reactive args factory the page passes to the overview query: `{}` for an
// admin, `'skip'` for an editor. Captured so tests can prove the query is skipped.
let overviewQueryArgs: (() => unknown) | undefined;

beforeEach(() => {
	role.value = 'owner';
	overview.value = {
		plugins: [
			{
				pluginId: 'policy-pack',
				packageName: '@example/policy-pack',
				version: '1.0.0',
				flagKey: 'plugin.policy-pack',
				enabled: true,
				hasSettings: false,
				capabilities: [{ capability: 'mail:read', granted: true }],
				values: {},
				secretsSet: {},
			},
		],
		orphaned: [],
	};
	overviewQueryArgs = undefined;

	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('usePermissions', () => ({
		isAdmin: computed(() => role.value !== 'editor'),
		showAdminGate: computed(() => role.value === 'editor'),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: (() => unknown) | undefined) => {
		overviewQueryArgs = typeof args === 'function' ? args : undefined;
		return { data: overview, isLoading: ref(false), error: ref(null), refetch: vi.fn() };
	});
});

const passthroughStub = { template: '<div><slot name="header"/><slot/></div>' };
const nuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot/></a>' };

function mountPage() {
	return mount(PluginsIndexPage, {
		global: {
			stubs: {
				UiQueryBoundary: passthroughStub,
				UiCard: passthroughStub,
				NuxtLink: nuxtLinkStub,
				UiEmptyState: true,
				UiConfirmationDialog: true,
				UiButton: true,
				UiBadge: true,
				UiIconBox: true,
				Icon: true,
			},
		},
	});
}

const PLUGIN_HREF = 'a[href="/dashboard/settings/plugins/policy-pack"]';

describe('Plugins index — admins-only gate', () => {
	it('renders the gate and skips the query for an editor', () => {
		role.value = 'editor';
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('Admins only');
		// The plugin list (an admin surface) is not rendered.
		expect(wrapper.find(PLUGIN_HREF).exists()).toBe(false);
		// The overview query is skipped for the non-admin, so no gated `forbidden`
		// throw can render as a "Failed to load" error.
		expect(overviewQueryArgs?.()).toBe('skip');
	});

	it('runs the query and lists plugins for an admin', () => {
		role.value = 'owner';
		const wrapper = mountPage();
		expect(wrapper.text()).not.toContain('Admins only');
		expect(wrapper.find(PLUGIN_HREF).exists()).toBe(true);
		expect(overviewQueryArgs?.()).toEqual({});
	});
});
