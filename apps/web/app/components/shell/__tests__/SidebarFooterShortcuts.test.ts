// @vitest-environment happy-dom
/**
 * The account menu's key hints are spelled for the machine: a Windows or
 * Linux user used to be told ⌘J and ⌘⇧F, keys their keyboard does not have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import SidebarFooter from '../SidebarFooter.vue';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

beforeEach(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => ({ path: '/dashboard' }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
		useAuth: () => ({
			user: ref({ name: 'Ada Member', email: 'ada@owlat.example' }),
			signOut: vi.fn(),
			isPending: ref(false),
		}),
		useKeyboardShortcuts: () => ({ openHelpModal: vi.fn() }),
	});
});
enableAutoUnmount(afterEach);
afterEach(() => {
	delete (window.navigator as { userAgent?: string }).userAgent;
});

const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' };

async function openMenu(userAgent: string) {
	Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
	const wrapper = mount(SidebarFooter, {
		props: { collapsed: false },
		global: {
			plugins: [createTestI18n()],
			components: { NuxtLink: NuxtLinkStub },
			stubs: { Icon: true, UiSkeleton: true, UiThemeToggle: true },
		},
	});
	await wrapper.get('button[aria-haspopup="menu"]').trigger('click');
	return wrapper;
}

function hints(wrapper: Awaited<ReturnType<typeof openMenu>>) {
	return wrapper.findAll('[role="menu"] kbd').map((kbd) => kbd.text());
}

describe('account menu shortcut hints', () => {
	it('say Ctrl on Windows', async () => {
		const wrapper = await openMenu(WINDOWS_UA);
		expect(hints(wrapper)).toEqual(['Ctrl+J', 'Ctrl+Shift+F', '?']);
		const settings = wrapper.get('a[href="/dashboard/preferences"]');
		expect(settings.attributes('title')).toBe('Settings (Ctrl+,)');
		expect(settings.attributes('aria-keyshortcuts')).toBe('Control+,');
	});

	it('say ⌘ on a Mac, in the browser too', async () => {
		const wrapper = await openMenu(MAC_UA);
		expect(hints(wrapper)).toEqual(['⌘J', '⇧⌘F', '?']);
		expect(wrapper.get('a[href="/dashboard/preferences"]').attributes('title')).toBe(
			'Settings (⌘,)'
		);
	});

	it('tell assistive tech the same keys', async () => {
		const wrapper = await openMenu(WINDOWS_UA);
		const items = wrapper.findAll('[role="menuitem"]');
		expect(items.map((item) => item.attributes('aria-keyshortcuts'))).toEqual([
			'Control+j',
			'Control+Shift+F',
			'?',
			undefined,
		]);
	});
});
