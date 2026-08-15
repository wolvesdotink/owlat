// @vitest-environment happy-dom
/**
 * The snooze dialog's PRESET COPY, rendered through the real catalog.
 *
 * `@owlat/shared/snoozePresets` is shared with the Convex backend and therefore
 * never speaks: it decides which preset exists, when it wakes, and which message
 * key names it. This dialog is the render boundary that turns those keys into
 * words — so this suite is the one place that proves the round trip:
 *   - every row shows its English label, not `sharedPkg.snoozePresets.*`
 *   - the sublabels are FORMATTED dates in the active locale (a German page
 *     reads "18:00", not "6:00 PM"), still in the user's own zone
 *   - the content-inferred suggestion is badged
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxSnoozeDialog from '../PostboxSnoozeDialog.vue';
import PostboxPresetTimeDialog from '../PostboxPresetTimeDialog.vue';
import { createTestI18n, i18nStubs, expectFullyLocalized } from '~/__tests__/i18n';
import de from '~~/i18n/locales/de.json';

// `useI18n` is an auto-import in the app, so it has to be a global here.
Object.assign(globalThis, i18nStubs);

// Wed 2026-01-07 10:00 UTC, viewed from UTC: the workday (9–18) is under way, so
// every preset is present and every wake hour is exact.
const WED_10_UTC = Date.UTC(2026, 0, 7, 10, 0, 0);

const stubs = {
	UiModal: { props: ['open', 'title', 'size'], template: '<div><slot /></div>' },
	UiButton: { template: '<button><slot /></button>' },
};

function mountDialog(hintText = '', locale: 'en' | 'de' = 'en') {
	const i18n = createTestI18n();
	// The shared helper ships `de` empty (its suites only mount the English
	// copy); the German case here is about the translated copy, so it loads the
	// real catalog rather than falling back to English.
	if (locale === 'de') {
		i18n.global.setLocaleMessage('de', de);
		i18n.global.locale.value = 'de';
	}
	return mount(PostboxSnoozeDialog, {
		props: { open: true, hintText },
		global: { plugins: [i18n], components: { PostboxPresetTimeDialog }, stubs },
	});
}

/** Rendered text with runs of whitespace (incl. the narrow NBSP Intl emits) collapsed. */
function flat(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

describe('PostboxSnoozeDialog', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(WED_10_UTC);
		// The dialog reads the viewer's offset off the wall clock; pin it so the
		// assertions below are about the copy, not about the runner's timezone.
		vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(0);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('renders every preset label as words, never as a message key', () => {
		const wrapper = mountDialog();
		const text = flat(wrapper.text());
		for (const label of [
			'Later today',
			'This evening',
			'Tomorrow',
			'This weekend',
			'Next week',
			"Until I'm back",
		]) {
			expect(text).toContain(label);
		}
		expect(wrapper.html()).not.toContain('sharedPkg.');
		expectFullyLocalized(wrapper);
	});

	it('formats the sublabels as times and weekdays in the user zone', () => {
		const text = flat(mountDialog().text());
		// Work end 18:00 and the 20:00 evening, on a 12-hour English clock.
		expect(text).toContain('6:00 PM');
		expect(text).toContain('8:00 PM');
		// Wed → the upcoming Saturday and the following Monday, at the 9:00 start.
		expect(text).toContain('Sat 9:00 AM');
		expect(text).toContain('Mon 9:00 AM');
	});

	it('speaks German — labels translated, clock and weekday localized', () => {
		const text = flat(mountDialog('', 'de').text());
		expect(text).toContain('Später heute');
		expect(text).toContain('Bis ich zurück bin');
		// A 24-hour clock and a German weekday, off the same instants.
		expect(text).toContain('18:00');
		expect(text).toContain('Sa 9:00');
		expect(text).not.toContain('PM');
	});

	it('badges the preset the thread text points at', () => {
		const wrapper = mountDialog('Can you get back to me next week?');
		const rows = wrapper.findAll('li');
		const badged = rows.filter((row) => row.text().includes('Suggested'));
		expect(badged).toHaveLength(1);
		expect(badged[0]!.text()).toContain('Next week');
	});
});
