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

import { createHash } from 'node:crypto';
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
import { isRecord } from '@owlat/shared/utils/guards';
import { checkDnsblNameDetailed, type DnsblLookupDeps, type DnsblStatus } from './dnsblLookup.js';

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
/** How long a DQS key's test result is reused; a revoked key is noticed within it. */
const KEY_TEST_TTL_SECONDS = 15 * 60;
/** Spamhaus's documented DBL test entry: every DBL zone lists it. */
const SPAMHAUS_DBL_TEST_DOMAIN = 'dbltest.com';
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
	/** The operator's Spamhaus DQS key, when one is configured. */
	dqsKey?: string;
	now: () => number;
}

type CachedVerdict = Pick<DomainBlocklistResult, 'status' | 'reason' | 'checkedAt'>;

const pendingLookups = new Map<string, Promise<CachedVerdict>>();

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

/**
 * The zone to ask, and the access it is asked through. Keyed verdicts are
 * cached per key (by a digest, never the key), so a replaced key starts over.
 */
function zoneFor(
	list: DomainBlocklistDefinition,
	dqsKey: string | undefined
): { zone: string; access: string } {
	return list.keyedZone && dqsKey
		? {
				zone: `${dqsKey}.${list.keyedZone}`,
				access: `keyed-${createHash('sha256').update(dqsKey).digest('hex').slice(0, 16)}`,
			}
		: { zone: list.zone, access: 'public' };
}

function parseCached(raw: string | null): CachedVerdict | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) return null;
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
	const { zone } = zoneFor(DOMAIN_BLOCKLISTS[id], deps.dqsKey);
	const result = await checkDnsblNameDetailed(`${domain}.${zone}`, { domain }, id, deps.lookup);
	if (result.answers.length > 0) return readDomainBlocklistAnswer(id, result.answers);
	if (result.status === 'clean') return { status: 'clean' };
	return { status: 'unknown', reason: result.reason ?? 'resolver_unreachable' };
}

/**
 * A cached verdict, or one shared lookup for every caller that misses the
 * cache at the same time, written to the cache before the next caller looks.
 */
async function cachedVerdict(
	redis: Redis,
	key: string,
	ttlSeconds: (status: DnsblStatus) => number,
	lookup: () => Promise<Pick<DomainBlocklistResult, 'status' | 'reason'>>,
	now: () => number
): Promise<CachedVerdict> {
	const cached = parseCached(await redis.get(key));
	if (cached) return cached;
	let pending = pendingLookups.get(key);
	if (!pending) {
		pending = limited(lookup)
			.then(async (verdict) => {
				const result = { ...verdict, checkedAt: now() };
				await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds(result.status));
				return result;
			})
			.finally(() => pendingLookups.delete(key));
		pendingLookups.set(key, pending);
	}
	return pending;
}

/**
 * Why the keyed Spamhaus zone cannot be trusted right now, or undefined when
 * it can. A wrong or expired DQS key answers NXDOMAIN for every name, which
 * would read as clean, so the zone is trusted only while Spamhaus's own DBL
 * test entry answers as listed through it. The test is cached briefly and
 * apart from the IP sweep's, whose last outcome can be a timeout that says
 * nothing about the key.
 */
async function keyedZoneProblem(
	redis: Redis,
	deps: DomainBlocklistDeps
): Promise<DnsblUnknownReason | undefined> {
	const probe = await cachedVerdict(
		redis,
		`${CACHE_PREFIX}dqs-test:${zoneFor(DOMAIN_BLOCKLISTS.spamhaus_dbl, deps.dqsKey).access}`,
		() => KEY_TEST_TTL_SECONDS,
		() => lookupOne(SPAMHAUS_DBL_TEST_DOMAIN, 'spamhaus_dbl', deps),
		deps.now
	);
	if (probe.status === 'listed') return undefined;
	return probe.status === 'clean' ? 'key_rejected' : (probe.reason ?? 'resolver_unreachable');
}

async function checkOne(
	redis: Redis,
	domain: string,
	id: DomainBlocklistId,
	deps: DomainBlocklistDeps,
	keyedProblem: DnsblUnknownReason | undefined
): Promise<DomainBlocklistResult> {
	const list = DOMAIN_BLOCKLISTS[id];
	// Before the cache: an answer read through a key that fails its test now
	// says nothing about the domain now.
	if (list.keyedZone && keyedProblem) {
		return { domain, list: id, status: 'unknown', reason: keyedProblem, checkedAt: deps.now() };
	}
	const key = `${CACHE_PREFIX}${id}:${zoneFor(list, deps.dqsKey).access}:${domain}`;
	const verdict = await cachedVerdict(
		redis,
		key,
		(status) => CACHE_TTL_SECONDS[status],
		() => lookupOne(domain, id, deps),
		deps.now
	);
	return { domain, list: id, ...verdict };
}

/** Every list's verdict for every domain, in domain then list order. */
export async function checkDomainBlocklists(
	redis: Redis,
	domains: readonly string[],
	deps: DomainBlocklistDeps
): Promise<DomainBlocklistResult[]> {
	const keyedProblem = deps.dqsKey ? await keyedZoneProblem(redis, deps) : undefined;
	return Promise.all(
		domains.flatMap((domain) =>
			DOMAIN_BLOCKLIST_IDS.map((id) => checkOne(redis, domain, id, deps, keyedProblem))
		)
	);
}
