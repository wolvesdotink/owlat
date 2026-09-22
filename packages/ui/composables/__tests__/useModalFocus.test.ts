import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useModalFocus } from '../useModalFocus';

function dialog(onEscape = () => {}, empty = false) {
	return mount(
		defineComponent({
			setup() {
				const root = ref<HTMLElement | null>(null);
				useModalFocus(root, () => true, onEscape);
				return () =>
					h(
						'div',
						{ ref: root, tabindex: -1 },
						empty ? [] : [h('button', 'First'), h('button', 'Last')]
					);
			},
		}),
		{ attachTo: document.body }
	);
}
function key(key: string, shiftKey = false) {
	const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
	document.activeElement?.dispatchEvent(event);
	return event;
}

describe('modal focus lifecycle', () => {
	it('wraps focus, contains an empty dialog, and restores focus on unmount', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const wrapper = dialog();
		await nextTick();
		const [first, last] = wrapper.findAll('button');
		expect(document.activeElement).toBe(first!.element);
		expect(key('Tab', true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last!.element);
		key('Tab');
		expect(document.activeElement).toBe(first!.element);
		const empty = dialog(undefined, true);
		await nextTick();
		expect(key('Tab').defaultPrevented).toBe(true);
		empty.unmount();
		expect(document.activeElement).toBe(first!.element);
		wrapper.unmount();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	it('only lets the top dialog handle Escape and restores the parent trap', async () => {
		let parentEscapes = 0;
		let childEscapes = 0;
		const parent = dialog(() => parentEscapes++);
		await nextTick();
		const child = dialog(() => childEscapes++);
		await nextTick();
		key('Escape');
		expect(childEscapes).toBe(1);
		expect(parentEscapes).toBe(0);
		child.unmount();
		key('Escape');
		expect(parentEscapes).toBe(1);
		parent.unmount();
	});

	it('does not steal focus after disposal while initial focus is queued', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const wrapper = dialog();
		wrapper.unmount();
		await nextTick();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});
});
