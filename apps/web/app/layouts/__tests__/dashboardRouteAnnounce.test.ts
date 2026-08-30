// @vitest-environment happy-dom
/**
 * WHAT HAPPENS WHEN THE DASHBOARD NAVIGATES, FOR SOMEONE WHO CANNOT SEE IT.
 *
 * A client-side navigation is silent: the browser announces a real page load,
 * but a router that swaps the DOM under `<main>` announces nothing, and focus
 * is left standing on the rail link that was activated. The layout repairs both
 * — it says the new page's name into the app's live region and moves focus into
 * `<main>` — and this is the suite that holds it to that, including the case
 * where moving focus would be WRONG (a surface where navigating is the
 * interaction).
 *
 * Mounted rather than unit-tested against the helpers alone, because the wiring
 * is the part that breaks: a watcher on the wrong route property, an
 * announcement fired before the new trail is computed, a live region that is
 * not in the document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { dashboardShellStubs, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAnnounce } from '~/composables/useAnnounce';
import AppLiveRegion from '~/components/AppLiveRegion.vue';
import DashboardLayout from '../dashboard.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** The route the layout watches, mutated per test to simulate a navigation. */
const route = reactive({
	path: '/dashboard',
	fullPath: '/dashboard',
	name: 'dashboard',
	params: {} as Record<string, string>,
	query: {} as Record<string, string>,
	hash: '',
	meta: {},
});

/** The trail `useBreadcrumbs` would build for the current route. */
const crumbs = ref<Array<{ label: string; href?: string }>>([]);

beforeEach(() => {
	route.path = '/dashboard';
	route.fullPath = '/dashboard';
	route.query = {};
	crumbs.value = [];
	useAnnounce().clear();
	document.body.innerHTML = '';
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		useAnnounce,
		useRoute: () => route,
		// Hand-driven rather than real: what is under test is what the shell DOES
		// with a trail, and building a real one would tie every case to the route
		// registry's current spelling of a page name.
		useBreadcrumbs: () => ({ breadcrumbs: crumbs, setBreadcrumbs: vi.fn() }),
	});
});

function mountLayout(): VueWrapper {
	return mount(DashboardLayout, {
		attachTo: document.body,
		slots: { default: '<h1>Page under the shell</h1>' },
		global: {
			plugins: [createTestI18n()],
			mocks: { resolveComponent: (name: string) => name },
			components: { AppLiveRegion },
			// Everything the shell pulls in that is not the subject here. The rail
			// links are NOT stubbed: one of them is the focus case below.
			stubs: {
				DesktopTitlebar: true,
				DashboardShellHeader: true,
				AppCommandPalette: true,
				KeyboardShortcutsHelp: true,
				Icon: true,
				UiBadge: true,
				UiThemeToggle: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

/** Change the route and let the layout's watcher + its `nextTick` settle. */
async function navigateTo(path: string, trail: Array<{ label: string }>): Promise<void> {
	crumbs.value = trail;
	route.path = path;
	route.fullPath = path;
	await nextTick();
	await nextTick();
	await nextTick();
}

describe('dashboard layout — route announcements', () => {
	it('mounts exactly one polite and one assertive live region', () => {
		const wrapper = mountLayout();

		// One pair, app-wide: several regions announcing at once is
		// unintelligible, and the shell is the only thing that never unmounts.
		expect(wrapper.findAll('[aria-live="polite"]')).toHaveLength(1);
		expect(wrapper.findAll('[aria-live="assertive"]')).toHaveLength(1);
		// Present and EMPTY before anything is said — a region that arrives with
		// its message is usually not announced at all.
		expect(wrapper.get('[aria-live="polite"]').text()).toBe('');
		wrapper.unmount();
	});

	it('announces the new page by name after a navigation', async () => {
		const wrapper = mountLayout();

		await navigateTo('/dashboard/audience/contacts', [
			{ label: 'Audience' },
			{ label: 'Contacts' },
		]);

		expect(wrapper.get('[aria-live="polite"]').text()).toBe('Navigated to Contacts');
		wrapper.unmount();
	});

	it('says nothing on the first render', async () => {
		// Mount is not a navigation: the browser already announced the document.
		const wrapper = mountLayout();
		await nextTick();
		await nextTick();

		expect(wrapper.get('[aria-live="polite"]').text()).toBe('');
		wrapper.unmount();
	});

	it('does not re-announce when only the query changed', async () => {
		const wrapper = mountLayout();
		await navigateTo('/dashboard/audience/contacts', [{ label: 'Contacts' }]);

		// A filter or a sort, not a new page. Re-announcing the same page name on
		// every keystroke of a search box is worse than saying nothing.
		route.query = { q: 'ines' };
		route.fullPath = '/dashboard/audience/contacts?q=ines';
		await nextTick();
		await nextTick();

		expect(wrapper.get('[aria-live="polite"]').text()).toBe('Navigated to Contacts');
		wrapper.unmount();
	});

	it('moves focus into <main> when focus was left on a rail link', async () => {
		const wrapper = mountLayout();
		const railLink = wrapper.findAll('nav a')[0]!.element as HTMLElement;
		railLink.focus();
		expect(document.activeElement).toBe(railLink);

		await navigateTo('/dashboard/audience/contacts', [{ label: 'Contacts' }]);

		// The `tabindex="-1"` on <main> exists precisely so this is possible.
		expect(document.activeElement).toBe(document.getElementById('main-content'));
		wrapper.unmount();
	});

	it('LEAVES focus alone when the navigation is the interaction', async () => {
		// Arrowing down the Postbox thread list changes the route on every row;
		// stealing focus to <main> each time would make the list unusable.
		const wrapper = mountLayout();
		const main = wrapper.get('main#main-content').element;
		const row = document.createElement('button');
		main.appendChild(row);
		row.focus();

		await navigateTo('/dashboard/postbox/inbox/msg2', [{ label: 'Message' }]);

		expect(document.activeElement).toBe(row);
		wrapper.unmount();
	});

	it('announces nothing rather than a wrong name when the trail is empty', async () => {
		const wrapper = mountLayout();

		await navigateTo('/dashboard/some/unmapped/route', []);

		expect(wrapper.get('[aria-live="polite"]').text()).toBe('');
		wrapper.unmount();
	});
});
