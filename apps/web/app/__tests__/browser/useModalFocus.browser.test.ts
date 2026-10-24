/**
 * The modal focus trap under native keyboard input.
 *
 * The unit suite dispatches synthetic `keydown` events, which never move
 * focus: it can show the trap's handler ran, not where focus went. Here Tab,
 * Shift+Tab, Enter and Escape are real key presses from Playwright, so the
 * browser does its own traversal and the trap only steps in at the edges. A
 * button before and after the dialog gives native traversal somewhere to
 * escape to.
 */
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, type PropType } from 'vue';
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';

const Dialog = defineComponent({
	props: {
		open: { type: Boolean, required: true },
		label: { type: String, required: true },
		initial: { type: String as PropType<string | undefined>, default: undefined },
	},
	emits: ['close'],
	setup(props, { emit, slots }) {
		const container = ref<HTMLElement | null>(null);
		useModalFocus(
			container,
			() => props.open,
			() => emit('close'),
			{
				initialFocus: () =>
					props.initial ? container.value?.querySelector<HTMLElement>(props.initial) : null,
			}
		);
		return () =>
			props.open
				? h(
						'div',
						{ ref: container, role: 'dialog', 'aria-label': props.label, tabindex: -1 },
						slots['default']?.()
					)
				: null;
	},
});

const button = (label: string, onClick?: () => void) =>
	h('button', { type: 'button', 'data-name': label, onClick }, label);

function mountPage(options: { initial?: string; empty?: boolean } = {}) {
	const parentOpen = ref(false);
	const childOpen = ref(false);
	const closes = { parent: 0, child: 0 };
	const Page = defineComponent({
		setup: () => () =>
			h('div', [
				button('Before'),
				button('Open', () => (parentOpen.value = true)),
				h(
					Dialog,
					{
						open: parentOpen.value,
						label: 'Parent',
						initial: options.initial,
						onClose: () => {
							closes.parent += 1;
							parentOpen.value = false;
						},
					},
					() =>
						options.empty
							? [h('p', 'Nothing to press here.')]
							: [
									button('First'),
									button('Open child', () => (childOpen.value = true)),
									button('Last'),
								]
				),
				// A sibling of the parent, not a descendant, as a teleported dialog is.
				h(
					Dialog,
					{
						open: childOpen.value,
						label: 'Child',
						onClose: () => {
							closes.child += 1;
							childOpen.value = false;
						},
					},
					() => [button('Child first'), button('Child last')]
				),
				button('After'),
			]),
	});
	const wrapper = mount(Page, { attachTo: document.body });
	const el = (label: string) => wrapper.get<HTMLElement>(`[data-name="${label}"]`).element;
	const focused = () => {
		const active = document.activeElement as HTMLElement | null;
		return active?.dataset['name'] ?? active?.getAttribute('aria-label') ?? active?.tagName;
	};
	return { el, focused, closes, parentOpen, childOpen };
}

const tab = () => userEvent.tab();
const shiftTab = () => userEvent.tab({ shift: true });

describe('useModalFocus in a real browser', () => {
	it('moves focus into the dialog and wraps native Tab at both edges', async () => {
		const page = mountPage();
		await userEvent.click(page.el('Open'));
		expect(page.focused()).toBe('First');

		// Inside the dialog the browser moves focus on its own.
		await tab();
		expect(page.focused()).toBe('Open child');
		await tab();
		expect(page.focused()).toBe('Last');
		// At the edges the trap wraps instead of letting focus reach "After"/"Open".
		await tab();
		expect(page.focused()).toBe('First');
		await shiftTab();
		expect(page.focused()).toBe('Last');
	});

	it('starts on the requested element', async () => {
		const page = mountPage({ initial: '[data-name="Last"]' });
		await userEvent.click(page.el('Open'));
		expect(page.focused()).toBe('Last');
	});

	it('keeps focus on a dialog with nothing focusable', async () => {
		const page = mountPage({ empty: true });
		await userEvent.click(page.el('Open'));
		expect(page.focused()).toBe('Parent');
		await tab();
		expect(page.focused()).toBe('Parent');
		await shiftTab();
		expect(page.focused()).toBe('Parent');
	});

	it('closes on Escape and gives focus back to the opener', async () => {
		const page = mountPage();
		await userEvent.click(page.el('Open'));
		await tab();

		await userEvent.keyboard('{Escape}');
		expect(page.closes.parent).toBe(1);
		expect(page.parentOpen.value).toBe(false);
		expect(page.focused()).toBe('Open');

		// Released: native Tab leaves the opener for the next control again.
		await tab();
		expect(page.focused()).toBe('After');
	});

	it('hands the trap to a nested dialog and back', async () => {
		const page = mountPage();
		await userEvent.click(page.el('Open'));
		await tab();
		expect(page.focused()).toBe('Open child');

		// Enter on the focused button opens the child, which takes focus and the trap.
		await userEvent.keyboard('{Enter}');
		expect(page.childOpen.value).toBe(true);
		expect(page.focused()).toBe('Child first');
		await tab();
		expect(page.focused()).toBe('Child last');
		await tab();
		expect(page.focused()).toBe('Child first');
		await shiftTab();
		expect(page.focused()).toBe('Child last');

		// One Escape closes the child only, and focus returns to its opener.
		await userEvent.keyboard('{Escape}');
		expect(page.closes).toEqual({ parent: 0, child: 1 });
		expect(page.focused()).toBe('Open child');

		// The parent's trap is back in charge.
		await tab();
		expect(page.focused()).toBe('Last');
		await tab();
		expect(page.focused()).toBe('First');

		await userEvent.keyboard('{Escape}');
		expect(page.closes).toEqual({ parent: 1, child: 1 });
		expect(page.focused()).toBe('Open');
	});
});
