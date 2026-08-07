/**
 * The payloads a journal entry replays — the attempt snapshot and the reducer's
 * effect list — and their codec.
 *
 * Both are captured around the SMTP transaction and replayed verbatim
 * afterwards, so validation and the fill-in of fields added after an entry was
 * written belong together and apart from the journal's Redis protocol.
 */

import { isDestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { CtxWithProviderPressure } from '../dispatch/types.js';
import { isUtcDateKey, utcDateKey } from '../intelligence/warmingKeys.js';

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
	if (!isUtcDateKey(attempt['utcDate'])) {
		attempt['utcDate'] = utcDateKey(attemptedAtMs);
	}
}

/**
 * Warming effect kinds whose day is applied verbatim from the journal.
 *
 * Each feeds `utcDate` into a per-day key and into the per-provider Lua's day
 * comparison, so it is exactly the set that must never replay without one.
 */
const WARMING_EFFECT_KINDS = new Set(['warming_record', 'warming_provider_pressure']);

/**
 * Give a journalled effect the attempt's day when it carries none.
 *
 * `applyCompletedAttempt` applies `reduction.effects` straight from the entry,
 * so an effect written before the day was carried reaches Redis as an
 * `undefined` key suffix and an empty Lua ARGV — which names a
 * `:daily:undefined` bucket and sorts below every stored day, so the monotonic
 * per-provider counter takes neither its roll nor its increment branch and the
 * send is never counted at all. The attempt's day is what the cap gates
 * measured, so it is the day its own effects book into.
 */
export function normalizeReductionEffects(value: unknown, utcDate: string): void {
	if (!value || typeof value !== 'object') return;
	const effects = (value as Record<string, unknown>)['effects'];
	if (!Array.isArray(effects)) return;
	for (const effect of effects) {
		if (!effect || typeof effect !== 'object') continue;
		const record = effect as Record<string, unknown>;
		if (!WARMING_EFFECT_KINDS.has(String(record['kind']))) continue;
		// A stored day of the wrong shape is replaced, not preserved: the Lua's
		// ordering assumption makes an unparseable day worse than an absent one.
		if (!isUtcDateKey(record['utcDate'])) record['utcDate'] = utcDate;
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
	// Same tolerance for the attempt's warming day, added in the same spirit: a
	// legacy entry carries none and is normalized, never rejected. A PRESENT day
	// must be a real `YYYY-MM-DD` though — it is compared lexicographically
	// inside the per-provider Lua, so a value above every real day would pin the
	// rolling reset forward and stop that IP/provider counter for good.
	if (attempt['utcDate'] !== undefined && !isUtcDateKey(attempt['utcDate'])) {
		return false;
	}
	const destination = attempt['destination'];
	if (!destination || typeof destination !== 'object') return false;
	const route = destination as Record<string, unknown>;
	return (
		typeof route['recipientDomain'] === 'string' &&
		// The taxonomy's own guard (D8), not a third copy of the key list: a copy
		// here would reject a sixth destination provider's replays as corrupt.
		isDestinationProviderKey(route['providerKey']) &&
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
