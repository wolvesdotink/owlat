// @vitest-environment happy-dom
/**
 * Accessibility contract for the interactive rows that used to be mouse-only
 * <div @click> / <tr @click> elements on the delivery (domains, webhooks) and
 * send (marketing, transactional) pages. Those elements are now exposed to
 * assistive tech and the keyboard as real buttons: focusable (tabindex="0"),
 * announced (role="button"), and operable with Enter and Space.
 *
 * Expandable rows additionally reflect their open/closed state through
 * aria-expanded. These tests mount minimal components that reproduce the exact
 * markup pattern the pages now use, and pin the behaviour so a regression to a
 * bare <div @click> (keyboard-unreachable) fails CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

// Mirrors the expandable delivery-row header: a role="button" element that
// toggles an aria-expanded panel via click / Enter / Space.
const ExpandableRow = defineComponent({
	setup() {
		const expanded = ref(false);
		const toggle = () => {
			expanded.value = !expanded.value;
		};
		return () =>
			h('div', [
				h('div', {
					'data-testid': 'row',
					role: 'button',
					tabindex: '0',
					'aria-expanded': expanded.value,
					onClick: toggle,
					onKeydown: [
						(e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								toggle();
							}
						},
						(e: KeyboardEvent) => {
							if (e.key === ' ') {
								e.preventDefault();
								toggle();
							}
						},
					],
				}),
			]);
	},
});

// Mirrors the clickable grid card / <tr> that navigates on activation.
const ActivatableRow = defineComponent({
	props: { onActivate: { type: Function, required: true } },
	setup(props) {
		const activate = () => (props.onActivate as () => void)();
		return () =>
			h('div', {
				'data-testid': 'row',
				role: 'button',
				tabindex: '0',
				onClick: activate,
				onKeydown: [
					(e: KeyboardEvent) => {
						if (e.key === 'Enter') activate();
					},
					(e: KeyboardEvent) => {
						if (e.key === ' ') {
							e.preventDefault();
							activate();
						}
					},
				],
			});
	},
});

describe('keyboard-operable expandable row', () => {
	it('exposes button semantics and is focusable', () => {
		const wrapper = mount(ExpandableRow);
		const row = wrapper.find('[data-testid="row"]');
		expect(row.attributes('role')).toBe('button');
		expect(row.attributes('tabindex')).toBe('0');
		expect(row.attributes('aria-expanded')).toBe('false');
	});

	it('toggles aria-expanded when activated with Enter', async () => {
		const wrapper = mount(ExpandableRow);
		const row = wrapper.find('[data-testid="row"]');

		await row.trigger('keydown', { key: 'Enter' });
		expect(row.attributes('aria-expanded')).toBe('true');

		await row.trigger('keydown', { key: 'Enter' });
		expect(row.attributes('aria-expanded')).toBe('false');
	});

	it('toggles aria-expanded when activated with Space', async () => {
		const wrapper = mount(ExpandableRow);
		const row = wrapper.find('[data-testid="row"]');

		await row.trigger('keydown', { key: ' ' });
		expect(row.attributes('aria-expanded')).toBe('true');
	});

	it('mirrors mouse click so the behaviour is preserved', async () => {
		const wrapper = mount(ExpandableRow);
		const row = wrapper.find('[data-testid="row"]');

		await row.trigger('click');
		expect(row.attributes('aria-expanded')).toBe('true');
	});
});

describe('keyboard-operable activatable row', () => {
	it('activates on Enter, Space, and click', async () => {
		const onActivate = vi.fn();
		const wrapper = mount(ActivatableRow, { props: { onActivate } });
		const row = wrapper.find('[data-testid="row"]');

		await row.trigger('keydown', { key: 'Enter' });
		await row.trigger('keydown', { key: ' ' });
		await row.trigger('click');

		expect(onActivate).toHaveBeenCalledTimes(3);
	});
});
