// @vitest-environment happy-dom
/**
 * The phone's bottom bar (UX piece T6).
 *
 * Two things make or break it and neither is visible in a screenshot: the five
 * slots have to follow the same flags the drawer does (a Mail tab pointing at a
 * surface this instance does not run is a 404 one thumb away), and the bar has
 * to get out of the way of anything that owns the bottom of the screen — a
 * composer, a dialog, a sheet — or it becomes a row of invisible tap targets
 * over someone else's buttons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

import MobileTabBar from '../MobileTabBar.vue';

let flags: readonly FeatureFlagKey[] | 'all';
let path: string;
let activeComposerId: ReturnType<typeof ref<string | null>>;
let railDrawerOpen: ReturnType<typeof ref<boolean>>;
let actions: Array<{ id: string; label: string; icon: string; run: () => void }>;

const NuxtLink = defineComponent({
	props: { to: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			h('a', { href: props.to }, slots['default']?.()),
});
const Icon = defineComponent({
	props: { name: { type: String, default: '' } },
	setup: (props) => () => h('span', { 'data-icon': props.name }),
});
const UiModal = defineComponent({
	props: { open: Boolean, title: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			props.open ? h('div', { role: 'dialog' }, slots['default']?.()) : null,
});

function mountBar(props: { navigationOpen?: boolean } = {}) {
	return mount(MobileTabBar, {
		props,
		global: {
			components: { NuxtLink, Icon, UiModal },
			stubs: { teleport: true },
		},
	});
}

/** MutationObserver callbacks land on a task, not the render tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	flags = 'all';
	path = '/dashboard';
	activeComposerId = ref<string | null>(null);
	railDrawerOpen = ref(false);
	actions = [
		{ id: 'compose', label: 'Compose email', icon: 'lucide:pencil', run: vi.fn() },
		{ id: 'contact', label: 'Contact', icon: 'lucide:user-plus', run: vi.fn() },
	];

	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useRoute', () => ({
		get path() {
			return path;
		},
	}));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: FeatureFlagKey) => flags === 'all' || flags.includes(flag),
	}));
	vi.stubGlobal('useQuickCreateMenu', () => ({ actions: computed(() => actions) }));
	vi.stubGlobal('usePostboxComposerStack', () => ({ activeComposerId }));
	vi.stubGlobal('useRailDrawer', () => ({ isOpen: railDrawerOpen, setOpen: vi.fn() }));
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('slots', () => {
	it('puts the create action between the destinations, in the middle of the bar', () => {
		const labels = mountBar()
			.findAll('li')
			.map((item) => item.text());
		expect(labels).toEqual([
			'components.dashboard.mobileTabBar.home',
			'components.dashboard.mobileTabBar.mail',
			'',
			'components.dashboard.mobileTabBar.people',
			'components.dashboard.mobileTabBar.more',
		]);
	});

	it('sends Mail to the Postbox when this instance runs one', () => {
		const hrefs = mountBar()
			.findAll('a')
			.map((link) => link.attributes('href'));
		expect(hrefs).toEqual([
			'/dashboard',
			'/dashboard/postbox/inbox',
			'/dashboard/audience/contacts',
		]);
	});

	it('falls back to the shared inbox when the Postbox is off', () => {
		flags = ['inbox'];
		const hrefs = mountBar()
			.findAll('a')
			.map((link) => link.attributes('href'));
		expect(hrefs).toContain('/dashboard/inbox');
	});

	it('drops the Mail slot entirely rather than linking to a surface that is off', () => {
		flags = [];
		const hrefs = mountBar()
			.findAll('a')
			.map((link) => link.attributes('href'));
		expect(hrefs).toEqual(['/dashboard', '/dashboard/audience/contacts']);
	});

	it('marks the destination you are on', () => {
		path = '/dashboard/audience/contacts';
		const current = mountBar()
			.findAll('a')
			.filter((link) => link.attributes('aria-current') === 'page');
		expect(current.map((link) => link.attributes('href'))).toEqual([
			'/dashboard/audience/contacts',
		]);
	});

	it('hands the drawer back to the shell instead of owning it', async () => {
		const bar = mountBar();
		await bar.get('[data-testid="mobile-tab-bar-more"]').trigger('click');
		expect(bar.emitted('openNavigation')).toHaveLength(1);
	});
});

describe('getting out of the way', () => {
	it('is on screen on an ordinary page', () => {
		expect(mountBar().find('[data-testid="mobile-tab-bar"]').exists()).toBe(true);
	});

	it('leaves while a composer is open', async () => {
		const bar = mountBar();
		activeComposerId.value = 'cmp_1';
		await nextTick();
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(false);
	});

	it('leaves while any dialog is up', async () => {
		const bar = mountBar();
		const dialog = document.createElement('div');
		dialog.setAttribute('aria-modal', 'true');
		document.body.append(dialog);
		await settle();
		await nextTick();
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(false);

		dialog.remove();
		await settle();
		await nextTick();
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(true);
	});

	it('leaves for its OWN create sheet too — at z-header it would paint over it', async () => {
		const bar = mountBar();
		await bar.get('[data-testid="mobile-tab-bar-create"]').trigger('click');
		// On the opening tap, not one observer task later: the sheet slides up
		// from the same edge, so a frame of overlap is a frame of covered rows.
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(false);
	});

	it('leaves while the navigation drawer it opens is on screen', async () => {
		// The drawer is z-50 and its scrim z-40, both under this bar; left up, it
		// covers the drawer's bottom rows and stays tappable over the scrim.
		const bar = mountBar({ navigationOpen: true });
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(false);

		await bar.setProps({ navigationOpen: false });
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(true);
	});

	it("leaves while a page's rail drawer is open", async () => {
		// Chat's and the assistant's conversation rails are the same z-50 panel
		// over a z-40 scrim as the shell drawer, so the bar has to step aside for
		// them too. Their state lives in the page rather than the shell, so it
		// arrives through useRailDrawer instead of a prop.
		const bar = mountBar();
		railDrawerOpen.value = true;
		await nextTick();
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(false);

		railDrawerOpen.value = false;
		await nextTick();
		expect(bar.find('[data-testid="mobile-tab-bar"]').exists()).toBe(true);
	});
});

describe('the create sheet', () => {
	it('offers the registry verbs and runs the one that is tapped', async () => {
		const bar = mountBar();
		await bar.get('[data-testid="mobile-tab-bar-create"]').trigger('click');

		const items = bar.findAll('[role="dialog"] button');
		expect(items.map((item) => item.text())).toEqual(['Compose email', 'Contact']);

		await items[0]!.trigger('click');
		expect(actions[0]!.run).toHaveBeenCalledTimes(1);
		// And it closes behind itself, so the composer it opened is not under a sheet.
		expect(bar.find('[role="dialog"]').exists()).toBe(false);
	});

	it('has no create button at all when nothing may be created', () => {
		actions = [];
		expect(mountBar().find('[data-testid="mobile-tab-bar-create"]').exists()).toBe(false);
	});
});
