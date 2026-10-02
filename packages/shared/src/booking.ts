/**
 * The booking page's shared rules: the bounds every field is held to and the
 * shape checks the settings form runs before a save and the backend runs again
 * on it. Import-free, so the web bundle and the Convex runtime load the same
 * module.
 */

export const BOOKING_LIMITS = {
	slugMinLength: 3,
	slugMaxLength: 40,
	displayNameMaxLength: 120,
	titleMaxLength: 120,
	descriptionMaxLength: 2000,
	locationMaxLength: 500,
	videoUrlMaxLength: 2000,
	guestNameMaxLength: 120,
	guestNoteMaxLength: 2000,
	meetingTypesMax: 20,
	rangesPerDayMax: 6,
	dateOverridesMax: 120,
	durationMinMinutes: 5,
	durationMaxMinutes: 480,
	noticeMaxMinutes: 30 * 24 * 60,
	horizonMinDays: 1,
	horizonMaxDays: 90,
	bufferMaxMinutes: 240,
	/** Confirmed, still-upcoming bookings one guest address may hold with one host. */
	openBookingsPerGuest: 3,
} as const;

/** Lowercase letters, digits and inner hyphens; no leading or trailing hyphen. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Path segments the booking pages use themselves (`/book/manage`). */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['manage']);

/** Whether `slug` can be a `/book/<slug>` path segment. */
export function isValidBookingSlug(slug: string): boolean {
	return (
		slug.length >= BOOKING_LIMITS.slugMinLength &&
		slug.length <= BOOKING_LIMITS.slugMaxLength &&
		SLUG_RE.test(slug) &&
		!slug.includes('--') &&
		!RESERVED_SLUGS.has(slug)
	);
}

/**
 * A slug suggestion from a name or a meeting title: "Ada Lovelace" → "ada-lovelace",
 * "30 min intro" → "30-min-intro". Accents fold to their base letter; anything
 * else that is not a letter or digit becomes one hyphen. May be shorter than the
 * minimum (the caller pads or asks for one).
 */
export function suggestBookingSlug(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, BOOKING_LIMITS.slugMaxLength)
		.replace(/-+$/g, '');
}

/** A stretch of a day, in minutes from local midnight, half-open [start, end). */
export interface BookingTimeRange {
	startMinute: number;
	endMinute: number;
}

/** A weekly opening: the weekday (0 = Sunday … 6 = Saturday) and its stretch. */
export interface BookingWeeklyRange extends BookingTimeRange {
	weekday: number;
}

/** What is wrong with a day's ranges, or `null` when they are fine. */
export type BookingRangeProblem = 'bounds' | 'order' | 'overlap' | 'tooMany';

/**
 * Check one day's ranges: each inside the day on a whole minute, start before
 * end, no two overlapping, at most {@link BOOKING_LIMITS.rangesPerDayMax}.
 */
export function bookingRangeProblem(
	ranges: readonly BookingTimeRange[]
): BookingRangeProblem | null {
	if (ranges.length > BOOKING_LIMITS.rangesPerDayMax) return 'tooMany';
	for (const range of ranges) {
		if (
			!Number.isInteger(range.startMinute) ||
			!Number.isInteger(range.endMinute) ||
			range.startMinute < 0 ||
			range.endMinute > 24 * 60
		) {
			return 'bounds';
		}
		if (range.startMinute >= range.endMinute) return 'order';
	}
	const sorted = [...ranges].sort((a, b) => a.startMinute - b.startMinute);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i]!.startMinute < sorted[i - 1]!.endMinute) return 'overlap';
	}
	return null;
}

/** `YYYY-MM-DD`, a real calendar date. */
export function isBookingDateKey(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [, y, m, d] = match;
	const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
	return date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
}
