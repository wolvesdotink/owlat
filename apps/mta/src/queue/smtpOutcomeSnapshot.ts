/**
 * The attempt snapshot a journal entry carries, and its codec.
 *
 * The snapshot is the reducer's immutable input, captured before the SMTP
 * transaction and replayed verbatim afterwards, so validation and the
 * fill-in of fields added after an entry was written belong together and
 * apart from the journal's Redis protocol.
 */

import type { CtxWithProviderPressure } from '../dispatch/types.js';
import { utcDateKey } from '../intelligence/warmingKeys.js';

export type SmtpAttemptSnapshot = Omit<CtxWithProviderPressure, 'job'>;

/** Fill in fields added after an entry was written, so a replay never sees a hole. */
export function normalizeAttemptSnapshot(value: unknown, attemptedAtMs: number): void {
	if (!value || typeof value !== 'object') return;
	const attempt = value as Record<string, unknown>;
	if (typeof attempt['providerVolumePressure'] !== 'number') {
		attempt['providerVolumePressure'] = 0;
	}
	// Entries written before the warming day was pinned to the attempt. The
	// journal's own reading for this attempt is the closest available stand-in
	// for the day the cap gates measured — and unlike the current wall clock it
	// is stable across replays, which is the whole point of carrying it.
	if (typeof attempt['utcDate'] !== 'string') {
		attempt['utcDate'] = utcDateKey(attemptedAtMs);
	}
}

export function isAttemptSnapshot(value: unknown): value is SmtpAttemptSnapshot {
	if (!value || typeof value !== 'object') return false;
	const attempt = value as Record<string, unknown>;
	if (
		typeof attempt['domain'] !== 'string' ||
		(attempt['fromDomain'] !== undefined && typeof attempt['fromDomain'] !== 'string') ||
		(attempt['pool'] !== 'transactional' && attempt['pool'] !== 'campaign') ||
		(attempt['dedicatedIp'] !== undefined && typeof attempt['dedicatedIp'] !== 'string') ||
		typeof attempt['ip'] !== 'string' ||
		typeof attempt['eligibilityGeneration'] !== 'number' ||
		!Number.isSafeInteger(attempt['eligibilityGeneration'])
	) {
		return false;
	}
	// Entries persisted before the per-provider pressure dimension carry no
	// counter. Tolerated rather than rejected — a legacy in-flight entry must
	// still replay — and normalized to zero by `normalizeAttemptSnapshot`.
	if (
		attempt['providerVolumePressure'] !== undefined &&
		typeof attempt['providerVolumePressure'] !== 'number'
	) {
		return false;
	}
	// Same tolerance for the attempt's warming day, added in the same spirit:
	// a legacy entry carries none and is normalized, never rejected.
	if (attempt['utcDate'] !== undefined && typeof attempt['utcDate'] !== 'string') {
		return false;
	}
	const destination = attempt['destination'];
	if (!destination || typeof destination !== 'object') return false;
	const route = destination as Record<string, unknown>;
	return (
		typeof route['recipientDomain'] === 'string' &&
		['gmail', 'microsoft', 'yahoo', 'apple', 'other'].includes(String(route['providerKey'])) &&
		typeof route['throttleKey'] === 'string' &&
		typeof route['daneDiscoveryAuthenticated'] === 'boolean' &&
		isMxSnapshot(route['mx']) &&
		(route['daneDestinations'] === undefined || Array.isArray(route['daneDestinations']))
	);
}

function isMxSnapshot(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const mx = value as Record<string, unknown>;
	if (mx['status'] === 'null-mx') return true;
	if (mx['status'] === 'domain-not-found' || mx['status'] === 'temporary-failure') {
		return typeof mx['reason'] === 'string';
	}
	return (
		mx['status'] === 'deliverable' &&
		(mx['source'] === 'mx' || mx['source'] === 'implicit') &&
		Array.isArray(mx['hosts']) &&
		mx['hosts'].length > 0 &&
		mx['hosts'].length <= 50 &&
		mx['hosts'].every(
			(host) =>
				!!host &&
				typeof host === 'object' &&
				typeof (host as Record<string, unknown>)['exchange'] === 'string' &&
				typeof (host as Record<string, unknown>)['priority'] === 'number' &&
				Number.isSafeInteger((host as Record<string, unknown>)['priority'])
		)
	);
}
