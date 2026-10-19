import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, onMounted, ref } from 'vue';
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

	it('focuses the requested target, else the first control, else the container', async () => {
		const mountWith = (children: () => ReturnType<typeof h>[], target?: string) =>
			mount(
				defineComponent({
					setup() {
						const root = ref<HTMLElement | null>(null);
						useModalFocus(root, () => true, undefined, {
							initialFocus: () =>
								target ? root.value?.querySelector<HTMLElement>(target) : undefined,
						});
						return () => h('div', { ref: root, tabindex: -1 }, children());
					},
				}),
				{ attachTo: document.body }
			);

		const requested = mountWith(
			() => [h('button', 'Close'), h('button', { 'data-cancel': '' }, 'Cancel')],
			'[data-cancel]'
		);
		await nextTick();
		expect(document.activeElement?.textContent).toBe('Cancel');
		requested.unmount();

		const disabled = mountWith(
			() => [h('button', 'Close'), h('button', { 'data-cancel': '', disabled: true }, 'Cancel')],
			'[data-cancel]'
		);
		await nextTick();
		expect(document.activeElement?.textContent).toBe('Close');
		disabled.unmount();

		const empty = mountWith(() => [h('p', 'Working…')], '[data-cancel]');
		await nextTick();
		expect(document.activeElement).toBe(empty.element);
		empty.unmount();
	});

	it('keeps focus a child already moved into the dialog over the requested target', async () => {
		const wrapper = mount(
			defineComponent({
				setup() {
					const root = ref<HTMLElement | null>(null);
					const input = ref<HTMLInputElement | null>(null);
					useModalFocus(root, () => true, undefined, {
						initialFocus: () => root.value?.querySelector<HTMLElement>('button'),
					});
					onMounted(() => input.value?.focus());
					return () =>
						h('div', { ref: root, tabindex: -1 }, [
							h('button', 'Cancel'),
							h('input', { ref: input }),
						]);
				},
			}),
			{ attachTo: document.body }
		);
		await nextTick();
		expect(document.activeElement?.tagName).toBe('INPUT');
		wrapper.unmount();
	});

	it('enters the Tab order at its edges from a non-tabbable target or the panel', async () => {
		const wrapper = mount(
			defineComponent({
				setup() {
					const root = ref<HTMLElement | null>(null);
					useModalFocus(root, () => true, undefined, {
						initialFocus: () => root.value?.querySelector<HTMLElement>('#intro'),
					});
					return () =>
						h('div', { ref: root, tabindex: -1 }, [
							h('h2', { id: 'intro', tabindex: -1 }, 'Intro'),
							h('button', 'First'),
							h('button', 'Last'),
						]);
				},
			}),
			{ attachTo: document.body }
		);
		await nextTick();
		const intro = wrapper.find('#intro').element as HTMLElement;
		const [first, last] = wrapper.findAll('button').map((b) => b.element);
		expect(document.activeElement).toBe(intro);

		expect(key('Tab', true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
		intro.focus();
		expect(key('Tab').defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);

		(wrapper.element as HTMLElement).focus();
		expect(key('Tab', true).defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(last);
		(wrapper.element as HTMLElement).focus();
		expect(key('Tab').defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		wrapper.unmount();
	});

	it('leaves Tab to the browser inside a shadow tree that has its own controls', async () => {
		let inner: HTMLButtonElement[] = [];
		const wrapper = mount(
			defineComponent({
				setup() {
					const root = ref<HTMLElement | null>(null);
					const host = ref<HTMLElement | null>(null);
					useModalFocus(root, () => true);
					onMounted(() => {
						const shadow = host.value!.attachShadow({ mode: 'open' });
						inner = ['Inner one', 'Inner two'].map((label) => {
							const button = document.createElement('button');
							button.textContent = label;
							shadow.append(button);
							return button;
						});
					});
					return () =>
						h('div', { ref: root, tabindex: -1 }, [
							h('button', 'First'),
							h('div', { ref: host, 'data-host': '' }),
							h('button', 'Last'),
						]);
				},
			}),
			{ attachTo: document.body }
		);
		await nextTick();
		const [one, two] = inner;
		const press = (target: Element, shiftKey: boolean) => {
			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey,
				bubbles: true,
				cancelable: true,
				composed: true,
			});
			target.dispatchEvent(event);
			return event;
		};
		one!.focus();
		expect(document.activeElement).toBe(wrapper.find('[data-host]').element);
		expect(press(one!, false).defaultPrevented).toBe(false);
		two!.focus();
		expect(press(two!, true).defaultPrevented).toBe(false);
		wrapper.unmount();
	});

	it('lets a non-tabbable descendant that handles Tab itself keep it', async () => {
		const wrapper = mount(
			defineComponent({
				setup() {
					const root = ref<HTMLElement | null>(null);
					useModalFocus(root, () => true, undefined, {
						initialFocus: () => root.value?.querySelector<HTMLElement>('[role="grid"]'),
					});
					return () =>
						h('div', { ref: root, tabindex: -1 }, [
							h('button', 'First'),
							h(
								'div',
								{
									role: 'grid',
									tabindex: -1,
									onKeydown: (event: KeyboardEvent) => {
										if (event.key === 'Tab') event.preventDefault();
									},
								},
								'Cells'
							),
							h('button', 'Last'),
						]);
				},
			}),
			{ attachTo: document.body }
		);
		await nextTick();
		const grid = wrapper.find('[role="grid"]').element;
		expect(document.activeElement).toBe(grid);
		key('Tab');
		expect(document.activeElement).toBe(grid);
		key('Tab', true);
		expect(document.activeElement).toBe(grid);
		wrapper.unmount();
	});

	it('leaves Tab to the browser inside a closed shadow tree it cannot inspect', async () => {
		let inner: HTMLButtonElement[] = [];
		const wrapper = mount(
			defineComponent({
				setup() {
					const root = ref<HTMLElement | null>(null);
					const host = ref<HTMLElement | null>(null);
					useModalFocus(root, () => true);
					onMounted(() => {
						const shadow = host.value!.attachShadow({ mode: 'closed' });
						inner = ['Inner one', 'Inner two'].map((label) => {
							const button = document.createElement('button');
							button.textContent = label;
							shadow.append(button);
							return button;
						});
					});
					return () =>
						h('div', { ref: root, tabindex: -1 }, [
							h('button', 'First'),
							h('div', { ref: host, 'data-host': '' }),
							h('button', 'Last'),
						]);
				},
			}),
			{ attachTo: document.body }
		);
		await nextTick();
		const host = wrapper.find('[data-host]').element as HTMLElement;
		expect(host.shadowRoot).toBeNull();
		const [one, two] = inner;
		const press = (target: Element, shiftKey: boolean) => {
			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey,
				bubbles: true,
				cancelable: true,
				composed: true,
			});
			target.dispatchEvent(event);
			return event;
		};
		one!.focus();
		expect(document.activeElement).toBe(host);
		expect(press(one!, false).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(host);
		two!.focus();
		expect(press(two!, true).defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(host);
		wrapper.unmount();
	});
});
