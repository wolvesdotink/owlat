/**
 * Date, number and size formatting — the PURE half.
 *
 * `useFormat()` (app/composables/useFormat.ts) is the front door: it reads the
 * reader's language off the active vue-i18n instance and the "Never" /
 * "Invalid date" literals out of the message catalog. Reach for this module
 * only from code that has no component to hang a composable off — the pure
 * `utils/*` builders that assemble copy for the delivery console, and anything
 * that formats before an i18n instance exists.
 *
 * Every function here still takes an explicit `locale`, and its DEFAULT is the
 * language the app is currently rendering in rather than a hard-coded
 * `'en-US'`. That default is what `bindAppLocale` below installs, and it is why
 * a call site that predates `useFormat()` no longer paints American dates in a
 * German UI: the fix could not live at the call sites, because the bug was the
 * default.
 */
import { capitalize as _capitalize } from '@owlat/shared';
import { compactRelativeTime, isSameYear, relativeTimeParts } from '~/utils/relativeTime';

/**
 * Capitalize the first character of a string, leaving the rest untouched
 * (e.g. "delivered" -> "Delivered"). Re-exported from `@owlat/shared` so it is
 * available as a Nuxt auto-import in web templates and code.
 */
export const capitalize = _capitalize;

/** The literals a formatter has to fall back to when there is no date. */
export interface FormatLabels {
	never: string;
	invalidDate: string;
	invalidTime: string;
}

/**
 * English, and only until the app boots. The Nuxt plugin
 * `plugins/i18n-format.client.ts` replaces both of these with the active locale
 * and the catalog's own wording on the first render and on every language
 * change; a unit test that never boots the app gets the English defaults, which
 * is what its assertions are written against.
 */
let appLocale = 'en-US';
let appLabels: FormatLabels = {
	never: 'Never',
	invalidDate: 'Invalid date',
	invalidTime: 'Invalid time',
};

/**
 * Point the defaults at the language the app is rendering in. Called by the
 * i18n plugin, not by feature code.
 */
export function bindAppLocale(locale: string, labels: FormatLabels): void {
	appLocale = locale;
	appLabels = labels;
}

/** The active locale, for a caller that has to build its own `Intl`. */
export function activeFormatLocale(): string {
	return appLocale;
}

export type DateFormatStyle = 'short' | 'medium' | 'long' | 'full' | 'relative';

const dateFormatOptions: Record<
	Exclude<DateFormatStyle, 'relative'>,
	Intl.DateTimeFormatOptions
> = {
	short: {
		month: 'short',
		day: 'numeric',
	},
	medium: {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	},
	long: {
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	},
	full: {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	},
};

/**
 * Format a date value to a human-readable string
 * @param date - Date object, timestamp, or ISO string
 * @param style - Format style: 'short', 'medium', 'long', 'full', or 'relative'
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatDate(
	date: Date | number | string | undefined | null,
	style: DateFormatStyle = 'medium',
	locale = appLocale
): string {
	if (date === undefined || date === null) return appLabels.never;

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return appLabels.invalidDate;

	if (style === 'relative') {
		return formatRelativeTime(d);
	}

	return new Intl.DateTimeFormat(locale, dateFormatOptions[style]).format(d);
}

/**
 * Format a date as a short human label mid-sentence: month + day, adding the
 * year only when it is not the current year (e.g. "Mar 3", or "Mar 3, 2024").
 * @param date - Date object, timestamp, or ISO string
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatShortDate(
	date: Date | number | string | undefined | null,
	locale = appLocale
): string {
	if (date === undefined || date === null) return appLabels.never;

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return appLabels.invalidDate;

	return formatDate(d, isSameYear(d.getTime(), Date.now()) ? 'short' : 'medium', locale);
}

/**
 * Format a date with time
 * @param date - Date object, timestamp, or ISO string
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatDateTime(
	date: Date | number | string | undefined | null,
	locale = appLocale
): string {
	if (date === undefined || date === null) return appLabels.never;

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return appLabels.invalidDate;

	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).format(d);
}

/**
 * Format time only
 * @param date - Date object, timestamp, or ISO string
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatTime(
	date: Date | number | string | undefined | null,
	locale = appLocale
): string {
	if (date === undefined || date === null) return '';

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return appLabels.invalidTime;

	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
	}).format(d);
}

/** `Intl.RelativeTimeFormat` for the active locale, in the requested style. */
function relativeFormatter(style: Intl.RelativeTimeFormatStyle): Intl.RelativeTimeFormat {
	return new Intl.RelativeTimeFormat(appLocale, { numeric: 'auto', style });
}

/**
 * A timestamp as relative time: "2 hours ago", "in 3 days", "yesterday".
 *
 * `Intl.RelativeTimeFormat` owns the words. What this replaced was a ladder of
 * thresholds with `${n !== 1 ? 's' : ''}` on the end and "ago" concatenated on
 * — English grammar hard-coded into a formatter, with no German output at all.
 * `numeric: 'auto'` is what yields "yesterday" instead of "1 day ago", in
 * whatever the reader's language spells that.
 *
 * @param date - Date object, timestamp, or ISO string
 */
export function formatRelativeTime(date: Date | number | string | undefined | null): string {
	if (date === undefined || date === null) return appLabels.never;
	const d = date instanceof Date ? date : new Date(date);
	if (isNaN(d.getTime())) return appLabels.invalidDate;

	const { value, unit } = relativeTimeParts(d.getTime(), Date.now());
	return relativeFormatter('long').format(value, unit);
}

/**
 * The terse style for list rows and chips ("5m ago", "3h ago", "2d ago"),
 * falling back to a short calendar date past a week — the point at which a
 * duration stops being an answer to "when was this?". Single home for the form
 * that was copy-pasted as a local helper across ~10 cards and pages.
 *
 * For the verbose form, or for future dates, use `formatRelativeTime`.
 *
 * @param timestamp - Epoch milliseconds, or null/undefined
 * @param options.emptyLabel - Shown when timestamp is null/undefined
 */
export function formatCompactRelativeTime(
	timestamp: number | undefined | null,
	options: { emptyLabel?: string } = {}
): string {
	if (timestamp === undefined || timestamp === null) {
		return options.emptyLabel ?? appLabels.never;
	}
	const rendered = compactRelativeTime(timestamp, Date.now());
	if (rendered.kind === 'date') return formatDate(rendered.at, 'short');
	return relativeFormatter('narrow').format(rendered.parts.value, rendered.parts.unit);
}

/**
 * Number formatting utilities
 */

/**
 * Format a number with thousands separators
 * @param value - Number to format
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatNumber(value: number | undefined | null, locale = appLocale): string {
	if (value === undefined || value === null) return '0';
	return new Intl.NumberFormat(locale).format(value);
}

/**
 * Format a number as compact (e.g., 1.2K, 3.4M)
 * @param value - Number to format
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatCompactNumber(value: number | undefined | null, locale = appLocale): string {
	if (value === undefined || value === null) return '0';
	return new Intl.NumberFormat(locale, {
		notation: 'compact',
		compactDisplay: 'short',
	}).format(value);
}

/**
 * Format a number as percentage
 * @param value - Number to format (0-1 or 0-100 depending on isDecimal)
 * @param decimals - Number of decimal places
 * @param isDecimal - Whether the value is in decimal form (0-1) or percentage form (0-100)
 */
export function formatPercentage(
	value: number | undefined | null,
	decimals = 1,
	isDecimal = true
): string {
	if (value === undefined || value === null) return '0%';
	const percentage = isDecimal ? value * 100 : value;
	return `${percentage.toFixed(decimals)}%`;
}

/**
 * Format bytes to human readable size
 * @param bytes - Number of bytes
 * @param decimals - Number of decimal places
 */
export function formatFileSize(bytes: number | undefined | null, decimals = 2): string {
	if (bytes === undefined || bytes === null || bytes === 0) return '0 Bytes';

	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Format bytes in the *compact* file-size style ("512 B", "1.5 KB", "3.2 MB")
 * used by the file/attachment cards. Unlike formatFileSize (verbose
 * "Bytes/KB/MB/GB/TB" at 2 decimals), this uses terse "B/KB/MB" units at 1
 * decimal and tops out at MB. This is the single home for the form that was
 * previously copy-pasted as a local formatSize/formatBytes/formatFileSize
 * across ~9 file/attachment components.
 *
 * @param bytes - Number of bytes
 */
export function formatCompactFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a timestamp as an ISO-8601 date string for CSV export, returning an
 * empty string for missing values. Single home for the helper previously
 * duplicated in useContactBulkOperations.ts and contacts/ExportModal.vue.
 *
 * @param timestamp - Epoch milliseconds, or undefined
 */
export function formatDateForCsv(timestamp: number | undefined): string {
	if (!timestamp) return '';
	return new Date(timestamp).toISOString();
}

/**
 * Turn a snake_case enum value into a human "Title Case" label
 * ("circuit_open" -> "Circuit Open"). Single home for the fallback formatting
 * previously copy-pasted across enum-driven labels.
 *
 * @param value - The snake_case enum value
 */
export function titleCaseEnum(value: string): string {
	return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
