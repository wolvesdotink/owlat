/**
 * Domain blocklist lookups for the Deliverability Center's `domain.blocklist`
 * check: one registered domain against Spamhaus DBL, SURBL and URIBL.
 *
 * The lookups go through the same transport, retry budget and three-state
 * reading as the IP sweep (`dnsblLookup.ts`), so they leave from this server's
 * own resolver (`DNSBL_RESOLVER`), and an answer that means "you may not query
 * from here" is `unknown`, never clean. What each zone's answers mean lives in
 * `@owlat/shared/dnsbl` (`readDomainBlocklistAnswer`).
 *
 * Every verdict is cached in Redis, and at most a few lookups are in flight
 * at once, so a sweep over many domains is spread out instead of arriving at
 * the lists as one burst; a free zone answers a burst with its refusal code.
 */

import type Redis from 'ioredis';
import {
	DOMAIN_BLOCKLIST_IDS,
	DOMAIN_BLOCKLISTS,
	isDnsblUnknownReason,
	readDomainBlocklistAnswer,
	type DnsblUnknownReason,
	type DomainBlocklistDefinition,
	type DomainBlocklistId,
} from '@owlat/shared/dnsbl';
import { checkDnsblNameDetailed, type DnsblLookupDeps, type DnsblStatus } from './dnsblLookup.js';
import type { SpamhausAccess } from './dnsblAccess.js';

const CACHE_PREFIX = 'mta:domain-blocklist:';
/**
 * How long a verdict is reused. A clean domain rarely changes within hours; a
 * listing is re-read sooner so a delisting shows up the same day; a refusal or
 * a resolver failure is retried soonest.
 */
const CACHE_TTL_SECONDS: Record<DnsblStatus, number> = {
	clean: 6 * 60 * 60,
	listed: 60 * 60,
	unknown: 15 * 60,
};
/** Lookups in flight at once, across every caller of this module. */
const MAX_CONCURRENT_LOOKUPS = 3;

export interface DomainBlocklistResult {
	domain: string;
	list: DomainBlocklistId;
	status: DnsblStatus;
	reason?: DnsblUnknownReason;
	checkedAt: number;
}

export interface DomainBlocklistDeps {
	lookup: DnsblLookupDeps;
	/** This sweep's Spamhaus access: the DQS key, or why it cannot be used. */
	spamhaus: SpamhausAccess;
	now: () => number;
}

const pendingLookups = new Map<
	string,
	Promise<Pick<DomainBlocklistResult, 'status' | 'reason' | 'checkedAt'>>
>();

let inFlight = 0;
const waiting: Array<() => void> = [];

/** Run `task` once a lookup slot is free; a finished task hands its slot on. */
async function limited<T>(task: () => Promise<T>): Promise<T> {
	if (inFlight >= MAX_CONCURRENT_LOOKUPS) {
		await new Promise<void>((resolve) => waiting.push(resolve));
	} else {
		inFlight += 1;
	}
	try {
		return await task();
	} finally {
		const next = waiting.shift();
		if (next) next();
		else inFlight -= 1;
	}
}

/** The zone to ask, and whether it is the keyed one (cached apart). */
function zoneFor(
	list: DomainBlocklistDefinition,
	spamhaus: SpamhausAccess
): { zone: string; access: 'public' | 'keyed' } {
	return list.keyedZone && spamhaus.dqsKey
		? { zone: `${spamhaus.dqsKey}.${list.keyedZone}`, access: 'keyed' }
		: { zone: list.zone, access: 'public' };
}

function parseCached(
	raw: string | null
): Pick<DomainBlocklistResult, 'status' | 'reason' | 'checkedAt'> | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Record<string, unknown>;
		const status = value['status'];
		const checkedAt = value['checkedAt'];
		if (
			(status !== 'listed' && status !== 'clean' && status !== 'unknown') ||
			typeof checkedAt !== 'number'
		) {
			return null;
		}
		const reason = value['reason'];
		return { status, checkedAt, ...(isDnsblUnknownReason(reason) ? { reason } : {}) };
	} catch {
		return null;
	}
}

async function lookupOne(
	domain: string,
	id: DomainBlocklistId,
	deps: DomainBlocklistDeps
): Promise<Pick<DomainBlocklistResult, 'status' | 'reason'>> {
	const { zone } = zoneFor(DOMAIN_BLOCKLISTS[id], deps.spamhaus);
	const result = await checkDnsblNameDetailed(`${domain}.${zone}`, { domain }, id, deps.lookup);
	if (result.answers.length > 0) return readDomainBlocklistAnswer(id, result.answers);
	if (result.status === 'clean') return { status: 'clean' };
	return { status: 'unknown', reason: result.reason ?? 'resolver_unreachable' };
}

async function checkOne(
	redis: Redis,
	domain: string,
	id: DomainBlocklistId,
	deps: DomainBlocklistDeps
): Promise<DomainBlocklistResult> {
	const list = DOMAIN_BLOCKLISTS[id];
	// Before the cache: a verdict read through a key that has since been
	// rejected says nothing about the domain now.
	if (list.keyedZone && deps.spamhaus.unavailable) {
		return {
			domain,
			list: id,
			status: 'unknown',
			reason: deps.spamhaus.unavailable,
			checkedAt: deps.now(),
		};
	}
	const key = `${CACHE_PREFIX}${id}:${zoneFor(list, deps.spamhaus).access}:${domain}`;
	const cached = parseCached(await redis.get(key));
	if (cached) return { domain, list: id, ...cached };
	// Checks that arrive together for one domain share one lookup.
	let pending = pendingLookups.get(key);
	if (!pending) {
		pending = limited(() => lookupOne(domain, id, deps))
			.then(async (verdict) => {
				const result = { ...verdict, checkedAt: deps.now() };
				await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS[result.status]);
				return result;
			})
			.finally(() => pendingLookups.delete(key));
		pendingLookups.set(key, pending);
	}
	return { domain, list: id, ...(await pending) };
}

/** Every list's verdict for every domain, in domain then list order. */
export async function checkDomainBlocklists(
	redis: Redis,
	domains: readonly string[],
	deps: DomainBlocklistDeps
): Promise<DomainBlocklistResult[]> {
	return Promise.all(
		domains.flatMap((domain) => DOMAIN_BLOCKLIST_IDS.map((id) => checkOne(redis, domain, id, deps)))
	);
}
