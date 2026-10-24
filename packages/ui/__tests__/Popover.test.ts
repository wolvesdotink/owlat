/**
 * The shared anchored popover (Reka UI underneath): rendered at the end of the
 * body, closed by Escape through the escape-layer stack (so inside a modal the
 * first Escape is the popover's), and, for suggestion lists, leaving focus in
 * the field it hangs from.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type Component } from 'vue';
import Modal from '../components/ui/Modal.vue';
import Popover from '../components/ui/Popover.vue';
import { anchorToElementBox } from '../utils/popoverAnchor';
import { createUiI18n } from './i18n';

enableAutoUnmount(afterEach);

const IconStub = { name: 'Icon', setup: () => () => h('i') };
const panel = () => document.querySelector<HTMLElement>('[data-testid="panel"]');

async function escape(target: Element = document.activeElement ?? document.body) {
	const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	await flushPromises();
	return event;
}

function mountWithTrigger() {
	const open = ref(false);
	const Host = defineComponent({
		setup: () => () =>
			h(
				Popover as Component,
				{ open: open.value, 'onUpdate:open': (next: boolean) => (open.value = next) },
				{
					trigger: () => h('button', { 'data-testid': 'trigger' }, 'Filters'),
					default: () => h('div', { 'data-testid': 'panel' }, [h('button', 'Apply')]),
				}
			),
	});
	const wrapper = mount(Host, { attachTo: document.body });
	return { wrapper, open };
}

describe('UiPopover', () => {
	it('opens from its trigger at the end of the body, and Escape closes it', async () => {
		const { wrapper, open } = mountWithTrigger();
		expect(panel()).toBeNull();
		await wrapper.get('[data-testid="trigger"]').trigger('click');
		await flushPromises();
		expect(open.value).toBe(true);
		expect(panel()).not.toBeNull();
		expect(wrapper.element.contains(panel())).toBe(false);
		expect(wrapper.get('[data-testid="trigger"]').attributes('aria-expanded')).toBe('true');

		const event = await escape();
		expect(event.defaultPrevented).toBe(true);
		expect(open.value).toBe(false);
		expect(panel()).toBeNull();
	});

	it('inside a modal, the first Escape closes the popover and the second the modal', async () => {
		const modalOpen = ref(true);
		const popoverOpen = ref(false);
		const Host = defineComponent({
			setup: () => () =>
				h(
					Modal,
					{
						open: modalOpen.value,
						title: 'Edit',
						'onUpdate:open': (next: boolean) => (modalOpen.value = next),
					},
					{
						default: () =>
							h(
								Popover as Component,
								{
									open: popoverOpen.value,
									'onUpdate:open': (next: boolean) => (popoverOpen.value = next),
								},
								{
									trigger: () => h('button', { 'data-testid': 'trigger' }, 'More'),
									default: () => h('div', { 'data-testid': 'panel' }, 'Options'),
								}
							),
					}
				),
		});
		mount(Host, {
			attachTo: document.body,
			global: { plugins: [createUiI18n('en')], components: { Icon: IconStub } },
		});
		await flushPromises();
		document.querySelector<HTMLElement>('[data-testid="trigger"]')!.click();
		await flushPromises();
		expect(popoverOpen.value).toBe(true);

		await escape();
		expect(popoverOpen.value).toBe(false);
		expect(modalOpen.value).toBe(true);

		await escape();
		expect(modalOpen.value).toBe(false);
	});

	it('anchored to a field without taking focus, a press in the field keeps it open', async () => {
		const open = ref(true);
		const fieldRef = ref<HTMLTextAreaElement | null>(null);
		const Host = defineComponent({
			setup: () => () => [
				h('textarea', { ref: fieldRef, 'data-testid': 'field' }),
				h('button', { 'data-testid': 'elsewhere' }, 'Elsewhere'),
				h(
					Popover as Component,
					{
						open: open.value,
						anchor: fieldRef.value,
						focus: false,
						inside: [fieldRef.value],
						'onUpdate:open': (next: boolean) => (open.value = next),
					},
					{ default: () => h('div', { 'data-testid': 'panel' }, [h('button', 'Pick')]) }
				),
			],
		});
		const wrapper = mount(Host, { attachTo: document.body });
		const field = wrapper.get<HTMLTextAreaElement>('[data-testid="field"]').element;
		field.focus();
		open.value = false;
		await flushPromises();
		open.value = true;
		await flushPromises();
		expect(panel()).not.toBeNull();
		expect(document.activeElement).toBe(field);

		// Reka arms its outside-press listener a macrotask after opening, which
		// the `flushPromises` above already yielded.
		field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await flushPromises();
		expect(open.value).toBe(true);

		wrapper
			.get('[data-testid="elsewhere"]')
			.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await flushPromises();
		expect(open.value).toBe(false);
		expect(document.activeElement).toBe(field);
	});
});

describe('anchorToElementBox', () => {
	it('moves a measured box by exactly as much as its element moved', async () => {
		const el = document.createElement('div');
		let top = 100;
		el.getBoundingClientRect = () => new DOMRect(20, top, 300, 40);
		const anchor = anchorToElementBox(el, { left: 60, top: 110, width: 2, height: 18 });
		expect(anchor.contextElement).toBe(el);
		expect(anchor.getBoundingClientRect()).toMatchObject({ x: 60, y: 110, width: 2, height: 18 });
		top = 40; // the page scrolled 60px
		await nextTick();
		expect(anchor.getBoundingClientRect()).toMatchObject({ x: 60, y: 50 });
	});
});
