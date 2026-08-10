// @vitest-environment happy-dom
/**
 * Plugin settings index page (index.vue) — the overview is an adminQuery, and the
 * page's `middleware: ['auth', 'admin']` is what keeps a non-admin away from it:
 * the middleware waits for the role and redirects to /dashboard before the page
 * renders (the app is `ssr: false`, so it always runs). The page therefore has no
 * editor reader to skip the query for and no in-template "Admins only" card to
 * show one — it used to carry both, unreachably. app/__tests__/adminGatingParity
 * .test.ts is what fails if the middleware declaration ever goes missing.
 *
 * What is pinned here is the consequence: the overview query runs UNCONDITIONALLY,
 * with no `'skip'` branch left to strand the page on an empty list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

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

// The reactive args factory the page passes to the overview query. Captured so a
// test can prove it never answers `'skip'`.
let overviewQueryArgs: (() => unknown) | undefined;

beforeEach(() => {
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

const PLUGIN_HREF = 'a[href="/dashboard/admin/instance/plugins/policy-pack"]';

describe('Plugins index — gated by the route, not by the template', () => {
	it('runs the overview query and lists plugins for the admin who reached it', () => {
		const wrapper = mountPage();
		expect(wrapper.find(PLUGIN_HREF).exists()).toBe(true);
		expect(overviewQueryArgs?.()).toEqual({});
	});

	it('never answers the query args with a skip', () => {
		// The `'skip'` branch existed only for the editor the middleware now turns
		// away; left behind, it would be an unreachable condition that could only
		// ever strand an admin on an empty page.
		mountPage();
		expect(overviewQueryArgs?.()).not.toBe('skip');
	});

	it('shows no "Admins only" card to the only role that can read the page', () => {
		const wrapper = mountPage();
		expect(wrapper.text()).not.toContain('Admins only');
	});
});
