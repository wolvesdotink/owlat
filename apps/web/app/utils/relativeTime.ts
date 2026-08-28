/**
 * Relative-time arithmetic, kept apart from the words.
 *
 * The app used to build "2 hours ago" and "in 3 days" by hand: a ladder of
 * thresholds, a `${n !== 1 ? 's' : ''}` for the plural, and the word "ago"
 * concatenated on. That is English grammar hard-coded into a formatter, and it
 * has no German output at all — German does not pluralise like English, does
 * not put its "ago" where English does, and has a case system a template string
 * cannot satisfy.
 *
 * `Intl.RelativeTimeFormat` knows all of that for every locale the browser
 * ships. What it does NOT know is which unit to say a duration in — that is a
 * product decision (this app switches to a calendar date past a week in one
 * place and past a month in another), and it is the only thing here.
 *
 * So: this module picks `{ value, unit }`; `Intl` says it out loud.
 */

/** A duration reduced to the one unit it should be spoken in. */
export interface RelativeTimeParts {
	/** Signed, as `Intl.RelativeTimeFormat` wants it: past is negative. */
	value: number;
	unit: Intl.RelativeTimeFormatUnit;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** CLDR's own approximations, so the unit boundaries match what Intl says. */
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * The largest unit that describes `target` relative to `now` without lying:
 * 90 seconds is "1 minute", not "90 seconds"; 40 days is "1 month".
 *
 * The sign is preserved, so a future timestamp comes back positive and `Intl`
 * renders "in 3 days" rather than "3 days ago" — one code path for both
 * directions, where the hand-rolled version had two.
 */
export function relativeTimeParts(target: number, now: number): RelativeTimeParts {
	const delta = target - now;
	const magnitude = Math.abs(delta);
	const sign = delta < 0 ? -1 : 1;

	if (magnitude < MINUTE) return { value: sign * Math.floor(magnitude / SECOND), unit: 'second' };
	if (magnitude < HOUR) return { value: sign * Math.floor(magnitude / MINUTE), unit: 'minute' };
	if (magnitude < DAY) return { value: sign * Math.floor(magnitude / HOUR), unit: 'hour' };
	if (magnitude < WEEK) return { value: sign * Math.floor(magnitude / DAY), unit: 'day' };
	if (magnitude < MONTH) return { value: sign * Math.floor(magnitude / WEEK), unit: 'week' };
	if (magnitude < YEAR) return { value: sign * Math.floor(magnitude / MONTH), unit: 'month' };
	return { value: sign * Math.floor(magnitude / YEAR), unit: 'year' };
}

/**
 * What the COMPACT style should render for a past timestamp: either a duration
 * to hand to `Intl` in its terse ("narrow") form, or the instruction to fall
 * back to a calendar date.
 *
 * The cutoff is the point past which "31 days ago" stops being a useful answer
 * to "when was this?" — a mail list, an API-key row and an automation run all
 * agreed on a week, so a week it is, in one place instead of ten.
 */
export type CompactRelativeTime =
	| { kind: 'relative'; parts: RelativeTimeParts }
	| { kind: 'date'; at: number };

export function compactRelativeTime(target: number, now: number): CompactRelativeTime {
	if (now - target >= WEEK) return { kind: 'date', at: target };
	return { kind: 'relative', parts: relativeTimeParts(target, now) };
}

/**
 * Does this timestamp fall in the same calendar year as `now`? The short date
 * style drops the year inside the current one ("Mar 3") and keeps it outside
 * it ("Mar 3, 2024"), which is the difference between a glanceable list and a
 * column of redundant "2026"s.
 */
export function isSameYear(target: number, now: number): boolean {
	return new Date(target).getFullYear() === new Date(now).getFullYear();
}
