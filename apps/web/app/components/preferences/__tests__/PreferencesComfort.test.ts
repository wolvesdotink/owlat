/**
 * The Reading comfort card: every control is a labelled native control (a
 * select or a switch with its label pointing at it), shows the device's
 * current value, writes a change straight to the shared settings, and offers
 * Reset only where the value differs from the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { resetReadingComfortForTests, useReadingComfort } from '~/composables/useReadingComfort';
import { READING_COMFORT_STORAGE_KEY } from '~/utils/readingComfort';
import PreferencesComfort from '../PreferencesComfort.vue';

beforeEach(() => {
	localStorage.clear();
	resetReadingComfortForTests();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

afterEach(() => {
	resetReadingComfortForTests();
});

function mountCard() {
	return mount(PreferencesComfort, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiSwitch: {
					props: ['modelValue', 'id'],
					emits: ['update:modelValue'],
					template:
						'<button :id="id" role="switch" :aria-checked="String(modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />',
				},
			},
		},
	});
}

const markers = (card: ReturnType<typeof mountCard>) =>
	card
		.findAll('[data-testid="setting-reset"] button')
		.map((button) => button.attributes('aria-label'));

describe('PreferencesComfort', () => {
	it('labels every control and shows the defaults on an untouched device', () => {
		const card = mountCard();
		const labelled = card.findAll('label[for]').map((label) => ({
			label: label.text(),
			control: card.find(`#${label.attributes('for')}`),
		}));
		expect(labelled.map((l) => l.label)).toEqual([
			'Mail text size',
			'Reading width',
			'List density',
			'Higher contrast',
			'Reduce motion',
		]);
		for (const { control } of labelled) expect(control.exists()).toBe(true);
		expect((card.get('#comfort-text-size').element as HTMLSelectElement).value).toBe('default');
		expect((card.get('#comfort-reading-width').element as HTMLSelectElement).value).toBe('default');
		expect((card.get('#comfort-list-density').element as HTMLSelectElement).value).toBe(
			'comfortable'
		);
		expect(card.get('#comfort-high-contrast').attributes('aria-checked')).toBe('false');
		expect(card.get('#comfort-reduce-motion').attributes('aria-checked')).toBe('false');
		expect(markers(card)).toEqual([]);
		expectFullyLocalized(card);
	});

	it('names every option in words', () => {
		const card = mountCard();
		const options = (id: string) =>
			card
				.get(`#${id}`)
				.findAll('option')
				.map((option) => option.text());
		expect(options('comfort-text-size')).toEqual(['Small', 'Default', 'Large', 'Larger']);
		expect(options('comfort-reading-width')).toEqual(['Narrow', 'Default', 'Wide', 'Full width']);
		expect(options('comfort-list-density')).toEqual(['Comfortable', 'Compact']);
	});

	it('writes a change to the shared settings and this device', async () => {
		const card = mountCard();
		await card.get('#comfort-text-size').setValue('larger');
		await card.get('#comfort-list-density').setValue('compact');
		await card.get('#comfort-reduce-motion').trigger('click');

		const { comfort } = useReadingComfort();
		expect(comfort.value).toMatchObject({
			textSize: 'larger',
			listDensity: 'compact',
			reduceMotion: true,
		});
		expect(JSON.parse(localStorage.getItem(READING_COMFORT_STORAGE_KEY)!)).toMatchObject({
			textSize: 'larger',
			listDensity: 'compact',
			reduceMotion: true,
		});
		expect(card.get('#comfort-reduce-motion').attributes('aria-checked')).toBe('true');
		expect(markers(card)).toEqual([
			'Reset Mail text size to its default',
			'Reset List density to its default',
			'Reset Reduce motion to its default',
		]);
	});

	it('resets one setting to its default and leaves the others', async () => {
		const { set, comfort } = useReadingComfort();
		set('highContrast', true);
		set('readingWidth', 'wide');
		const card = mountCard();
		expect(markers(card)).toEqual([
			'Reset Reading width to its default',
			'Reset Higher contrast to its default',
		]);

		await card.get('[aria-label="Reset Higher contrast to its default"]').trigger('click');
		expect(comfort.value.highContrast).toBe(false);
		expect(comfort.value.readingWidth).toBe('wide');
		expect(markers(card)).toEqual(['Reset Reading width to its default']);
	});
});
