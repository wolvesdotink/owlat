// @vitest-environment happy-dom
//
// Shortcut labels are rendered on the server too (the editor page is SSR'd), and
// `navigator` only exists on the client. Reading it during render made a macOS
// browser produce `⌘` where the server had written `Ctrl` — a hydration mismatch
// on every tooltip and every <kbd> chip in the help sheet. The platform is
// therefore resolved after mount: the first client render matches the server's,
// and the labels correct themselves a tick later.
import { describe, it, expect, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { formatShortcut, isApplePlatform, useApplePlatform } from '../editorShortcuts';

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');

function pretendPlatform(platform: string) {
	Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
	if (originalPlatform) Object.defineProperty(navigator, 'platform', originalPlatform);
});

describe('useApplePlatform', () => {
	it('renders the server-safe modifier first and corrects it after mount', async () => {
		pretendPlatform('MacIntel');

		const duringSetup: boolean[] = [];
		const probe = defineComponent({
			setup() {
				const isApple = useApplePlatform();
				duringSetup.push(isApple.value);
				return () => h('span', formatShortcut(['Mod', 'Z'], isApple.value));
			},
		});

		const w = mount(probe);

		// What the server would have written, and what the client's first render
		// must therefore write as well.
		expect(duringSetup).toEqual([false]);
		expect(w.text()).toBe('Ctrl + Z');

		await flushPromises();
		expect(w.text()).toBe('⌘ + Z');
		w.unmount();
	});

	it('stays on Ctrl everywhere else', async () => {
		pretendPlatform('Win32');

		const probe = defineComponent({
			setup() {
				const isApple = useApplePlatform();
				return () => h('span', formatShortcut(['Mod', 'Z'], isApple.value));
			},
		});

		const w = mount(probe);
		await flushPromises();
		expect(w.text()).toBe('Ctrl + Z');
		w.unmount();
	});

	it('reports no platform at all when there is no navigator', () => {
		// The bare detector still has to answer during SSR, where it is the
		// fallback the first render is built from.
		const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
		try {
			expect(isApplePlatform()).toBe(false);
		} finally {
			if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
		}
	});
});
