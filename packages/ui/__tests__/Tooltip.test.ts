import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { Transition, defineComponent, h, inject, nextTick, provide, ref } from 'vue';
import SegmentedControl from '../components/ui/SegmentedControl.vue';
import Tooltip from '../components/ui/Tooltip.vue';
import { useEscapeLayer } from '../composables/useEscapeLayer';
import {
	TOOLTIP_CLOSE_DELAY_MS,
	TOOLTIP_OPEN_DELAY_MS,
	TOOLTIP_WARM_MS,
} from '../utils/tooltipDelay';

let wrapper: VueWrapper | null = null;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(async () => {
	wrapper?.unmount();
	wrapper = null;
	// Let the shared warm window lapse so no test starts with a warm group.
	await vi.advanceTimersByTimeAsync(TOOLTIP_WARM_MS + TOOLTIP_CLOSE_DELAY_MS);
	vi.useRealTimers();
});

const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
const button = (name: string) => document.querySelector<HTMLButtonElement>(`#${name}`)!;

function pointer(target: Element, type: string, pointerType = 'mouse') {
	target.dispatchEvent(new PointerEvent(type, { pointerType, bubbles: type === 'pointerdown' }));
}

async function hover(target: Element) {
	pointer(target, 'pointerenter');
	await nextTick();
}

async function leave(target: Element) {
	pointer(target, 'pointerleave');
	await nextTick();
}

async function elapse(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	await nextTick();
}

/** Each entry is one tooltip around one button: `[id, text, extra button attrs]`. */
function mountTooltips(
	entries: Array<[string, string, Record<string, unknown>?]>,
	tooltipProps: Record<string, unknown> = {}
) {
	wrapper = mount(
		defineComponent({
			setup: () => () =>
				h(
					'div',
					{ id: 'host' },
					entries.map(([id, text, attrs]) =>
						h(Tooltip, { text, ...tooltipProps }, () => h('button', { id, ...attrs }, 'icon'))
					)
				),
		}),
		{ attachTo: document.body }
	);
	return wrapper;
}

describe('UiTooltip', () => {
	it('opens after the shared delay on hover, and describes the control', async () => {
		mountTooltips([['a', 'Archive', { 'aria-label': 'Archive thread' }]]);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS - 1);
		expect(tooltip()).toBeNull();

		await elapse(1);
		expect(tooltip()?.textContent).toBe('Archive');
		expect(button('a').getAttribute('aria-describedby')).toBe(tooltip()!.id);
	});

	it('does not repeat a name the control already has, and restores its own description', async () => {
		mountTooltips([
			['same', 'Archive', { 'aria-label': 'Archive' }],
			['other', 'Snooze', { 'aria-label': 'Snooze thread', 'aria-describedby': 'hint' }],
		]);
		await hover(button('same'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()?.textContent).toBe('Archive');
		expect(button('same').hasAttribute('aria-describedby')).toBe(false);

		await leave(button('same'));
		await hover(button('other'));
		expect(button('other').getAttribute('aria-describedby')).toBe(`hint ${tooltip()!.id}`);
		await leave(button('other'));
		await elapse(TOOLTIP_CLOSE_DELAY_MS);
		expect(tooltip()).toBeNull();
		expect(button('other').getAttribute('aria-describedby')).toBe('hint');
	});

	it('opens at once on keyboard focus and closes on blur', async () => {
		mountTooltips([['a', 'Archive']]);
		button('a').focus();
		await nextTick();
		expect(tooltip()?.textContent).toBe('Archive');

		button('a').blur();
		await nextTick();
		expect(tooltip()).toBeNull();
	});

	it('a press hides it until the pointer leaves, and click handling is untouched', async () => {
		const onClick = vi.fn();
		mountTooltips([['a', 'Archive', { onClick }]]);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).not.toBeNull();

		pointer(button('a'), 'pointerdown');
		button('a').focus();
		button('a').click();
		await nextTick();
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(tooltip()).toBeNull();
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).toBeNull();

		await leave(button('a'));
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()?.textContent).toBe('Archive');
	});

	it('shares the delay: the next trigger opens at once while one is showing or just closed', async () => {
		mountTooltips([
			['a', 'Archive'],
			['b', 'Snooze'],
			['c', 'Delete'],
		]);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()?.textContent).toBe('Archive');

		await leave(button('a'));
		await hover(button('b'));
		expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
		expect(tooltip()?.textContent).toBe('Snooze');

		await leave(button('b'));
		await elapse(TOOLTIP_CLOSE_DELAY_MS);
		expect(tooltip()).toBeNull();
		await hover(button('c'));
		expect(tooltip()?.textContent).toBe('Delete');

		await leave(button('c'));
		await elapse(TOOLTIP_CLOSE_DELAY_MS + TOOLTIP_WARM_MS);
		await hover(button('a'));
		expect(tooltip()).toBeNull();
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()?.textContent).toBe('Archive');
	});

	it('leaving before the delay cancels the open', async () => {
		mountTooltips([['a', 'Archive']]);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS / 2);
		await leave(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).toBeNull();
	});

	it('stays open while the pointer moves onto it', async () => {
		mountTooltips([['a', 'Archive']]);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		await leave(button('a'));
		pointer(tooltip()!, 'pointerenter');
		await elapse(TOOLTIP_CLOSE_DELAY_MS * 2);
		expect(tooltip()).not.toBeNull();

		pointer(tooltip()!, 'pointerleave');
		await elapse(TOOLTIP_CLOSE_DELAY_MS);
		expect(tooltip()).toBeNull();
	});

	it('Escape closes the tooltip first, then reaches the layer underneath', async () => {
		const closeDialog = vi.fn();
		const Dialog = defineComponent({
			setup(_, { slots }) {
				useEscapeLayer(ref(true), () => {
					closeDialog();
				});
				return () => h('div', slots['default']?.());
			},
		});
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Dialog, () => h(Tooltip, { text: 'Archive' }, () => h('button', { id: 'a' }))),
			}),
			{ attachTo: document.body }
		);
		button('a').focus();
		await nextTick();
		expect(tooltip()).not.toBeNull();

		const first = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(first);
		await nextTick();
		expect(tooltip()).toBeNull();
		expect(first.defaultPrevented).toBe(true);
		expect(closeDialog).not.toHaveBeenCalled();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		expect(closeDialog).toHaveBeenCalledTimes(1);
		// Dismissed by Escape, it stays shut while focus stays put.
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).toBeNull();
	});

	it('a touch never opens it', async () => {
		mountTooltips([['a', 'Archive']]);
		pointer(button('a'), 'pointerenter', 'touch');
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).toBeNull();
	});

	it('closes when the page scrolls, and listens to the window only while open', async () => {
		const add = vi.spyOn(window, 'addEventListener');
		const remove = vi.spyOn(window, 'removeEventListener');
		const windowListeners = () =>
			add.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize').length -
			remove.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize').length;
		mountTooltips([
			['a', 'Archive'],
			['b', 'Snooze'],
		]);
		expect(windowListeners()).toBe(0);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(windowListeners()).toBe(2);
		window.dispatchEvent(new Event('scroll'));
		await nextTick();
		expect(tooltip()).toBeNull();
		expect(windowListeners()).toBe(0);
		add.mockRestore();
		remove.mockRestore();
	});

	it('unmounting cancels a pending open and removes an open bubble', async () => {
		const shown = ref(true);
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					shown.value
						? h(Tooltip, { text: 'Archive' }, () => h('button', { id: 'a' }))
						: h('p', 'gone'),
			}),
			{ attachTo: document.body }
		);
		await hover(button('a'));
		shown.value = false;
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).toBeNull();

		shown.value = true;
		await nextTick();
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()).not.toBeNull();
		shown.value = false;
		await nextTick();
		expect(tooltip()).toBeNull();
	});

	it('renders the control itself, with the attributes given to the tooltip', async () => {
		const onClick = vi.fn();
		const Wrapped = defineComponent({
			setup: () => () =>
				h(Tooltip, { text: 'Archive', class: 'from-parent', onClick }, () =>
					h('button', { id: 'a', class: 'own' })
				),
		});
		wrapper = mount(
			defineComponent({ setup: () => () => h('div', { id: 'host' }, [h(Wrapped)]) }),
			{ attachTo: document.body }
		);
		const host = document.querySelector('#host')!;
		expect(host.children).toHaveLength(1);
		expect(host.children[0]).toBe(button('a'));
		expect(button('a').className).toBe('own from-parent');
		button('a').click();
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("is its control's root: a component built on it keeps the control as $el, also in a Transition", async () => {
		const IconAction = defineComponent({
			setup: () => () => h(Tooltip, { text: 'Archive' }, () => h('button', { id: 'a' })),
		});
		const shown = ref(true);
		const action = ref<InstanceType<typeof IconAction> | null>(null);
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Transition, null, () => (shown.value ? h(IconAction, { ref: action }) : null)),
			}),
			{ attachTo: document.body }
		);
		expect(action.value?.$el).toBe(button('a'));
		button('a').focus();
		await nextTick();
		expect(tooltip()?.textContent).toBe('Archive');
		shown.value = false;
		await nextTick();
		expect(tooltip()).toBeNull();
	});

	it('finds the element of a component control', async () => {
		const IconAction = defineComponent({
			setup: () => () => h('button', { id: 'a', type: 'button' }, 'icon'),
		});
		wrapper = mount(
			defineComponent({
				setup: () => () => h(Tooltip, { text: 'Archive' }, () => h(IconAction)),
			}),
			{ attachTo: document.body }
		);
		await hover(button('a'));
		await elapse(TOOLTIP_OPEN_DELAY_MS);
		expect(tooltip()?.textContent).toBe('Archive');
	});

	it('follows a control that appears later', async () => {
		const shown = ref(false);
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Tooltip, { text: 'Archive' }, () => (shown.value ? h('button', { id: 'a' }) : null)),
			}),
			{ attachTo: document.body }
		);
		shown.value = true;
		await nextTick();
		button('a').focus();
		await nextTick();
		expect(tooltip()?.textContent).toBe('Archive');
	});

	it('shows a shortcut, from the prop or the slot, and hides an empty slot', async () => {
		const label = ref<string | null>('E');
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h('div', [
						h(Tooltip, { text: 'Archive', shortcut: 'E' }, () => h('button', { id: 'a' })),
						h(
							Tooltip,
							{ text: 'Snooze' },
							{
								default: () => h('button', { id: 'b' }),
								shortcut: () => (label.value ? h('kbd', label.value) : null),
							}
						),
					]),
			}),
			{ attachTo: document.body }
		);
		button('a').focus();
		await nextTick();
		expect(tooltip()?.querySelector('kbd')?.textContent).toBe('E');

		button('b').focus();
		await nextTick();
		expect(tooltip()?.textContent).toBe('SnoozeE');
		label.value = null;
		await nextTick();
		expect(tooltip()?.querySelector('.ui-tooltip-shortcut')?.textContent).toBe('');
		expect(tooltip()?.querySelector('.ui-tooltip-shortcut')?.className).toContain('empty:hidden');
	});

	it('renders rich content from the #content slot and links it as the description', async () => {
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Tooltip, null, {
						default: () => h('button', { id: 'a', 'aria-label': 'Archive' }),
						content: () => h('strong', 'Archive'),
					}),
			}),
			{ attachTo: document.body }
		);
		button('a').focus();
		await nextTick();
		expect(tooltip()?.querySelector('strong')?.textContent).toBe('Archive');
		expect(button('a').getAttribute('aria-describedby')).toBe(tooltip()!.id);
	});

	it('opens nothing without text or while disabled', async () => {
		mountTooltips([['a', '']]);
		button('a').focus();
		await nextTick();
		expect(tooltip()).toBeNull();
		wrapper?.unmount();

		mountTooltips([['b', 'Archive']], { disabled: true });
		button('b').focus();
		await nextTick();
		expect(tooltip()).toBeNull();
	});

	it('closes an open tooltip that is disabled or loses its text, and its Escape layer with it', async () => {
		const text = ref('Archive');
		const disabled = ref(false);
		const onEscape = vi.fn();
		wrapper = mount(
			defineComponent({
				setup: () => {
					useEscapeLayer(ref(true), onEscape);
					return () =>
						h(Tooltip, { text: text.value, disabled: disabled.value }, () =>
							h('button', { id: 'a' }, 'icon')
						);
				},
			}),
			{ attachTo: document.body }
		);
		button('a').focus();
		await nextTick();
		expect(tooltip()).not.toBeNull();

		disabled.value = true;
		await nextTick();
		expect(tooltip()).toBeNull();
		expect(button('a').hasAttribute('aria-describedby')).toBe(false);
		// The tooltip's layer is gone: Escape reaches the layer underneath.
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onEscape).toHaveBeenCalledTimes(1);

		disabled.value = false;
		await nextTick();
		button('a').blur();
		button('a').focus();
		await nextTick();
		expect(tooltip()).not.toBeNull();

		text.value = '';
		await nextTick();
		expect(tooltip()).toBeNull();
	});

	it('closes when the #content slot it shows goes away', async () => {
		const rich = ref(true);
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Tooltip, null, {
						default: () => h('button', { id: 'a', 'aria-label': 'Archive' }),
						...(rich.value ? { content: () => h('strong', 'Archive') } : {}),
					}),
			}),
			{ attachTo: document.body }
		);
		button('a').focus();
		await nextTick();
		expect(tooltip()).not.toBeNull();

		rich.value = false;
		await nextTick();
		expect(tooltip()).toBeNull();
	});

	it('opens on keyboard focus inside a composite control and describes the focused part', async () => {
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Tooltip, { text: 'Switch inbox mode' }, () =>
						h(SegmentedControl, {
							'aria-label': 'Inbox mode',
							options: [
								{ value: 'today', label: 'Priority' },
								{ value: 'browse', label: 'All mail' },
							],
							modelValue: 'today',
						})
					),
			}),
			{ attachTo: document.body }
		);
		const [first, second] = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
		first!.focus();
		await nextTick();
		expect(tooltip()?.textContent).toBe('Switch inbox mode');
		expect(first!.getAttribute('aria-describedby')).toBe(tooltip()!.id);

		// Moving between the parts keeps it open and moves the description.
		second!.focus();
		await nextTick();
		expect(tooltip()).not.toBeNull();
		expect(first!.hasAttribute('aria-describedby')).toBe(false);
		expect(second!.getAttribute('aria-describedby')).toBe(tooltip()!.id);

		second!.blur();
		await nextTick();
		expect(tooltip()).toBeNull();
		expect(second!.hasAttribute('aria-describedby')).toBe(false);
	});

	it("gives the bubble's slot content what the tooltip's ancestors provide", async () => {
		const key = Symbol('chip-context');
		const Chip = defineComponent({
			setup: () => {
				const value = inject(key, 'missing');
				return () => h('span', { class: 'chip' }, value);
			},
		});
		const Provider = defineComponent({
			setup: (_, { slots }) => {
				provide(key, 'provided');
				return () => slots['default']?.();
			},
		});
		wrapper = mount(
			defineComponent({
				setup: () => () =>
					h(Provider, null, () =>
						h(
							Tooltip,
							{ text: 'Archive' },
							{
								default: () => h('button', { id: 'a' }, 'icon'),
								shortcut: () => h(Chip),
							}
						)
					),
			}),
			{ attachTo: document.body }
		);
		button('a').focus();
		await nextTick();
		expect(tooltip()?.querySelector('.chip')?.textContent).toBe('provided');
	});

	it('places the bubble once it has been measured', async () => {
		mountTooltips([['a', 'Archive']]);
		button('a').focus();
		await nextTick();
		await nextTick();
		const style = tooltip()!.style;
		expect(style.visibility).toBe('');
		expect(style.top).toMatch(/px$/);
		expect(style.left).toMatch(/px$/);
	});
});
