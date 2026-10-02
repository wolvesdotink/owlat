/**
 * The booking pages' calls to the public booking routes on the Convex site URL
 * (`/booking/page|book|manage|cancel|reschedule/...`, see the API's
 * `booking/publicHttp.ts`). No session: the page slug or the guest's manage
 * token in the path is all a call carries. Answers collapse to
 * `{ ok, data } | { ok: false, reason }` through the recipient pages' reader, so
 * a page branches on a machine-readable reason. Never throws.
 */
import {
	PUBLIC_TOKEN_REASONS,
	readPublicTokenBody,
	type PublicTokenResult,
} from './publicTokenClient';

export interface BookingHost {
	name: string;
	image: string | null;
	timeZone: string;
}

export interface PublicMeetingType {
	slug: string;
	title: string;
	durationMinutes: number;
	description: string | null;
	location: string | null;
	hasVideoLink: boolean;
}

export interface BookingPageData {
	host: BookingHost;
	meetingTypes: PublicMeetingType[];
}

export interface OpenTimes {
	slots: number[];
	earliest: number;
	latest: number;
}

export interface MeetingPageData extends OpenTimes {
	host: BookingHost;
	meetingType: PublicMeetingType;
}

export interface BookedMeeting {
	title: string;
	startAt: number;
	endAt: number;
	hostName: string;
}

export interface ManagedBooking {
	booking: {
		title: string;
		startAt: number;
		endAt: number;
		status: 'confirmed' | 'cancelled';
		guestName: string;
		location: string | null;
		hasVideoLink: boolean;
	};
	host: { name: string; timeZone: string };
	isChangeable: boolean;
	reschedule: OpenTimes | null;
}

export interface GuestDetails {
	type: string;
	start: number;
	name: string;
	email: string;
	note?: string;
	timeZone?: string;
	locale?: string;
	/** The honeypot. A person never fills it. */
	website?: string;
}

type Query = Record<string, string | number | undefined>;

async function bookingRequest<T>(
	route: 'page' | 'book' | 'manage' | 'cancel' | 'reschedule',
	segment: string,
	options: { query?: Query; body?: unknown } = {}
): Promise<PublicTokenResult<T>> {
	// The routes answer only to a page slug spelled as stored (lowercase), so
	// `/book/Ada` typed by hand still finds the page.
	const canonical = route === 'page' || route === 'book' ? segment.toLowerCase() : segment;
	const url = new URL(
		`${useRuntimeConfig().public.convexSiteUrl}/booking/${route}/${encodeURIComponent(canonical)}`
	);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
	}
	let response: Response;
	try {
		response =
			options.body === undefined && (route === 'page' || route === 'manage')
				? await fetch(url)
				: await fetch(url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(options.body ?? {}),
					});
	} catch {
		return { ok: false, reason: PUBLIC_TOKEN_REASONS.network };
	}
	const body: unknown = await response.json().catch(() => null);
	return readPublicTokenBody<T>(response.ok, response.status, body);
}

/** A host's page: their active meeting types. */
export function fetchBookingPage(slug: string) {
	return bookingRequest<BookingPageData>('page', slug);
}

/** One meeting on a host's page and its open times in `[from, until)`. */
export function fetchMeetingPage(
	slug: string,
	type: string,
	window: { from?: number; until?: number }
) {
	return bookingRequest<MeetingPageData>('page', slug, { query: { type, ...window } });
}

export function bookMeeting(slug: string, details: GuestDetails) {
	return bookingRequest<{ booking: BookedMeeting }>('book', slug, { body: details });
}

export function fetchManagedBooking(token: string, window: { from?: number; until?: number } = {}) {
	return bookingRequest<ManagedBooking>('manage', token, { query: window });
}

export function cancelManagedBooking(token: string) {
	return bookingRequest<{ cancelled: true }>('cancel', token, { body: {} });
}

export function rescheduleManagedBooking(token: string, start: number) {
	return bookingRequest<{ startAt: number; endAt: number }>('reschedule', token, {
		body: { start },
	});
}
