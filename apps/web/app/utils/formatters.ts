/**
 * Date and time formatting utilities
 */

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
	locale = 'en-US'
): string {
	if (date === undefined || date === null) return 'Never';

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return 'Invalid date';

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
	locale = 'en-US'
): string {
	if (date === undefined || date === null) return 'Never';

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return 'Invalid date';

	const isCurrentYear = d.getFullYear() === new Date().getFullYear();
	return formatDate(d, isCurrentYear ? 'short' : 'medium', locale);
}

/**
 * Format a date with time
 * @param date - Date object, timestamp, or ISO string
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatDateTime(
	date: Date | number | string | undefined | null,
	locale = 'en-US'
): string {
	if (date === undefined || date === null) return 'Never';

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return 'Invalid date';

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
	locale = 'en-US'
): string {
	if (date === undefined || date === null) return '';

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return 'Invalid time';

	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
	}).format(d);
}

/**
 * Format a date as relative time (e.g., "2 hours ago", "in 3 days")
 * @param date - Date object, timestamp, or ISO string
 */
export function formatRelativeTime(date: Date | number | string | undefined | null): string {
	if (date === undefined || date === null) return 'Never';

	const d = date instanceof Date ? date : new Date(date);

	if (isNaN(d.getTime())) return 'Invalid date';

	const now = new Date();
	const diffInSeconds = Math.floor((now.getTime() - d.getTime()) / 1000);
	const diffInMinutes = Math.floor(diffInSeconds / 60);
	const diffInHours = Math.floor(diffInMinutes / 60);
	const diffInDays = Math.floor(diffInHours / 24);
	const diffInWeeks = Math.floor(diffInDays / 7);
	const diffInMonths = Math.floor(diffInDays / 30);
	const diffInYears = Math.floor(diffInDays / 365);

	// Future dates
	if (diffInSeconds < 0) {
		const absDiffInSeconds = Math.abs(diffInSeconds);
		const absDiffInMinutes = Math.floor(absDiffInSeconds / 60);
		const absDiffInHours = Math.floor(absDiffInMinutes / 60);
		const absDiffInDays = Math.floor(absDiffInHours / 24);

		if (absDiffInSeconds < 60) return 'in a few seconds';
		if (absDiffInMinutes < 60)
			return `in ${absDiffInMinutes} minute${absDiffInMinutes !== 1 ? 's' : ''}`;
		if (absDiffInHours < 24) return `in ${absDiffInHours} hour${absDiffInHours !== 1 ? 's' : ''}`;
		if (absDiffInDays < 7) return `in ${absDiffInDays} day${absDiffInDays !== 1 ? 's' : ''}`;
		return formatDate(d, 'medium');
	}

	// Past dates
	if (diffInSeconds < 60) return 'just now';
	if (diffInMinutes < 60) return `${diffInMinutes} minute${diffInMinutes !== 1 ? 's' : ''} ago`;
	if (diffInHours < 24) return `${diffInHours} hour${diffInHours !== 1 ? 's' : ''} ago`;
	if (diffInDays < 7) return `${diffInDays} day${diffInDays !== 1 ? 's' : ''} ago`;
	if (diffInWeeks < 4) return `${diffInWeeks} week${diffInWeeks !== 1 ? 's' : ''} ago`;
	if (diffInMonths < 12) return `${diffInMonths} month${diffInMonths !== 1 ? 's' : ''} ago`;
	return `${diffInYears} year${diffInYears !== 1 ? 's' : ''} ago`;
}

/**
 * Format a past timestamp as a *compact* relative string ("Just now", "5m ago",
 * "3h ago", "2d ago"), falling back to a short date past 7 days. This is the
 * single home for the terse "Nx ago" style that was previously copy-pasted as a
 * local helper across ~10 cards/pages (audience, campaigns report, code tasks,
 * channel config, API keys, automations, inbox review, mail, recent contacts).
 *
 * For verbose output ("5 minutes ago") or future dates, use formatRelativeTime.
 *
 * @param timestamp - Epoch milliseconds, or null/undefined
 * @param options.emptyLabel - Shown when timestamp is null/undefined (default "Never")
 */
export function formatCompactRelativeTime(
	timestamp: number | undefined | null,
	options: { emptyLabel?: string } = {}
): string {
	if (timestamp === undefined || timestamp === null) {
		return options.emptyLabel ?? 'Never';
	}
	const diff = Date.now() - timestamp;
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / 86_400_000);
	if (minutes < 1) return 'Just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	return formatDate(timestamp, 'short');
}

/**
 * Number formatting utilities
 */

/**
 * Format a number with thousands separators
 * @param value - Number to format
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatNumber(value: number | undefined | null, locale = 'en-US'): string {
	if (value === undefined || value === null) return '0';
	return new Intl.NumberFormat(locale).format(value);
}

/**
 * Format a number as compact (e.g., 1.2K, 3.4M)
 * @param value - Number to format
 * @param locale - Locale string (defaults to 'en-US')
 */
export function formatCompactNumber(value: number | undefined | null, locale = 'en-US'): string {
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
