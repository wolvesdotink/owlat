/**
 * Continuous Forward-Confirmed Reverse DNS readiness.
 *
 * Every configured sending IP is observed at boot and hourly. The full
 * checklist is persisted in Redis, while hard failures feed the IP pool's
 * composed eligibility gate. Generic provider PTRs remain deliverable but warn.
 */

import { resolve4, reverse } from 'dns/promises';
import {
	normalizeDnsName,
	verifyFcrdnsIdentity,
	type FcrdnsDnsDeps,
	type FcrdnsFailureReason,
	type FcrdnsReadiness,
} from '@owlat/shared/fcrdns';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import { logger } from '../monitoring/logger.js';
import { getIpPoolBlockReasons, setIpPoolBlock } from './ipPool.js';

const FCRDNS_PREFIX = 'mta:fcrdns:';

export type { FcrdnsFailureReason, FcrdnsReadiness } from '@owlat/shared/fcrdns';

export interface FcrdnsResult extends FcrdnsReadiness {
	/** Backwards-compatible convenience for send-readiness callers. */
	ok: boolean;
	/** Backwards-compatible list form; runtime config has one EHLO per bind IP. */
	expectedNames: string[];
}

export interface FcrdnsDeps extends FcrdnsDnsDeps {
	now?: () => number;
}

const DEFAULT_DEPS: FcrdnsDeps = { reverse, resolve4 };

type FcrdnsConfig = Pick<MtaConfig, 'ipPools' | 'ehloHostname' | 'ehloHostnames'> &
	Partial<Pick<MtaConfig, 'genericPtrSuffixes' | 'allowUnverifiedFcrdns'>>;

function failedResult(
	ip: string,
	ehlo: string,
	ptrNames: string[],
	reason: FcrdnsFailureReason,
	checkedAt: number,
	checklist: FcrdnsReadiness['checklist']
): FcrdnsResult {
	return {
		ip,
		ehlo,
		ptrNames,
		checklist,
		verdict: reason === 'lookup-error' ? 'error' : 'fail',
		genericPtr: false,
		reason,
		checkedAt,
		overridden: false,
		ok: false,
		expectedNames: [ehlo],
	};
}

/** Verify one IPv4 sending identity from live DNS observations. */
export async function verifyFcrdns(
	ip: string,
	expectedNames: string[],
	deps: FcrdnsDeps = DEFAULT_DEPS,
	genericPtrSuffixes: readonly string[] = []
): Promise<FcrdnsResult> {
	const expected = expectedNames.map(normalizeDnsName).filter(Boolean);
	const ehlo = expected[0] ?? '';
	const checkedAt = deps.now?.() ?? Date.now();
	const verification = await verifyFcrdnsIdentity(ip, ehlo, deps, genericPtrSuffixes);
	return {
		...verification,
		checkedAt,
		overridden: false,
		ok: verification.verdict === 'pass' || verification.verdict === 'warn',
		expectedNames: expected,
	};
}

function readinessHash(
	result: FcrdnsResult,
	wouldBlockWithoutOverride: boolean
): Record<string, string> {
	return {
		ip: result.ip,
		ehlo: result.ehlo,
		ptrNames: JSON.stringify(result.ptrNames),
		ptrExists: String(result.checklist.ptrExists),
		ptrIsFqdn: String(result.checklist.ptrIsFqdn),
		forwardConfirmed: String(result.checklist.forwardConfirmed),
		ehloMatches: String(result.checklist.ehloMatches),
		verdict: result.verdict,
		genericPtr: String(result.genericPtr),
		reason: result.reason ?? '',
		checkedAt: String(result.checkedAt),
		overridden: String(result.overridden),
		wouldBlockWithoutOverride: String(wouldBlockWithoutOverride),
	};
}

export async function getFcrdnsReadiness(
	redis: Redis,
	ip: string
): Promise<FcrdnsReadiness | null> {
	const data = await redis.hgetall(`${FCRDNS_PREFIX}${ip}`);
	if (!data['checkedAt']) return null;
	let ptrNames: string[] = [];
	try {
		const parsed = JSON.parse(data['ptrNames'] ?? '[]');
		if (Array.isArray(parsed))
			ptrNames = parsed.filter((name): name is string => typeof name === 'string');
	} catch {
		// A malformed legacy/cache value is observation data, not authority. Keep
		// the verdict readable and expose no invented PTR name.
	}
	const reason = data['reason'];
	return {
		ip,
		ehlo: data['ehlo'] ?? '',
		ptrNames,
		checklist: {
			ptrExists: data['ptrExists'] === 'true',
			ptrIsFqdn: data['ptrIsFqdn'] === 'true',
			forwardConfirmed: data['forwardConfirmed'] === 'true',
			ehloMatches: data['ehloMatches'] === 'true',
		},
		verdict:
			data['verdict'] === 'pass' || data['verdict'] === 'warn' || data['verdict'] === 'fail'
				? data['verdict']
				: 'error',
		genericPtr: data['genericPtr'] === 'true',
		...(reason ? { reason: reason as FcrdnsFailureReason } : {}),
		checkedAt: Number(data['checkedAt']),
		overridden: data['overridden'] === 'true',
	};
}

export async function runFcrdnsSelfCheck(
	config: FcrdnsConfig,
	deps: FcrdnsDeps = DEFAULT_DEPS
): Promise<FcrdnsResult[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
	const results: FcrdnsResult[] = [];
	for (const ip of ips) {
		const ehlo = resolveEhloForIp(config, ip);
		let result: FcrdnsResult;
		try {
			result = await verifyFcrdns(ip, [ehlo], deps, config.genericPtrSuffixes ?? []);
		} catch (err) {
			result = failedResult(ip, normalizeDnsName(ehlo), [], 'lookup-error', Date.now(), {
				ptrExists: false,
				ptrIsFqdn: false,
				forwardConfirmed: false,
				ehloMatches: false,
			});
			logger.warn({ ip, err }, 'FCrDNS readiness check threw unexpectedly');
		}
		if (!result.ok) {
			logger.warn(
				{ ip, reason: result.reason, ptrNames: result.ptrNames, expectedEhlo: result.ehlo },
				`FCrDNS readiness failed for sending IP ${ip} (${result.reason})`
			);
		} else if (result.genericPtr) {
			logger.warn({ ip, ptrNames: result.ptrNames }, 'Sending IP uses a generic provider PTR');
		}
		results.push(result);
	}
	logger.info(
		{ total: results.length, ready: results.filter((result) => result.ok).length },
		'FCrDNS readiness check complete'
	);
	return results;
}

/** Persist a full sweep and reconcile each IP's FCrDNS exclusion reason. */
export async function runFcrdnsReadinessCheck(
	redis: Redis,
	config: FcrdnsConfig,
	deps: FcrdnsDeps = DEFAULT_DEPS
): Promise<FcrdnsResult[]> {
	const results = await runFcrdnsSelfCheck(config, deps);
	const persistedResults: FcrdnsResult[] = [];
	for (const observed of results) {
		const previous = await getFcrdnsReadiness(redis, observed.ip);
		const existingBlocks = await getIpPoolBlockReasons(redis, observed.ip);
		const previousWouldBlockRaw = await redis.hget(
			`${FCRDNS_PREFIX}${observed.ip}`,
			'wouldBlockWithoutOverride'
		);
		const hardFailure = observed.verdict === 'fail';
		const firstCheckUnverified = observed.verdict === 'error' && previous === null;
		// A transient lookup error preserves the last eligibility decision: it can
		// neither release a prior hard failure nor quarantine a previously verified
		// IP. A never-verified fresh IP fails closed.
		const shouldBlock =
			hardFailure ||
			firstCheckUnverified ||
			(observed.verdict === 'error' &&
				(previousWouldBlockRaw === 'true' ||
					(previousWouldBlockRaw === null && existingBlocks.includes('fcrdns'))));
		const overridden = shouldBlock && config.allowUnverifiedFcrdns === true;
		const result = { ...observed, overridden };
		await redis.hset(`${FCRDNS_PREFIX}${result.ip}`, readinessHash(result, shouldBlock));
		await setIpPoolBlock(redis, result.ip, 'fcrdns', shouldBlock && !overridden);
		persistedResults.push(result);
	}
	return persistedResults;
}
