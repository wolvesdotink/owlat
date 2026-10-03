/**
 * The booking pages' refusal reasons (from `booking/publicHttp.ts`, plus the
 * client's own transport reasons) as i18n keys. A page shows the key; the
 * server's English message is never shown to a guest.
 */
import { PUBLIC_TOKEN_REASONS } from '~/lib/publicTokenClient';

const KEYS: Readonly<Record<string, string>> = {
	not_found: 'booking.errors.notFound',
	slot_taken: 'booking.errors.slotTaken',
	too_many_bookings: 'booking.errors.tooMany',
	invalid_guest: 'booking.errors.invalidGuest',
	rate_limited: 'booking.errors.rateLimited',
	already_started: 'booking.errors.alreadyStarted',
	not_changeable: 'booking.errors.notChangeable',
	missing_token: 'booking.errors.missingToken',
	[PUBLIC_TOKEN_REASONS.network]: 'booking.errors.unreachable',
	[PUBLIC_TOKEN_REASONS.badResponse]: 'booking.errors.unreachable',
};

/** The i18n key for a refusal, or `fallback` for one this table does not name. */
export function bookingErrorKey(reason: string, fallback: string): string {
	return KEYS[reason] ?? fallback;
}

/** Whether the request never got an answer (as opposed to a "no"). */
export function isUnreachableReason(reason: string): boolean {
	return reason === PUBLIC_TOKEN_REASONS.network || reason === PUBLIC_TOKEN_REASONS.badResponse;
}
