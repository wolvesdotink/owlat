import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineComponent, h, ref, type ComponentPublicInstance } from 'vue';
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

function unmountHost(): void {
	wrapper?.unmount();
	wrapper = null;
}

afterEach(unmountHost);

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

		unmountHost();
		document.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(handler).not.toHaveBeenCalled();
	});

	// A `ref=` on a component resolves to its public instance, not its root
	// element. That instance is truthy but has no `.contains`, so the naive
	// `t.value?.contains(node)` threw on every document click and the panel never
	// closed. Both target shapes must work.
	describe('component-instance targets (ref= on a component)', () => {
		/** Stand-in for <UiButton>: a component, so the ref holds its instance. */
		const Child = defineComponent({
			name: 'ChildButton',
			setup: () => () => h('button', { class: 'child' }, 'trigger'),
		});

		/** Trigger is a component instance; the panel is a plain element. */
		function mountInstanceHost(handler: (e: MouseEvent) => void): VueWrapper {
			const Host = defineComponent({
				setup() {
					const trigger = ref<ComponentPublicInstance | null>(null);
					const panel = ref<HTMLElement | null>(null);
					useClickOutside([trigger, panel], handler);
					return () =>
						h('div', [
							h(Child, { ref: trigger }),
							h('div', { ref: panel, class: 'panel' }, [
								h('button', { class: 'panel-item' }, 'item'),
							]),
							h('div', { class: 'outside' }, 'outside'),
						]);
				},
			});
			wrapper = mount(Host, { attachTo: document.body });
			return wrapper;
		}

		it('does not throw and still fires for outside clicks', () => {
			const handler = vi.fn();
			const w = mountInstanceHost(handler);

			expect(() =>
				w.get('.outside').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			).not.toThrow();
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('treats a click on the component trigger as inside', () => {
			const handler = vi.fn();
			const w = mountInstanceHost(handler);

			w.get('.child').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(handler).not.toHaveBeenCalled();
		});

		it('treats a click inside the panel as inside', () => {
			const handler = vi.fn();
			const w = mountInstanceHost(handler);

			w.get('.panel-item').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			expect(handler).not.toHaveBeenCalled();
		});
	});
});
