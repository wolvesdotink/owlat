// @vitest-environment happy-dom
/**
 * Read on arrival's switch in the Reading card (SPEC §2.1): it says plainly
 * that the AI provider reads mail when it arrives, including mail that is
 * never opened; it writes `isReadOnArrival`; and it is only offered when AI
 * is on at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PreferencesReading from '../PreferencesReading.vue';

const setReadOnArrival = vi.fn();
let isAiOn = true;

beforeEach(() => {
	setReadOnArrival.mockClear();
	isAiOn = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => flag === 'ai' && isAiOn }));
	vi.stubGlobal('usePostboxSettings', () => ({
		autoAdvance: ref('next'),
		setAutoAdvance: vi.fn(),
		writingSuggestions: ref(true),
		setWritingSuggestions: vi.fn(),
		readOnArrival: ref(true),
		setReadOnArrival,
		replyDefault: ref('reply'),
		setReplyDefault: vi.fn(),
		density: ref('comfortable'),
		setDensity: vi.fn(),
		readingPane: ref('right'),
		setReadingPane: vi.fn(),
		markReadPolicy: ref('immediately'),
		setMarkReadPolicy: vi.fn(),
		swipeLeftAction: ref('archive'),
		swipeRightAction: ref('read'),
		setSwipeAction: vi.fn(),
		sendSound: ref(false),
		setSendSound: vi.fn(),
		isSaving: ref(false),
	}));
});

function mountCard() {
	return mount(PreferencesReading, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				PreferencesBriefBackfill: true,
				UiSwitch: {
					props: ['modelValue', 'id'],
					emits: ['update:modelValue'],
					template:
						'<button :id="id" :data-on="modelValue" @click="$emit(\'update:modelValue\', !modelValue)" />',
				},
			},
		},
	});
}

describe('PreferencesReading: read on arrival', () => {
	it('says the provider reads mail on arrival, also mail never opened', () => {
		const card = mountCard();
		const text = card.text();
		expect(text).toContain('Read new mail when it arrives');
		expect(text).toContain('including mail you never open');
		// Off is D10, not "nothing is read": replies and categories are still checked (Sol r1 F11).
		expect(text).toContain('still checks new mail for replies and categories');
		expect(text).toContain('only prepares the brief of other mail when you open it');
		expect(card.get('#postbox-read-on-arrival').attributes('data-on')).toBe('true');
		expectFullyLocalized(card);
	});

	it('writes the preference', async () => {
		const card = mountCard();
		await card.get('#postbox-read-on-arrival').trigger('click');
		expect(setReadOnArrival).toHaveBeenCalledWith(false);
	});

	it('is not offered with AI off', () => {
		isAiOn = false;
		expect(mountCard().find('#postbox-read-on-arrival').exists()).toBe(false);
	});

	it('has no Overview switch since the one-page reader, and offers the brief backfill with AI on', () => {
		const card = mountCard();
		expect(card.find('#postbox-auto-summarize').exists()).toBe(false);
		expect(card.text().toLowerCase()).not.toContain('overview');
		expect(card.find('preferences-brief-backfill-stub').exists()).toBe(true);
		isAiOn = false;
		expect(mountCard().find('preferences-brief-backfill-stub').exists()).toBe(false);
	});
});
