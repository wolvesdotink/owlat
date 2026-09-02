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
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { CommandPaletteProvider } from '~/lib/commandPaletteRegistry';
import AdminLayout from '../admin.vue';

// The generated module is a Nuxt plugin as well as a manifest list, so importing
// it for real needs a Nuxt runtime. `hasPlugins` reads its length; a build with
// one bundled plugin is what keeps the rail's Plugins row in the assertions.
vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: [Object.freeze({ packageName: '@example/plugin' })],
}));

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
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

beforeEach(() => {
	route.path = '/dashboard/admin/delivery/domains';
	registered = null;
	isPlatformAdmin = true;
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useConvexQuery: () => queryResult(isPlatformAdmin),
		registerCommandPaletteProvider: (provider: CommandPaletteProvider) => {
			registered = provider;
		},
		navigateTo: vi.fn(),
	});
});

function mountLayout(): VueWrapper {
	return mount(AdminLayout, {
		slots: { default: '<h1>Page under the admin shell</h1>' },
		global: {
			plugins: [createTestI18n()],
			stubs: {
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
		.findAll('nav[aria-label="Administration sections"] a')
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
				'/dashboard/admin/delivery/advanced/controls',
				'/dashboard/admin/delivery/advanced/measurement',
				'/dashboard/admin/instance/features',
				'/dashboard/admin/team/audit',
			])
		);
		const eyebrows = wrapper
			.findAll('nav[aria-label="Administration sections"] p')
			.map((paragraph) => paragraph.text());
		expect(eyebrows).toEqual([
			'Administration',
			'Delivery',
			'Advanced',
			'Instance',
			'Team & access',
			'Platform',
		]);
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
			.findAll('nav[aria-label="Administration sections (compact)"] a')
			.map((link) => link.attributes('href'));
		expect(compact).toEqual([
			'/dashboard/admin',
			'/dashboard/admin/delivery',
			'/dashboard/admin/delivery/domains',
			'/dashboard/admin/delivery/transport',
			'/dashboard/admin/delivery/deliverability',
			'/dashboard/admin/delivery/webhooks',
			'/dashboard/admin/delivery/provider-routing',
			'/dashboard/admin/delivery/migrate',
		]);
	});

	it('drops the compact row on the hub, where it would point at itself', () => {
		route.path = '/dashboard/admin';
		const wrapper = mountLayout();
		expect(wrapper.find('nav[aria-label="Administration sections (compact)"]').exists()).toBe(
			false
		);
	});

	it('renders the page it wraps, and adds no heading of its own', () => {
		const wrapper = mountLayout();
		expect(wrapper.findAll('h1').map((heading) => heading.text())).toEqual([
			'Page under the admin shell',
		]);
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
		expect(group?.items[0]?.subtitle).toBe('Delivery');
	});

	it('offers only what this deployment reaches', () => {
		isPlatformAdmin = false;
		mountLayout();
		const [group] = registered!.build({ query: '', mode: 'all' });
		expect(group?.items.map((item) => item.id)).not.toContain('admin:operator');
	});
});
