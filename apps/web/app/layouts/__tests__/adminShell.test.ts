// @vitest-environment happy-dom
/**
 * THE ADMIN SHELL: WHAT THE RAIL SHOWS, AND WHAT ⌘K LEARNS FROM IT.
 *
 * The registry itself is unit-tested as data next door
 * (`lib/__tests__/adminSettingsRegistry.test.ts`); what this suite holds is the
 * WIRING — that the layout renders the whole table rather than one area, marks
 * the page you are standing on, narrows to the current area at phone width, and
 * registers the palette provider that made those thirty-odd pages reachable by
 * keyboard. Every one of those is a binding that breaks silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import { installNuxtStubs, queryResult, shellComponents } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';
import AdminLayout from '../admin.vue';

// The generated module is a Nuxt plugin as well as a manifest list, so importing
// it for real needs a Nuxt runtime. `hasPlugins` reads its length; a build with
// one bundled plugin is what keeps the rail's Plugins row in the assertions.
vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: [Object.freeze({ packageName: '@example/plugin' })],
}));

// Each function reference remembers its own path, so the query stub below can
// answer the platform-admin check and the inbound counters differently.
vi.mock('@owlat/api', () => {
	const at = (path: string): unknown =>
		new Proxy(function () {}, {
			get: (_target, key) => (key === '__path' ? path : at(`${path}.${String(key)}`)),
			apply: () => at(path),
		});
	return { api: at('api') };
});

const route = reactive({
	path: '/dashboard/admin/delivery/domains',
	fullPath: '/dashboard/admin/delivery/domains',
	name: 'admin-delivery-domains',
	params: {},
	query: {},
	hash: '',
	meta: {},
});

/** The provider the layout registers while it is mounted. */
let registered: CommandPaletteProvider | null = null;
/** Whether this deployment's platform admin is the one looking. */
let isPlatformAdmin = true;
/** The inbound counters the attention badges read. */
let inboundStats: { quarantined: number; failed: number } | null = null;
/** `NUXT_PUBLIC_DEPLOYMENT_MODE`. */
let deploymentMode = 'hosted';

beforeEach(() => {
	route.path = '/dashboard/admin/delivery/domains';
	registered = null;
	isPlatformAdmin = true;
	inboundStats = null;
	deploymentMode = 'hosted';
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useConvexQuery: (reference: { __path: string }) =>
			reference.__path.endsWith('getInboundStats')
				? queryResult(inboundStats)
				: queryResult(isPlatformAdmin),
		useRuntimeConfig: () => ({ public: { deploymentMode } }),
		registerCommandPaletteProvider: (provider: CommandPaletteProvider) => {
			registered = provider;
		},
		navigateTo: vi.fn(),
		useDesktopContext: () => ({ isDesktop: ref(false) }),
	});
});

function mountLayout(): VueWrapper {
	return mount(AdminLayout, {
		slots: { default: '<h1>Page under the admin shell</h1>' },
		global: {
			plugins: [createTestI18n()],
			components: { ...shellComponents },
			stubs: {
				DashboardNavigationPortal: { template: '<div><slot /></div>' },
				// The shell this one nests inside is audited on its own; here it is
				// just the frame around the rail.
				NuxtLayout: { template: '<div><slot /></div>' },
				Icon: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

/** The wide-viewport rail's links, as `[href, label]`. */
function railLinks(wrapper: VueWrapper): [string, string][] {
	return wrapper
		.findAll('nav[aria-label="Workspace settings"] a')
		.map((link) => [link.attributes('href') ?? '', link.text()]);
}

describe('the admin rail', () => {
	it('lists every area of the tree, not just the one you are in', () => {
		const wrapper = mountLayout();
		const hrefs = railLinks(wrapper).map(([href]) => href);
		expect(hrefs).toEqual(
			expect.arrayContaining([
				'/dashboard/admin',
				'/dashboard/admin/delivery/transport',
				// The ramp pages that used to live behind a collapsed disclosure on
				// one hub, and appeared in no navigation at all.
				'/dashboard/admin/delivery/advanced',
				'/dashboard/admin/delivery/quarantine',
				'/dashboard/admin/instance/features',
				'/dashboard/admin/team/audit',
			])
		);
		const eyebrows = wrapper
			.findAll('nav[aria-label="Workspace settings"] p')
			.map((paragraph) => paragraph.text());
		// The overview leads without an eyebrow; then the five groups.
		expect(eyebrows).toEqual(['Team', 'Email delivery', 'AI', 'Features', 'System']);
	});

	it('marks the page being viewed', () => {
		const wrapper = mountLayout();
		const current = wrapper.findAll('a[aria-current="page"]');
		expect(current.map((link) => link.attributes('href'))).toEqual([
			// Once in the rail, once in the compact row — both are in the DOM at
			// once, because the swap between them is a media query.
			'/dashboard/admin/delivery/domains',
			'/dashboard/admin/delivery/domains',
		]);
	});

	it('leaves out deployment tooling for a workspace admin', () => {
		isPlatformAdmin = false;
		const hrefs = railLinks(mountLayout()).map(([href]) => href);
		expect(hrefs).not.toContain('/dashboard/admin/operator');
		expect(hrefs).not.toContain('/dashboard/admin/backups');
		expect(hrefs).toContain('/dashboard/admin/delivery');
	});

	it('narrows to the current area at phone width', () => {
		const wrapper = mountLayout();
		const compact = wrapper
			.findAll('nav[aria-label="Workspace settings (compact)"] a')
			.map((link) => link.attributes('href'));
		expect(compact).toEqual([
			'/dashboard/admin',
			'/dashboard/admin/delivery',
			'/dashboard/admin/delivery/domains',
			'/dashboard/admin/delivery/transport',
			'/dashboard/admin/delivery/deliverability',
			'/dashboard/admin/delivery/webhooks',
			'/dashboard/admin/delivery/provider-routing',
			'/dashboard/admin/delivery/quarantine',
			'/dashboard/admin/delivery/failed',
			'/dashboard/admin/delivery/activity',
			'/dashboard/admin/delivery/migrate',
			'/dashboard/admin/delivery/advanced',
			// The way across to the other half of Settings, as in My settings.
			'/dashboard/preferences',
		]);
	});

	it('on the hub, keeps only the way across to My settings in the compact row', () => {
		route.path = '/dashboard/admin';
		const wrapper = mountLayout();
		const compact = wrapper
			.findAll('nav[aria-label="Workspace settings (compact)"] a')
			.map((link) => [link.attributes('href'), link.text()]);
		expect(compact).toEqual([['/dashboard/preferences', 'My settings']]);
	});

	it('keeps the operator console on a self-hosted deployment', () => {
		// Held content and the platform-admin roster exist on self-host too.
		deploymentMode = 'selfhost';
		const hrefs = railLinks(mountLayout()).map(([href]) => href);
		expect(hrefs).toContain('/dashboard/admin/operator');
		expect(hrefs).toContain('/dashboard/admin/system');
	});

	it('badges quarantine and failed messages while something waits there', () => {
		inboundStats = { quarantined: 2, failed: 0 };
		const wrapper = mountLayout();
		const quarantine = wrapper.find(
			'nav[aria-label="Workspace settings"] a[href="/dashboard/admin/delivery/quarantine"]'
		);
		expect(quarantine.text()).toContain('2');
		expect(quarantine.text()).toContain('2 waiting');
		const failed = wrapper.find(
			'nav[aria-label="Workspace settings"] a[href="/dashboard/admin/delivery/failed"]'
		);
		expect(failed.text()).not.toContain('waiting');
	});

	it('switches the sidebar between My settings and Workspace', async () => {
		const wrapper = mountLayout();
		const tabs = wrapper.findAll('[role="group"] button');
		expect(tabs.map((tab) => tab.text())).toEqual(['My settings', 'Workspace']);
		expect(tabs[1]!.attributes('aria-pressed')).toBe('true');
		await tabs[0]!.trigger('click');
		expect(wrapper.find('nav[aria-label="Workspace settings"]').exists()).toBe(false);
		expect(wrapper.find('nav[aria-label="Preferences sections"]').exists()).toBe(true);
	});

	it('shows the ramp pages as tabs under one Advanced row', () => {
		route.path = '/dashboard/admin/delivery/advanced/cells';
		const wrapper = mountLayout();
		const tabs = wrapper
			.findAll('nav[aria-label="Advanced delivery pages"] a')
			.map((link) => link.attributes('href'));
		expect(tabs).toEqual([
			'/dashboard/admin/delivery/advanced/controls',
			'/dashboard/admin/delivery/advanced/cells',
			'/dashboard/admin/delivery/advanced/independence',
			'/dashboard/admin/delivery/advanced/measurement',
		]);
		const current = wrapper
			.find('nav[aria-label="Workspace settings"] a[aria-current="page"]')
			.attributes('href');
		expect(current).toBe('/dashboard/admin/delivery/advanced');
	});

	it('frames every page at the reading width, and lets wide tables opt out', () => {
		route.path = '/dashboard/admin/delivery/webhooks';
		expect(mountLayout().find('.settings-page-shell').attributes('data-width')).toBe('reading');
		route.path = '/dashboard/admin/delivery/domains';
		expect(mountLayout().find('.settings-page-shell').attributes('data-width')).toBe('wide');
	});

	it('renders the page it wraps, and adds no heading of its own', () => {
		const wrapper = mountLayout();
		expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual([
			'Page under the admin shell',
		]);
	});

	it('gives the global layout transition a native element root', () => {
		const wrapper = mountLayout();
		expect(typeof wrapper.vm.$.subTree.type).toBe('string');
	});
});

describe('the admin palette provider', () => {
	it('offers the tree from inside Administration and nowhere else', () => {
		mountLayout();
		expect(registered).not.toBeNull();
		const provider = registered!;
		expect(provider.matchRoute?.('/dashboard/admin/instance')).toBe(true);
		expect(provider.matchRoute?.('/dashboard/campaigns')).toBe(false);

		const [group] = provider.build({ query: 'webhook', mode: 'all' });
		expect(group?.items.map((item) => item.label)).toEqual(['Webhooks']);
		expect(group?.items[0]?.subtitle).toBe('Email delivery');
	});

	it('offers only what this deployment reaches', () => {
		isPlatformAdmin = false;
		mountLayout();
		const [group] = registered!.build({ query: '', mode: 'all' });
		expect(group?.items.map((item) => item.id)).not.toContain('admin:operator');
	});
});
