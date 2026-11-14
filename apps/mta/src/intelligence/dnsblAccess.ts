/**
 * How the MTA reaches Spamhaus: the public mirror, or the Data Query Service
 * with an operator's key.
 *
 * Spamhaus only answers its public mirror for queriers it can attribute. A
 * shared resolver, or a hosting range with generic reverse DNS (Hetzner, OVH,
 * DigitalOcean and others), gets the reserved refusal answer instead — and an
 * unmeasured Spamhaus result holds a never-checked address out of the pool.
 * A free DQS key lifts that: the keyed zone answers from anywhere.
 *
 * The key is set from the admin UI through Convex, which passes it straight
 * through and never stores it. Here it is sealed at rest with MTA_SECRET, like
 * DKIM private keys.
 *
 * A DQS key has one trap this module exists to close: a query under an unknown
 * key does not come back as an error Spamhaus names. Depending on the resolver
 * it is NXDOMAIN — exactly what "not listed" looks like — or a bare SERVFAIL.
 * So a keyed zone is only trusted after its permanent test entry (127.0.0.2,
 * always listed) answers as listed — at save time, and at the start of every
 * sweep, so a key that later expires reads as `unknown`, never as a pool full
 * of clean addresses.
 */

import type Redis from 'ioredis';
import {
	DNSBL_LISTS,
	dnsblZoneHost,
	isDnsblUnknownReason,
	isSpamhausDqsKey,
	type DnsblUnknownReason,
} from '@owlat/shared/dnsbl';
import type { MtaDnsblAccess } from '@owlat/mta-protocol/dnsblAccess';
import { getMtaSecretBox } from '../lib/secretBox.js';
import { logger } from '../monitoring/logger.js';
import { checkDnsblDetailed, lookupDnsblZone, type DnsblLookupDeps } from './dnsblLookup.js';
import type { DnsblResolverPath } from './dnsblResolver.js';

const DQS_KEY_REDIS_KEY = 'mta:dnsbl:spamhaus-dqs-key';
const ACCESS_STATE_REDIS_KEY = 'mta:dnsbl:spamhaus-access';
/** Spamhaus's permanent test entry: every zone lists it, so a keyed zone must. */
const SPAMHAUS_TEST_ADDRESS = '127.0.0.2';

/** What a sweep needs to know before it queries Spamhaus. */
export interface SpamhausAccess {
	/** The verified-this-sweep DQS key, when one is configured. */
	dqsKey?: string;
	/**
	 * Set when the configured key failed its test query: every Spamhaus result
	 * this sweep is `unknown` for this reason, and no address is queried.
	 */
	unavailable?: DnsblUnknownReason;
}

/** The configured DQS key, or undefined. An unreadable value reads as absent. */
export async function readSpamhausDqsKey(redis: Redis): Promise<string | undefined> {
	const stored = await redis.get(DQS_KEY_REDIS_KEY);
	if (!stored) return undefined;
	try {
		const key = getMtaSecretBox().open(stored);
		return isSpamhausDqsKey(key) ? key : undefined;
	} catch {
		// Sealed under a different MTA_SECRET (a restored backup): unusable, so the
		// sweep falls back to the public mirror rather than failing outright.
		logger.warn({ operation: 'dnsbl_dqs_key' }, 'Stored Spamhaus DQS key cannot be opened');
		return undefined;
	}
}

export async function storeSpamhausDqsKey(redis: Redis, key: string | null): Promise<void> {
	if (key === null) {
		await redis.del(DQS_KEY_REDIS_KEY);
		return;
	}
	await redis.set(DQS_KEY_REDIS_KEY, getMtaSecretBox().seal(key));
}

/**
 * Query the keyed zone's test entry. `undefined` means the zone answers as a
 * blocklist should; otherwise the reason it cannot be trusted this sweep.
 *
 * A SERVFAIL is ambiguous on its own — an unknown key, or no route to Spamhaus
 * at all — so it is settled with one control query to the PUBLIC zone through
 * the same resolver. If that gets any answer, even the refusal code, the path
 * to Spamhaus works and it was the key that failed.
 *
 * Only a SERVFAIL gets that treatment. A timeout or any other transport error
 * says nothing about the key: the keyed zone can time out while the public one
 * answers from cache, and reading that as `key_rejected` would refuse a valid
 * key at save time and show "Key rejected" for a slow network.
 */
export async function probeSpamhausZone(
	zone: string,
	deps: DnsblLookupDeps
): Promise<DnsblUnknownReason | undefined> {
	const result = await checkDnsblDetailed(SPAMHAUS_TEST_ADDRESS, 'spamhaus', zone, deps);
	if (result.status === 'listed') return undefined;
	if (result.status === 'clean') return 'key_rejected';
	if (result.reason !== 'resolver_unreachable') return result.reason ?? 'resolver_unreachable';
	if (result.errorCode !== 'ESERVFAIL') return 'resolver_unreachable';
	const control = await lookupDnsblZone(
		SPAMHAUS_TEST_ADDRESS,
		'spamhaus',
		DNSBL_LISTS.spamhaus.zone,
		{ ...deps, quiet: true }
	);
	return control.reason === 'resolver_unreachable' ? 'resolver_unreachable' : 'key_rejected';
}

/** Resolve this sweep's Spamhaus access. Never throws on a lookup failure. */
export async function prepareSpamhausAccess(
	redis: Redis,
	deps: DnsblLookupDeps
): Promise<SpamhausAccess> {
	const dqsKey = await readSpamhausDqsKey(redis);
	if (!dqsKey) return {};
	const zone = dnsblZoneHost(DNSBL_LISTS.spamhaus, dqsKey);
	const unavailable = zone ? await probeSpamhausZone(zone, deps) : 'key_rejected';
	return unavailable ? { dqsKey, unavailable } : { dqsKey };
}

/** Persist the outcome of one sweep's Spamhaus lookups for the admin card. */
export async function recordSpamhausAccess(
	redis: Redis,
	outcome: { reason?: DnsblUnknownReason; path: DnsblResolverPath; checkedAt: number }
): Promise<void> {
	await redis.hset(ACCESS_STATE_REDIS_KEY, {
		status: outcome.reason ? 'unknown' : 'ok',
		reason: outcome.reason ?? '',
		path: outcome.path,
		checkedAt: String(outcome.checkedAt),
	});
}

/** Forget the last sweep's outcome, so the card never pairs a new key with an old result. */
export async function resetSpamhausAccess(redis: Redis): Promise<void> {
	await redis.del(ACCESS_STATE_REDIS_KEY);
}

/** A key is shown by its last four characters only. */
function keyHint(key: string): string {
	return key.slice(-4);
}

/** The admin card's view of blocklist access. */
export async function readSpamhausAccess(
	redis: Redis,
	configured: DnsblResolverPath
): Promise<MtaDnsblAccess> {
	const [dqsKey, state] = await Promise.all([
		readSpamhausDqsKey(redis),
		redis.hgetall(ACCESS_STATE_REDIS_KEY),
	]);
	const checkedAt = Number(state['checkedAt']);
	const hasCheck = Number.isFinite(checkedAt) && checkedAt > 0;
	const reason = state['reason'];
	const lastPath = state['path'];
	return {
		resolver: {
			configured,
			...(lastPath === 'bundled' || lastPath === 'system' ? { lastPath } : {}),
		},
		spamhaus: {
			access: dqsKey ? 'dqs' : 'public',
			...(dqsKey ? { keyHint: keyHint(dqsKey) } : {}),
			status: !hasCheck ? 'pending' : state['status'] === 'ok' ? 'ok' : 'unknown',
			...(hasCheck && isDnsblUnknownReason(reason) ? { reason } : {}),
			...(hasCheck ? { checkedAt } : {}),
		},
	};
}
