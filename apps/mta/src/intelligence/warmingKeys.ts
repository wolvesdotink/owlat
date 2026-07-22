import { createHash } from 'crypto';
import type { DurableEffectIdentity } from '../lib/effectCheckpoint.js';

const WARMING_PREFIX = 'mta:warming:';

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
