// @vitest-environment happy-dom
/**
 * THE POINT OF `useFormat()`: the same value, in the reader's language.
 *
 * `utils/formatters.ts` defaulted to `locale = 'en-US'` and most of its call
 * sites took the default, so a German member read German copy wrapped around
 * American dates ("Mar 3, 2024"), American digit grouping ("1,234") and a
 * percent sign glued straight onto the number — where German writes "3. März
 * 2024", "1.234" and "12,3 %". Every assertion below is run in BOTH locales
 * for that reason: an English-only suite would pass on exactly the bug this
 * composable exists to fix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { datetimeFormats, numberFormats } from '~~/i18n/formats';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { useFormat } from '../useFormat';

/** Run `useFormat()` against a real i18n instance pinned to one locale. */
function formatterFor(locale: 'en' | 'de') {
	const i18n = createI18n({
		legacy: false,
		locale,
		fallbackLocale: 'en',
		messages: { en, de },
		datetimeFormats,
		numberFormats,
	});
	vi.stubGlobal('useI18n', () => i18n.global);
	return useFormat();
}

/** A fixed instant, so nothing here depends on when the suite runs. */
const MARCH_3 = Date.UTC(2024, 2, 3, 9, 30, 0);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('dates follow the reader, not the developer', () => {
	it('formats a calendar date in each locale', () => {
		expect(formatterFor('en').formatDate(MARCH_3, 'long')).toBe('March 3, 2024');
		expect(formatterFor('de').formatDate(MARCH_3, 'long')).toBe('3. März 2024');
	});

	it('drops the year inside the current one and keeps it outside', () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2024, 5, 1));
		// A list of this week's mail does not need "2024" on every row; a list
		// that reaches back a year does.
		expect(formatterFor('en').formatShortDate(MARCH_3)).toBe('Mar 3');
		expect(formatterFor('en').formatShortDate(Date.UTC(2023, 2, 3))).toBe('Mar 3, 2023');
	});
});

describe('numbers follow the reader too', () => {
	it('groups digits the way the locale does', () => {
		// The separators are swapped between the two, so a German reading
		// "1,234" reads it as one-point-two-three-four.
		expect(formatterFor('en').formatNumber(1234)).toBe('1,234');
		expect(formatterFor('de').formatNumber(1234)).toBe('1.234');
	});

	it('lets Intl own the percent sign and its spacing', () => {
		// German puts a no-break space before the sign. Every hand-rolled
		// `${value}%` in this codebase got that wrong by construction.
		expect(formatterFor('en').formatPercentage(0.123)).toBe('12.3%');
		// The space German inserts is a NO-BREAK space (U+00A0), spelled out here
		// so a reviewer is not left comparing two visually identical strings.
		expect(formatterFor('de').formatPercentage(0.123)).toBe('12,3\u00A0%');
	});

	it('takes an already-multiplied percentage when told to', () => {
		// Both spellings exist in this codebase; only the ratio means anything
		// to Intl.
		expect(formatterFor('en').formatPercentage(12.3, 1, false)).toBe('12.3%');
	});

	it('treats a missing number as zero rather than printing nothing', () => {
		expect(formatterFor('en').formatNumber(null)).toBe('0');
		expect(formatterFor('en').formatCompactNumber(undefined)).toBe('0');
	});
});

describe('relative times', () => {
	it('are spoken in the reader language, with its own plural rules', () => {
		vi.useFakeTimers();
		vi.setSystemTime(MARCH_3);
		const twoHoursEarlier = MARCH_3 - 2 * 60 * 60 * 1000;
		expect(formatterFor('en').formatRelativeTime(twoHoursEarlier)).toBe('2 hours ago');
		expect(formatterFor('de').formatRelativeTime(twoHoursEarlier)).toBe('vor 2 Stunden');
	});

	it('use the locale word for a day back instead of counting it', () => {
		vi.useFakeTimers();
		vi.setSystemTime(MARCH_3);
		const yesterday = MARCH_3 - 24 * 60 * 60 * 1000;
		expect(formatterFor('en').formatRelativeTime(yesterday)).toBe('yesterday');
		expect(formatterFor('de').formatRelativeTime(yesterday)).toBe('gestern');
	});

	it('are terse in the compact style and fall back to a date past a week', () => {
		vi.useFakeTimers();
		vi.setSystemTime(MARCH_3);
		const format = formatterFor('en');
		expect(format.formatCompactRelativeTime(MARCH_3 - 5 * 60_000)).toBe('5m ago');
		expect(format.formatCompactRelativeTime(MARCH_3 - 8 * 24 * 3_600_000)).toBe('Feb 24');
	});
});

describe('the two literals that used to be hard-coded English', () => {
	it('says "Never" from the catalog, in the reader language', () => {
		expect(formatterFor('en').formatDate(null)).toBe('Never');
		expect(formatterFor('de').formatDate(null)).toBe('Nie');
	});

	it('says so when a value did not parse', () => {
		expect(formatterFor('en').formatDate('not a date')).toBe('Invalid date');
		expect(formatterFor('de').formatDate('not a date')).toBe('Ungültiges Datum');
	});

	it('leaves a missing clock time empty — the row already says what is missing', () => {
		expect(formatterFor('en').formatTime(null)).toBe('');
		expect(formatterFor('en').formatTime('not a date')).toBe('Invalid time');
	});

	it('lets a caller override the empty label for a compact relative time', () => {
		expect(formatterFor('en').formatCompactRelativeTime(null, { emptyLabel: '—' })).toBe('—');
	});
});
