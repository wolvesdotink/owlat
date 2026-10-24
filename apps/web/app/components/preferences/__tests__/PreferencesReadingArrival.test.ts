/**
 * Read on arrival's switch in the Reading card (SPEC §2.1): it says plainly
 * that the AI provider reads mail when it arrives, including mail that is
 * never opened; it writes `isReadOnArrival`; and it is only offered when AI
 * is on at all. Next to it, "Show the brief above conversations"
 * (`isAutoSummarizeOn`), which also gates the brief backfill row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PreferencesReading from '../PreferencesReading.vue';

const setReadOnArrival = vi.fn();
const setAutoSummarize = vi.fn();
const setAfterReply = vi.fn();
let isAiOn = true;
let isBriefShown = true;

beforeEach(() => {
	setReadOnArrival.mockClear();
	setAutoSummarize.mockClear();
	setAfterReply.mockClear();
	isAiOn = true;
	isBriefShown = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: (flag: string) => flag === 'ai' && isAiOn }));
	vi.stubGlobal('usePostboxSettings', () => ({
		autoAdvance: ref('next'),
		setAutoAdvance: vi.fn(),
		writingSuggestions: ref(true),
		setWritingSuggestions: vi.fn(),
		autoSummarize: ref(isBriefShown),
		setAutoSummarize,
		readOnArrival: ref(true),
		setReadOnArrival,
		replyDefault: ref('reply'),
		setReplyDefault: vi.fn(),
		afterReply: ref('keep'),
		setAfterReply,
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

	it('keeps the brief switch, worded for the one-page reader, and writes it', async () => {
		const card = mountCard();
		expect(card.text()).toContain('Show the brief above conversations');
		expect(card.text()).toContain('Off: you see only the conversation.');
		expect(card.text().toLowerCase()).not.toContain('overview');
		await card.get('#postbox-auto-summarize').trigger('click');
		expect(setAutoSummarize).toHaveBeenCalledWith(false);
	});

	it('offers the brief backfill only with AI on and the brief shown', () => {
		expect(mountCard().find('preferences-brief-backfill-stub').exists()).toBe(true);
		isBriefShown = false;
		expect(mountCard().find('preferences-brief-backfill-stub').exists()).toBe(false);
		isBriefShown = true;
		isAiOn = false;
		const off = mountCard();
		expect(off.find('preferences-brief-backfill-stub').exists()).toBe(false);
		expect(off.find('#postbox-auto-summarize').exists()).toBe(false);
	});
});

describe('PreferencesReading: after replying', () => {
	it('offers keeping a replied conversation or marking it done, and names the chord', () => {
		const card = mountCard();
		const row = card.get('[data-testid="preferences-after-reply"]');
		expect(row.text()).toContain('After replying');
		expect(row.text()).toContain('Ctrl+Alt+Enter');
		const select = card.get<HTMLSelectElement>('#postbox-after-reply');
		expect(select.element.value).toBe('keep');
		expect(select.findAll('option').map((o) => o.text())).toEqual([
			'Keep it in the Inbox',
			'Mark it done (archive)',
		]);
		expectFullyLocalized(card);
	});

	it('writes the preference', async () => {
		const card = mountCard();
		await card.get('#postbox-after-reply').setValue('done');
		expect(setAfterReply).toHaveBeenCalledWith('done');
	});
});
