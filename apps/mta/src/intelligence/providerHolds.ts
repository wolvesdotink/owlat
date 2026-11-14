/**
 * Per-(IP x mailbox provider) holds the provider asked for out of band.
 *
 * Convex writes the set: today only Microsoft, from a fresh SNDS "red" reading
 * for a sending address. While an address is in its provider's set, the
 * adaptive throttle (`domainThrottle.ts`) caps that pair at the provider's
 * floor rate, the same rate a provider that keeps deferring us ends up at.
 * Every other address and every other provider keeps its rate.
 *
 * The set expires on its own. Convex rewrites it after every SNDS poll, so a
 * hold whose data stopped arriving lapses instead of throttling forever.
 */

import type Redis from 'ioredis';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

const HOLD_PREFIX = 'mta:provider-hold:';
/** Four SNDS poll intervals: one failed poll must not lift a standing hold. */
export const PROVIDER_HOLD_TTL_SECONDS = 24 * 60 * 60;

function holdKey(provider: DestinationProviderKey | string): string {
	return `${HOLD_PREFIX}${provider}`;
}

/** Replace the held addresses of one provider; an empty list lifts them all. */
export async function replaceProviderHolds(
	redis: Redis,
	provider: DestinationProviderKey,
	ips: readonly string[]
): Promise<void> {
	const key = holdKey(provider);
	const transaction = redis.multi().del(key);
	if (ips.length > 0) {
		transaction.sadd(key, ...ips).expire(key, PROVIDER_HOLD_TTL_SECONDS);
	}
	await transaction.exec();
}

/**
 * Whether `ip` is held for `provider`. A read that fails answers "not held":
 * the hold is a reduction on top of the adaptive rate, and a Redis error must
 * not turn it into a stop.
 */
export async function isProviderHeld(redis: Redis, ip: string, provider: string): Promise<boolean> {
	try {
		return (await redis.sismember(holdKey(provider), ip)) === 1;
	} catch {
		return false;
	}
}
