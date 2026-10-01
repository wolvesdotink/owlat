/**
 * The ultra-compact timestamp Postbox lists print on every row: "5m", "3h",
 * "2d", no "ago" suffix, then a short calendar date past a week.
 *
 * Distinct from the app-wide `formatCompactRelativeTime` ("5m ago") and
 * `formatRelativeTime` ("5 minutes ago") in utils/formatters.ts: a row's meta
 * column has room for the number and its unit and nothing else.
 *
 * Pure on purpose. It used to read `Date.now()` and hard-code `en-US`, so a row
 * said "5m" forever (nothing re-rendered it as time passed) and a German reader
 * got "just now" and "Sep 3". The caller now hands in the list's clock, the
 * active locale and the translated "just now"; `usePostboxThreadTimestamp`
 * (composables/postbox/usePostboxListClock.ts) is the one caller.
 *
 * The durations go through `Intl.NumberFormat`'s narrow unit style rather than
 * `Intl.RelativeTimeFormat`: the relative formatter always adds its "ago"
 * ("5m ago", "vor 5 Min."), which is exactly the suffix this column drops.
 * CLDR's narrow units keep English byte-identical to the old output ("5m",
 * "3h", "2d") and give every other locale its own abbreviations.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

type DurationUnit = 'minute' | 'hour' | 'day';

// A row list formats the same few units in the same locale over and over;
// building an Intl formatter is the expensive part, so keep one per pair.
const unitFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function unitFormatter(locale: string, unit: DurationUnit): Intl.NumberFormat {
	const key = `${locale}\u0000${unit}`;
	let formatter = unitFormatters.get(key);
	if (!formatter) {
		formatter = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' });
		unitFormatters.set(key, formatter);
	}
	return formatter;
}

function dateFormatter(locale: string): Intl.DateTimeFormat {
	let formatter = dateFormatters.get(locale);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
		dateFormatters.set(locale, formatter);
	}
	return formatter;
}

export interface ThreadTimestampContext {
	/** The list's clock, epoch ms. */
	now: number;
	/** The locale the app is rendering in. */
	locale: string;
	/** The translated "just now" for anything under a minute old (or in the future). */
	justNow: string;
}

export function formatThreadTimestamp(timestamp: number, context: ThreadTimestampContext): string {
	const diff = context.now - timestamp;
	if (diff < MINUTE) return context.justNow;
	if (diff < HOUR) return unitFormatter(context.locale, 'minute').format(Math.floor(diff / MINUTE));
	if (diff < DAY) return unitFormatter(context.locale, 'hour').format(Math.floor(diff / HOUR));
	if (diff < WEEK) return unitFormatter(context.locale, 'day').format(Math.floor(diff / DAY));
	return dateFormatter(context.locale).format(timestamp);
}
