/**
 * Reset to default on the Reading card: a row whose value is the default shows
 * no marker, a changed row shows one, Reset writes the default through that
 * row's own setter, and nothing is marked while the settings row is still
 * loading (every value then reads as a fallback nobody chose).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { POSTBOX_READING_DEFAULTS } from '~/utils/postboxReadingDefaults';
import PreferencesReading from '../PreferencesReading.vue';

const setters = {
	setAutoAdvance: vi.fn(async () => {}),
	setMarkReadPolicy: vi.fn(async () => {}),
	setDensity: vi.fn(async () => {}),
	setReadingPane: vi.fn(async () => true),
	setSwipeAction: vi.fn(async () => {}),
	setReplyDefault: vi.fn(async () => {}),
	setWritingSuggestions: vi.fn(async () => {}),
	setAutoSummarize: vi.fn(async () => {}),
	setReadOnArrival: vi.fn(async () => {}),
	setAutoLoadImages: vi.fn(async () => {}),
	setSendSound: vi.fn(async () => {}),
};

let values: Record<string, unknown>;
let isLoading: boolean;
let isSaving: boolean;

beforeEach(() => {
	for (const setter of Object.values(setters)) setter.mockClear();
	values = { ...POSTBOX_READING_DEFAULTS };
	isLoading = false;
	isSaving = false;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => flag === 'ai' }));
	vi.stubGlobal('usePostboxSettings', () => ({
		...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)])),
		...setters,
		isSaving: ref(isSaving),
		isLoading: ref(isLoading),
	}));
});

function mountCard() {
	return mount(PreferencesReading, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				PreferencesBriefBackfill: true,
				UiSwitch: {
					props: ['modelValue', 'id', 'disabled'],
					emits: ['update:modelValue'],
					template: '<button :id="id" :data-on="modelValue" />',
				},
			},
		},
	});
}

const markers = (card: ReturnType<typeof mountCard>) =>
	card
		.findAll('[data-testid="setting-reset"] button')
		.map((button) => button.attributes('aria-label'));

describe('PreferencesReading: reset to default', () => {
	it('marks nothing when every value is the default', () => {
		expect(markers(mountCard())).toEqual([]);
	});

	it('marks exactly the rows that differ, named after the setting', () => {
		values.density = 'compact';
		values.sendSound = true;
		values.swipeLeftAction = 'trash';
		const card = mountCard();
		expect(markers(card)).toEqual([
			'Reset Density to its default',
			'Reset Swipe left on a message to its default',
			'Reset Play sound when sending to its default',
		]);
		expectFullyLocalized(card);
	});

	it('writes the default back through the row setter', async () => {
		values.density = 'compact';
		values.swipeRightAction = 'archive';
		values.autoSummarize = false;
		const card = mountCard();
		const buttons = card.findAll('[data-testid="setting-reset"] button');
		for (const button of buttons) await button.trigger('click');

		expect(setters.setDensity).toHaveBeenCalledWith(POSTBOX_READING_DEFAULTS.density);
		expect(setters.setSwipeAction).toHaveBeenCalledWith(
			'right',
			POSTBOX_READING_DEFAULTS.swipeRightAction
		);
		expect(setters.setAutoSummarize).toHaveBeenCalledWith(true);
		// Only the rows that were reset were written.
		expect(setters.setAutoAdvance).not.toHaveBeenCalled();
		expect(setters.setSendSound).not.toHaveBeenCalled();
	});

	it('shows no marker while the settings row is loading', () => {
		// While loading, images read as off on purpose; that is not a choice.
		values.autoLoadImages = false;
		isLoading = true;
		expect(markers(mountCard())).toEqual([]);
	});

	it('disables Reset while a save is in flight', () => {
		values.density = 'compact';
		isSaving = true;
		const button = mountCard().get('[data-testid="setting-reset"] button');
		expect(button.attributes('disabled')).toBeDefined();
	});
});
