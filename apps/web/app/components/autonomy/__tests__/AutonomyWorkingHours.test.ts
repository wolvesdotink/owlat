/**
 * Working hours (AutonomyWorkingHours): the switch and the window each carry a
 * reset marker against the shipped defaults (off, 09:00–17:00, Monday to
 * Friday). A Reset only edits the card's draft; Save writes it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const { default: AutonomyWorkingHours } = await import('../AutonomyWorkingHours.vue');

const SwitchStub = defineComponent({
	props: { modelValue: Boolean, label: { type: String, default: '' } },
	emits: ['update:modelValue'],
	setup:
		(props, { emit }) =>
		() =>
			h('button', {
				role: 'switch',
				'aria-checked': String(props.modelValue),
				'aria-label': props.label,
				onClick: () => emit('update:modelValue', !props.modelValue),
			}),
});

function mountCard(props: Record<string, unknown> = {}) {
	return mount(AutonomyWorkingHours, {
		props: { timezone: 'Europe/Berlin', ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: { template: '<div><slot /></div>' },
				UiIconBox: true,
				UiSwitch: SwitchStub,
				UiButton: {
					props: { disabled: Boolean },
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
				Icon: true,
			},
		},
	});
}

function resetButtons(w: ReturnType<typeof mountCard>) {
	return w.findAll('[data-testid="setting-reset"] button');
}

function saveButton(w: ReturnType<typeof mountCard>) {
	const save = w.findAll('button').find((b) => b.text() === 'Save working hours');
	if (!save) throw new Error('no Save button');
	return save;
}

describe('AutonomyWorkingHours: reset to default', () => {
	it('is quiet at the defaults, switched off', () => {
		expect(resetButtons(mountCard()).length).toBe(0);
	});

	it('is quiet when switched on with the default window, except for the switch', () => {
		const buttons = resetButtons(mountCard({ enabled: true }));
		expect(buttons.map((b) => b.attributes('aria-label'))).toEqual([
			'Reset Working hours to its default',
		]);
	});

	it('marks a changed window and resets hours and days as a draft', async () => {
		const w = mountCard({ enabled: true, start: 8 * 60, end: 16 * 60, days: [1, 2, 3] });
		const window = resetButtons(w).find(
			(b) => b.attributes('aria-label') === 'Reset Working hours window to its default'
		);
		expect(window).toBeDefined();
		await window!.trigger('click');
		expect(resetButtons(w).map((b) => b.attributes('aria-label'))).toEqual([
			'Reset Working hours to its default',
		]);
		expect(w.emitted('save')).toBeUndefined();

		await saveButton(w).trigger('click');
		expect(w.emitted('save')).toEqual([
			[{ enabled: true, timezone: 'Europe/Berlin', start: 540, end: 1020, days: [1, 2, 3, 4, 5] }],
		]);
	});

	it('treats the same days in another order as the default window', () => {
		const buttons = resetButtons(mountCard({ enabled: true, days: [5, 4, 3, 2, 1] }));
		expect(buttons.length).toBe(1);
	});

	it('resets the switch to off and Save writes it', async () => {
		const w = mountCard({ enabled: true });
		await resetButtons(w)[0]!.trigger('click');
		expect(w.get('[role="switch"]').attributes('aria-checked')).toBe('false');
		expect(resetButtons(w).length).toBe(0);
		await saveButton(w).trigger('click');
		expect(w.emitted('save')?.[0]?.[0]).toMatchObject({ enabled: false });
	});

	it('holds the resets while a save is in flight', () => {
		const w = mountCard({ enabled: true, start: 8 * 60, busy: true });
		const buttons = resetButtons(w);
		expect(buttons.length).toBe(2);
		for (const button of buttons) expect(button.attributes('disabled')).toBeDefined();
	});
});
