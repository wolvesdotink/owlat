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

	it('inside a modal, Tab and Shift+Tab stay in a focused popover', async () => {
		const popoverOpen = ref(false);
		const Host = defineComponent({
			setup: () => () =>
				h(
					Modal,
					{ open: true, title: 'Edit' },
					{
						default: () => [
							h('input', { 'data-testid': 'modal-field' }),
							h(
								Popover as Component,
								{
									open: popoverOpen.value,
									'onUpdate:open': (next: boolean) => (popoverOpen.value = next),
								},
								{
									trigger: () => h('button', { 'data-testid': 'trigger' }, 'More'),
									default: () => [
										h('button', { 'data-testid': 'first' }, 'First'),
										h('button', { 'data-testid': 'second' }, 'Second'),
									],
								}
							),
						],
					}
				),
		});
		mount(Host, {
			attachTo: document.body,
			global: { plugins: [createUiI18n('en')], components: { Icon: IconStub } },
		});
		await flushPromises();
		const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
		byId('trigger').click();
		await flushPromises();
		expect(document.activeElement).toBe(byId('first'));

		async function tab(shiftKey = false) {
			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey,
				bubbles: true,
				cancelable: true,
			});
			document.activeElement!.dispatchEvent(event);
			await flushPromises();
			return event;
		}

		// Between the panel's own controls Tab is the browser's: the modal's
		// trap does not pull focus back into the modal.
		expect((await tab()).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(byId('first'));
		expect(popoverOpen.value).toBe(true);

		// At the edges it wraps inside the panel, both ways.
		byId('second').focus();
		await tab();
		expect(document.activeElement).toBe(byId('first'));
		await tab(true);
		expect(document.activeElement).toBe(byId('second'));
		expect(popoverOpen.value).toBe(true);

		// Once the popover closes, the modal's trap is back in charge: Tab from
		// outside the modal lands back inside it.
		await escape();
		expect(popoverOpen.value).toBe(false);
		expect(document.activeElement).toBe(byId('trigger'));
		const outside = document.createElement('button');
		document.body.append(outside);
		outside.focus();
		expect((await tab()).defaultPrevented).toBe(true);
		expect(document.activeElement?.closest('[aria-modal="true"]')).not.toBeNull();
		outside.remove();
	});

	describe('inside a modal that an action in the focused popover closes', () => {
		// The popover's own return target is in the modal and leaves with it, so
		// focus goes back to what opened the modal.
		function mountModalWithPopover(withTrigger: boolean, transitions: boolean) {
			const modalOpen = ref(false);
			const popoverOpen = ref(false);
			const anchor = ref<HTMLButtonElement | null>(null);
			const Host = defineComponent({
				setup: () => () => [
					h('button', { 'data-testid': 'edit', onClick: () => (modalOpen.value = true) }, 'Edit'),
					h(
						Modal,
						{
							open: modalOpen.value,
							title: 'Edit',
							'onUpdate:open': (next: boolean) => (modalOpen.value = next),
						},
						{
							default: () => [
								withTrigger
									? null
									: h(
											'button',
											{
												ref: anchor,
												'data-testid': 'more',
												onClick: () => (popoverOpen.value = true),
											},
											'More'
										),
								h(
									Popover as Component,
									{
										open: popoverOpen.value,
										anchor: withTrigger ? null : anchor.value,
										label: withTrigger ? undefined : 'More',
										'onUpdate:open': (next: boolean) => (popoverOpen.value = next),
									},
									{
										...(withTrigger
											? { trigger: () => h('button', { 'data-testid': 'more' }, 'More') }
											: {}),
										default: () =>
											h(
												'button',
												{ 'data-testid': 'save', onClick: () => (modalOpen.value = false) },
												'Save and close'
											),
									}
								),
							],
						}
					),
				],
			});
			const wrapper = mount(Host, {
				attachTo: document.body,
				global: {
					plugins: [createUiI18n('en')],
					components: { Icon: IconStub },
					stubs: transitions ? { transition: false } : {},
				},
			});
			return { wrapper, modalOpen, popoverOpen };
		}

		const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

		it.each([
			{ withTrigger: true, transitions: false, name: 'with a trigger' },
			{ withTrigger: true, transitions: true, name: 'with a trigger, modal transition running' },
			{ withTrigger: false, transitions: false, name: 'anchored without a trigger' },
			{
				withTrigger: false,
				transitions: true,
				name: 'anchored without a trigger, modal transition running',
			},
		])("returns focus to the modal's opener ($name)", async ({ withTrigger, transitions }) => {
			const { wrapper, modalOpen, popoverOpen } = mountModalWithPopover(withTrigger, transitions);
			const edit = wrapper.get<HTMLButtonElement>('[data-testid="edit"]').element;
			edit.focus();
			edit.click();
			await flushPromises();
			byId('more')!.focus();
			byId('more')!.click();
			await flushPromises();
			expect(popoverOpen.value).toBe(true);
			expect(document.activeElement).toBe(byId('save'));

			byId('save')!.click();
			await flushPromises();
			// Reka's focus scope hands focus back in a zero-delay timeout.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await flushPromises();
			expect(modalOpen.value).toBe(false);
			expect(byId('save')).toBeNull();
			expect(document.activeElement).toBe(edit);
		});
	});

	it('leaves a composing Escape to the IME: not cancelled, panel still open', async () => {
		const { wrapper, open } = mountWithTrigger();
		await wrapper.get('[data-testid="trigger"]').trigger('click');
		await flushPromises();
		expect(document.activeElement?.closest('[data-testid="panel"]')).not.toBeNull();

		const event = new KeyboardEvent('keydown', {
			key: 'Escape',
			isComposing: true,
			bubbles: true,
			cancelable: true,
		});
		document.activeElement!.dispatchEvent(event);
		await flushPromises();
		expect(event.defaultPrevented).toBe(false);
		expect(open.value).toBe(true);

		// The next, plain Escape still closes it.
		expect((await escape()).defaultPrevented).toBe(true);
		expect(open.value).toBe(false);
	});

	describe('without a trigger, anchored to an element', () => {
		function mountAnchored() {
			const open = ref(false);
			const anchor = ref<HTMLButtonElement | null>(null);
			const Host = defineComponent({
				setup: () => () => [
					h(
						'button',
						{ ref: anchor, 'data-testid': 'opener', onClick: () => (open.value = true) },
						'Filters'
					),
					h('button', { 'data-testid': 'elsewhere' }, 'Elsewhere'),
					h(
						Popover as Component,
						{
							open: open.value,
							anchor: anchor.value,
							label: 'Filters',
							'onUpdate:open': (next: boolean) => (open.value = next),
						},
						{ default: () => h('div', { 'data-testid': 'panel' }, [h('button', 'Apply')]) }
					),
				],
			});
			const wrapper = mount(Host, { attachTo: document.body });
			const opener = wrapper.get<HTMLButtonElement>('[data-testid="opener"]').element;
			const elsewhere = wrapper.get<HTMLButtonElement>('[data-testid="elsewhere"]').element;
			return { open, opener, elsewhere };
		}

		async function openFrom(opener: HTMLButtonElement) {
			opener.focus();
			opener.click();
			await flushPromises();
			expect(document.activeElement?.closest('[data-testid="panel"]')).not.toBeNull();
		}

		it('gives focus back to its opener when Escape closes it', async () => {
			const { open, opener } = mountAnchored();
			await openFrom(opener);
			await escape();
			expect(open.value).toBe(false);
			expect(document.activeElement).toBe(opener);
		});

		it('gives focus back to its opener when the caller closes it', async () => {
			const { open, opener } = mountAnchored();
			await openFrom(opener);
			open.value = false;
			await flushPromises();
			expect(panel()).toBeNull();
			expect(document.activeElement).toBe(opener);
		});

		it('leaves focus where a press outside put it', async () => {
			const { open, opener, elsewhere } = mountAnchored();
			await openFrom(opener);
			elsewhere.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			elsewhere.focus();
			await flushPromises();
			expect(open.value).toBe(false);
			expect(document.activeElement).toBe(elsewhere);

			// A later open from the keyboard restores again.
			await openFrom(opener);
			await escape();
			expect(document.activeElement).toBe(opener);
		});
	});

	it('is a dialog named by its trigger', async () => {
		const { wrapper } = mountWithTrigger();
		await wrapper.get('[data-testid="trigger"]').trigger('click');
		await flushPromises();
		const dialog = panel()!.closest('[role="dialog"]')!;
		const labelledBy = dialog.getAttribute('aria-labelledby')!;
		expect(document.getElementById(labelledBy)?.textContent).toBe('Filters');
	});

	it('without a trigger, is a dialog named by `label`', async () => {
		const anchor = document.createElement('button');
		document.body.append(anchor);
		mount(Popover as Component, {
			props: { open: true, anchor, label: 'Filters' },
			slots: { default: () => h('div', { 'data-testid': 'panel' }, [h('button', 'Apply')]) },
			attachTo: document.body,
		});
		await flushPromises();
		const named = panel()!.closest('[role="dialog"]')!;
		expect(named.getAttribute('aria-label')).toBe('Filters');
		expect(named.hasAttribute('aria-labelledby')).toBe(false);
		anchor.remove();
	});

	it('without taking focus it is a plain box, not an unnamed dialog', async () => {
		const field = document.createElement('textarea');
		document.body.append(field);
		mount(Popover as Component, {
			props: { open: true, anchor: field, focus: false, inside: [field] },
			slots: { default: () => h('div', { 'data-testid': 'panel' }, 'Suggestions') },
			attachTo: document.body,
		});
		await flushPromises();
		const box = panel()!.parentElement!;
		expect(box.classList.contains('ui-popover')).toBe(true);
		expect(box.hasAttribute('role')).toBe(false);
		expect(box.hasAttribute('aria-labelledby')).toBe(false);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		field.remove();
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
