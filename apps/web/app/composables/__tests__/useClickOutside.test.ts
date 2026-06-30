import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useClickOutside } from '../useClickOutside';

let wrapper: VueWrapper | null = null;

/** Mount a host whose template ref is wired to `useClickOutside`. */
function mountHost(handler: (e: MouseEvent) => void): VueWrapper {
	const Host = defineComponent({
		setup() {
			const inside = ref<HTMLElement | null>(null);
			useClickOutside(inside, handler);
			return () =>
				h('div', [
					h('div', { ref: inside, class: 'inside' }, 'inside'),
					h('div', { class: 'outside' }, 'outside'),
				]);
		},
	});
	wrapper = mount(Host, { attachTo: document.body });
	return wrapper;
}

afterEach(() => {
	try {
		wrapper?.unmount();
	} catch {
		// a test may have unmounted already
	}
	wrapper = null;
});

describe('useClickOutside', () => {
	it('fires the handler when the click lands outside the element', () => {
		const handler = vi.fn();
		const w = mountHost(handler);

		w.get('.outside').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('does not fire when the click is inside the element', () => {
		const handler = vi.fn();
		const w = mountHost(handler);

		w.get('.inside').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(handler).not.toHaveBeenCalled();
	});

	it('stops listening after the component unmounts', () => {
		const handler = vi.fn();
		const w = mountHost(handler);

		w.unmount();
		document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(handler).not.toHaveBeenCalled();
	});
});
