/**
 * Booking page: the reads and checks the host settings, the public routes and
 * the composer snippet share. Not a Convex function module; imported by the
 * siblings in `booking/`.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { throwInvalidInput } from '../_utils/errors';
import { getOptional } from '../lib/env';
import { BOOKING_LIMITS, bookingRangeProblem, isBookingDateKey } from '@owlat/shared/booking';
import type { BookingTimeRange, BookingWeeklyRange } from '@owlat/shared/booking';
import type { AvailabilityRules, BusyInterval } from './slots';

type ReadCtx = QueryCtx | MutationCtx;

const MINUTE_MS = 60_000;

/** Whether the runtime knows `timeZone` as an IANA zone. */
export function isKnownTimeZone(timeZone: string): boolean {
	if (!timeZone || timeZone.length > 64) return false;
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== '';
	} catch {
		return false;
	}
}

/** The web app's origin the booking links are built on. */
export function bookingSiteUrl(): string {
	return (getOptional('SITE_URL') || 'http://localhost:3000').replace(/\/+$/, '');
}

/** The public URL of a booking page, or of one meeting on it. */
export function bookingPageUrl(profileSlug: string, typeSlug?: string): string {
	const base = bookingSiteUrl();
	return typeSlug ? `${base}/book/${profileSlug}/${typeSlug}` : `${base}/book/${profileSlug}`;
}

/** A guest's cancel / reschedule page for a manage token. */
export function bookingManageUrl(token: string): string {
	return `${bookingSiteUrl()}/book/manage?token=${encodeURIComponent(token)}`;
}

/** The stored profile as the slot calculator reads it. */
export function rulesOf(profile: Doc<'bookingProfiles'>): AvailabilityRules {
	return {
		timeZone: profile.timeZone,
		weeklyHours: profile.weeklyHours,
		dateOverrides: profile.dateOverrides,
		minimumNoticeMinutes: profile.minimumNoticeMinutes,
		horizonDays: profile.horizonDays,
		bufferMinutes: profile.bufferMinutes,
	};
}

/**
 * Validate the availability half of a profile save. Throws `invalid_input`
 * with a field name the settings form can point at.
 */
export function assertAvailability(input: {
	timeZone: string;
	weeklyHours: readonly BookingWeeklyRange[];
	dateOverrides: readonly { date: string; ranges: readonly BookingTimeRange[] }[];
	minimumNoticeMinutes: number;
	horizonDays: number;
	bufferMinutes: number;
}): void {
	if (!isKnownTimeZone(input.timeZone)) throwInvalidInput('Unknown time zone');
	for (let weekday = 0; weekday < 7; weekday++) {
		const problem = bookingRangeProblem(
			input.weeklyHours.filter((range) => range.weekday === weekday)
		);
		if (problem) throwInvalidInput(`Weekly hours: ${problem}`, { field: 'weeklyHours', problem });
	}
	if (
		input.weeklyHours.some(
			(range) => !Number.isInteger(range.weekday) || range.weekday < 0 || range.weekday > 6
		)
	) {
		throwInvalidInput('Weekly hours: bounds', { field: 'weeklyHours', problem: 'bounds' });
	}
	if (input.dateOverrides.length > BOOKING_LIMITS.dateOverridesMax) {
		throwInvalidInput('Too many date overrides', { field: 'dateOverrides', problem: 'tooMany' });
	}
	const seen = new Set<string>();
	for (const override of input.dateOverrides) {
		if (!isBookingDateKey(override.date) || seen.has(override.date)) {
			throwInvalidInput('Date overrides: bad date', { field: 'dateOverrides', problem: 'date' });
		}
		seen.add(override.date);
		const problem = bookingRangeProblem(override.ranges);
		if (problem)
			throwInvalidInput(`Date overrides: ${problem}`, { field: 'dateOverrides', problem });
	}
	assertWholeNumber(
		input.minimumNoticeMinutes,
		0,
		BOOKING_LIMITS.noticeMaxMinutes,
		'minimumNoticeMinutes'
	);
	assertWholeNumber(
		input.horizonDays,
		BOOKING_LIMITS.horizonMinDays,
		BOOKING_LIMITS.horizonMaxDays,
		'horizonDays'
	);
	assertWholeNumber(input.bufferMinutes, 0, BOOKING_LIMITS.bufferMaxMinutes, 'bufferMinutes');
}

export function assertWholeNumber(value: number, min: number, max: number, field: string): void {
	if (!Number.isInteger(value) || value < min || value > max) {
		throwInvalidInput(`${field} must be a whole number from ${min} to ${max}`, { field });
	}
}

/**
 * Confirmed bookings of one host that could touch `[from, until)`: every
 * booking starting before `until` plus the buffer, and late enough that the
 * longest meeting plus the buffer could still reach `from`.
 */
export async function loadBusy(
	ctx: ReadCtx,
	args: {
		userId: string;
		from: number;
		until: number;
		bufferMinutes: number;
		exclude?: Id<'bookings'>;
	}
): Promise<BusyInterval[]> {
	const reach = (BOOKING_LIMITS.durationMaxMinutes + args.bufferMinutes) * MINUTE_MS;
	const rows = await ctx.db
		.query('bookings')
		.withIndex('by_user_and_start', (q) =>
			q
				.eq('userId', args.userId)
				.gte('startAt', args.from - reach)
				.lt('startAt', args.until + args.bufferMinutes * MINUTE_MS)
		)
		.take(2000); // bounded: one host's bookings in a window of at most a few months
	return rows
		.filter((row) => row.status === 'confirmed' && row._id !== args.exclude)
		.map((row) => ({ start: row.startAt, end: row.endAt }));
}

/** The host's display name on the page and in the mails. */
export function hostDisplayName(
	profile: Pick<Doc<'bookingProfiles'>, 'displayName'>,
	user: { name?: string | null; email?: string | null } | null
): string {
	return profile.displayName?.trim() || user?.name?.trim() || user?.email?.split('@')[0] || 'Owlat';
}

/** SHA-256 hex of a guest's manage token; only the digest is stored. */
export async function hashManageToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
