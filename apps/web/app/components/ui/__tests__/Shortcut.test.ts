// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import UiShortcut from '../Shortcut.vue';
import {
	applyShortcutPreferences,
	pushShortcutScope,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';

/**
 * `<UiShortcut>`: the hint chip every surface uses instead of a hand-typed
 * `⌘K`. It has to be right for the machine (a browser on a Mac included), for
 * the person's preset and remaps, and it has to vanish while nothing fires the
 * key.
 */
const MAC_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const WINDOWS_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const LINUX_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function onPlatform(userAgent: string) {
	Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
}

enableAutoUnmount(afterEach);
afterEach(() => {
	delete (window.navigator as { userAgent?: string }).userAgent;
	resetShortcutPreferences();
	resetShortcutScopes();
});

describe('UiShortcut', () => {
	it.each([
		[MAC_UA, '⌘K'],
		[WINDOWS_UA, 'Ctrl+K'],
		[LINUX_UA, 'Ctrl+K'],
	])('names the palette chord for the browser it runs in (%#)', (userAgent, label) => {
		onPlatform(userAgent);
		const wrapper = mount(UiShortcut, { props: { id: 'global.commandPalette' } });
		expect(wrapper.get('kbd').text()).toBe(label);
	});

	it('puts the caller’s classes on the chip', () => {
		const wrapper = mount(UiShortcut, {
			props: { id: 'global.zen' },
			attrs: { class: 'font-mono' },
		});
		expect(wrapper.get('kbd').classes()).toContain('font-mono');
		expect(wrapper.get('kbd').text()).toBe('Ctrl+Shift+F');
	});

	it('follows a preset switch while it is on screen', async () => {
		const wrapper = mount(UiShortcut, { props: { id: 'postbox.replyAll' } });
		expect(wrapper.get('kbd').text()).toBe('A');
		applyShortcutPreferences('superhuman', []);
		await nextTick();
		expect(wrapper.get('kbd').text()).toBe('Shift+R');
	});

	it('follows a remap, and renders nothing once the key is unbound', async () => {
		const wrapper = mount(UiShortcut, { props: { id: 'postbox.archive' } });
		applyShortcutPreferences('owlat', [{ id: 'postbox.archive', keys: ['y'] }]);
		await nextTick();
		expect(wrapper.get('kbd').text()).toBe('Y');
		applyShortcutPreferences('owlat', [{ id: 'postbox.archive', keys: [] }]);
		await nextTick();
		expect(wrapper.find('kbd').exists()).toBe(false);
	});

	it('hides a global key while the surface on screen claims it', async () => {
		const wrapper = mount(UiShortcut, { props: { id: 'global.newItem' } });
		expect(wrapper.get('kbd').text()).toBe('N');
		const release = pushShortcutScope('postbox');
		await nextTick();
		expect(wrapper.find('kbd').exists()).toBe(false);
		release();
		await nextTick();
		expect(wrapper.get('kbd').text()).toBe('N');
	});

	it('spells a fixed chord for the platform too', () => {
		onPlatform(MAC_UA);
		const wrapper = mount(UiShortcut, { props: { chord: 'mod+Enter' } });
		expect(wrapper.get('kbd').text()).toBe('⌘↵');
	});

	it('renders nothing for an id the catalog does not know', () => {
		const wrapper = mount(UiShortcut, { props: { id: 'global.nope' } });
		expect(wrapper.find('kbd').exists()).toBe(false);
	});
});
