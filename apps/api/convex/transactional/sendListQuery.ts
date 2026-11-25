/**
 * The query string of `GET /api/v1/transactional`, read and checked, and the
 * cursor the route hands out.
 *
 * The window defaults to the days before now, and "now" moves between two
 * page reads. The cursor therefore carries the window the first page
 * resolved, so every later page reads the same index range the paginator's
 * own cursor was issued for. It also carries the filters it was issued for: a
 * cursor sent with other filters would continue a range it does not belong
 * to, so it is refused instead.
 */

import {
	SEND_LIST_MAX_WINDOW_DAYS,
	TRANSACTIONAL_SEND_STATUSES,
	type TransactionalSendStatusValue,
} from '@owlat/public-contract';
import { readListQuery } from '@owlat/public-contract/schemas';
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from '../lib/bytes';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = SEND_LIST_MAX_WINDOW_DAYS * DAY_MS;

export interface SendListQuery {
	email: string | null;
	status: TransactionalSendStatusValue | null;
	since: number;
	until: number;
	limit: number;
	/** The paginator's cursor inside the route's cursor, or null for the first page. */
	cursor: string | null;
	/** What a cursor issued for this request must match. */
	filterKey: string;
}

type Refusal = { ok: false; message: string; field?: string };

interface CursorPayload {
	filterKey: string;
	since: number;
	until: number;
	cursor: string;
}

/** The route's cursor for the page after one read with `query`. */
export function encodeSendListCursor(query: SendListQuery, next: string): string {
	const payload: CursorPayload = {
		filterKey: query.filterKey,
		since: query.since,
		until: query.until,
		cursor: next,
	};
	return bytesToBase64Url(utf8Bytes(JSON.stringify(payload)));
}

function decodeCursor(raw: string): CursorPayload | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw)));
		if (!value || typeof value !== 'object') return null;
		const { filterKey, since, until, cursor } = value as Record<string, unknown>;
		if (typeof filterKey !== 'string' || typeof cursor !== 'string') return null;
		if (typeof since !== 'number' || typeof until !== 'number') return null;
		return { filterKey, since, until, cursor };
	} catch {
		return null;
	}
}

/**
 * Whether a timestamp's written date is one the calendar has. `Date.parse`
 * rolls a day past the month's end into the next month (February 30 reads as
 * March 2), so the written day is checked against the month's length; the
 * offset does not matter for that.
 */
function isCalendarDate(raw: string): boolean {
	const written = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
	if (!written) return true;
	const [year, month, day] = written.slice(1).map(Number) as [number, number, number];
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function readTimestamp(params: URLSearchParams, name: string): number | null | Refusal {
	const raw = params.get(name);
	if (!raw) return null;
	const at = Date.parse(raw);
	if (Number.isNaN(at) || !isCalendarDate(raw)) {
		return { ok: false, message: `${name} must be an ISO 8601 timestamp`, field: name };
	}
	return at;
}

const isRefusal = (value: unknown): value is Refusal =>
	typeof value === 'object' && value !== null && 'ok' in value;

/** Read the list request's query at `now`, or the refusal to answer with. */
export function readSendListQuery(
	params: URLSearchParams,
	now: number
): { ok: true; value: SendListQuery } | Refusal {
	const page = readListQuery(params);
	if (!page.ok) return page;
	if (page.value.search !== undefined) {
		return {
			ok: false,
			message: 'Sends cannot be searched; filter by email or status',
			field: 'search',
		};
	}

	// A filter that is present but empty is refused, not dropped: an integration
	// passing an empty input must not get every recipient's sends.
	const rawEmail = params.get('email');
	const email = rawEmail === null ? null : normalizeEmail(rawEmail);
	if (email !== null && !isValidEmail(email)) {
		return { ok: false, message: 'Invalid email format', field: 'email' };
	}
	const rawStatus = params.get('status');
	const status = TRANSACTIONAL_SEND_STATUSES.find((value) => value === rawStatus) ?? null;
	if (rawStatus !== null && status === null) {
		return {
			ok: false,
			message: `status must be one of ${TRANSACTIONAL_SEND_STATUSES.join(', ')}`,
			field: 'status',
		};
	}
	const since = readTimestamp(params, 'since');
	if (isRefusal(since)) return since;
	const until = readTimestamp(params, 'until');
	if (isRefusal(until)) return until;
	const filterKey = JSON.stringify([email, status, since, until]);

	if (page.value.cursor) {
		const cursor = decodeCursor(page.value.cursor);
		const isWindowSound =
			cursor !== null &&
			cursor.since <= cursor.until &&
			cursor.until - cursor.since <= MAX_WINDOW_MS;
		if (!cursor || !isWindowSound) return { ok: false, message: 'Invalid cursor', field: 'cursor' };
		if (cursor.filterKey !== filterKey) {
			return {
				ok: false,
				message: 'This cursor belongs to a request with other filters; start again without it',
				field: 'cursor',
			};
		}
		return {
			ok: true,
			value: {
				email,
				status,
				since: cursor.since,
				until: cursor.until,
				limit: page.value.limit,
				cursor: cursor.cursor,
				filterKey,
			},
		};
	}

	const end = until ?? now;
	const start = since ?? end - MAX_WINDOW_MS;
	if (start > end) return { ok: false, message: 'since must not be after until', field: 'since' };
	if (end - start > MAX_WINDOW_MS) {
		return {
			ok: false,
			message: `The window from since to until can be at most ${SEND_LIST_MAX_WINDOW_DAYS} days`,
			field: 'since',
		};
	}
	return {
		ok: true,
		value: {
			email,
			status,
			since: start,
			until: end,
			limit: page.value.limit,
			cursor: null,
			filterKey,
		},
	};
}
