// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ON THE SHARED SELECT, OPEN AND CLOSED.
 *
 * `UiSelect` is a select-only combobox (packages/ui/components/ui/Select.vue):
 * a `combobox` trigger that keeps focus, a `listbox` named by the field label,
 * and an `aria-activedescendant` that has to point at an option that exists.
 * Closed, axe only sees the trigger, so the open audits are the ones that check
 * the listbox wiring. The keyboard behaviour itself is covered in
 * packages/ui/__tests__/Select.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { auditA11y } from '~/__tests__/a11y';
import { createTestI18n } from '~/__tests__/i18n';
import UiSelect from '@owlat/ui/components/ui/Select.vue';

const OPTIONS = [
	{ value: 30, label: '30 days' },
	{ value: 90, label: '90 days' },
	{ value: 365, label: '365 days' },
];

async function openWithKeyboard(wrapper: VueWrapper): Promise<void> {
	const trigger = wrapper.get<HTMLElement>('[role="combobox"]').element;
	trigger.focus();
	trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	await nextTick();
	trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	await nextTick();
	const active = trigger.getAttribute('aria-activedescendant');
	expect(active && document.getElementById(active)?.getAttribute('role')).toBe('option');
}

const audit = (props: Record<string, unknown>, open: boolean) =>
	auditA11y(UiSelect, {
		props: { options: OPTIONS, ...props },
		global: { plugins: [createTestI18n()] },
		prepare: open ? openWithKeyboard : undefined,
	});

describe('UiSelect — accessibility', () => {
	it('has no axe violations closed, with a label, an error and the required mark', async () => {
		expect(
			await audit(
				{ label: 'Keep raw mail', modelValue: 90, error: 'Pick one', required: true },
				false
			)
		).toEqual([]);
	});

	it('has no axe violations open, with the keyboard on an option', async () => {
		expect(await audit({ label: 'Keep raw mail', modelValue: 90 }, true)).toEqual([]);
	});

	it('has no axe violations open without a visible label', async () => {
		expect(await audit({ placeholder: 'All tags', modelValue: null }, true)).toEqual([]);
	});
});
