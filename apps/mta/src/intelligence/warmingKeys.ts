import { createHash } from 'crypto';
import type { DurableEffectIdentity } from '../lib/effectCheckpoint.js';
import type { DestinationProviderKey } from '../types.js';

const WARMING_PREFIX = 'mta:warming:';

/**
 * The UTC date every warming key is bucketed by, as `YYYY-MM-DD`.
 *
 * Lives beside the keys it feeds so the three call sites that used to inline
 * `new Date(...).toISOString().split('T')[0]!` cannot drift apart, and so a
 * caller that already holds a clock reading passes it in rather than re-reading
 * the clock (which is how a phase and its effects can straddle midnight).
 */
export function utcDateKey(nowMs: number = Date.now()): string {
	return new Date(nowMs).toISOString().split('T')[0]!;
}

export function warmingReservationsKey(ip: string, utcDate: string): string {
	return `${WARMING_PREFIX}{warming:${ip}}:reservations:${utcDate}`;
}

export function warmingStateKey(ip: string): string {
	return `${WARMING_PREFIX}{warming:${ip}}:state`;
}

export function warmingDailyStatsKey(ip: string, utcDate: string): string {
	return `${WARMING_PREFIX}{warming:${ip}}:daily:${utcDate}`;
}

export function warmingReservationReceiptKey(ip: string, messageId: string): string {
	return `${WARMING_PREFIX}{warming:${ip}}:reservation-receipt:${messageId}`;
}

export function warmingOutcomeReceiptKey(ip: string, identity: DurableEffectIdentity): string {
	const identityHash = createHash('sha256').update(identity).digest('hex');
	return `${WARMING_PREFIX}{warming:${ip}}:effect:${identityHash}`;
}

/**
 * Per-(IP x mailbox provider) keys.
 *
 * They extend the shipped scheme rather than replacing it: the same
 * `{warming:<ip>}` hash tag keeps every key for one IP in a single Redis slot
 * (so a Lua script may touch the per-IP and per-provider state together), and
 * the per-IP keys above are untouched, so existing state keeps working while
 * the provider dimension fills in.
 */
/**
 * Bulk-pool send counter for one IP and UTC day.
 *
 * Intraday pacing shapes the BULK pool only, so it needs a bulk-only
 * denominator: the shipped per-IP `sentToday` counts both pools, and feeding it
 * to a bulk ceiling would let transactional volume defer a small campaign.
 */
export function warmingBulkDailyKey(ip: string, utcDate: string): string {
	return `${WARMING_PREFIX}{warming:${ip}}:bulk-daily:${utcDate}`;
}

export function warmingProviderStateKey(ip: string, provider: DestinationProviderKey): string {
	return `${WARMING_PREFIX}{warming:${ip}}:provider:${provider}:state`;
}

export function warmingProviderDailyStatsKey(
	ip: string,
	provider: DestinationProviderKey,
	utcDate: string
): string {
	return `${WARMING_PREFIX}{warming:${ip}}:provider:${provider}:daily:${utcDate}`;
}

export function warmingProviderPressureKey(ip: string, provider: DestinationProviderKey): string {
	return `${WARMING_PREFIX}{warming:${ip}}:provider:${provider}:pressure`;
}

export function warmingProviderReceiptKey(
	ip: string,
	provider: DestinationProviderKey,
	identity: DurableEffectIdentity
): string {
	const identityHash = createHash('sha256').update(identity).digest('hex');
	return `${WARMING_PREFIX}{warming:${ip}}:provider:${provider}:effect:${identityHash}`;
}
