/**
 * Booking page — the public HTTP routes the `/book/**` pages call. No session:
 * each route is a Public token endpoint (`lib/publicTokenEndpoint.ts`), which
 * owns CORS, the method gate, the per-IP rate limit and the body bound.
 *
 *   GET  /booking/page/<slug>[?type=&from=&until=]  the page, or one meeting's open times
 *   POST /booking/book/<slug>                       book a time (JSON body)
 *   GET  /booking/manage/<token>[?from=&until=]     a guest's booking and times to move it to
 *   POST /booking/cancel/<token>                    the guest cancels
 *   POST /booking/reschedule/<token>                the guest moves it (JSON `{ start }`)
 *
 * `<token>` on the manage routes is the guest's manage token from their mail;
 * it is hashed here and only the digest is looked up. A booking request with
 * the honeypot field filled answers like a success and books nothing.
 *
 * Every route keys its limit on `<ip>:<page slug or manage token>`, like the
 * forms endpoint: while `RATE_LIMIT_TRUSTED_PROXY` is unset (the default) every
 * caller shares the `'unknown'` IP, and an IP-only key would let one visitor
 * close every member's page. The segment must be spelled as it is stored
 * (a lowercase slug, a manage token, no percent escapes); any other spelling
 * answers "not found", so it cannot stand in for the page with a bucket of its
 * own. What one page can take in total is held by the per-host limit inside
 * `reserve` / `rescheduleByToken`.
 */

import type { HttpRouter } from 'convex/server';
import { internal } from '../_generated/api';
import { publicTokenEndpoint, type ResultAction } from '../lib/publicTokenEndpoint';
import { randomToken } from '../lib/randomToken';
import { BOOKING_LIMITS, isValidBookingSlug } from '@owlat/shared/booking';
import { hashManageToken } from './model';

const NOT_FOUND: ResultAction = {
	ok: false,
	reason: 'not_found',
	message: 'Booking page not found',
	status: 404,
};

/** A manage token as `randomToken(40, 'bk_')` mints it. */
const MANAGE_TOKEN_RE = /^bk_[A-Za-z0-9]{40}$/;

/**
 * Whether the path's last segment is `token` exactly as sent: no percent
 * escapes and, for a page slug, no capitals. The rate-limit key is the raw
 * segment, so a spelling that still resolved (`ADA`, `%61da`) would open a
 * fresh bucket per variant.
 */
function isCanonicalSegment(
	request: Request,
	token: string,
	kind: 'slug' | 'manageToken'
): boolean {
	const segments = new URL(request.url).pathname.split('/').filter(Boolean);
	if (segments[segments.length - 1] !== token) return false;
	return kind === 'slug' ? isValidBookingSlug(token) : MANAGE_TOKEN_RE.test(token);
}

/** A finite number query parameter, or undefined. */
function numberParam(request: Request, name: string): number | undefined {
	const raw = new URL(request.url).searchParams.get(name);
	if (raw === null || raw === '') return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function stringField(body: Record<string, unknown>, name: string, max: number): string | undefined {
	const value = body[name];
	return typeof value === 'string' && value.length <= max ? value : undefined;
}

/** Map an internal refusal to its HTTP status. */
function refusal(reason: string): ResultAction {
	const status =
		reason === 'not_found'
			? 404
			: reason === 'slot_taken'
				? 409
				: reason === 'rate_limited'
					? 429
					: reason === 'invalid_guest'
						? 400
						: 422;
	return { ok: false, reason, status };
}

const getBookingPage = publicTokenEndpoint(
	{
		path: '/booking/page/:token',
		method: 'GET',
		rateLimit: 'bookingPage',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token, request }) => {
		const type = new URL(request.url).searchParams.get('type') ?? undefined;
		if (
			!isCanonicalSegment(request, token, 'slug') ||
			(type?.length ?? 0) > BOOKING_LIMITS.slugMaxLength
		) {
			return NOT_FOUND;
		}
		const page = await ctx.runQuery(internal.booking.public.getPage, {
			slug: token,
			typeSlug: type || undefined,
			from: numberParam(request, 'from'),
			until: numberParam(request, 'until'),
		});
		return page ? { ok: true, data: page } : NOT_FOUND;
	}
);

const createBooking = publicTokenEndpoint(
	{
		path: '/booking/book/:token',
		method: 'POST',
		rateLimit: 'bookingCreate',
		rateLimitKeyMode: 'ip+token',
		cors: 'POST, OPTIONS',
		body: 'json',
		resultMode: 'action',
	},
	async (ctx, { token, body, request }) => {
		if (!isCanonicalSegment(request, token, 'slug')) return NOT_FOUND;
		const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
		const start = fields['start'];
		const typeSlug = stringField(fields, 'type', BOOKING_LIMITS.slugMaxLength);
		const guestName = stringField(fields, 'name', BOOKING_LIMITS.guestNameMaxLength);
		const guestEmail = stringField(fields, 'email', 254);
		const guestNote = stringField(fields, 'note', BOOKING_LIMITS.guestNoteMaxLength);
		if (
			typeof start !== 'number' ||
			!Number.isFinite(start) ||
			!typeSlug ||
			!guestName ||
			!guestEmail ||
			(fields['note'] !== undefined && guestNote === undefined)
		) {
			return refusal('invalid_guest');
		}
		// Honeypot: a person never sees this field, a form-filling bot fills it.
		// Answer like a success so the bot learns nothing, and book nothing.
		if (typeof fields['website'] === 'string' && fields['website'].trim() !== '') {
			return {
				ok: true,
				data: { booking: { title: '', startAt: start, endAt: start, hostName: '' } },
			};
		}
		const result = await ctx.runMutation<
			| { ok: true; booking: { title: string; startAt: number; endAt: number; hostName: string } }
			| { ok: false; reason: string }
		>(internal.booking.public.reserve, {
			slug: token,
			typeSlug,
			start,
			guestName,
			guestEmail,
			guestNote,
			guestTimeZone: stringField(fields, 'timeZone', 64),
			guestLocale: stringField(fields, 'locale', 16),
			manageToken: randomToken(40, 'bk_'),
		});
		return result.ok ? { ok: true, data: { booking: result.booking } } : refusal(result.reason);
	}
);

const getManagedBooking = publicTokenEndpoint(
	{
		path: '/booking/manage/:token',
		method: 'GET',
		rateLimit: 'bookingPage',
		rateLimitKeyMode: 'ip+token',
		cors: 'GET, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token, request }) => {
		if (!isCanonicalSegment(request, token, 'manageToken')) return NOT_FOUND;
		const managed = await ctx.runQuery(internal.booking.public.getManaged, {
			manageTokenHash: await hashManageToken(token),
			from: numberParam(request, 'from'),
			until: numberParam(request, 'until'),
		});
		return managed ? { ok: true, data: managed } : NOT_FOUND;
	}
);

const cancelManagedBooking = publicTokenEndpoint(
	{
		path: '/booking/cancel/:token',
		method: 'POST',
		rateLimit: 'bookingPage',
		rateLimitKeyMode: 'ip+token',
		cors: 'POST, OPTIONS',
		resultMode: 'action',
	},
	async (ctx, { token, request }) => {
		if (!isCanonicalSegment(request, token, 'manageToken')) return NOT_FOUND;
		const result = await ctx.runMutation<{ ok: true } | { ok: false; reason: string }>(
			internal.booking.public.cancelByToken,
			{ manageTokenHash: await hashManageToken(token) }
		);
		return result.ok ? { ok: true, data: { cancelled: true } } : refusal(result.reason);
	}
);

const rescheduleManagedBooking = publicTokenEndpoint(
	{
		path: '/booking/reschedule/:token',
		method: 'POST',
		rateLimit: 'bookingCreate',
		rateLimitKeyMode: 'ip+token',
		cors: 'POST, OPTIONS',
		body: 'json',
		resultMode: 'action',
	},
	async (ctx, { token, body, request }) => {
		if (!isCanonicalSegment(request, token, 'manageToken')) return NOT_FOUND;
		const start = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {})[
			'start'
		];
		if (typeof start !== 'number' || !Number.isFinite(start)) return refusal('invalid_guest');
		const result = await ctx.runMutation<
			{ ok: true; startAt: number; endAt: number } | { ok: false; reason: string }
		>(internal.booking.public.rescheduleByToken, {
			manageTokenHash: await hashManageToken(token),
			start,
			nextManageToken: randomToken(40, 'bk_'),
		});
		return result.ok
			? { ok: true, data: { startAt: result.startAt, endAt: result.endAt } }
			: refusal(result.reason);
	}
);

/**
 * Register the routes (and their CORS preflights) on the deployment router.
 * The new manage token from a reschedule is not returned: it goes to the
 * guest's mail, like the first one.
 */
export function registerBookingRoutes(http: HttpRouter): void {
	const routes = [
		['/booking/page/', 'GET', getBookingPage],
		['/booking/book/', 'POST', createBooking],
		['/booking/manage/', 'GET', getManagedBooking],
		['/booking/cancel/', 'POST', cancelManagedBooking],
		['/booking/reschedule/', 'POST', rescheduleManagedBooking],
	] as const;
	for (const [pathPrefix, method, handler] of routes) {
		http.route({ pathPrefix, method, handler });
		http.route({ pathPrefix, method: 'OPTIONS', handler });
	}
}
