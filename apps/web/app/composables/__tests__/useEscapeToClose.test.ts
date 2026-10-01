// @vitest-environment happy-dom
/**
 * Esc on an open popover closes it and claims the key, so the page's own Esc
 * (Answer mode leaving for the list, the reader closing its conversation)
 * does not run on the same press. The pages check `defaultPrevented`; the
 * shortcut dispatcher listens on the document in the bubble phase and was
 * registered first, so the popover's listener has to run in the capture phase.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useEscapeToClose } from '../useEscapeToClose';

const seen: Array<{ where: string; prevented: boolean }> = [];
const onDocument = (e: KeyboardEvent) =>
	seen.push({ where: 'document', prevented: e.defaultPrevented });
const onWindow = (e: KeyboardEvent) =>
	seen.push({ where: 'window', prevented: e.defaultPrevented });

function setup() {
	// Registered before the popover, like the app-wide shortcut dispatcher.
	document.addEventListener('keydown', onDocument);
	window.addEventListener('keydown', onWindow);
	const open = ref(false);
	const wrapper = mount(
		defineComponent({
			setup() {
				useEscapeToClose(open);
				return () => h('button');
			},
		}),
		{ attachTo: document.body }
	);
	return { open, wrapper };
}

const pressEsc = () =>
	document.body.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
	);

afterEach(() => {
	document.removeEventListener('keydown', onDocument);
	window.removeEventListener('keydown', onWindow);
	seen.length = 0;
});

describe('useEscapeToClose', () => {
	it('closes the open popover and claims the press before the page handlers see it', async () => {
		const { open, wrapper } = setup();
		open.value = true;
		await nextTick();

		pressEsc();

		expect(open.value).toBe(false);
		expect(seen).toEqual([
			{ where: 'document', prevented: true },
			{ where: 'window', prevented: true },
		]);
		wrapper.unmount();
	});

	it('leaves Esc alone while the popover is closed', async () => {
		const { wrapper } = setup();
		await nextTick();

		pressEsc();

		expect(seen.every((s) => !s.prevented)).toBe(true);
		wrapper.unmount();
	});
});
