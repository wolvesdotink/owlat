import { compactRelativeTime, isSameYear, relativeTimeParts } from '~/utils/relativeTime';

/** The named date/time styles from `i18n/formats.ts`. */
export type DateStyle = 'short' | 'medium' | 'long' | 'full';

/** A timestamp in any of the shapes this app's data actually carries. */
export type FormattableDate = Date | number | string | undefined | null;

/**
 * THE app's formatting front door, bound to the language the reader chose.
 *
 * `utils/formatters.ts` took `locale = 'en-US'` as a default and ~160 of its
 * ~225 call sites accepted it, so a German member got German copy around
 * American dates, American digit grouping and a percent sign glued on with no
 * space. Nothing was wrong at any one call site; the default was wrong, and a
 * default cannot be fixed at the call sites.
 *
 * So the locale is not a parameter here at all: it comes from the active
 * vue-i18n instance, the date and number styles come from that instance's
 * `datetimeFormats`/`numberFormats` (`i18n/formats.ts`), the relative times
 * come from `Intl.RelativeTimeFormat`, and the two literals that used to be
 * hard-coded English — "Never" and "Invalid date" — come from the catalog like
 * every other string a person reads.
 *
 * `useFormat()` also INSTALLS its locale into `utils/formatters.ts`, so the call
 * sites that have not migrated to it yet stop rendering `en-US` too (see
 * `bindFormatterLocale` there).
 */
export function useFormat() {
	const { t, d, n, locale } = useI18n();

	/** Empty timestamp, everywhere it can occur. */
	const never = (): string => t('shared.format.never');

	/** A value that parsed to `Invalid Date` — bad data, said plainly. */
	const invalidDate = (): string => t('shared.format.invalidDate');

	/** `null` for "nothing to format", a `Date` for something real. */
	function toDate(value: FormattableDate): Date | null | undefined {
		if (value === undefined || value === null) return null;
		const date = value instanceof Date ? value : new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}

	/** A calendar date in one of the four named styles. */
	function formatDate(value: FormattableDate, style: DateStyle = 'medium'): string {
		const date = toDate(value);
		if (date === null) return never();
		if (date === undefined) return invalidDate();
		return d(date, style);
	}

	/**
	 * A date mid-sentence: month and day, plus the year only when it is not the
	 * current one. The year on every row of a list of this week's mail is noise.
	 */
	function formatShortDate(value: FormattableDate): string {
		const date = toDate(value);
		if (date === null) return never();
		if (date === undefined) return invalidDate();
		return d(date, isSameYear(date.getTime(), Date.now()) ? 'short' : 'medium');
	}

	/** A date with its clock time. */
	function formatDateTime(value: FormattableDate): string {
		const date = toDate(value);
		if (date === null) return never();
		if (date === undefined) return invalidDate();
		return d(date, 'dateTime');
	}

	/**
	 * Clock time alone. Empty rather than "Never" for a missing value: this one
	 * renders inside a row that already says what is missing.
	 */
	function formatTime(value: FormattableDate): string {
		const date = toDate(value);
		if (date === null) return '';
		if (date === undefined) return t('shared.format.invalidTime');
		return d(date, 'time');
	}

	/** `Intl.RelativeTimeFormat` for the active locale, in the given style. */
	function relativeFormatter(style: Intl.RelativeTimeFormatStyle): Intl.RelativeTimeFormat {
		return new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto', style });
	}

	/**
	 * "2 hours ago" / "in 3 days", in the reader's language and with the
	 * reader's plural rules. `numeric: 'auto'` is what turns "1 day ago" into
	 * "yesterday" — which every locale spells its own way, and none of which the
	 * hand-rolled ladder could produce.
	 */
	function formatRelativeTime(value: FormattableDate): string {
		const date = toDate(value);
		if (date === null) return never();
		if (date === undefined) return invalidDate();
		const { value: amount, unit } = relativeTimeParts(date.getTime(), Date.now());
		return relativeFormatter('long').format(amount, unit);
	}

	/**
	 * The terse style for list rows and chips ("5 min. ago"), falling back to a
	 * short calendar date past a week — at which point a duration stops being an
	 * answer to "when was this?".
	 */
	function formatCompactRelativeTime(
		timestamp: number | undefined | null,
		options: { emptyLabel?: string } = {}
	): string {
		if (timestamp === undefined || timestamp === null) return options.emptyLabel ?? never();
		const rendered = compactRelativeTime(timestamp, Date.now());
		if (rendered.kind === 'date') return formatDate(rendered.at, 'short');
		return relativeFormatter('narrow').format(rendered.parts.value, rendered.parts.unit);
	}

	/** A grouped number. "1,234" in English, "1.234" in German. */
	function formatNumber(value: number | undefined | null): string {
		return n(value ?? 0, 'decimal');
	}

	/** An abbreviated number for a tight tile. "1.2K" */
	function formatCompactNumber(value: number | undefined | null): string {
		return n(value ?? 0, 'compact');
	}

	/**
	 * A percentage. `isDecimal` says whether the caller holds a RATIO (0–1) or
	 * an already-multiplied percentage (0–100) — both spellings exist in this
	 * codebase, and `Intl` only understands the ratio.
	 */
	function formatPercentage(
		value: number | undefined | null,
		decimals = 1,
		isDecimal = true
	): string {
		const ratio = (value ?? 0) / (isDecimal ? 1 : 100);
		return n(ratio, {
			key: 'percent',
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
		});
	}

	return {
		formatDate,
		formatShortDate,
		formatDateTime,
		formatTime,
		formatRelativeTime,
		formatCompactRelativeTime,
		formatNumber,
		formatCompactNumber,
		formatPercentage,
		/** The active locale, for the rare caller that has to build its own `Intl`. */
		locale,
	};
}
